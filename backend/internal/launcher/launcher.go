package launcher

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Launcher settings live next to the routes file, apart from routes.yml: they
// only describe the start page and never go through drafts or apply.
type Device struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Note      string   `json:"note,omitempty"`
	Addresses []string `json:"addresses"`
}

type Link struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	URL         string `json:"url"`
	Device      string `json:"device"`
	Description string `json:"description,omitempty"`
	Art         string `json:"art,omitempty"`
	Repo        string `json:"repo,omitempty"` // source repository, e.g. in Forgejo
	// Upstream is host:port behind a public URL, so the link is probed and placed like a routed app (NPM-84).
	Upstream string `json:"upstream,omitempty"`
}

type AppOverride struct {
	Title       string `json:"title,omitempty"`
	Device      string `json:"device,omitempty"`
	Description string `json:"description,omitempty"`
	Art         string `json:"art,omitempty"`
	Hidden      bool   `json:"hidden,omitempty"`
	Repo        string `json:"repo,omitempty"`
}

type Config struct {
	Devices []Device               `json:"devices"`
	Links   []Link                 `json:"links"`
	Apps    map[string]AppOverride `json:"apps"`
	Order   []string               `json:"order,omitempty"`
	// Dismissed lists ip:port of found containers the administrator chose not to add (NPM-84).
	Dismissed []string `json:"dismissed,omitempty"`
}

var launcherFileMu sync.Mutex

type Store struct{ Path string }

func (a Store) launcherPath() string { return a.Path }
func (a Store) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

type response = map[string]any

// Load returns nil when nothing was saved yet; the UI then offers
// its default device groups.
func (a Store) Load() (*Config, error) {
	launcherFileMu.Lock()
	defer launcherFileMu.Unlock()
	body, err := os.ReadFile(a.launcherPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(body, &cfg); err != nil {
		return nil, fmt.Errorf("launcher.json: %w", err)
	}
	return &cfg, nil
}

func ValidURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func (a Store) Save(cfg Config) error {
	if len(cfg.Devices) > 64 || len(cfg.Links) > 512 || len(cfg.Dismissed) > 1024 {
		return errors.New("слишком много устройств или ссылок")
	}
	seen := map[string]bool{}
	for _, device := range cfg.Devices {
		if strings.TrimSpace(device.ID) == "" || strings.TrimSpace(device.Name) == "" {
			return errors.New("у устройства должны быть id и название")
		}
		if seen[device.ID] {
			return fmt.Errorf("устройство %s повторяется", device.ID)
		}
		seen[device.ID] = true
	}
	for _, link := range cfg.Links {
		if strings.TrimSpace(link.Title) == "" || !ValidURL(link.URL) {
			return fmt.Errorf("ссылка %q: нужны название и адрес http(s)://", link.Title)
		}
		if link.Repo != "" && !ValidURL(link.Repo) {
			return fmt.Errorf("ссылка %q: адрес репозитория должен быть http(s)://", link.Title)
		}
		if _, ok := Target(link.Upstream); link.Upstream != "" && !ok {
			return fmt.Errorf("ссылка %q: upstream должен быть вида адрес:порт", link.Title)
		}
	}
	for id, app := range cfg.Apps {
		if app.Repo != "" && !ValidURL(app.Repo) {
			return fmt.Errorf("приложение %s: адрес репозитория должен быть http(s)://", id)
		}
	}
	if cfg.Apps == nil {
		cfg.Apps = map[string]AppOverride{}
	}
	launcherFileMu.Lock()
	defer launcherFileMu.Unlock()
	return integration.AtomicJSON(a.Path, cfg)
}

func (a Store) Get(w http.ResponseWriter) {
	cfg, err := a.Load()
	if err != nil {
		a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true, "config": cfg})
}

func (a Store) Post(w http.ResponseWriter, r *http.Request) {
	var cfg Config
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&cfg); err != nil {
		http.Error(w, "Invalid launcher configuration", 400)
		return
	}
	if err := a.Save(cfg); err != nil {
		a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true})
}

type Probe struct {
	OK bool  `json:"ok"`
	Ms int64 `json:"ms"`
	// Since is when the current state began (unix seconds); Exact is false when
	// the state was already there at the first check after Core started (NPM-86).
	Since int64 `json:"since,omitempty"`
	Exact bool  `json:"exact,omitempty"`
}

type watch struct {
	ok          bool
	since, seen time.Time
	exact       bool
}

var (
	watchMu sync.Mutex
	watched = map[string]*watch{}
)

// remember keeps when each target's current state began, for «не отвечает 12 мин».
func remember(target string, p Probe, now time.Time) Probe {
	watchMu.Lock()
	defer watchMu.Unlock()
	w := watched[target]
	switch {
	case w == nil:
		w = &watch{ok: p.OK, since: now}
		watched[target] = w
	case w.ok != p.OK:
		w.ok, w.since, w.exact = p.OK, now, true
	}
	w.seen = now
	for key, other := range watched {
		if now.Sub(other.seen) > time.Hour {
			delete(watched, key)
		}
	}
	p.Since, p.Exact = w.since.Unix(), w.exact
	return p
}

func probe(target string) Probe {
	started := time.Now()
	conn, err := net.DialTimeout("tcp", target, 1500*time.Millisecond)
	p := Probe{OK: err == nil, Ms: time.Since(started).Milliseconds()}
	if conn != nil {
		_ = conn.Close()
	}
	return remember(target, p, time.Now())
}

// ProbeAll checks targets in parallel; Core calls it every minute so downtime
// is known even when nobody has the page open.
func ProbeAll(raw []string) map[string]Probe {
	if len(raw) > 96 {
		raw = raw[:96]
	}
	out := map[string]Probe{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for _, r := range raw {
		target, ok := Target(r)
		if !ok {
			continue
		}
		wg.Add(1)
		go func(key, target string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			p := probe(target)
			mu.Lock()
			out[key] = p
			mu.Unlock()
		}(r, target)
	}
	wg.Wait()
	return out
}

// Targets lists host:port of routed apps and links, as the portal probes them.
func Targets(apps []schema.App, cfg *Config) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(t string) {
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	for _, a := range apps {
		add(net.JoinHostPort(a.Upstream.Address, strconv.Itoa(a.Upstream.Port)))
	}
	if cfg != nil {
		for _, l := range cfg.Links {
			if l.Upstream != "" {
				add(l.Upstream)
			} else if u, err := url.Parse(l.URL); err == nil && u.Hostname() != "" {
				port := u.Port()
				if port == "" {
					port = map[bool]string{true: "443", false: "80"}[u.Scheme == "https"]
				}
				add(net.JoinHostPort(u.Hostname(), port))
			}
		}
	}
	return out
}

// Target accepts host:port on the local network only, so the status
// check cannot be used to poke at the internet from the router.
func Target(raw string) (string, bool) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(raw))
	if err != nil || host == "" || port == "" {
		return "", false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		if !strings.HasSuffix(strings.ToLower(host), ".local") {
			return "", false
		}
	} else if !(ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()) {
		return "", false
	}
	return net.JoinHostPort(host, port), true
}

func (a Store) Status(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, response{"ok": true, "status": ProbeAll(r.URL.Query()["t"])})
}
