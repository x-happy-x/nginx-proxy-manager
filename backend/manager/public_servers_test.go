package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

type publicSSHFixture struct {
	t           *testing.T
	listener    net.Listener
	signer      ssh.Signer
	mu          sync.Mutex
	connections []*ssh.ServerConn
	allowedKey  ssh.PublicKey
	forwards    chan net.Listener
}

func newPublicSSHFixture(t *testing.T) *publicSSHFixture {
	t.Helper()
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(key)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &publicSSHFixture{t: t, listener: ln, signer: signer, forwards: make(chan net.Listener, 8)}
	t.Cleanup(func() {
		ln.Close()
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, c := range f.connections {
			c.Close()
		}
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.accept(c)
		}
	}()
	return f
}
func (f *publicSSHFixture) accept(raw net.Conn) {
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.allowedKey != nil && string(key.Marshal()) != string(f.allowedKey.Marshal()) {
			return nil, fmt.Errorf("key not authorized")
		}
		return nil, nil
	}}
	cfg.AddHostKey(f.signer)
	c, chans, reqs, err := ssh.NewServerConn(raw, cfg)
	if err != nil {
		raw.Close()
		return
	}
	defer c.Close()
	f.mu.Lock()
	f.connections = append(f.connections, c)
	f.mu.Unlock()
	go func() {
		for request := range reqs {
			switch request.Type {
			case "tcpip-forward":
				var req struct {
					Address string
					Port    uint32
				}
				_ = ssh.Unmarshal(request.Payload, &req)
				if req.Address != "127.0.0.1" {
					request.Reply(false, nil)
					continue
				}
				ln, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					request.Reply(false, nil)
					continue
				}
				defer ln.Close()
				request.Reply(true, nil)
				f.forwards <- ln
				go func() {
					for {
						conn, err := ln.Accept()
						if err != nil {
							return
						}
						go func() {
							defer conn.Close()
							payload := ssh.Marshal(struct {
								Dest       string
								Port       uint32
								Origin     string
								OriginPort uint32
							}{req.Address, req.Port, "127.0.0.1", 12345})
							channel, requests, err := c.OpenChannel("forwarded-tcpip", payload)
							if err != nil {
								return
							}
							defer channel.Close()
							go ssh.DiscardRequests(requests)
							done := make(chan struct{})
							go func() { io.Copy(channel, conn); channel.CloseWrite(); close(done) }()
							io.Copy(conn, channel)
							conn.Close()
							<-done
						}()
					}
				}()
			case "cancel-tcpip-forward":
				request.Reply(true, nil)
			default:
				request.Reply(true, nil)
			}
		}
	}()
	for ch := range chans {
		if ch.ChannelType() != "session" {
			ch.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		channel, requests, err := ch.Accept()
		if err != nil {
			return
		}
		go func() {
			defer channel.Close()
			for req := range requests {
				if req.Type != "exec" {
					req.Reply(false, nil)
					continue
				}
				req.Reply(true, nil)
				body, _ := io.ReadAll(channel)
				output := "configured\n"
				if strings.Contains(string(body), "/proc/meminfo") {
					output = `{"host":"fixture","load1":0.1,"cores":2,"memory_total":1024,"memory_used":512,"disk_total":1024,"disk_used":1,"uptime":20}`
				}
				io.WriteString(channel, output)
				channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
				return
			}
		}()
	}
}
func (f *publicSSHFixture) config() publicServer {
	h, p, _ := net.SplitHostPort(f.listener.Addr().String())
	port, _ := strconv.Atoi(p)
	return publicServer{ID: "fixture", Name: "Fixture", Address: h, Port: port, User: "root", Fingerprint: ssh.FingerprintSHA256(f.signer.PublicKey())}
}

func TestPublicSSHRejectsChangedKeyAndInspectsWithoutTrust(t *testing.T) {
	f := newPublicSSHFixture(t)
	s := f.config()
	key, err := publicKeyFile(t.TempDir(), s.ID, "admin")
	if err != nil {
		t.Fatal(err)
	}
	_, fp, err := dialPublicSSH(context.Background(), s, nil, true)
	if err == nil || fp != s.Fingerprint {
		t.Fatalf("inspection: %s %v", fp, err)
	}
	s.Fingerprint = "SHA256:other"
	c, _, err := dialPublicSSH(context.Background(), s, []ssh.AuthMethod{ssh.PublicKeys(key)}, false)
	if c != nil || err == nil || !strings.Contains(err.Error(), "изменился") {
		t.Fatalf("changed key accepted: %v", err)
	}
}

func TestPublicBootstrapUsesExistingKeyAfterUnregisteredManagedKey(t *testing.T) {
	f := newPublicSSHFixture(t)
	dir := t.TempDir()
	managed, err := publicKeyFile(dir, "managed", "admin")
	if err != nil {
		t.Fatal(err)
	}
	provided, err := publicKeyFile(dir, "provided", "admin")
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.allowedKey = provided.PublicKey()
	f.mu.Unlock()
	body, err := os.ReadFile(filepath.Join(dir, "provided-admin.key"))
	if err != nil {
		t.Fatal(err)
	}
	auth, err := publicBootstrapAuth(managed, string(body), "")
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := dialPublicSSH(context.Background(), f.config(), auth, false)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if output, err := publicSSHRun(context.Background(), c, "test\n"); err != nil || output != "configured\n" {
		t.Fatalf("bootstrap command: %q %v", output, err)
	}
}

func TestPublicTunnelForwardsAndReconnectsAfterDrop(t *testing.T) {
	f := newPublicSSHFixture(t)
	s := f.config()
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, e := echo.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	_, rawPort, _ := net.SplitHostPort(echo.Addr().String())
	port, _ := strconv.Atoi(rawPort)
	m := &publicServerManager{dir: t.TempDir()}
	j := &publicServerJob{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); m.run(ctx, s, []publicForward{{Host: "test.example", Port: port}}, j) }()
	for attempt := 0; attempt < 2; attempt++ {
		var ln net.Listener
		select {
		case ln = <-f.forwards:
		case <-time.After(9 * time.Second):
			t.Fatal("tunnel did not connect/reconnect")
		}
		c, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		c.SetDeadline(time.Now().Add(2 * time.Second))
		fmt.Fprint(c, "ping")
		body := make([]byte, 4)
		_, err = io.ReadFull(c, body)
		c.Close()
		if err != nil || string(body) != "ping" {
			m.mu.Lock()
			detail := j.status
			m.mu.Unlock()
			t.Fatalf("forward: %q %v; %+v", body, err, detail)
		}
		if attempt == 0 {
			f.mu.Lock()
			for _, conn := range f.connections {
				if strings.HasPrefix(conn.User(), "homenet-tunnel-") {
					conn.Close()
				}
			}
			f.mu.Unlock()
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown blocked")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if j.status.Reconnects < 1 || !json.Valid(j.status.Metrics) {
		t.Fatalf("missing recovery/metrics: %+v", j.status)
	}
}

func TestPublicServerRejectsCommandInjection(t *testing.T) {
	s := publicServer{ID: "vps", Name: "VPS", Address: "213.155.28.79", Port: 22, User: "root"}
	for _, change := range []func(*publicServer){func(s *publicServer) { s.ID = "../../root" }, func(s *publicServer) { s.Address = "host;reboot" }, func(s *publicServer) { s.SOCKS = "host:7891" }, func(s *publicServer) { s.Email = "a@b\nreboot" }} {
		bad := s
		change(&bad)
		if validatePublicServer(bad) == nil {
			t.Fatalf("invalid server accepted: %+v", bad)
		}
	}
}
