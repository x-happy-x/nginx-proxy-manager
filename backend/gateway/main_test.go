package main

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestMobileBasicScopeAndRole(t *testing.T) {
	status, role, calls := 200, "admin", 0
	a := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/api/gateway/basic" || r.Header.Get("X-Gateway-Token") != "test-secret" {
			t.Error("wrong endpoint or credential")
		}
		var b map[string]string
		json.NewDecoder(r.Body).Decode(&b)
		if b["login"] != "mobile" || b["password"] != "correct" || b["app"] != "lms_node" {
			t.Error("lost Basic credentials")
		}
		w.WriteHeader(status)
		if status == 200 {
			json.NewEncoder(w).Encode(map[string]string{"login": "mobile", "role": role})
		}
	}))
	defer a.Close()
	g := newGateway(configuration{Secret: "test-secret", AccountAPI: a.URL})
	check := func(scheme string) int {
		r := httptest.NewRequest("GET", "http://gateway/_gate/check", nil)
		r.Header.Set("X-Gate-URI", "/api/ui/jobs?active=true")
		r.SetBasicAuth("mobile", "correct")
		w := httptest.NewRecorder()
		g.check(w, r, "lms.test", scheme, hostPolicy{App: "lms_node", MinRole: "admin"})
		return w.Code
	}
	if check("http") != 401 || calls != 0 {
		t.Fatal("credentials sent over cleartext client route")
	}
	if check("https") != 204 {
		t.Fatal("valid mobile credentials rejected")
	}
	role = "viewer"
	if check("https") != 403 {
		t.Fatal("non-admin accepted")
	}
	for _, pair := range [][2]int{{401, 401}, {403, 403}, {429, 403}, {503, 503}} {
		status = pair[0]
		if check("https") != pair[1] {
			t.Fatalf("bad status mapping %d", status)
		}
	}
}

func TestRouterChallengeAndSessionVerification(t *testing.T) {
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth" {
			t.Fatal("unexpected router endpoint")
		}
		if r.Method == "GET" {
			if c, e := r.Cookie("router"); e == nil && c.Value == "authenticated" {
				w.WriteHeader(200)
				return
			}
			w.Header().Set("X-NDM-Realm", "router")
			w.Header().Set("X-NDM-Challenge", "challenge")
			http.SetCookie(w, &http.Cookie{Name: "router", Value: "challenge", Path: "/"})
			w.WriteHeader(401)
			return
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		md := md5.Sum([]byte("admin:router:correct"))
		answer := sha256.Sum256([]byte("challenge" + hex.EncodeToString(md[:])))
		c, e := r.Cookie("router")
		if e != nil || c.Value != "challenge" || body["login"] != "admin" || body["password"] != hex.EncodeToString(answer[:]) {
			w.WriteHeader(401)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "router", Value: "authenticated", Path: "/"})
		w.WriteHeader(200)
	}))
	defer router.Close()
	g := newGateway(configuration{RouterURL: router.URL})
	if !g.routerPassword("correct") {
		t.Fatal("valid router login rejected")
	}
	if g.routerPassword("wrong") {
		t.Fatal("invalid router login accepted")
	}
}

func fixture(t *testing.T, health, check *int) *gateway {
	t.Helper()
	a := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Gateway-Token") != "test-secret" {
			t.Error("missing service credential")
		}
		if strings.HasSuffix(r.URL.Path, "health") {
			w.WriteHeader(*health)
			return
		}
		w.WriteHeader(*check)
		if *check == 200 {
			json.NewEncoder(w).Encode(map[string]string{"login": "alice", "role": "viewer"})
		}
	}))
	t.Cleanup(a.Close)
	return newGateway(configuration{Secret: "test-secret", AccountAPI: a.URL, AccountURL: "https://account.test", EmergencyURL: "https://account.test/_gate/emergency", Hosts: map[string]hostPolicy{"app.test": {App: "test"}, "account.test": {}}})
}
func request(g *gateway, path, host, scheme string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", path, nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("X-Gate-Host", host)
	r.Header.Set("X-Gate-Proto", scheme)
	for _, c := range cookies {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	return w
}
func TestNormalAccessDenialNeverEnablesFallback(t *testing.T) {
	health, check := 200, 403
	g := fixture(t, &health, &check)
	c := &http.Cookie{Name: "kartoteka_session", Value: "existing-token"}
	if w := request(g, "/_gate/check", "app.test", "https", c); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := request(g, "/_gate/emergency", "account.test", "https"); w.Code != 409 {
		t.Fatal(w.Code)
	}
	check = 200
	if w := request(g, "/_gate/check", "app.test", "https", c); w.Code != 204 {
		t.Fatal(w.Code)
	}
	g.cfg.Hosts["app.test"] = hostPolicy{App: "test", MinRole: "admin"}
	if w := request(g, "/_gate/check", "app.test", "https", c); w.Code != 403 {
		t.Fatal("viewer reached administrator panel")
	}
}
func TestEmergencyIsScopedAndRevokedOnRecovery(t *testing.T) {
	health, check := 503, 200
	g := fixture(t, &health, &check)
	g.sessions["fallback"] = session{Host: "https://app.test", Emergency: true, Until: time.Now().Add(time.Minute)}
	c := &http.Cookie{Name: "__Host-homenet_gate", Value: "fallback"}
	if w := request(g, "/_gate/check", "app.test", "https", c); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := request(g, "/_gate/check", "app.test", "http", c); w.Code != 401 {
		t.Fatal("cross scheme session")
	}
	health = 200
	g.healthUntil = time.Time{}
	if w := request(g, "/_gate/check", "app.test", "https", c); w.Code != 401 {
		t.Fatal("fallback survived recovery")
	}
	health = 503
	g.healthUntil = time.Time{}
	if w := request(g, "/_gate/check", "app.test", "https", c); w.Code != 401 {
		t.Fatal("revoked fallback revived")
	}
}
func TestGatewayRejectsRemoteCallerAndUnknownHost(t *testing.T) {
	health, check := 200, 200
	g := fixture(t, &health, &check)
	if w := request(g, "/_gate/check", "evil.test", "https"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	r := httptest.NewRequest("GET", "/_gate/check", nil)
	r.RemoteAddr = "192.168.1.5:5000"
	r.Header.Set("X-Gate-Host", "app.test")
	r.Header.Set("X-Gate-Proto", "https")
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
func TestEmergencyFlowCSRFAndOneTimeCallback(t *testing.T) {
	health, check := 503, 200
	g := fixture(t, &health, &check)
	g.verifyRouter = func(password string) bool { return password == "correct" }
	start := request(g, "/_gate/login", "app.test", "http")
	u, _ := url.Parse(start.Header().Get("Location"))
	state := u.Query().Get("state")
	if state == "" || u.Scheme != "https" {
		t.Fatal("fallback must redirect to HTTPS")
	}
	originCookie := start.Result().Cookies()[0]
	form := request(g, "/_gate/emergency?state="+state, "account.test", "https")
	csrf := form.Result().Cookies()[0]
	send := func(origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/_gate/emergency", strings.NewReader(url.Values{"state": {state}, "password": {"correct"}}.Encode()))
		r.RemoteAddr = "127.0.0.1:5000"
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("X-Gate-Host", "account.test")
		r.Header.Set("X-Gate-Proto", "https")
		r.Header.Set("Origin", origin)
		r.AddCookie(csrf)
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		return w
	}
	if w := send("https://evil.test"); w.Code != 403 {
		t.Fatal("CSRF accepted")
	}
	w := send("https://account.test")
	if w.Code != 303 {
		t.Fatal(w.Code)
	}
	back, _ := url.Parse(w.Header().Get("Location"))
	cb := back.RequestURI()
	if w := request(g, cb, "app.test", "http"); w.Code != 403 {
		t.Fatal("callback without origin flow cookie")
	}
	result := request(g, cb, "app.test", "http", originCookie)
	if result.Code != 303 {
		t.Fatal(result.Code)
	}
	if w := request(g, cb, "app.test", "http", originCookie); w.Code != 403 {
		t.Fatal("callback replay")
	}
	if len(g.sessions) != 1 {
		t.Fatal("session not issued")
	}
}
func TestConfigurationErrorIsNotAnOutage(t *testing.T) {
	health, check := 403, 200
	g := fixture(t, &health, &check)
	if g.down() {
		t.Fatal("credential rejection enabled fallback")
	}
}
func TestRateLimitAndReturnValidation(t *testing.T) {
	health, check := 200, 200
	g := fixture(t, &health, &check)
	for i := 0; i < 5; i++ {
		if !g.attempt("client") {
			t.Fatal(i)
		}
	}
	if g.attempt("client") {
		t.Fatal("limit bypass")
	}
	for _, s := range []string{"//evil.test", "/\\evil.test", "https://evil.test", "/_gate/login"} {
		if safeReturn(s) != "/" {
			t.Fatal(s)
		}
	}
}
