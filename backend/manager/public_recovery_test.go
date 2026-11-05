package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestPublicVPNConfigOwnGroupAndListenerOnly(t *testing.T) {
	original := []byte("mixed-port: 1080\nsecret: keep-secret\nproxy-groups:\n  - name: AUTO\n    type: select\n    proxies: [test]\nproxies:\n  - name: test\n    type: socks5\n    server: localhost\n    port: 1\nrules: [MATCH,AUTO]\n")
	candidate, port, err := publicVPNConfig(original, "cdn6")
	if err != nil {
		t.Fatal(err)
	}
	if port < 33000 || port > 33999 {
		t.Fatalf("invalid private SOCKS port %d", port)
	}
	var before, after map[string]any
	_ = yaml.Unmarshal(original, &before)
	_ = yaml.Unmarshal(candidate, &after)
	for _, key := range []string{"mixed-port", "secret", "rules", "proxies"} {
		a, _ := json.Marshal(before[key])
		b, _ := json.Marshal(after[key])
		if string(a) != string(b) {
			t.Fatalf("unrelated %s changed", key)
		}
	}
	var doc yaml.Node
	_ = yaml.Unmarshal(candidate, &doc)
	root := doc.Content[0]
	listeners := mihomoYAMLField(root, "listeners")
	if len(listeners.Content) != 1 || scalar(mapGet(listeners.Content[0], "listen")) != "127.0.0.1" {
		t.Fatal("listener is not loopback only")
	}
	second, nextPort, err := publicVPNConfig(candidate, "cdn6")
	if err != nil {
		t.Fatal(err)
	}
	if string(second) != string(candidate) || nextPort != port {
		t.Fatal("ensuring an existing group rewrites config/reloads VPN")
	}
	foreign := strings.Replace(string(candidate), "# HomeNet public VPN: cdn6", "# user-owned", 1)
	if _, _, err := publicVPNConfig([]byte(foreign), "cdn6"); err == nil {
		t.Fatal("foreign group overwritten")
	}
}

func TestPublicRecoveryBudgetSurvivesRestartAndServerAliases(t *testing.T) {
	m := &publicServerManager{dir: t.TempDir()}
	s := publicServer{ID: "one", Address: "203.0.113.1", Port: 22}
	start := time.Now().UTC()
	for i := 0; i < publicRecoveryAttempts; i++ {
		if wait, err := m.reservePublicRecovery(s, start.Add(time.Duration(i)*time.Minute)); err != nil || wait != 0 {
			t.Fatalf("attempt %d: %v %v", i, wait, err)
		}
		restarted := &publicServerManager{dir: m.dir}
		alias := s
		alias.ID = "another-id"
		if wait, err := restarted.reservePublicRecovery(alias, start.Add(time.Duration(i)*time.Minute+time.Second)); err != nil || wait < 59*time.Second {
			t.Fatalf("restart/alias bypassed rate limit: %v %v", wait, err)
		}
	}
	if wait, err := m.reservePublicRecovery(s, start.Add(6*time.Minute)); err != nil || wait != 24*time.Minute {
		t.Fatalf("burst was not capped: %v %v", wait, err)
	}
	if wait, err := m.reservePublicRecovery(s, start.Add(31*time.Minute)); err != nil || wait != 0 {
		t.Fatalf("budget did not recover: %v %v", wait, err)
	}
	m.blockPublicRecovery(s, "unable to authenticate")
	if _, err := m.reservePublicRecovery(s, start.Add(32*time.Minute)); err == nil {
		t.Fatal("authentication failures keep trying keys")
	}
	m.mu.Lock()
	err := m.clearRecoveryBlockLocked(s)
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if wait, err := m.reservePublicRecovery(s, start.Add(31*time.Minute+time.Second)); err != nil || wait < 59*time.Second {
		t.Fatal("manual unblock bypassed cooldown")
	}
	if !publicSSHSecurityError(fmt.Errorf("ssh: handshake failed: unable to authenticate")) || !publicSSHSecurityError(fmt.Errorf("SSH-ключ сервера изменился")) {
		t.Fatal("security circuit breaker missing")
	}
	if err := os.WriteFile(m.recoveryPath(s), []byte("broken JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.reservePublicRecovery(s, start.Add(time.Hour)); err == nil {
		t.Fatal("corrupt budget fails open")
	}
}

func TestPublicRecoveryProbeReadsBannerWithoutAuthentication(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	extra := make(chan int, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(3 * time.Second))
		g := make([]byte, 3)
		_, _ = io.ReadFull(c, g)
		_, _ = c.Write([]byte{5, 0})
		request := make([]byte, 10)
		_, _ = io.ReadFull(c, request)
		_, _ = c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 1})
		_, _ = io.WriteString(c, "SSH-2.0-test\r\n")
		buf := make([]byte, 100)
		n, _ := c.Read(buf)
		extra <- n
	}()
	s := publicServer{Address: "203.0.113.1", Port: 22}
	if err := publicSSHBanner(context.Background(), ln.Addr().String(), s); err != nil {
		t.Fatal(err)
	}
	select {
	case n := <-extra:
		if n != 0 {
			t.Fatal("probe sent SSH identity or authentication bytes")
		}
	case <-time.After(4 * time.Second):
		t.Fatal("probe left connection open")
	}
}

func TestPublicBannerBudgetIsSharedAfterLongRunningTunnel(t *testing.T) {
	m := &publicServerManager{dir: t.TempDir()}
	s := publicServer{ID: "one", Address: "203.0.113.1", Port: 22}
	now := time.Now().UTC()
	for i := 0; i < 6; i++ {
		if wait, err := m.reservePublicBanner(s, now.Add(time.Duration(i)*time.Minute)); err != nil || wait != 0 {
			t.Fatalf("banner %d: %v %v", i, wait, err)
		}
		alias := s
		alias.ID = "two"
		restarted := &publicServerManager{dir: m.dir}
		if wait, err := restarted.reservePublicBanner(alias, now.Add(time.Duration(i)*time.Minute+time.Second)); err != nil || wait < 59*time.Second {
			t.Fatal("parallel tunnel/worker restart bypassed banner budget")
		}
	}
	if wait, err := m.reservePublicBanner(s, now.Add(7*time.Minute)); err != nil || wait != 23*time.Minute {
		t.Fatalf("banner window: %v %v", wait, err)
	}
}

func TestPublicVPNCandidatesRequireFreshAvailability(t *testing.T) {
	now := time.Now().UTC()
	var nodes map[string]publicVPNNode
	data := fmt.Sprintf(`{"good":{"type":"VLESS","alive":true,"history":[{"time":%q,"delay":100}]},"stale":{"type":"VLESS","alive":true,"history":[{"time":%q,"delay":100}]},"dead":{"type":"VLESS","alive":false},"DIRECT":{"type":"Direct","alive":true},"group":{"type":"Selector","all":["good"]},"AUTO":{"type":"Selector","now":"good"}}`, now.Format(time.RFC3339Nano), now.Add(-time.Hour).Format(time.RFC3339Nano))
	if err := json.Unmarshal([]byte(data), &nodes); err != nil {
		t.Fatal(err)
	}
	out := publicVPNCandidates(nodes, []string{"dead", "stale", "DIRECT", "group", "good"}, now)
	if len(out) != 1 || out[0] != "good" {
		t.Fatalf("unsafe candidates: %v", out)
	}
}

func TestPublicVPNGroupSurvivesRoutingEditsWithoutConsumingReserveProviders(t *testing.T) {
	s := defaultRouting()
	base, err := buildRouting([]byte(routingFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	withVPN, _, err := publicVPNConfig(base, "cdn6")
	if err != nil {
		t.Fatal(err)
	}
	rebuilt, err := buildRouting(withVPN, s)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := publicVPNConfig(rebuilt, "cdn6"); err != nil {
		t.Fatalf("routing stripped group ownership: %v", err)
	}
	var before, after yaml.Node
	_ = yaml.Unmarshal(base, &before)
	_ = yaml.Unmarshal(rebuilt, &after)
	find := func(root *yaml.Node, name string) *yaml.Node {
		for _, g := range mihomoYAMLField(root, "proxy-groups").Content {
			if scalar(mapGet(g, "name")) == name {
				return g
			}
		}
		return nil
	}
	a, b := find(before.Content[0], "Резерв"), find(after.Content[0], "Резерв")
	if (a == nil) != (b == nil) {
		t.Fatal("dedicated group changed reserve provider ownership")
	}
	if a != nil {
		aa, _ := yaml.Marshal(a)
		bb, _ := yaml.Marshal(b)
		if string(aa) != string(bb) {
			t.Fatal("reserve group changed")
		}
	}
}

func TestPublicVPNSelectsAnotherNodeAndOpensSSHWithoutChangingOtherGroups(t *testing.T) {
	f := newPublicSSHFixture(t)
	s := f.config()
	s.AutoVPN = true
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var available atomic.Bool
	var selections atomic.Int32
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				c.SetDeadline(time.Now().Add(5 * time.Second))
				g := make([]byte, 3)
				if _, err := io.ReadFull(c, g); err != nil {
					return
				}
				_, _ = c.Write([]byte{5, 0})
				req := make([]byte, 10)
				if _, err := io.ReadFull(c, req); err != nil {
					return
				}
				if !available.Load() {
					_, _ = c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
					return
				}
				up, err := net.DialTimeout("tcp", f.listener.Addr().String(), time.Second)
				if err != nil {
					return
				}
				defer up.Close()
				_, _ = c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 1})
				c.SetDeadline(time.Time{})
				done := make(chan struct{})
				go func() { io.Copy(up, c); up.Close(); close(done) }()
				io.Copy(c, up)
				c.Close()
				<-done
			}()
		}
	}()
	m := &publicServerManager{dir: t.TempDir()}
	j := &publicServerJob{}
	m.vpnRPC = func(action string, input, output any) error {
		if action == "select" {
			request := input.(publicVPNRequest)
			if request.ID != s.ID || request.Node != "good-node" {
				t.Errorf("unrelated group/node selected: %+v", request)
			}
			selections.Add(1)
			available.Store(true)
		}
		selected := "bad-node"
		if available.Load() {
			selected = "good-node"
		}
		*output.(*publicVPNStatus) = publicVPNStatus{OK: true, Group: publicVPNGroup(s.ID), SOCKS: ln.Addr().String(), Selected: selected, Candidates: []string{"good-node"}}
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var pathError publicTransportError
	if err := m.serve(ctx, s, nil, j); !errors.As(err, &pathError) {
		t.Fatalf("dead route did not report transport failure: %v", err)
	}
	m.tryPublicVPN(ctx, s, j)
	if selections.Load() != 1 {
		t.Fatal("available alternative was not selected")
	}
	done := make(chan struct{})
	go func() { defer close(done); _ = m.serve(ctx, s, nil, j) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		m.mu.Lock()
		online := j.status.State == "online" && len(j.status.Metrics) > 0
		m.mu.Unlock()
		if online {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("SSH did not recover through the selected VPN")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("recovered SSH did not stop")
	}
}
