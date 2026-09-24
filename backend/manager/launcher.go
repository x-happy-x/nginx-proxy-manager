package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Launcher settings live next to the routes file, apart from routes.yml: they
// only describe the start page and never go through drafts or apply.
type launcherDevice struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Note      string   `json:"note,omitempty"`
	Addresses []string `json:"addresses"`
}

type launcherLink struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	URL         string `json:"url"`
	Device      string `json:"device"`
	Description string `json:"description,omitempty"`
	Art         string `json:"art,omitempty"`
}

type launcherAppOverride struct {
	Title       string `json:"title,omitempty"`
	Device      string `json:"device,omitempty"`
	Description string `json:"description,omitempty"`
	Art         string `json:"art,omitempty"`
	Hidden      bool   `json:"hidden,omitempty"`
}

type launcherConfig struct {
	Devices []launcherDevice               `json:"devices"`
	Links   []launcherLink                 `json:"links"`
	Apps    map[string]launcherAppOverride `json:"apps"`
	Order   []string                       `json:"order,omitempty"`
}

var launcherFileMu sync.Mutex

func (a *app) launcherPath() string {
	return filepath.Join(filepath.Dir(a.routesPath()), "launcher.json")
}

// loadLauncher returns nil when nothing was saved yet; the UI then offers
// its default device groups.
func (a *app) loadLauncher() (*launcherConfig, error) {
	launcherFileMu.Lock()
	defer launcherFileMu.Unlock()
	body, err := os.ReadFile(a.launcherPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg launcherConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		return nil, fmt.Errorf("launcher.json: %w", err)
	}
	return &cfg, nil
}

func validLauncherURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func (a *app) saveLauncher(cfg launcherConfig) error {
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
		if strings.TrimSpace(link.Title) == "" || !validLauncherURL(link.URL) {
			return fmt.Errorf("ссылка %q: нужны название и адрес http(s)://", link.Title)
		}
	}
	if cfg.Apps == nil {
		cfg.Apps = map[string]launcherAppOverride{}
	}
	body, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	launcherFileMu.Lock()
	defer launcherFileMu.Unlock()
	path := a.launcherPath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(body, '\n'), 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (a *app) handleLauncherGet(w http.ResponseWriter) {
	cfg, err := a.loadLauncher()
	if err != nil {
		a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true, "config": cfg})
}

func (a *app) handleLauncherSave(w http.ResponseWriter, r *http.Request) {
	var cfg launcherConfig
	if !a.decodeJSON(w, r, &cfg) {
		return
	}
	if err := a.saveLauncher(cfg); err != nil {
		a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true})
}

type launcherProbe struct {
	OK bool  `json:"ok"`
	Ms int64 `json:"ms"`
}

// launcherTarget accepts host:port on the local network only, so the status
// check cannot be used to poke at the internet from the router.
func launcherTarget(raw string) (string, bool) {
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

func (a *app) handleLauncherStatus(w http.ResponseWriter, r *http.Request) {
	targets := r.URL.Query()["t"]
	if len(targets) > 96 {
		targets = targets[:96]
	}
	out := map[string]launcherProbe{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for _, raw := range targets {
		target, ok := launcherTarget(raw)
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
			probe := launcherProbe{OK: err == nil, Ms: time.Since(started).Milliseconds()}
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
