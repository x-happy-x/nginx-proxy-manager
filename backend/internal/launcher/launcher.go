package launcher

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"net"
	"net/http"
	"net/url"
	"os"
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
	if len(cfg.Devices) > 64 || len(cfg.Links) > 512 {
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
	targets := r.URL.Query()["t"]
	if len(targets) > 96 {
		targets = targets[:96]
	}
	out := map[string]Probe{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for _, raw := range targets {
		target, ok := Target(raw)
		if !ok {
			continue
		}
		wg.Add(1)
		go func(key, target string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			started := time.Now()
			conn, err := net.DialTimeout("tcp", target, 1500*time.Millisecond)
			probe := Probe{OK: err == nil, Ms: time.Since(started).Milliseconds()}
			if conn != nil {
				_ = conn.Close()
			}
			mu.Lock()
			out[key] = probe
			mu.Unlock()
		}(raw, target)
	}
	wg.Wait()
	a.writeJSON(w, http.StatusOK, response{"ok": true, "status": out})
}
