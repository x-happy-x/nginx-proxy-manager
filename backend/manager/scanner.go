package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Automatic scanner: runs the analyzer over a list of targets every N minutes
// and keeps the latest full result plus a short verdict history per target.
// Settings and results live in NETWORK_STATE_DIR on the router.

type scanSettings struct {
	Enabled     bool     `json:"enabled"`
	IntervalMin int      `json:"interval_min"`
	Paths       []string `json:"paths"`
	Targets     []string `json:"targets"`
}

type scanPreset struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Targets     []string `json:"targets"`
}

var scanPresets = []scanPreset{
	{ID: "whitelist", Name: "Белые списки РФ", Description: "Должны открываться напрямую даже при отключениях мобильного интернета.",
		Targets: []string{"gosuslugi.ru", "yandex.ru", "vk.com", "mail.ru", "online.sberbank.ru", "ozon.ru", "wildberries.ru", "rutube.ru", "avito.ru", "2gis.ru"}},
	{ID: "blocked", Name: "Заблокированные", Description: "Типичные блокировки РКН и замедления.",
		Targets: []string{"youtube.com", "instagram.com", "facebook.com", "x.com", "discord.com", "linkedin.com", "rutracker.org", "telegram.org", "signal.org", "medium.com"}},
	{ID: "ai", Name: "ИИ", Description: "Сервисы, которые сами закрыты для России.",
		Targets: []string{"chatgpt.com", "api.openai.com", "claude.ai", "api.anthropic.com", "gemini.google.com", "copilot.microsoft.com"}},
	{ID: "hosting", Name: "Зарубежный хостинг", Description: "Проверка обрыва после 16–20 КБ, который ТСПУ применяет к хостингам.",
		Targets: []string{"speed.cloudflare.com/__down?bytes=200000", "hetzner.com", "digitalocean.com", "github.com", "ovhcloud.com", "vultr.com", "fly.io"}},
	{ID: "games", Name: "Игры", Description: "Лаунчеры и магазины.",
		Targets: []string{"store.steampowered.com", "epicgames.com", "battle.net", "ea.com", "riotgames.com"}},
}

type scanHistoryItem struct {
	At      int64             `json:"at"`
	Verdict string            `json:"verdict"`
	Paths   map[string]string `json:"paths"`
	Changed bool              `json:"changed,omitempty"`
}

type scanResult struct {
	Last    analysis          `json:"last"`
	History []scanHistoryItem `json:"history"`
}

type scanner struct {
	mu       sync.Mutex
	settings scanSettings
	results  map[string]*scanResult
	running  bool
	progress string
	lastRun  int64
	nextRun  int64
	wake     chan struct{}
}

var scan = &scanner{results: map[string]*scanResult{}, wake: make(chan struct{}, 1)}

func (s *scanner) dir() string { return netmon.stateDir }

func startScanner() {
	scan.settings = scanSettings{IntervalMin: 60, Paths: []string{"direct", "mihomo", "mikrotik"}, Targets: append([]string{}, scanPresets[1].Targets[:5]...)}
	if raw, err := os.ReadFile(filepath.Join(scan.dir(), "scan-settings.json")); err == nil {
		_ = json.Unmarshal(raw, &scan.settings)
	}
	if raw, err := os.ReadFile(filepath.Join(scan.dir(), "scan-results.json")); err == nil {
		_ = json.Unmarshal(raw, &scan.results)
	}
	for _, r := range scan.results {
		if len(r.History) > 0 && r.History[len(r.History)-1].At > scan.lastRun {
			scan.lastRun = r.History[len(r.History)-1].At
		}
	}
	go scan.loop()
}

func (s *scanner) loop() {
	for {
		s.mu.Lock()
		cfg := s.settings
		due := cfg.Enabled && time.Now().Unix() >= s.lastRun+int64(cfg.IntervalMin)*60
		if cfg.Enabled {
			s.nextRun = s.lastRun + int64(cfg.IntervalMin)*60
		} else {
			s.nextRun = 0
		}
		s.mu.Unlock()
		if due {
			s.runAll()
		}
		select {
		case <-s.wake:
		case <-time.After(30 * time.Second):
		}
	}
}

// runAll checks targets one by one, so a scan never floods the uplink.
func (s *scanner) runAll() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	cfg := s.settings
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.running, s.progress, s.lastRun = false, "", time.Now().Unix()
		s.mu.Unlock()
		s.save()
	}()
	for i, target := range cfg.Targets {
		s.mu.Lock()
		s.progress = target + " (" + strconv.Itoa(i+1) + " из " + strconv.Itoa(len(cfg.Targets)) + ")"
		s.mu.Unlock()
		res, err := analyze(target, cfg.Paths)
		if err != nil {
			continue
		}
		s.record(target, res)
	}
}

func (s *scanner) record(target string, res analysis) {
	item := scanHistoryItem{At: res.At, Verdict: res.Verdict, Paths: map[string]string{}}
	for _, p := range res.Paths {
		item.Paths[p.ID] = p.Verdict
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.results[target]
	if r == nil {
		r = &scanResult{}
		s.results[target] = r
	}
	if n := len(r.History); n > 0 {
		prev := r.History[n-1]
		item.Changed = prev.Verdict != item.Verdict
	}
	r.Last = res
	r.History = appendRing(r.History, item, 96)
}

func (s *scanner) save() {
	s.mu.Lock()
	settings, _ := json.MarshalIndent(s.settings, "", "  ")
	results, _ := json.Marshal(s.results)
	s.mu.Unlock()
	if err := os.MkdirAll(s.dir(), 0755); err != nil {
		return
	}
	writeAtomic(filepath.Join(s.dir(), "scan-settings.json"), settings)
	writeAtomic(filepath.Join(s.dir(), "scan-results.json"), results)
}

func writeAtomic(path string, body []byte) {
	tmp := path + ".tmp"
	if os.WriteFile(tmp, body, 0644) == nil {
		_ = os.Rename(tmp, path)
	}
}

func (a *app) handleScanGet(w http.ResponseWriter) {
	scan.mu.Lock()
	defer scan.mu.Unlock()
	type row struct {
		Target string `json:"target"`
		scanResult
	}
	rows := []row{}
	for _, t := range scan.settings.Targets {
		if r := scan.results[t]; r != nil {
			rows = append(rows, row{Target: t, scanResult: *r})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return verdictRank(rows[i].Last.Verdict) > verdictRank(rows[j].Last.Verdict) })
	a.writeJSON(w, http.StatusOK, response{
		"ok": true, "settings": scan.settings, "presets": scanPresets, "results": rows,
		"running": scan.running, "progress": scan.progress, "last_run": scan.lastRun, "next_run": scan.nextRun,
	})
}

func verdictRank(v string) int {
	return map[string]int{"down": 5, "partial": 4, "proxy-broken": 3, "blocked": 3, "bypassed": 2, "open": 1}[v]
}

func (a *app) handleNetworkPost(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/network/analyze":
		var req struct {
			Target string   `json:"target"`
			Paths  []string `json:"paths"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		res, err := analyze(req.Target, req.Paths)
		if err != nil {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "result": res})
	case "/api/network/scan/settings":
		var req scanSettings
		if !a.decodeJSON(w, r, &req) {
			return
		}
		clean := scanSettings{Enabled: req.Enabled, IntervalMin: req.IntervalMin, Paths: []string{}, Targets: []string{}}
		if clean.IntervalMin < 15 {
			clean.IntervalMin = 15
		}
		if clean.IntervalMin > 24*60 {
			clean.IntervalMin = 24 * 60
		}
		for _, p := range req.Paths {
			if p == "direct" || p == "mihomo" || p == "mikrotik" {
				clean.Paths = append(clean.Paths, p)
			}
		}
		seen := map[string]bool{}
		for _, t := range req.Targets {
			t = strings.TrimSpace(strings.ToLower(t))
			if t == "" || seen[t] {
				continue
			}
			if _, _, _, err := parseProbeTarget(t); err != nil {
				a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": err.Error()})
				return
			}
			seen[t] = true
			clean.Targets = append(clean.Targets, t)
		}
		if len(clean.Targets) > 60 {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "не больше 60 целей"})
			return
		}
		if len(clean.Paths) == 0 {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "выберите хотя бы один путь"})
			return
		}
		scan.mu.Lock()
		scan.settings = clean
		scan.mu.Unlock()
		scan.save()
		scan.poke()
		a.writeJSON(w, http.StatusOK, response{"ok": true, "settings": clean})
	case "/api/network/lte/load", "/api/network/lte/survey":
		a.handleLTEPost(w, r)
	case "/api/network/dns/run":
		a.handleDNSFinderRun(w)
	case "/api/network/scan/run":
		scan.mu.Lock()
		running := scan.running
		scan.mu.Unlock()
		if !running {
			go scan.runAll()
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "running": true})
	default:
		http.NotFound(w, r)
	}
}

func (s *scanner) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
