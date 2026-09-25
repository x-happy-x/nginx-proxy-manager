// HomeNet access gateway. Only nginx on loopback may call this listener.
package main

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type hostPolicy struct {
	App     string `json:"app"`
	MinRole string `json:"min_role"`
}
type configuration struct {
	Secret       string                `json:"secret"`
	AccountAPI   string                `json:"account_api"`
	AccountURL   string                `json:"account_url"`
	EmergencyURL string                `json:"emergency_url"`
	RouterURL    string                `json:"router_url"`
	Hosts        map[string]hostPolicy `json:"hosts"`
}
type session struct {
	Host, Token string
	Emergency   bool
	Until       time.Time
}
type flow struct {
	Host, Scheme, Return, Code string
	Emergency                  bool
	Until                      time.Time
}
type limit struct {
	Count int
	Until time.Time
}
type gateway struct {
	cfg          configuration
	client       *http.Client
	mu           sync.Mutex
	sessions     map[string]session
	flows        map[string]flow
	limits       map[string]limit
	healthUntil  time.Time
	healthDown   bool
	verifyRouter func(string) bool
}

func newGateway(c configuration) *gateway {
	g := &gateway{cfg: c, client: &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, sessions: map[string]session{}, flows: map[string]flow{}, limits: map[string]limit{}}
	g.verifyRouter = g.routerPassword
	return g
}
func main() {
	path := flag.String("config", "/opt/etc/homenet/gateway.json", "configuration")
	flag.Parse()
	b, e := os.ReadFile(*path)
	if e != nil {
		log.Fatal(e)
	}
	var c configuration
	if json.Unmarshal(b, &c) != nil || len(c.Secret) < 32 || len(c.Hosts) == 0 {
		log.Fatal("invalid gateway config")
	}
	for _, raw := range []string{c.AccountAPI, c.AccountURL, c.EmergencyURL, c.RouterURL} {
		u, e := url.Parse(raw)
		if e != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
			log.Fatal("invalid configured URL")
		}
	}
	if !strings.HasPrefix(c.EmergencyURL, "https://") {
		log.Fatal("emergency login requires HTTPS")
	}
	s := &http.Server{Addr: "127.0.0.1:63415", Handler: newGateway(c), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
	log.Fatal(s.ListenAndServe())
}
func random() string {
	var b [32]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}
func cookieName(base, scheme string) string {
	if scheme == "https" {
		return "__Host-" + base
	}
	return base
}
func setCookie(w http.ResponseWriter, name, value, scheme string, age int) {
	http.SetCookie(w, &http.Cookie{Name: cookieName(name, scheme), Value: value, Path: "/", Secure: scheme == "https", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: age})
}
func readCookie(r *http.Request, name, scheme string) string {
	c, e := r.Cookie(cookieName(name, scheme))
	if e != nil {
		return ""
	}
	return c.Value
}
func safeReturn(s string) string {
	if !strings.HasPrefix(s, "/") || strings.HasPrefix(s, "//") || strings.ContainsAny(s, "\\\r\n") || strings.HasPrefix(s, "/_gate/") {
		return "/"
	}
	return s
}
func (g *gateway) account(path string, body any, out any) int {
	b, _ := json.Marshal(body)
	req, e := http.NewRequest("POST", g.cfg.AccountAPI+"/api/gateway/"+path, bytes.NewReader(b))
	if e != nil {
		return 502
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gateway-Token", g.cfg.Secret)
	resp, e := g.client.Do(req)
	if e != nil {
		return 502
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 && out != nil {
		if json.NewDecoder(io.LimitReader(resp.Body, 16384)).Decode(out) != nil {
			return 502
		}
	}
	return resp.StatusCode
}
func (g *gateway) down() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if time.Now().Before(g.healthUntil) {
		return g.healthDown
	}
	status := g.account("health", nil, nil)
	// A bad gateway credential is a configuration error, never an outage bypass.
	g.healthDown = status == 502 || status == 503 || status == 504
	g.healthUntil = time.Now().Add(3 * time.Second)
	if !g.healthDown {
		for key, s := range g.sessions {
			if s.Emergency {
				delete(g.sessions, key)
			}
		}
	}
	return g.healthDown
}
func (g *gateway) clean() {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	for k, s := range g.sessions {
		if now.After(s.Until) {
			delete(g.sessions, k)
		}
	}
	for k, s := range g.flows {
		if now.After(s.Until) {
			delete(g.flows, k)
		}
	}
	for k, s := range g.limits {
		if now.After(s.Until) {
			delete(g.limits, k)
		}
	}
}
func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if p := net.ParseIP(ip); p == nil || !p.IsLoopback() {
		http.Error(w, "Forbidden", 403)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	host := r.Header.Get("X-Gate-Host")
	scheme := r.Header.Get("X-Gate-Proto")
	policy, ok := g.cfg.Hosts[host]
	if !ok || (scheme != "http" && scheme != "https") {
		http.Error(w, "Unknown gateway host", 403)
		return
	}
	g.clean()
	switch r.URL.Path {
	case "/_gate/check":
		g.check(w, r, host, scheme, policy)
	case "/_gate/login":
		g.login(w, r, host, scheme, policy)
	case "/_gate/callback":
		g.callback(w, r, host, scheme)
	case "/_gate/emergency":
		g.emergency(w, r, host, scheme)
	case "/_gate/logout":
		if r.Method != "POST" || r.Header.Get("Origin") != scheme+"://"+host {
			http.Error(w, "Forbidden", 403)
			return
		}
		key := readCookie(r, "homenet_gate", scheme)
		g.mu.Lock()
		delete(g.sessions, key)
		g.mu.Unlock()
		setCookie(w, "homenet_gate", "", scheme, -1)
		http.Redirect(w, r, "/", 303)
	default:
		http.NotFound(w, r)
	}
}
func (g *gateway) check(w http.ResponseWriter, r *http.Request, host, scheme string, p hostPolicy) {
	if p.App == "" {
		http.Error(w, "No protected application", 403)
		return
	}
	uri, _ := url.ParseRequestURI(r.Header.Get("X-Gate-URI"))
	if p.App == "lms_node" && uri != nil && strings.HasPrefix(uri.Path, "/api/ui/") && r.Header.Get("Authorization") != "" {
		login, password, valid := r.BasicAuth()
		if scheme != "https" || !valid || login == "" || password == "" || len(login) > 128 || len(password) > 1024 {
			http.Error(w, "HTTPS and Account credentials required", 401)
			return
		}
		var identity struct{ Login, Role string }
		code := g.account("basic", map[string]string{"login": login, "password": password, "app": p.App, "ip": r.Header.Get("X-Gate-IP")}, &identity)
		if code == 200 && (p.MinRole != "admin" || identity.Role == "admin") {
			w.WriteHeader(204)
		} else if code == 401 {
			http.Error(w, "Invalid Account credentials", 401)
		} else if code == 200 || code == 403 || code == 429 {
			http.Error(w, "Access denied", 403)
		} else {
			http.Error(w, "Account unavailable", 503)
		}
		return
	}
	outage := g.down()
	key := readCookie(r, "homenet_gate", scheme)
	g.mu.Lock()
	s, ok := g.sessions[key]
	g.mu.Unlock()
	if ok && s.Host == scheme+"://"+host && time.Now().Before(s.Until) {
		if s.Emergency {
			if outage {
				w.WriteHeader(204)
				return
			}
			http.Error(w, "Account recovered; sign in again", 401)
			return
		}
	} else {
		s = session{}
	}
	if outage {
		http.Error(w, "Account unavailable; emergency sign-in required", 401)
		return
	}
	token := s.Token
	if token == "" {
		token = readCookie(r, "kartoteka_session", "")
	}
	if token == "" {
		http.Error(w, "Sign in", 401)
		return
	}
	var identity struct{ Login, Role string }
	code := g.account("check", map[string]string{"token": token, "app": p.App}, &identity)
	if code != 200 {
		if code == 401 || code == 403 {
			http.Error(w, "Access denied", code)
		} else {
			http.Error(w, "Account verification unavailable", 503)
		}
		return
	}
	if p.MinRole == "admin" && identity.Role != "admin" {
		http.Error(w, "Administrator access required", 403)
		return
	}
	w.WriteHeader(204)
}
func (g *gateway) login(w http.ResponseWriter, r *http.Request, host, scheme string, p hostPolicy) {
	if r.Method != "GET" {
		http.Error(w, "Sign in using the browser", 401)
		return
	}
	if p.App == "" {
		http.Error(w, "No application", 400)
		return
	}
	state := random()
	f := flow{Host: host, Scheme: scheme, Return: safeReturn(r.Header.Get("X-Gate-URI")), Until: time.Now().Add(5 * time.Minute)}
	g.mu.Lock()
	if len(g.flows) >= 2000 {
		g.mu.Unlock()
		http.Error(w, "Busy", 429)
		return
	}
	g.flows[state] = f
	g.mu.Unlock()
	setCookie(w, "homenet_flow", state, scheme, 300)
	callback := scheme + "://" + host + "/_gate/callback"
	dest := g.cfg.AccountURL + "/gateway/authorize?" + url.Values{"redirect_uri": {callback}, "state": {state}}.Encode()
	if g.down() {
		dest = g.cfg.EmergencyURL + "?state=" + state
	}
	http.Redirect(w, r, dest, 302)
}
func (g *gateway) callback(w http.ResponseWriter, r *http.Request, host, scheme string) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", 405)
		return
	}
	state := r.URL.Query().Get("state")
	if state == "" || readCookie(r, "homenet_flow", scheme) != state {
		http.Error(w, "Invalid login state", 403)
		return
	}
	g.mu.Lock()
	f, ok := g.flows[state]
	if ok && f.Host == host && f.Scheme == scheme {
		delete(g.flows, state)
	}
	g.mu.Unlock()
	if !ok || f.Host != host || f.Scheme != scheme || time.Now().After(f.Until) {
		http.Error(w, "Expired login", 403)
		return
	}
	s := session{Host: scheme + "://" + host, Until: time.Now().Add(12 * time.Hour)}
	if f.Emergency {
		if f.Code == "" || f.Code != r.URL.Query().Get("code") || !g.down() {
			http.Error(w, "Emergency login expired", 403)
			return
		}
		s.Emergency = true
		s.Until = time.Now().Add(15 * time.Minute)
	} else {
		var result struct{ Token string }
		status := g.account("exchange", map[string]string{"code": r.URL.Query().Get("code"), "callback": scheme + "://" + host + "/_gate/callback"}, &result)
		if status != 200 || result.Token == "" {
			http.Error(w, "Account login failed", 403)
			return
		}
		s.Token = result.Token
	}
	key := random()
	g.mu.Lock()
	if len(g.sessions) >= 5000 {
		g.mu.Unlock()
		http.Error(w, "Busy", 429)
		return
	}
	g.sessions[key] = s
	g.mu.Unlock()
	setCookie(w, "homenet_gate", key, scheme, int(time.Until(s.Until).Seconds()))
	setCookie(w, "homenet_flow", "", scheme, -1)
	log.Printf("gateway login host=%s emergency=%t", host, s.Emergency)
	http.Redirect(w, r, f.Return, 303)
}

var page = template.Must(template.New("emergency").Parse(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Аварийный вход · HomeNet</title><style>body{font:16px system-ui;background:#101826;color:#eef4ff;max-width:460px;margin:9vh auto;padding:24px}form{display:grid;gap:16px}input,button{font:inherit;padding:14px;border-radius:10px;border:1px solid #526176}button{background:#9ed8ff;color:#102033;cursor:pointer}p{line-height:1.6;color:#bed0e2}small{color:#aac0d5}</style><h1>Аварийный вход</h1><p>Account недоступен. Для доступа к <b>{{.Host}}</b> введите пароль администратора роутера.</p><form method="post"><input type="hidden" name="state" value="{{.State}}"><label>Пользователь: admin</label><input type="password" name="password" maxlength="256" autocomplete="current-password" placeholder="Пароль роутера" required><button>Войти на 15 минут</button></form><p>Пароль проверяет роутер. После восстановления Account потребуется обычный вход. Внутренние логины приложений сохраняются.</p><small>{{.Message}}</small></html>`))

func (g *gateway) attempt(ip string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	for _, k := range []string{ip, "global"} {
		l := g.limits[k]
		if now.After(l.Until) {
			l = limit{Until: now.Add(5 * time.Minute)}
		}
		max := 5
		if k == "global" {
			max = 30
		}
		if l.Count >= max {
			return false
		}
	}
	for _, k := range []string{ip, "global"} {
		l := g.limits[k]
		if now.After(l.Until) {
			l = limit{Until: now.Add(5 * time.Minute)}
		}
		l.Count++
		g.limits[k] = l
	}
	return true
}
func (g *gateway) emergency(w http.ResponseWriter, r *http.Request, host, scheme string) {
	if scheme+"://"+host+"/_gate/emergency" != g.cfg.EmergencyURL {
		http.Error(w, "Use the secure emergency address", 403)
		return
	}
	if !g.down() {
		http.Error(w, "Account доступен. Вернитесь в сервис и войдите через Account.", 409)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if e := r.ParseForm(); e != nil {
		http.Error(w, "Invalid form", 400)
		return
	}
	state := r.Form.Get("state")
	g.mu.Lock()
	f, ok := g.flows[state]
	g.mu.Unlock()
	if !ok || time.Now().After(f.Until) {
		http.Error(w, "Начните вход со страницы сервиса", 403)
		return
	}
	if r.Method == "GET" {
		setCookie(w, "homenet_emergency", state, scheme, 300)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_ = page.Execute(w, map[string]string{"State": state, "Host": f.Host})
		return
	}
	if r.Method != "POST" || readCookie(r, "homenet_emergency", scheme) != state || r.Header.Get("Origin") != scheme+"://"+host {
		http.Error(w, "Forbidden", 403)
		return
	}
	if !g.attempt(r.Header.Get("X-Gate-IP")) {
		w.Header().Set("Retry-After", "300")
		http.Error(w, "Слишком много попыток. Подождите 5 минут.", 429)
		return
	}
	password := r.Form.Get("password")
	if password == "" || len(password) > 256 || !g.verifyRouter(password) {
		log.Print("gateway emergency authentication rejected")
		http.Error(w, "Неверный пароль администратора роутера", 401)
		return
	}
	f.Emergency = true
	f.Code = random()
	g.mu.Lock()
	g.flows[state] = f
	g.mu.Unlock()
	http.Redirect(w, r, f.Scheme+"://"+f.Host+"/_gate/callback?"+url.Values{"state": {state}, "code": {f.Code}}.Encode(), 303)
}
func (g *gateway) routerPassword(password string) bool {
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar, Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}
	resp, e := c.Get(g.cfg.RouterURL + "/auth")
	if e != nil {
		return false
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 8192))
	resp.Body.Close()
	realm, challenge := resp.Header.Get("X-NDM-Realm"), resp.Header.Get("X-NDM-Challenge")
	if resp.StatusCode != 401 || realm == "" || challenge == "" {
		return false
	}
	digest := md5.Sum([]byte("admin:" + realm + ":" + password))
	answer := sha256.Sum256([]byte(challenge + hex.EncodeToString(digest[:])))
	b, _ := json.Marshal(map[string]string{"login": "admin", "password": hex.EncodeToString(answer[:])})
	resp, e = c.Post(g.cfg.RouterURL+"/auth", "application/json", bytes.NewReader(b))
	if e != nil {
		return false
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 8192))
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return false
	}
	// Verify the established session, not only the POST response.
	resp, e = c.Get(g.cfg.RouterURL + "/auth")
	if e != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}
