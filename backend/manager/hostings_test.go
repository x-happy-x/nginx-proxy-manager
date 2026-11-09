package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type hostingTransport func(*http.Request) (*http.Response, error)

func (f hostingTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func hostingReply(code int, body string) *http.Response {
	return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}
func TestHostingsInventoryNeverExposesCredentialsAndKeepsLastGood(t *testing.T) {
	secret := "private-provider-token-12345"
	fail := false
	calls := 0
	m := newHostingMonitor(t.TempDir(), hostingTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Method != "GET" || r.URL.Host != "api.ishosting.com" || r.Header.Get("X-Api-Token") != secret || !strings.HasPrefix(r.UserAgent(), "HomeNet-") {
			t.Fatalf("Unexpected provider request: %s %s", r.Method, r.URL)
		}
		if fail {
			return hostingReply(403, secret+" root-password-from-upstream"), nil
		}
		if r.URL.Path == "/vps/list" {
			if r.URL.Query().Get("limit") != "50" {
				t.Fatal("Missing page size")
			}
			return hostingReply(200, `[{"id":482492}]`), nil
		}
		return hostingReply(200, `{"id":482492,"name":"test","network":{"public_ip":"192.0.2.1"},"status":{"code":"running"},"access":{"ssh":{"users":[{"password":"root-password-from-upstream"}]}},"platform":{"config":{"ram":{"name":"1 Gb"}}}}`), nil
	}))
	m.accounts = []hostingAccount{{ID: "a", Name: "Main", Provider: "ishosting", Token: secret}}
	m.poll(context.Background())
	first := m.views["a"]
	if calls != 2 || len(first.Servers) != 1 || first.LastOK == 0 || first.Servers[0].RAM != "1 Gb" {
		t.Fatalf("Inventory failed: %+v", first)
	}
	fail = true
	m.poll(context.Background())
	if m.views["a"].Error == "" || len(m.views["a"].Servers) != 1 || m.views["a"].LastOK != first.LastOK {
		t.Fatal("Lost last known inventory on provider failure")
	}
	response, _ := json.Marshal(m.snapshot())
	cache, _ := os.ReadFile(filepath.Join(m.dir, "inventory.json"))
	for _, out := range []string{string(response), string(cache)} {
		for _, s := range []string{secret, "root-password-from-upstream", `"access"`, `"token"`} {
			if strings.Contains(out, s) {
				t.Fatalf("Credential leaked: %s", s)
			}
		}
	}
}
func TestHostingsCredentialLifecycleAndCorruptStore(t *testing.T) {
	old := hostings
	defer func() { hostings = old }()
	m := newHostingMonitor(t.TempDir(), nil)
	hostings = m
	a := &app{}
	request := func(path string, body any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		w := httptest.NewRecorder()
		a.handleHostings(w, httptest.NewRequest("POST", "/api/hostings/"+path, strings.NewReader(string(b))))
		return w
	}
	r := request("accounts", response{"name": "Main", "provider": "ishosting", "token": "initial-secret-token"})
	if r.Code != 200 || len(m.accounts) != 1 {
		t.Fatalf("Create: %s", r.Body)
	}
	id := m.accounts[0].ID
	r = request("accounts", response{"id": id, "name": "Renamed", "provider": "ishosting", "token": ""})
	if r.Code != 200 || m.accounts[0].Token != "initial-secret-token" {
		t.Fatal("Blank edit lost saved key")
	}
	m.views[id] = hostingSnapshot{Servers: []hostingServer{{ID: "1"}}, LastOK: 1}
	_ = m.save("inventory.json", m.views)
	r = request("accounts", response{"id": id, "name": "Renamed", "provider": "ishosting", "token": "replacement-secret-token"})
	reloaded := newHostingMonitor(m.dir, nil)
	if r.Code != 200 || len(reloaded.views[id].Servers) != 0 {
		t.Fatal("Changed key retained old account inventory")
	}
	if data, _ := os.ReadFile(filepath.Join(m.dir, "accounts.json")); !strings.Contains(string(data), "replacement-secret-token") {
		t.Fatal("Key did not persist")
	}
	if os.PathSeparator != '\\' {
		info, _ := os.Stat(filepath.Join(m.dir, "accounts.json"))
		if info.Mode().Perm() != 0600 {
			t.Fatal("Credential mode is not 0600")
		}
	}
	r = request("accounts/remove", response{"id": id})
	if r.Code != 200 || len(newHostingMonitor(m.dir, nil).accounts) != 0 {
		t.Fatal("Local disconnect failed")
	}
	_ = os.WriteFile(filepath.Join(m.dir, "accounts.json"), []byte("broken"), 0600)
	hostings = newHostingMonitor(m.dir, nil)
	r = request("accounts", response{"name": "Wrong", "provider": "ishosting", "token": "should-not-overwrite"})
	if r.Code == 200 {
		t.Fatal("Corrupt credential store overwritten")
	}
}
func TestHostingsRejectsProviderRedirectAndUnsafeID(t *testing.T) {
	calls := 0
	m := newHostingMonitor(t.TempDir(), hostingTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		res := hostingReply(302, "")
		res.Header.Set("Location", "https://other.example/steal")
		return res, nil
	}))
	if _, err := m.inventory(context.Background(), hostingAccount{Token: "private"}); err == nil || calls != 1 {
		t.Fatal("Provider redirect followed")
	}
	calls = 0
	m.client.Transport = hostingTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		return hostingReply(200, `[{"id":"../settings/ssh"}]`), nil
	})
	if _, err := m.inventory(context.Background(), hostingAccount{}); err == nil || calls != 1 {
		t.Fatal("Unsafe provider identifier used")
	}
}
