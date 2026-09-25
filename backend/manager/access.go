package main

import (
	"encoding/json"
	"fmt"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/access"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

func gateHeaders(r *http.Request, h http.Header) {
	host := r.Host
	name := host
	if v, _, e := net.SplitHostPort(host); e == nil {
		name = v
	}
	scheme := "https"
	if net.ParseIP(name) != nil || name == "localhost" {
		scheme = "http"
	}
	h.Set("X-Gate-Host", host)
	h.Set("X-Gate-Proto", scheme)
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	h.Set("X-Gate-IP", ip)
	h.Set("X-Gate-URI", r.URL.RequestURI())
	h.Set("Cookie", r.Header.Get("Cookie"))
	h.Set("Origin", r.Header.Get("Origin"))
}

var gateClient = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func gateRequest(r *http.Request, path string) (*http.Response, error) {
	q, _ := http.NewRequest("GET", "http://127.0.0.1:63415"+path, nil)
	gateHeaders(r, q.Header)
	return gateClient.Do(q)
}

// Protect every management API, including direct IP access. Only the curated
// portal and static assets are readable by guests; forwarded identity is ignored.
func (a *app) accessGuard(w http.ResponseWriter, r *http.Request) bool {
	if os.Getenv("HOMENET_ACCESS_ENABLED") != "1" {
		return false
	}
	if strings.HasPrefix(r.URL.Path, "/_gate/") {
		target, _ := url.Parse("http://127.0.0.1:63415")
		p := httputil.NewSingleHostReverseProxy(target)
		orig := p.Director
		p.Director = func(q *http.Request) { orig(q); gateHeaders(r, q.Header) }
		p.ServeHTTP(w, r)
		return true
	}
	if r.Method == "GET" && (r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/static/")) {
		return false
	}
	res, e := gateRequest(r, "/_gate/check")
	if e != nil {
		http.Error(w, "Authentication unavailable", 503)
		return true
	}
	defer res.Body.Close()
	if res.StatusCode != 204 {
		http.Error(w, "Authentication required", res.StatusCode)
		return true
	}
	login, role := res.Header.Get("X-Gate-Login"), res.Header.Get("X-Gate-Role")
	if r.URL.Path == "/api/portal" && r.Method == "GET" {
		a.portal(w, r, login, role)
		return true
	}
	if role != "admin" {
		http.Error(w, "HomeNet administrator required", 403)
		return true
	}
	if r.URL.Path == "/api/access/users" && r.Method == "GET" {
		res, e := gateRequest(r, "/_gate/users")
		if e != nil {
			http.Error(w, "Account unavailable", 503)
			return true
		}
		defer res.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(res.StatusCode)
		io.Copy(w, res.Body)
		return true
	}
	if r.URL.Path == "/api/access" {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == "GET" {
			c, e := access.Load()
			if e != nil {
				http.Error(w, e.Error(), 503)
			} else {
				a.writeJSON(w, 200, c)
			}
			return true
		}
		if r.Method != "POST" || r.Header.Get("X-HomeNet-UI") != "1" || r.Header.Get("Origin") == "" {
			http.Error(w, "Forbidden", 403)
			return true
		}
		origin, e := url.Parse(r.Header.Get("Origin"))
		if e != nil || origin.Host != r.Host {
			http.Error(w, "Forbidden", 403)
			return true
		}
		var c access.Config
		e = json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&c)
		if e == nil {
			e = validateAccess(c)
		}
		if e != nil {
			http.Error(w, e.Error(), 400)
			return true
		}
		a.operationMu.Lock()
		defer a.operationMu.Unlock()
		body, _ := json.MarshalIndent(c, "", "  ")
		path := access.Path()
		if e = os.WriteFile(path+".tmp", body, 0600); e == nil {
			e = os.Rename(path+".tmp", path)
		}
		if e != nil {
			http.Error(w, e.Error(), 500)
		} else {
			a.writeJSON(w, 200, response{"ok": true})
		}
		return true
	}
	return false
}
func validateAccess(c access.Config) error {
	if c.Apps == nil || len(c.Apps) > 512 {
		return fmt.Errorf("invalid application list")
	}
	for id, r := range c.Apps {
		if id == "" || (r.Mode != "admin" && r.Mode != "users" && r.Mode != "public") || len(r.Users) > 500 {
			return fmt.Errorf("invalid access rule")
		}
		for _, u := range r.Users {
			if u == "" || len(u) > 128 {
				return fmt.Errorf("invalid login")
			}
		}
		for _, raw := range []string{r.IPURL, r.DomainURL} {
			if raw != "" {
				u, e := url.Parse(raw)
				if e != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
					return fmt.Errorf("invalid link")
				}
			}
		}
	}
	return nil
}
func (a *app) portal(w http.ResponseWriter, r *http.Request, login, role string) {
	c, e := access.Load()
	if e != nil {
		http.Error(w, "Access policy unavailable", 503)
		return
	}
	doc, e := schema.LoadRoutes(a.routesPath())
	if e != nil {
		http.Error(w, "Routes unavailable", 503)
		return
	}
	cfg, e := a.loadLauncher()
	if e != nil {
		http.Error(w, "Launcher unavailable", 503)
		return
	}
	allowed := map[string]bool{}
	apps := []schema.App{}
	hosts := []schema.Host{}
	for _, app := range doc.Apps {
		if app.ID == "account" || access.Allowed(c.Apps[app.ID], login, role) {
			allowed[app.ID] = true
			apps = append(apps, app)
		}
	}
	for _, h := range doc.Hosts {
		if allowed[h.AppID] {
			hosts = append(hosts, h)
		}
	}
	if cfg != nil {
		links := []launcherLink{}
		for _, l := range cfg.Links {
			if access.Allowed(c.Apps["link:"+l.ID], login, role) {
				links = append(links, l)
			}
		}
		cfg.Links = links
		for id := range cfg.Apps {
			if !allowed[id] {
				delete(cfg.Apps, id)
			}
		}
	}
	links := map[string]access.Rule{}
	for id, rule := range c.Apps {
		if role == "admin" || allowed[id] {
			links[id] = access.Rule{IPURL: rule.IPURL, DomainURL: rule.DomainURL}
		}
	}
	a.writeJSON(w, 200, response{"login": login, "admin": role == "admin", "doc": response{"apps": apps, "hosts": hosts}, "launcher": cfg, "links": links})
}
