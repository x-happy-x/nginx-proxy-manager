package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
 * VPN → «Сейчас» (NPM-47): do the services people use open right now? Every
 * two minutes the manager opens each service's address through mihomo's SOCKS
 * port, so the request follows the same rules as a device's, and keeps an hour
 * of results. Any HTTP answer counts as «opens»: a Cloudflare challenge or a
 * redirect still proves the path works.
 */

const (
	serviceInterval = 2 * time.Minute
	serviceTimeout  = 8 * time.Second
	serviceKeep     = 30 // two-minute results: one hour
	serviceSlowMS   = 1000
)

type serviceDef struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	What  string `json:"what"`
	URL   string `json:"url,omitempty"`
	Group string `json:"group"`
	// "dns": a lookup through mihomo's DNS instead of an HTTP request
	Kind string `json:"kind,omitempty"`
}

type serviceResult struct {
	T     int64  `json:"t"`
	OK    bool   `json:"ok"`
	MS    int64  `json:"ms"`
	Error string `json:"error,omitempty"`
}

type serviceState struct {
	serviceDef
	History []serviceResult `json:"history"`
	// the node the group used at the last check, outermost group first
	Path []string `json:"path"`
}

// By how often each was opened at home, 2–5 October 2026 (NPM-44 analysis).
var defaultServices = []serviceDef{
	{ID: "ai", Name: "ИИ", What: "ChatGPT, Claude, Cursor", URL: "https://chatgpt.com/cdn-cgi/trace", Group: "ИИ"},
	{ID: "dns", Name: "DNS устройств", What: "1.1.1.1, 8.8.8.8, Яндекс", Group: "HomeNet DNS", Kind: "dns"},
	{ID: "google", Name: "Google и уведомления", What: "поиск, Play, пуши Android", URL: "https://www.google.com/generate_204", Group: "Заблокированные сервисы"},
	{ID: "ru", Name: "Российские сайты", What: "Яндекс, VK, OK, Rutube", URL: "https://ya.ru/", Group: "Белые списки"},
	{ID: "telegram", Name: "Telegram", What: "сообщения и звонки", URL: "https://api.telegram.org/", Group: "Telegram"},
	{ID: "instagram", Name: "Instagram и Facebook", What: "лента, сторис, Reels", URL: "https://www.instagram.com/", Group: "Заблокированные сервисы"},
	{ID: "microsoft", Name: "Windows и Office", What: "обновления, Teams", URL: "https://www.microsoft.com/", Group: "Заблокированные сервисы"},
	{ID: "dev", Name: "Разработка", What: "GitHub, JetBrains, Docker", URL: "https://api.github.com/", Group: "Заблокированные сервисы"},
	{ID: "tiktok", Name: "TikTok", What: "видео", URL: "https://www.tiktok.com/", Group: "Заблокированные сервисы"},
	{ID: "whatsapp", Name: "WhatsApp", What: "сообщения и звонки", URL: "https://web.whatsapp.com/", Group: "Заблокированные сервисы"},
	{ID: "youtube", Name: "YouTube", What: "видео", URL: "https://www.youtube.com/generate_204", Group: "Заблокированные сервисы"},
	{ID: "games", Name: "Nulls и игры", What: "Brawl Stars, Roblox", URL: "https://nulls.gg/", Group: "Игры"},
}

// serviceList: the addresses that must always open (Keycloak, Headscale…)
// go right after ИИ, each with its own group.
func serviceList() []serviceDef {
	out := []serviceDef{defaultServices[0]}
	if s, ok := loadRouting(); ok {
		for _, a := range s.Access {
			out = append(out, serviceDef{ID: "access-" + a.Host, Name: a.Name, What: a.Host, URL: a.URL, Group: a.Name})
		}
	}
	return append(out, defaultServices[1:]...)
}

type serviceChecker struct {
	mu      sync.Mutex
	path    string
	states  map[string]*serviceState
	checked int64
	running bool
}

var services *serviceChecker

func (a *app) startServiceChecks() {
	if os.Getenv("MAINTENANCE_DISABLED") == "1" || os.Getenv("MIHOMO_TRAFFIC_DISABLED") == "1" {
		return
	}
	services = newServiceChecker(filepath.Join(coreStateDir(), "services.json"))
	go func() {
		time.Sleep(20 * time.Second) // let the manager and mihomo settle
		services.checkAll("")
		t := time.NewTicker(serviceInterval)
		defer t.Stop()
		for range t.C {
			services.checkAll("")
		}
	}()
}

func newServiceChecker(path string) *serviceChecker {
	c := &serviceChecker{path: path, states: map[string]*serviceState{}}
	if body, err := os.ReadFile(path); err == nil {
		var saved struct {
			Checked int64                    `json:"checked"`
			States  map[string]*serviceState `json:"states"`
		}
		if json.Unmarshal(body, &saved) == nil && saved.States != nil {
			c.states, c.checked = saved.States, saved.Checked
		}
	}
	return c
}

// checkAll checks every service, or only the one with the id given.
func (c *serviceChecker) checkAll(only string) {
	c.mu.Lock()
	if c.running && only == "" {
		c.mu.Unlock()
		return
	}
	c.running = only == "" || c.running
	c.mu.Unlock()
	list := serviceList()
	var proxies map[string]proxyNow
	var body struct {
		Proxies map[string]proxyNow `json:"proxies"`
	}
	if mihomoGet("/proxies", &body) == nil {
		proxies = body.Proxies
	}
	var wg sync.WaitGroup
	results := make([]serviceResult, len(list))
	for i, def := range list {
		if only != "" && def.ID != only {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = checkService(def)
		}()
	}
	wg.Wait()
	now := time.Now().Unix()
	c.mu.Lock()
	defer c.mu.Unlock()
	if only == "" {
		c.running = false
		c.checked = now
	}
	known := map[string]bool{}
	for i, def := range list {
		known[def.ID] = true
		st := c.states[def.ID]
		if st == nil {
			st = &serviceState{}
			c.states[def.ID] = st
		}
		st.serviceDef = def
		if only != "" && def.ID != only {
			continue
		}
		st.History = append(st.History, results[i])
		if len(st.History) > serviceKeep {
			st.History = st.History[len(st.History)-serviceKeep:]
		}
		st.Path = groupPath(def.Group, proxies)
	}
	for id := range c.states {
		if !known[id] {
			delete(c.states, id)
		}
	}
	c.saveLocked()
}

type proxyNow struct {
	Now string `json:"now"`
}

// groupPath follows a group's choice down to the node: [Telegram Обходы №10-1].
func groupPath(group string, proxies map[string]proxyNow) []string {
	if proxies == nil {
		return nil
	}
	out := []string{group}
	cur := group
	for i := 0; i < 10; i++ {
		p, ok := proxies[cur]
		if !ok || p.Now == "" {
			break
		}
		out = append(out, p.Now)
		cur = p.Now
	}
	return out
}

func (c *serviceChecker) saveLocked() {
	body, err := json.Marshal(struct {
		Checked int64                    `json:"checked"`
		States  map[string]*serviceState `json:"states"`
	}{c.checked, c.states})
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(c.path), 0o755)
	tmp := c.path + ".tmp"
	if os.WriteFile(tmp, body, 0o644) == nil {
		_ = os.Rename(tmp, c.path)
	}
}

func (c *serviceChecker) snapshot() (int64, []serviceState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []serviceState{}
	for _, def := range serviceList() {
		st, ok := c.states[def.ID]
		if !ok {
			out = append(out, serviceState{serviceDef: def, History: []serviceResult{}})
			continue
		}
		cp := *st
		cp.History = append([]serviceResult(nil), st.History...)
		cp.Path = append([]string(nil), st.Path...)
		out = append(out, cp)
	}
	return c.checked, out
}

func checkService(def serviceDef) serviceResult {
	start := time.Now()
	res := serviceResult{T: start.Unix()}
	var err error
	if def.Kind == "dns" {
		var ips []string
		ips, _, err = mihomoResolve("www.example.com")
		if err == nil && len(ips) == 0 {
			err = errors.New("DNS mihomo не вернул адрес")
		}
	} else {
		err = serviceGET(def.URL)
	}
	res.MS = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = serviceError(err)
		return res
	}
	res.OK = true
	return res
}

func serviceGET(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	port := 443
	if u.Scheme == "http" {
		port = 80
	}
	if p := u.Port(); p != "" {
		port, _ = strconv.Atoi(p)
	}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return socksDial(u.Hostname(), port, serviceTimeout)
		},
		TLSClientConfig:       &tls.Config{ServerName: u.Hostname()},
		TLSHandshakeTimeout:   serviceTimeout,
		ResponseHeaderTimeout: serviceTimeout,
		DisableKeepAlives:     true,
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: serviceTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "HomeNet-Service-Check/1")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	_, _ = io.CopyN(io.Discard, resp.Body, 4096)
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("сервер ответил %d", resp.StatusCode)
	}
	return nil
}

// serviceError: the reason in plain words, without addresses or secrets.
func serviceError(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "Client.Timeout") || strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
		return "нет ответа за 8 с"
	case strings.Contains(msg, "SOCKS-порт mihomo"):
		return "mihomo не принимает соединения"
	case strings.Contains(msg, "mihomo:"):
		return strings.TrimPrefix(msg[strings.Index(msg, "mihomo:"):], "mihomo: ")
	case strings.Contains(msg, "connection reset") || strings.Contains(msg, "EOF"):
		return "соединение оборвалось"
	case strings.Contains(msg, "certificate"):
		return "ошибка сертификата"
	case strings.Contains(msg, "сервер ответил"):
		return msg
	}
	return "не открылся"
}

func (a *app) handleServices(w http.ResponseWriter, r *http.Request) {
	if services == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "проверка сервисов выключена"})
		return
	}
	if r.Method == http.MethodPost {
		id := r.URL.Query().Get("id")
		services.checkAll(id)
	}
	checked, list := services.snapshot()
	a.writeJSON(w, http.StatusOK, response{"ok": true, "checked": checked, "interval": int(serviceInterval.Seconds()), "slow_ms": serviceSlowMS, "services": list})
}
