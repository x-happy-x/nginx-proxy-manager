package core

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/access"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/launcher"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

// PortalDocument is a published snapshot, independent of the Proxy working file.
// It contains only public application addresses, never certificates or secrets.
type PortalDocument struct {
	Apps  []schema.App  `json:"apps"`
	Hosts []schema.Host `json:"hosts"`
}

func (s *Server) accessPath() string {
	if s.Config.AccessPath != "" {
		return s.Config.AccessPath
	}
	return access.Path()
}
func (s *Server) launcher() launcher.Store {
	if s.Config.LauncherPath != "" {
		return launcher.Store{Path: s.Config.LauncherPath}
	}
	return launcher.Store{Path: filepath.Join(s.Config.StateDir, "launcher.json")}
}
func (s *Server) portalDocument(id Identity, policy access.Config) (PortalDocument, *launcher.Config, map[string]access.Rule, error) {
	doc := PortalDocument{Apps: []schema.App{}, Hosts: []schema.Host{}}
	b, err := os.ReadFile(filepath.Join(s.Config.StateDir, "portal.json"))
	if err != nil && !os.IsNotExist(err) {
		return doc, nil, nil, err
	}
	if err == nil {
		if err = json.Unmarshal(b, &doc); err != nil {
			return doc, nil, nil, err
		}
	}
	known := map[string]bool{}
	for _, app := range doc.Apps {
		known[app.ID] = true
	}
	for _, app := range s.dmsCatalog() {
		if !known[app.ID] {
			doc.Apps = append(doc.Apps, app)
			known[app.ID] = true
		}
	}
	cfg, err := s.launcher().Load()
	if err != nil {
		return doc, nil, nil, err
	}
	// An empty config avoids displaying private, hard-coded legacy defaults on a clean install.
	if cfg == nil {
		cfg = &launcher.Config{Devices: []launcher.Device{}, Links: []launcher.Link{}, Apps: map[string]launcher.AppOverride{}}
	}
	role := "user"
	if id.Admin {
		role = "admin"
	}
	allowed := map[string]bool{}
	apps := []schema.App{}
	hosts := []schema.Host{}
	for _, a := range doc.Apps {
		if a.ID == "account" || access.Allowed(policy.Apps[a.ID], id.Login, role) {
			allowed[a.ID] = true
			apps = append(apps, a)
		}
	}
	for _, h := range doc.Hosts {
		if allowed[h.AppID] {
			hosts = append(hosts, h)
		}
	}
	doc.Apps = apps
	doc.Hosts = hosts
	links := []launcher.Link{}
	for _, l := range cfg.Links {
		key := "link:" + l.ID
		if access.Allowed(policy.Apps[key], id.Login, role) {
			allowed[key] = true
			if !id.Admin {
				l.Repo, l.Upstream = "", "" // NPM-84: internal details stay with administrators
			}
			links = append(links, l)
		}
	}
	cfg.Links = links
	for key, app := range cfg.Apps {
		if !allowed[key] {
			delete(cfg.Apps, key)
		} else if !id.Admin && app.Repo != "" {
			app.Repo = ""
			cfg.Apps[key] = app
		}
	}
	if !id.Admin {
		cfg.Dismissed = nil
	}
	rules := map[string]access.Rule{}
	for key, rule := range policy.Apps {
		if id.Admin || allowed[key] {
			rules[key] = access.Rule{IPURL: rule.IPURL, DomainURL: rule.DomainURL}
		}
	}
	return doc, cfg, rules, nil
}
func (s *Server) portalAdmin(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/access/users":
		if r.Method != "GET" {
			http.Error(w, "Method not allowed", 405)
			return true
		}
		q, _ := http.NewRequestWithContext(r.Context(), "GET", s.Config.AccountURL+"/_gate/users", nil)
		gateHeaders(r, q.Header)
		res, err := s.Client.Do(q)
		if err != nil {
			http.Error(w, "Account unavailable", 503)
			return true
		}
		defer res.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(res.StatusCode)
		_, _ = io.Copy(w, io.LimitReader(res.Body, 1<<20))
		return true
	case "/api/access":
		if r.Method == "GET" {
			c, err := access.LoadFile(s.accessPath())
			if err != nil {
				http.Error(w, "Access policy unavailable", 503)
			} else {
				jsonReply(w, 200, c)
			}
			return true
		}
		if r.Method != "POST" {
			http.Error(w, "Method not allowed", 405)
			return true
		}
		var c access.Config
		err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&c)
		if err == nil {
			err = access.Validate(c)
		}
		if err != nil {
			http.Error(w, err.Error(), 400)
			return true
		}
		if err = integration.AtomicJSON(s.accessPath(), c); err != nil {
			http.Error(w, "Cannot save policy", 500)
		} else {
			jsonReply(w, 200, map[string]bool{"ok": true})
		}
		return true
	case "/api/launcher":
		if r.Method == "GET" {
			s.launcher().Get(w)
		} else if r.Method == "POST" {
			s.launcher().Post(w, r)
		} else {
			http.Error(w, "Method not allowed", 405)
		}
		return true
	case "/api/launcher/status":
		if r.Method == "GET" {
			s.launcher().Status(w, r)
		} else {
			http.Error(w, "Method not allowed", 405)
		}
		return true
	}
	return false
}
