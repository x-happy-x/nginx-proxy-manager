// offlinefront terminates local HTTPS and adapts Core's loopback gateway calls.
// Authentication remains in the existing gateway and the router's /auth API.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type config struct {
	Listen  string `json:"listen"`
	Host    string `json:"host"`
	Core    string `json:"core"`
	Gateway string `json:"gateway"`
	Shim    string `json:"shim"`
	Cert    string `json:"cert"`
	Key     string `json:"key"`
}

func localURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("invalid local upstream")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() || u.Port() == "" {
		return nil, fmt.Errorf("upstream must be loopback")
	}
	return u, nil
}

func newCertificate(ip, certPath, keyPath string) error {
	addr := net.ParseIP(ip)
	if addr == nil {
		return fmt.Errorf("certificate needs an IP address")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	t := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "HomeNet local router"},
		NotBefore: time.Now().Add(-24 * time.Hour), NotAfter: time.Now().AddDate(5, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{addr}}
	der, err := x509.CreateCertificate(rand.Reader, t, t, &key.PublicKey, key)
	if err != nil {
		return err
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	if err = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0600); err != nil {
		return err
	}
	return os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600)
}

func handlers(c config) (http.Handler, http.Handler, error) {
	core, err := localURL(c.Core)
	if err != nil {
		return nil, nil, err
	}
	gate, err := localURL(c.Gateway)
	if err != nil {
		return nil, nil, err
	}
	front := httputil.NewSingleHostReverseProxy(core)
	shim := httputil.NewSingleHostReverseProxy(gate)
	shimDirector := shim.Director
	shim.Director = func(r *http.Request) { shimDirector(r); r.Header.Set("X-Gate-Proto", "https") }
	ui := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != c.Host {
			http.Error(w, "Use the installation's HTTPS address", 403)
			return
		}
		front.ServeHTTP(w, r)
	})
	internal := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if p := net.ParseIP(ip); p == nil || !p.IsLoopback() || r.Header.Get("X-Gate-Host") != c.Host || !strings.HasPrefix(r.URL.Path, "/_gate/") {
			http.Error(w, "Forbidden", 403)
			return
		}
		shim.ServeHTTP(w, r)
	})
	return ui, internal, nil
}

func main() {
	file := flag.String("config", "/opt/etc/homenet/offline/front.json", "configuration")
	certIP := flag.String("init-cert", "", "create a new local certificate for this IP")
	cert := flag.String("cert", "", "certificate file")
	key := flag.String("key", "", "private key file")
	flag.Parse()
	if *certIP != "" {
		if err := newCertificate(*certIP, *cert, *key); err != nil {
			log.Fatal(err)
		}
		return
	}
	var c config
	b, err := os.ReadFile(*file)
	if err != nil {
		log.Fatal(err)
	}
	if err = json.Unmarshal(b, &c); err != nil {
		log.Fatal(err)
	}
	host, _, err := net.SplitHostPort(c.Shim)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("shim must listen on loopback")
	}
	ui, internal, err := handlers(c)
	if err != nil {
		log.Fatal(err)
	}
	servers := []*http.Server{{Addr: c.Listen, Handler: ui, ReadHeaderTimeout: 5 * time.Second}, {Addr: c.Shim, Handler: internal, ReadHeaderTimeout: 5 * time.Second}}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errors := make(chan error, 2)
	go func() { errors <- servers[1].ListenAndServe() }()
	go func() { errors <- servers[0].ListenAndServeTLS(c.Cert, c.Key) }()
	select {
	case <-ctx.Done():
	case err = <-errors:
		if err != http.ErrServerClosed {
			log.Print(err)
		}
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shutdown)
	}
}
