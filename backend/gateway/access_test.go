package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestRouterOwnedAccessAndLiveRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.json")
	t.Setenv("HOMENET_ACCESS_PATH", path)
	if e := os.WriteFile(path, []byte(`{"apps":{"test":{"mode":"users","users":["alice"]}}}`), 0600); e != nil {
		t.Fatal(e)
	}
	login, role := "alice", "none"
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/gateway/health" {
			w.Write([]byte(`{"ok":true}`))
			return
		}
		w.Write([]byte(`{"login":"` + login + `","role":"` + role + `"}`))
	}))
	defer account.Close()
	g := newGateway(configuration{AccountAPI: account.URL})
	check := func(resource string, cookie bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://gateway/_gate/check", nil)
		if cookie {
			r.AddCookie(&http.Cookie{Name: "kartoteka_session", Value: "session"})
		}
		w := httptest.NewRecorder()
		g.check(w, r, "test.example", "https", hostPolicy{App: "homenet", Resource: resource})
		return w
	}
	if w := check("test", true); w.Code != 204 || w.Header().Get("X-Gate-Login") != "alice" {
		t.Fatal("selected user rejected")
	}
	login = "bob"
	if check("test", true).Code != 403 {
		t.Fatal("other user accepted")
	}
	role = "admin"
	if check("test", true).Code != 204 {
		t.Fatal("admin rejected")
	}
	if check("test", false).Code != 401 {
		t.Fatal("anonymous access accepted")
	}
	os.WriteFile(path, []byte(`{"apps":{"test":{"mode":"public"}}}`), 0600)
	if check("test", false).Code != 204 {
		t.Fatal("public denied")
	}
	os.WriteFile(path, []byte(`{"apps":{"test":{"mode":"admin"}}}`), 0600)
	if check("test", false).Code != 401 {
		t.Fatal("public access not revoked immediately")
	}
	if w := check("homenet", false); w.Code != 204 || w.Header().Get("X-Gate-Role") != "guest" {
		t.Fatal("guest portal unavailable")
	}
	os.WriteFile(path, []byte(`invalid`), 0600)
	if check("test", true).Code != 503 {
		t.Fatal("invalid policy must fail closed")
	}
}
