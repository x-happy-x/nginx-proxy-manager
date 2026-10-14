// Package core serves the HomeNet shell without initializing optional integrations.
package core

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/access"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

type Config struct {
	Listen         string            `json:"listen"`
	StateDir       string            `json:"state_dir"`
	StaticDir      string            `json:"static_dir"`
	PackagesDir    string            `json:"packages_dir"`
	AccountURL     string            `json:"account_url"`
	DMSURL         string            `json:"dms_url"`
	DMSTokenFile   string            `json:"dms_token_file"`
	WorkerEnv      string            `json:"worker_env"`
	WorkerAppDir   string            `json:"worker_app_dir"`
	AccessPath     string            `json:"access_path,omitempty"`
	LauncherPath   string            `json:"launcher_path,omitempty"`
	WorkerDefaults map[string]string `json:"worker_defaults,omitempty"`
	ManageWorkers  bool              `json:"manage_workers"`
}
type Server struct {
	operations sync.WaitGroup
	Config     Config
	Registry   *integration.Registry
	Client     *http.Client
	Lifecycle  *integration.Lifecycle
	homeOnce   sync.Once
	homeCache  *homeCache
}
type Identity struct {
	Login string `json:"login"`
	Admin bool   `json:"admin"`
}

func New(cfg Config, arch string) (*Server, error) {
	if cfg.WorkerAppDir == "" {
		cfg.WorkerAppDir = "/opt/etc/homenet/nginx"
	}
	for _, raw := range []string{cfg.AccountURL, cfg.DMSURL} {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
			return nil, fmt.Errorf("invalid local service URL")
		}
		ip := net.ParseIP(u.Hostname())
		if ip == nil || !ip.IsLoopback() || u.Port() == "" {
			return nil, fmt.Errorf("service URL must use explicit loopback and port")
		}
	}
	r, err := integration.Open(filepath.Join(cfg.StateDir, "registry.json"), arch)
	if err != nil {
		return nil, err
	}
	s := &Server{Config: cfg, Registry: r, Client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	host, port, _ := net.SplitHostPort(cfg.Listen)
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if host == "::" {
		host = "::1"
	}
	s.Lifecycle = &integration.Lifecycle{Registry: r, PackagesDir: cfg.PackagesDir, StateDir: cfg.StateDir, Arch: arch, Runtime: &integration.Processes{StateDir: cfg.StateDir, PackagesDir: cfg.PackagesDir, ConfigEnv: cfg.WorkerEnv, AppDir: cfg.WorkerAppDir, CoreURL: "http://" + net.JoinHostPort(host, port), Defaults: cfg.WorkerDefaults}}
	return s, nil
}
func jsonReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeAllowed(r *http.Request) bool {
	if r.Method == "GET" || r.Method == "HEAD" {
		return true
	}
	u, err := url.Parse(r.Header.Get("Origin"))
	return err == nil && u.Host == r.Host && (u.Scheme == "http" || u.Scheme == "https") && r.Header.Get("Sec-Fetch-Site") != "cross-site" && r.Header.Get("X-HomeNet-UI") == "1"
}
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
	h.Set("X-Gate-URI", r.URL.RequestURI())
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	h.Set("X-Gate-IP", ip)
	h.Set("Cookie", r.Header.Get("Cookie"))
	h.Set("Origin", r.Header.Get("Origin"))
}
func (s *Server) identity(r *http.Request) (Identity, int) {
	req, err := http.NewRequestWithContext(r.Context(), "GET", s.Config.AccountURL+"/_gate/check", nil)
	if err != nil {
		return Identity{}, 503
	}
	gateHeaders(r, req.Header)
	res, err := s.Client.Do(req)
	if err != nil {
		return Identity{}, 503
	}
	defer res.Body.Close()
	if res.StatusCode != 204 {
		if res.StatusCode == 401 || res.StatusCode == 403 {
			return Identity{}, res.StatusCode
		}
		return Identity{}, 503
	}
	return Identity{res.Header.Get("X-Gate-Login"), res.Header.Get("X-Gate-Role") == "admin"}, 200
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/health" && r.Method == "GET" {
		jsonReply(w, 200, map[string]any{"status": "ok", "component": "homenet-core", "protocol": 1})
		return
	}
	if r.URL.Path == "/health/ready" && r.Method == "GET" {
		if s.Lifecycle.Ready() != nil {
			jsonReply(w, 503, map[string]string{"status": "not_ready"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		for _, item := range s.Registry.Snapshot() {
			if item.Enabled {
				if err := s.Lifecycle.Runtime.Check(ctx, item.Manifest); err != nil {
					jsonReply(w, 503, map[string]string{"status": "not_ready"})
					return
				}
			}
		}
		jsonReply(w, 200, map[string]string{"status": "ready"})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/internal/") {
		s.internal(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/_gate/") {
		target, _ := url.Parse(s.Config.AccountURL)
		proxy := httputil.NewSingleHostReverseProxy(target)
		original := proxy.Director
		proxy.Director = func(q *http.Request) { original(q); gateHeaders(r, q.Header) }
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
			http.Error(w, "Authentication unavailable", 503)
		}
		proxy.ServeHTTP(w, r)
		return
	}
	if r.Method == "GET" && (r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/static/")) {
		if r.URL.Path == "/" {
			http.ServeFile(w, r, filepath.Join(s.Config.StaticDir, "core.html"))
			return
		}
		http.StripPrefix("/static/", http.FileServer(http.Dir(s.Config.StaticDir))).ServeHTTP(w, r)
		return
	}
	id, status := s.identity(r)
	if status != 200 {
		http.Error(w, http.StatusText(status), status)
		return
	}
	if r.URL.Path == "/api/portal" && r.Method == "GET" {
		s.portal(w, r, id)
		return
	}
	if !id.Admin {
		http.Error(w, "HomeNet administrator required", 403)
		return
	}
	if !writeAllowed(r) {
		http.Error(w, "same-origin UI request required", 403)
		return
	}
	if s.portalAdmin(w, r) {
		return
	}
	if r.URL.Path == "/api/platform" && r.Method == "GET" {
		jsonReply(w, 200, map[string]any{"identity": id, "protocol": 1, "integrations": s.connections(r.Context())})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/integrations/") {

		integration.Gateway{Registry: s.Registry, Token: s.workerToken}.ServeHTTP(w, r)
		return
	}
	if r.URL.Path == "/api/platform/home" || strings.HasPrefix(r.URL.Path, "/api/platform/home/") {
		s.home(w, r, id)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/platform/") {
		s.lifecycle(w, r)
		return
	}
	if owner := legacyOwner(r.URL.Path); owner != "" {
		copy := r.Clone(r.Context())
		copy.URL.Path = "/api/integrations/" + owner + r.URL.Path
		copy.URL.RawPath = ""
		integration.Gateway{Registry: s.Registry, Token: s.workerToken}.ServeHTTP(w, copy)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/integrations/") && r.Method == "GET" {
		s.asset(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/dms/") {
		s.dms(w, r)
		return
	}
	http.NotFound(w, r)
}
func (s *Server) workerToken(id string) (string, error) {
	if !integration.ValidID(id) {
		return "", fmt.Errorf("invalid integration")
	}
	b, err := os.ReadFile(filepath.Join(s.Config.StateDir, "credentials", id+".token"))
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(b))
	if len(token) < 32 {
		return "", fmt.Errorf("invalid credential")
	}
	return token, nil
}
func (s *Server) asset(w http.ResponseWriter, r *http.Request) {
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/integrations/"), "/", 3)
	if len(parts) != 3 {
		http.NotFound(w, r)
		return
	}
	for _, item := range s.Registry.Snapshot() {
		m := item.Manifest
		if m.ID == parts[0] && m.Version == parts[1] && item.Enabled {
			root := filepath.Join(s.Config.PackagesDir, m.ID, m.Version, "ui")
			// FileServer cleans traversal and refuses requests outside its configured root.
			http.StripPrefix("/integrations/"+m.ID+"/"+m.Version+"/", http.FileServer(http.Dir(root))).ServeHTTP(w, r)
			return
		}
	}
	http.NotFound(w, r)
}
func (s *Server) dms(w http.ResponseWriter, r *http.Request) {
	suffix := strings.TrimPrefix(r.URL.Path, "/api/dms/")
	jobID := strings.TrimPrefix(suffix, "jobs/")
	validJob := jobID != "" && jobID != "." && jobID != ".." && !strings.ContainsAny(jobID, `/\:%`) && len(jobID) <= 128
	allowed := r.Method == "GET" && (suffix == "health" || suffix == "apps" || suffix == "jobs" || strings.HasPrefix(suffix, "jobs/") && validJob) || r.Method == "POST" && (suffix == "packages" || suffix == "install" || suffix == "rollback")
	if !allowed {
		http.NotFound(w, r)
		return
	}
	b, err := os.ReadFile(s.Config.DMSTokenFile)
	if err != nil || len(strings.TrimSpace(string(b))) < 32 {
		http.Error(w, "DMS credentials unavailable", 503)
		return
	}
	limit := int64(8192)
	if suffix == "packages" {
		limit = 128 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	u := s.Config.DMSURL + "/v1/" + suffix
	if suffix == "packages" && r.URL.Query().Get("dry_run") == "true" {
		u += "?dry_run=true"
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, u, r.Body)
	if err != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(b)))
	req.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	req.Header.Set("Idempotency-Key", r.Header.Get("Idempotency-Key"))
	res, err := s.Client.Do(req)
	if err != nil {
		http.Error(w, "DMS unavailable", 503)
		return
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 && res.StatusCode < 400 {
		http.Error(w, "DMS redirect rejected", 502)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(res.Body, 4<<20))
}

// Portal data is an independent catalog. Proxy contributes entries during migration
// and publication, but neither reading this file nor applying ACL needs routes.yml.
type CatalogEntry struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	Source string `json:"source"`
}

func (s *Server) portal(w http.ResponseWriter, r *http.Request, id Identity) {
	policy, err := access.LoadFile(s.accessPath())
	if err != nil {
		http.Error(w, "Access policy unavailable", 503)
		return
	}
	entries := []CatalogEntry{}
	b, err := os.ReadFile(filepath.Join(s.Config.StateDir, "catalog.json"))
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, "Catalog unavailable", 503)
		return
	}
	if err == nil {
		if json.Unmarshal(b, &entries) != nil {
			http.Error(w, "Catalog invalid", 503)
			return
		}
	}
	visible := []CatalogEntry{}
	role := "user"
	if id.Admin {
		role = "admin"
	}
	for _, entry := range entries {
		if access.Allowed(policy.Apps[entry.ID], id.Login, role) {
			visible = append(visible, entry)
		}
	}
	doc, launcher, links, err := s.portalDocument(id, policy)
	if err != nil {
		http.Error(w, "Portal unavailable", 503)
		return
	}
	jsonReply(w, 200, map[string]any{"identity": id, "items": visible, "login": id.Login, "admin": id.Admin, "doc": doc, "launcher": launcher, "links": links})
}
