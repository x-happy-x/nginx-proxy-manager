package main

// NPM-76: the «Умный дом» settings page. The address and the long-lived token live in
// HA_DIR/config.json (0600) on the router only. The token is write-only for the UI:
// GET says whether it is set, PUT with an empty token keeps the saved one.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func normalizeHAURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("адрес — http(s)://хост[:порт], например http://192.168.99.12:8123")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("адрес без пути, логина и параметров: http(s)://хост[:порт]")
	}
	return u.Scheme + "://" + u.Host, nil
}

func validateHAToken(token string) error {
	if len(token) < 20 || len(token) > 1024 || strings.ContainsAny(token, " \t\r\n") {
		return fmt.Errorf("токен — длинная строка без пробелов из профиля пользователя HA («Долгосрочные токены доступа»)")
	}
	return nil
}

func (m *haMonitor) saveConfig(cfg haConfig) error {
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(m.dir, 0700); err != nil {
		return err
	}
	tmp := filepath.Join(m.dir, ".config.json.tmp")
	if err = os.WriteFile(tmp, append(b, '\n'), 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(m.dir, "config.json"))
}

// applyConfig swaps the settings; data collected from another HA is dropped.
func (m *haMonitor) applyConfig(cfg haConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cfg.URL != m.cfg.URL {
		m.info, m.states, m.view, m.devmap, m.devmapAt, m.mapErr = haInfo{}, nil, nil, nil, time.Time{}, ""
		m.lastOK = time.Time{}
	}
	m.cfg, m.loadErr = cfg, ""
	m.err, m.authErr, m.errSince = "", false, time.Time{}
}

func (a *app) handleHAConfig(w http.ResponseWriter, r *http.Request) {
	m := ha
	var body struct {
		URL   string `json:"url"`
		Token string `json:"token"`
	}
	readBody := func() (haConfig, bool) {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": "invalid_json"})
			return haConfig{}, false
		}
		u, err := normalizeHAURL(body.URL)
		if err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
			return haConfig{}, false
		}
		token := strings.TrimSpace(body.Token)
		m.mu.Lock()
		if token == "" {
			token = m.cfg.Token
		}
		m.mu.Unlock()
		if err := validateHAToken(token); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
			return haConfig{}, false
		}
		return haConfig{URL: u, Token: token}, true
	}
	switch {
	case r.URL.Path == "/api/ha/config" && r.Method == http.MethodGet:
		m.mu.Lock()
		out := response{"url": m.cfg.URL, "token_set": m.cfg.Token != "", "error": m.loadErr}
		m.mu.Unlock()
		a.writeJSON(w, 200, out)
	case r.URL.Path == "/api/ha/config" && (r.Method == http.MethodPut || r.Method == http.MethodPost):
		cfg, ok := readBody()
		if !ok {
			return
		}
		if err := m.saveConfig(cfg); err != nil {
			a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
			return
		}
		m.applyConfig(cfg)
		managedGo(m.poll)
		a.writeJSON(w, 200, response{"ok": true})
	case r.URL.Path == "/api/ha/config/test" && r.Method == http.MethodPost:
		cfg, ok := readBody()
		if !ok {
			return
		}
		a.writeJSON(w, 200, m.test(r.Context(), cfg))
	default:
		http.Error(w, "method not allowed", 405)
	}
}

// test reads /api/config and probes the template API: without admin rights the
// module still works, but counts entities instead of devices.
func (m *haMonitor) test(ctx context.Context, cfg haConfig) response {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	started := time.Now()
	var info haInfo
	if err := m.call(ctx, cfg, "GET", "/api/config", nil, &info); err != nil {
		return response{"ok": false, "error": err.Error()}
	}
	res := response{"ok": true, "version": info.Version, "location": info.LocationName, "latency_ms": time.Since(started).Milliseconds()}
	var rendered string
	if err := m.call(ctx, cfg, "POST", "/api/template", map[string]string{"template": haDeviceTemplate}, &rendered); err != nil {
		res["devices"], res["devices_error"] = false, err.Error()
	} else if dm, err := parseHADeviceMap(rendered); err != nil {
		res["devices"], res["devices_error"] = false, err.Error()
	} else {
		res["devices"], res["device_count"] = true, len(dm.Devices)
	}
	return res
}
