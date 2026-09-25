// The generator never starts, stops or restarts nginx or changes router networking.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/envfile"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

const managedHeader = "# managed by homenet-nginx-yaml\n"

type generator struct {
	gatewayEnabled                                                             bool
	confRoot, mainConf, binary                                                 string
	nginxListenIPs, localCACert, localCAKey, leRoot                            string
	sitesEnabled, acmeWebroot, selfDir, mapsConf, proxySnippet, routeAccessLog string
	errorsDir                                                                  string
	preview                                                                    bool
	command                                                                    func(string, ...string) error
	verifyProcess                                                              func() error
	keeneticCerts                                                              map[string]string
}

func main() {
	var configPath string
	var dryRun bool
	flag.StringVar(&configPath, "config", "", "Path to routes v2.1 YAML")
	flag.BoolVar(&dryRun, "dry-run", false, "Print configuration without writing files or reloading nginx")
	flag.Parse()
	if configPath == "" {
		fatal(fmt.Errorf("--config is required"))
	}
	if wd, err := os.Getwd(); err == nil {
		loadRuntimeEnv(wd)
	}
	g := newGenerator(getenv("NGINX_CONF_ROOT", "/opt/etc/homenet/proxy"))
	g.mainConf = os.Getenv("NGINX_MAIN_CONF")
	g.binary = os.Getenv("NGINX_BINARY")
	g.nginxListenIPs = os.Getenv("NGINX_LISTEN_IPS")
	g.localCACert = getenv("LOCAL_CA_CERT", g.localCACert)
	g.localCAKey = getenv("LOCAL_CA_KEY", g.localCAKey)
	g.leRoot = getenv("LE_ROOT", "/opt/etc/letsencrypt")
	g.routeAccessLog = getenv("ROUTE_ACCESS_LOG", "/opt/var/log/nginx/route_access.log")
	routes, err := schema.LoadRoutes(configPath)
	if err != nil {
		fatal(err)
	}
	if err := schema.ResolveAutoPorts(&routes); err != nil {
		fatal(err)
	}
	if dryRun {
		g.preview = true
		files, err := g.render(routes)
		if err != nil {
			fatal(err)
		}
		body, err := json.MarshalIndent(map[string]any{"dry_run": true, "nginx_validated": false, "message": "Preview only; apply validates a staged configuration with the dedicated nginx binary.", "files": files}, "", "  ")
		if err != nil {
			fatal(err)
		}
		fmt.Println(string(body))
		return
	}
	if err := g.apply(routes); err != nil {
		fatal(err)
	}
	fmt.Println("Staged configuration validated; dedicated nginx gracefully reloaded.")
}

func newGenerator(root string) *generator {
	return &generator{confRoot: root, localCACert: filepath.Join(root, "local-ca", "ca.crt"), localCAKey: filepath.Join(root, "local-ca", "ca.key"), leRoot: "/opt/etc/letsencrypt", sitesEnabled: filepath.Join(root, "sites-enabled"), errorsDir: filepath.Join(root, "errors"), acmeWebroot: "/opt/var/www/_letsencrypt", selfDir: filepath.Join(root, "selfsigned"), mapsConf: filepath.Join(root, "conf.d", "npm_maps_v3.conf"), proxySnippet: filepath.Join(root, "snippets", "npm_proxy_v3.conf"), routeAccessLog: "/opt/var/log/nginx/route_access.log"}
}
func fatal(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
func loadRuntimeEnv(baseDir string) {
	_ = envfile.Load(getenv("CONFIG_ENV_PATH", filepath.Join(baseDir, "config", "runtime.env")))
}
func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
func exists(path string) bool { _, err := os.Stat(path); return err == nil }
func writeFile(path, content string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), mode)
}
func inside(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func nginxPath(path string) string { return filepath.ToSlash(path) }
func quote(path string) string     { return strconv.Quote(nginxPath(path)) }
func (g *generator) run(args ...string) error {
	if g.command != nil {
		return g.command(g.binary, args...)
	}
	cmd := exec.Command(g.binary, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("nginx %s: %w\n%s", strings.Join(args, " "), err, out)
	}
	return nil
}

var pidPattern = regexp.MustCompile(`(?m)^\s*pid\s+([^;\r\n]+)\s*;`)

func (g *generator) verifyDedicatedProcess() error {
	if !filepath.IsAbs(g.binary) || !filepath.IsAbs(g.mainConf) || !inside(g.confRoot, g.mainConf) {
		return fmt.Errorf("apply requires absolute NGINX_BINARY and NGINX_MAIN_CONF inside NGINX_CONF_ROOT for a dedicated nginx instance")
	}
	body, err := os.ReadFile(g.mainConf)
	if err != nil {
		return err
	}
	matches := pidPattern.FindAllStringSubmatch(string(body), -1)
	if len(matches) != 1 {
		return fmt.Errorf("dedicated nginx config must contain exactly one explicit pid directive")
	}
	pidPath := strings.Trim(strings.TrimSpace(matches[0][1]), `"'`)
	if !filepath.IsAbs(pidPath) || !inside(g.confRoot, pidPath) {
		return fmt.Errorf("dedicated nginx pid file must be inside NGINX_CONF_ROOT")
	}
	pidBody, err := os.ReadFile(pidPath)
	if err != nil {
		return fmt.Errorf("dedicated nginx is not running: %w", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidBody)))
	if err != nil || pid < 2 {
		return fmt.Errorf("invalid dedicated nginx pid")
	}
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return fmt.Errorf("cannot verify dedicated nginx process: %w", err)
	}
	if !strings.Contains(string(cmdline), g.mainConf) || !strings.Contains(string(cmdline), g.binary) {
		return fmt.Errorf("pid %d does not belong to the explicitly configured dedicated nginx instance", pid)
	}
	return nil
}

func (g *generator) render(routes schema.Routes) (map[string]string, error) {
	g.gatewayEnabled = routes.Globals.AccessGateway
	if err := schema.ValidateRoutes(routes); err != nil {
		return nil, err
	}
	ips := routes.Globals.ListenIPs
	if len(ips) == 0 {
		ips = schema.ParseListenIPs(g.nginxListenIPs)
	}
	for _, ip := range ips {
		if net.ParseIP(ip) == nil || net.ParseIP(ip).IsUnspecified() {
			return nil, fmt.Errorf("invalid or wildcard router listener IP %q", ip)
		}
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("explicit proxy listener IPs are required; refusing wildcard binding on a router")
	}
	files := map[string]string{
		g.mapsConf:     managedHeader + "map $http_upgrade $npm_connection_upgrade {\n  default upgrade;\n  '' close;\n}\n",
		g.proxySnippet: managedHeader + "proxy_set_header X-Real-IP $remote_addr;\nproxy_set_header X-Forwarded-For $remote_addr;\nproxy_http_version 1.1;\nproxy_read_timeout 3600;\nproxy_send_timeout 3600;\nproxy_buffering off;\nproxy_set_header Upgrade $http_upgrade;\nproxy_set_header Connection $npm_connection_upgrade;\n",
	}
	if err := g.addKeeneticCertificates(routes, files); err != nil {
		return nil, err
	}
	if routes.Globals.Stub.Enabled != nil && *routes.Globals.Stub.Enabled {
		stub, err := g.buildStubConf(routes, ips)
		if err != nil {
			return nil, err
		}
		files[filepath.Join(g.confRoot, "conf.d", "npm_stub_v3.conf")] = managedHeader + stub
	}
	apps := map[string]schema.App{}
	for _, app := range routes.Apps {
		apps[app.ID] = app
	}
	certs := map[string]schema.Certificate{}
	for _, cert := range routes.Certs {
		id := cert.ID
		if id == "" {
			id = cert.Host
		}
		certs[id] = cert
	}
	for _, host := range routes.Hosts {
		content, err := g.buildHostConf(host, apps[host.AppID], schema.NormalizePort(routes.Globals.Ports.HTTP, 80), ips, certs)
		if err != nil {
			return nil, err
		}
		files[filepath.Join(g.sitesEnabled, host.Host+".conf")] = managedHeader + content
	}
	g.addUnavailablePages(routes, apps, files)
	return files, nil
}

func owned(path string) bool {
	body, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	if len(body) > 256 {
		body = body[:256]
	}
	return strings.Contains(string(body), "managed by homenet-nginx-yaml") || strings.Contains(string(body), "managed by crubs-nginx-yaml")
}

// File symlinks are followed only in the isolated snapshot. Directory links and
// special files cause staging to fail; the live files are never followed for writes.
func cloneTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		dest := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(dest, 0o700)
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("cannot stage non-regular nginx config file %s", path)
		}
		if info.Size() > 16<<20 {
			return fmt.Errorf("nginx config file too large to stage: %s", path)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.HasSuffix(path, ".conf") {
			body = []byte(strings.ReplaceAll(string(body), nginxPath(src)+"/", nginxPath(dst)+"/"))
		}
		return os.WriteFile(dest, body, info.Mode().Perm())
	})
}

type fileState struct {
	body   []byte
	mode   os.FileMode
	link   string
	exists bool
}

func capture(path string) (fileState, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return fileState{}, nil
	}
	if err != nil {
		return fileState{}, err
	}
	s := fileState{exists: true, mode: info.Mode().Perm()}
	if info.Mode()&os.ModeSymlink != 0 {
		s.link, err = os.Readlink(path)
	} else if info.Mode().IsRegular() {
		s.body, err = os.ReadFile(path)
	} else {
		err = fmt.Errorf("refusing non-file target %s", path)
	}
	return s, err
}
func atomicWrite(path string, body []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".npm-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(body); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
func restore(path string, s fileState) error {
	if !s.exists {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if s.link != "" {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return os.Symlink(s.link, path)
	}
	return atomicWrite(path, s.body, s.mode)
}

// Only validated owned files enter the transaction. Failure restores bytes,
// modes and symlinks; the running workers are left serving the previous config.
func (g *generator) apply(routes schema.Routes) error {
	if err := schema.ValidateRoutes(routes); err != nil {
		return err
	}
	verify := g.verifyProcess
	if verify == nil {
		verify = g.verifyDedicatedProcess
	}
	if err := verify(); err != nil {
		return err
	}
	lock := filepath.Join(g.confRoot, ".npm-apply.lock")
	if err := os.Mkdir(lock, 0o700); err != nil {
		return fmt.Errorf("another apply may be running (lock %s): %w", lock, err)
	}
	defer os.Remove(lock)
	stage, err := os.MkdirTemp("", "npm-nginx-stage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := cloneTree(g.confRoot, stage); err != nil {
		return err
	}
	sg := *g
	rebase := func(path string) string {
		if inside(g.confRoot, path) {
			rel, _ := filepath.Rel(g.confRoot, path)
			return filepath.Join(stage, rel)
		}
		return path
	}
	sg.confRoot, sg.mainConf = stage, rebase(g.mainConf)
	sg.sitesEnabled, sg.mapsConf, sg.proxySnippet, sg.selfDir = rebase(g.sitesEnabled), rebase(g.mapsConf), rebase(g.proxySnippet), rebase(g.selfDir)
	sg.localCACert, sg.localCAKey = rebase(g.localCACert), rebase(g.localCAKey)
	sg.errorsDir = rebase(g.errorsDir)
	remove := map[string]bool{}
	// Owned host configs and error pages are regenerated; stale ones are removed.
	for _, dir := range []string{g.sitesEnabled, g.errorsDir} {
		entries, err := os.ReadDir(dir)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		for _, entry := range entries {
			path := filepath.Join(dir, entry.Name())
			if !entry.IsDir() && owned(path) {
				remove[path] = true
				if err := os.Remove(rebase(path)); err != nil {
					return err
				}
			}
		}
	}
	files, err := sg.render(routes)
	if err != nil {
		return err
	}
	for _, optional := range []string{"npm_keenetic_v3.conf", "npm_stub_v3.conf"} {
		path := filepath.Join(g.confRoot, "conf.d", optional)
		if _, needed := files[rebase(path)]; !needed && owned(path) {
			remove[path] = true
			if err := os.Remove(rebase(path)); err != nil {
				return err
			}
		}
	}
	desired := map[string]fileState{}
	for stagedPath, content := range files {
		rel, err := filepath.Rel(stage, stagedPath)
		if err != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("generated file outside staging tree")
		}
		livePath := filepath.Join(g.confRoot, rel)
		if _, err := os.Lstat(livePath); err == nil && !owned(livePath) {
			return fmt.Errorf("refusing to overwrite foreign nginx config %s", livePath)
		}
		mode := os.FileMode(0o644)
		if filepath.Base(stagedPath) == "npm_keenetic_v3.conf" {
			mode = 0o600
		}
		if err := writeFile(stagedPath, content, mode); err != nil {
			return err
		}
		desired[livePath] = fileState{body: []byte(strings.ReplaceAll(content, nginxPath(stage)+"/", nginxPath(g.confRoot)+"/")), mode: mode, exists: true}
		delete(remove, livePath)
	}
	// Certificates created during staging are committed only after nginx -t.
	if entries, err := os.ReadDir(sg.selfDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			livePath := filepath.Join(g.selfDir, entry.Name())
			if exists(livePath) {
				continue
			}
			s, err := capture(filepath.Join(sg.selfDir, entry.Name()))
			if err != nil {
				return err
			}
			desired[livePath] = s
		}
	}
	if err := sg.run("-t", "-p", stage+string(filepath.Separator), "-c", sg.mainConf); err != nil {
		return fmt.Errorf("staged validation failed; live config unchanged: %w", err)
	}
	for path := range remove {
		desired[path] = fileState{}
	}
	paths := make([]string, 0, len(desired))
	for path := range desired {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	previous := map[string]fileState{}
	for _, path := range paths {
		s, err := capture(path)
		if err != nil {
			return err
		}
		previous[path] = s
	}
	touched := []string{}
	rollback := func(cause error) error {
		errs := []error{cause}
		for i := len(touched) - 1; i >= 0; i-- {
			if err := restore(touched[i], previous[touched[i]]); err != nil {
				errs = append(errs, fmt.Errorf("rollback %s: %w", touched[i], err))
			}
		}
		return errors.Join(errs...)
	}
	for _, path := range paths {
		touched = append(touched, path)
		if err := restore(path, desired[path]); err != nil {
			return rollback(err)
		}
	}
	if err := g.run("-t", "-p", g.confRoot+string(filepath.Separator), "-c", g.mainConf); err != nil {
		return rollback(fmt.Errorf("live validation failed; previous files restored: %w", err))
	}
	if err := verify(); err != nil {
		return rollback(err)
	}
	if err := g.run("-s", "reload", "-p", g.confRoot+string(filepath.Separator), "-c", g.mainConf); err != nil {
		return rollback(fmt.Errorf("reload failed; previous files restored: %w", err))
	}
	return nil
}

func (g *generator) selfPaths(host string) (string, string) {
	return filepath.Join(g.selfDir, host+".crt"), filepath.Join(g.selfDir, host+".key")
}

func (g *generator) buildStubConf(routes schema.Routes, ips []string) (string, error) {
	crt, key, err := g.resolveCertPaths("homenet-unconfigured.local", schema.Host{TLS: schema.TLSConfig{CertPolicy: "auto_local_ca"}}, nil)
	if err != nil {
		return "", err
	}
	httpPorts := schema.NormalizePortList(append([]int{schema.NormalizePort(routes.Globals.Ports.HTTP, 80)}, routes.Globals.Ports.HTTPExtra...))
	httpsPorts := schema.NormalizePortList(append([]int{schema.NormalizePort(routes.Globals.Ports.HTTPS, 443)}, routes.Globals.Ports.HTTPSExtra...))
	httpListen, httpsListen := []string{}, []string{}
	for _, port := range httpPorts {
		httpListen = append(httpListen, listenLines(port, ips, " default_server")...)
	}
	for _, port := range httpsPorts {
		httpsListen = append(httpsListen, listenLines(port, ips, " ssl default_server")...)
	}
	root := routes.Globals.Stub.Root
	if root == "" {
		root = "/opt/var/www/stub"
	}
	return fmt.Sprintf("server {\n  %s\n  server_name _;\n  root %s;\n  index index.html;\n  location / { try_files $uri $uri/ =404; }\n}\nserver {\n  %s\n  server_name _;\n  ssl_certificate %s;\n  ssl_certificate_key %s;\n  ssl_protocols TLSv1.2 TLSv1.3;\n  root %s;\n  index index.html;\n  location / { try_files $uri $uri/ =404; }\n}\n", strings.Join(httpListen, "\n  "), quote(root), strings.Join(httpsListen, "\n  "), quote(crt), quote(key), quote(root)), nil
}
func (g *generator) resolveCertPaths(host string, cfg schema.Host, certs map[string]schema.Certificate) (string, string, error) {
	policy := cfg.TLS.CertPolicy
	if policy == "keenetic" {
		id, ok := g.keeneticCerts[host]
		if !ok {
			return "", "", fmt.Errorf("host %q: no matching valid Keenetic certificate", host)
		}
		return "data:$npm_ndm_cert_" + id, "data:$npm_ndm_key_" + id, nil
	}
	if policy == "off" {
		return "", "", fmt.Errorf("host %q: TLS disabled for HTTPS endpoint", host)
	}
	if policy == "custom_ref" {
		cert, ok := certs[cfg.TLS.CertRef]
		if !ok {
			cert, ok = certs[host]
		}
		if !ok || !exists(cert.CRTPath) || !exists(cert.KeyPath) {
			return "", "", fmt.Errorf("host %q: custom certificate not found", host)
		}
		return cert.CRTPath, cert.KeyPath, nil
	}
	if policy == "auto_acme" {
		crt, key := filepath.Join(g.leRoot, "live", host, "fullchain.pem"), filepath.Join(g.leRoot, "live", host, "privkey.pem")
		if exists(crt) && exists(key) {
			return crt, key, nil
		}
		return "", "", fmt.Errorf("host %q: ACME certificate is missing; provision it or select a local certificate policy", host)
	}
	crt, key := g.selfPaths(host)
	if exists(crt) && exists(key) || g.preview {
		return crt, key, nil
	}
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return "", "", err
	}
	leaf := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: host}, DNSNames: append([]string{host}, cfg.TLS.SAN...), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(1, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	parent, signer := leaf, any(private)
	if policy != "self_signed" && exists(g.localCACert) && exists(g.localCAKey) {
		certBody, err := os.ReadFile(g.localCACert)
		if err != nil {
			return "", "", err
		}
		block, _ := pem.Decode(certBody)
		if block == nil {
			return "", "", fmt.Errorf("invalid local CA certificate")
		}
		parent, err = x509.ParseCertificate(block.Bytes)
		if err != nil {
			return "", "", err
		}
		keyBody, err := os.ReadFile(g.localCAKey)
		if err != nil {
			return "", "", err
		}
		block, _ = pem.Decode(keyBody)
		if block == nil {
			return "", "", fmt.Errorf("invalid local CA key")
		}
		signer, err = x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			if k, e := x509.ParsePKCS1PrivateKey(block.Bytes); e == nil {
				signer, err = k, nil
			} else if k, e := x509.ParseECPrivateKey(block.Bytes); e == nil {
				signer, err = k, nil
			}
		}
		if err != nil {
			return "", "", err
		}
		if parent.NotAfter.Before(leaf.NotAfter) {
			leaf.NotAfter = parent.NotAfter
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, parent, &private.PublicKey, signer)
	if err != nil {
		return "", "", err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		return "", "", err
	}
	if err := writeFile(key, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})), 0o600); err != nil {
		return "", "", err
	}
	if err := writeFile(crt, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), 0o644); err != nil {
		return "", "", err
	}
	return crt, key, nil
}

func routeLogFormatName(name string) string {
	sum := sha256.Sum256([]byte(name))
	return "npm_route_" + hex.EncodeToString(sum[:10])
}

var keeneticMapPattern = regexp.MustCompile(`(?s)map\s+\$host\s+\$ndm_(cert|key)_([0-9]+)\s*\{(.*?)\}`)
var keeneticDefaultPattern = regexp.MustCompile(`(?s)\bdefault\s+"([^"]+)"\s*;`)

// Keenetic's firmware nginx understands its encrypted private keys. Copy only
// normalized PEM blocks; never decrypt, expose, or execute source directives.
// The firmware config is read-only and its nginx process is never controlled.
func (g *generator) addKeeneticCertificates(routes schema.Routes, files map[string]string) error {
	wanted := []string{}
	for _, host := range routes.Hosts {
		if host.TLS.CertPolicy == "keenetic" {
			wanted = append(wanted, host.Host)
		}
	}
	if len(wanted) == 0 {
		return nil
	}
	body, err := os.ReadFile(getenv("KEENETIC_NGINX_CONF", "/tmp/nginx/nginx.conf"))
	if err != nil {
		return fmt.Errorf("cannot read Keenetic TLS source: %w", err)
	}
	type pair struct {
		cert, key *pem.Block
		chain     []byte
		leaf      *x509.Certificate
	}
	pairs := map[string]*pair{}
	ids := []string{}
	for _, match := range keeneticMapPattern.FindAllStringSubmatch(string(body), -1) {
		value := keeneticDefaultPattern.FindStringSubmatch(match[3])
		if len(value) != 2 {
			continue
		}
		block, rest := pem.Decode([]byte(strings.ReplaceAll(value[1], `\n`, "\n")))
		if block == nil {
			continue
		}
		id := match[2]
		if pairs[id] == nil {
			pairs[id] = &pair{}
			ids = append(ids, id)
		}
		if match[1] == "cert" && block.Type == "CERTIFICATE" {
			leaf, err := x509.ParseCertificate(block.Bytes)
			if err == nil {
				chain := pem.EncodeToMemory(block)
				for len(strings.TrimSpace(string(rest))) > 0 {
					next, tail := pem.Decode(rest)
					if next == nil || next.Type != "CERTIFICATE" {
						err = fmt.Errorf("invalid certificate chain")
						break
					}
					if _, err = x509.ParseCertificate(next.Bytes); err != nil {
						break
					}
					chain = append(chain, pem.EncodeToMemory(next)...)
					rest = tail
				}
				if err == nil {
					pairs[id].cert, pairs[id].leaf, pairs[id].chain = block, leaf, chain
				}
			}
		}
		if match[1] == "key" && block.Type == "ENCRYPTED PRIVATE KEY" {
			pairs[id].key = block
		}
	}
	sort.Strings(ids)
	g.keeneticCerts = map[string]string{}
	used := map[string]bool{}
	for _, host := range wanted {
		for _, id := range ids {
			p := pairs[id]
			if p.cert == nil || p.key == nil || p.leaf == nil || time.Now().Before(p.leaf.NotBefore) || time.Now().After(p.leaf.NotAfter) || p.leaf.VerifyHostname(host) != nil {
				continue
			}
			g.keeneticCerts[host], used[id] = id, true
			break
		}
		if g.keeneticCerts[host] == "" {
			return fmt.Errorf("host %q: no valid matching Keenetic certificate with encrypted key", host)
		}
	}
	path := filepath.Join(g.confRoot, "conf.d", "npm_keenetic_v3.conf")
	if g.preview {
		files[path] = managedHeader + "# Keenetic certificate and encrypted key omitted from preview.\n"
		return nil
	}
	var out strings.Builder
	out.WriteString(managedHeader)
	for _, id := range ids {
		if used[id] {
			p := pairs[id]
			fmt.Fprintf(&out, "map $host $npm_ndm_cert_%s {\n  default \"%s\";\n}\nmap $host $npm_ndm_key_%s {\n  default \"%s\";\n}\n", id, p.chain, id, pem.EncodeToMemory(p.key))
		}
	}
	files[path] = out.String()
	return nil
}

func routeLogFormat(host schema.Host, ep schema.Endpoint, source string) (string, string) {
	name := routeLogFormatName(host.Host + ":" + ep.Name)
	// Source and route identity are literal configuration, never forwarded headers.
	format := fmt.Sprintf(`log_format %s escape=json
  '{"time":"$time_iso8601","route_host":"%s","app_id":"%s","endpoint":"%s","traffic_source":"%s","remote":"$remote_addr","host":"$host","server_name":"$server_name","server_addr":"$server_addr","server_port":"$server_port","scheme":"$scheme","method":"$request_method","uri":"$uri","status":"$status","bytes_sent":"$body_bytes_sent","request_length":"$request_length","request_time":"$request_time","upstream_addr":"$upstream_addr","upstream_status":"$upstream_status","upstream_connect_time":"$upstream_connect_time","upstream_header_time":"$upstream_header_time","upstream_response_time":"$upstream_response_time","proxy_host":"$proxy_host","http_user_agent":"$http_user_agent"}';`, name, host.Host, host.AppID, ep.Name, source)
	return name, format
}
func listenLines(port int, ips []string, extra string) []string {
	out := make([]string, 0, len(ips))
	for _, ip := range ips {
		out = append(out, fmt.Sprintf("listen %s%s;", net.JoinHostPort(ip, strconv.Itoa(port)), extra))
	}
	return out
}
func proxyBlock(g *generator, app schema.App, host schema.Host, path string, external bool, publicHTTPS bool) string {
	scheme := app.Upstream.Scheme
	if scheme == "" {
		scheme = "http"
	}
	hostHeader := "$host"
	if external {
		hostHeader = host.Host
	}
	forwardedProto := "$scheme"
	if external && publicHTTPS {
		forwardedProto = "https"
	}
	lines := []string{fmt.Sprintf("location %s {", path), fmt.Sprintf("  proxy_pass %s://%s;", scheme, net.JoinHostPort(app.Upstream.Address, strconv.Itoa(app.Upstream.Port))), "  include " + quote(g.proxySnippet) + ";", "  proxy_set_header Host " + hostHeader + ";", "  proxy_set_header X-Forwarded-Proto " + forwardedProto + ";"}
	if g.gatewayEnabled && host.AccessApp != "" {
		lines = append(lines, "  auth_request /_gate/check;", "  error_page 401 = /_gate/login;", "  proxy_set_header X-Auth-User \"\";", "  proxy_set_header X-Auth-Role \"\";")
	}
	if scheme == "https" {
		lines = append(lines, "  proxy_ssl_server_name on;")
		if host.VerifyUpstreamSSL {
			lines = append(lines, "  proxy_ssl_verify on;", "  proxy_ssl_trusted_certificate "+quote(getenv("UPSTREAM_CA_BUNDLE", "/opt/etc/ssl/certs/ca-certificates.crt"))+";")
		} else {
			lines = append(lines, "  proxy_ssl_verify off;")
		}
	}
	lines = append(lines, "}")
	return strings.Join(lines, "\n")
}
func (g *generator) buildHostConf(host schema.Host, app schema.App, httpPort int, ips []string, certs map[string]schema.Certificate) (string, error) {
	blocks := []string{}
	for _, ep := range host.Endpoints {
		external := ep.Name != "web"
		proto := ep.Listen.Protocol
		if proto == "" {
			proto = "http"
			if !external {
				proto = "https"
			}
		}
		fallback := 80
		if proto == "https" {
			fallback = 443
		}
		if external {
			fallback = 0
		}
		port := schema.NormalizePort(ep.Listen.Port, fallback)
		if port == 0 {
			return "", fmt.Errorf("host %q: unresolved public endpoint port", host.Host)
		}
		source := "local"
		if external {
			source = "external"
		}
		format, decl := routeLogFormat(host, ep, source)
		blocks = append(blocks, decl)
		extra, tls := "", ""
		if proto == "https" {
			crt, key, err := g.resolveCertPaths(host.Host, host, certs)
			if err != nil {
				return "", err
			}
			extra = " ssl"
			tls = "\n  ssl_certificate " + quote(crt) + ";\n  ssl_certificate_key " + quote(key) + ";\n  ssl_protocols TLSv1.2 TLSv1.3;"
			if host.TLS.CertPolicy == "keenetic" {
				tls += "\n  ssl_password_file /dev/random;"
			}
		}
		publicHTTPS := ep.Behavior.NDNSSSLRedirect == nil || *ep.Behavior.NDNSSSLRedirect
		pb := g.unavailableDirectives(host.Host, external) + "\n  " + proxyBlock(g, app, host, "/", external, publicHTTPS)
		if g.gatewayEnabled {
			pb += "\n" + gatewayLocations(host.Host, external && publicHTTPS)
			for _, path := range host.AccessPassthrough {
				bypass := host
				bypass.AccessApp = ""
				location := "= " + path
				if strings.HasSuffix(path, "/") {
					location = "^~ " + path
				}
				pb += "\n" + proxyBlock(g, app, bypass, location, external, publicHTTPS)
			}
		}
		ws := host.WSProxy
		if !ws.Enabled {
			ws = app.WSProxy
		}
		if ws.Enabled && ws.Path != "/" {
			path := ws.Path
			if path == "" {
				path = "/connections"
			}
			pb += "\n" + proxyBlock(g, app, host, "^~ "+path, external, publicHTTPS)
		}
		blocks = append(blocks, fmt.Sprintf("server {\n  %s\n  server_name %s;\n  access_log %s %s;%s\n  %s\n}", strings.Join(listenLines(port, ips, extra), "\n  "), host.Host, quote(g.routeAccessLog), format, tls, pb))
		if !external && proto == "https" && ep.Behavior.Redirect != "off" {
			body := pb
			if ep.Behavior.Redirect != "http" {
				target := ""
				if port != 443 {
					target = fmt.Sprintf(":%d", port)
				}
				body = fmt.Sprintf("location / { return 308 https://%s%s$request_uri; }", host.Host, target)
			}
			blocks = append(blocks, fmt.Sprintf("server {\n  %s\n  server_name %s;\n  access_log %s %s;\n  location ^~ /.well-known/acme-challenge/ { root %s; }\n  %s\n}", strings.Join(listenLines(httpPort, ips, ""), "\n  "), host.Host, quote(g.routeAccessLog), format, quote(g.acmeWebroot), body))
		}
	}
	return strings.Join(blocks, "\n\n") + "\n", nil
}
