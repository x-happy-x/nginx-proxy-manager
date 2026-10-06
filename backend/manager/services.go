package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
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
	serviceKeep     = 30   // two-minute results: one hour
	serviceSlowMS   = 2500 // a full HTTPS request through a bypass node takes about a second
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

// serviceConfig: the list people edit (NPM-49) — their own services, the
// built-in ones they hid and the order. Kept on the router, one for all devices.
type serviceConfig struct {
	Custom []serviceDef `json:"custom"`
	Hidden []string     `json:"hidden"`
	Order  []string     `json:"order"`
}

func serviceConfigPath() string { return filepath.Join(coreStateDir(), "services-config.json") }

func loadServiceConfig() serviceConfig {
	c := serviceConfig{Custom: []serviceDef{}, Hidden: []string{}, Order: []string{}}
	if body, err := os.ReadFile(serviceConfigPath()); err == nil {
		_ = json.Unmarshal(body, &c)
	}
	return c
}

// normalize checks what a person typed and gives own services stable ids.
func (c *serviceConfig) normalize() error {
	if len(c.Custom) > 40 {
		return errors.New("своих сервисов — не больше 40")
	}
	seen := map[string]bool{}
	for i := range c.Custom {
		d := &c.Custom[i]
		d.Name, d.What, d.URL = strings.TrimSpace(d.Name), strings.TrimSpace(d.What), strings.TrimSpace(d.URL)
		if !strings.Contains(d.URL, "://") && d.URL != "" {
			d.URL = "https://" + d.URL
		}
		switch {
		case d.Name == "" || len([]rune(d.Name)) > 40:
			return fmt.Errorf("сервис %d: нужно название до 40 символов", i+1)
		case len([]rune(d.What)) > 80:
			return fmt.Errorf("«%s»: подпись до 80 символов", d.Name)
		case !httpURL(d.URL):
			return fmt.Errorf("«%s»: адрес проверки — сайт вида example.org или https-адрес", d.Name)
		}
		if !strings.HasPrefix(d.ID, "custom-") {
			sum := sha256.Sum256([]byte(d.URL + "|" + d.Name))
			d.ID = "custom-" + hex.EncodeToString(sum[:6])
		}
		for seen[d.ID] {
			d.ID += "x"
		}
		seen[d.ID] = true
		d.Group, d.Kind = "", ""
	}
	clean := func(in []string) []string {
		out := []string{}
		for _, id := range in {
			if id = strings.TrimSpace(id); id != "" && len(id) <= 80 && len(out) < 200 {
				out = append(out, id)
			}
		}
		return out
	}
	c.Hidden, c.Order = clean(c.Hidden), clean(c.Order)
	return nil
}

func saveServiceConfig(c serviceConfig) error {
	if err := os.MkdirAll(coreStateDir(), 0o755); err != nil {
		return err
	}
	body, _ := json.MarshalIndent(c, "", "  ")
	tmp := serviceConfigPath() + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, serviceConfigPath())
}

// serviceCatalog: every service the list can show — built-in, the addresses
// that must always open (Keycloak, Headscale…) right after ИИ, then own ones.
func serviceCatalog(c serviceConfig) []serviceDef {
	out := []serviceDef{defaultServices[0]}
	if s, ok := loadRouting(); ok {
		for _, a := range s.Access {
			out = append(out, serviceDef{ID: "access-" + a.Host, Name: a.Name, What: a.Host, URL: a.URL, Group: a.Name})
		}
	}
	out = append(out, defaultServices[1:]...)
	return append(out, c.Custom...)
}

// serviceList: the catalog without the hidden ones, in the chosen order;
// services the order does not name keep their place after it.
func serviceList() []serviceDef {
	c := loadServiceConfig()
	hidden := map[string]bool{}
	for _, id := range c.Hidden {
		hidden[id] = true
	}
	all := serviceCatalog(c)
	byID := map[string]serviceDef{}
	for _, d := range all {
		byID[d.ID] = d
	}
	out := []serviceDef{}
	placed := map[string]bool{}
	for _, id := range c.Order {
		if d, ok := byID[id]; ok && !hidden[id] && !placed[id] {
			out = append(out, d)
			placed[id] = true
		}
	}
	for _, d := range all {
		if !hidden[d.ID] && !placed[d.ID] {
			out = append(out, d)
		}
	}
	return out
}

type serviceChecker struct {
	mu      sync.Mutex
	path    string
	states  map[string]*serviceState
	probes  map[string]*probeState
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
			Probes  map[string]*probeState   `json:"probes"`
		}
		if json.Unmarshal(body, &saved) == nil && saved.States != nil {
			c.states, c.checked, c.probes = saved.States, saved.Checked, saved.Probes
		}
	}
	return c
}

// checkAll checks every service, or only the one with the id given.
func (c *serviceChecker) checkAll(only string) {
	if only == "probes" {
		c.checkProbes()
		c.mu.Lock()
		c.saveLocked()
		c.mu.Unlock()
		return
	}
	c.mu.Lock()
	if c.running && only == "" {
		c.mu.Unlock()
		return
	}
	c.running = only == "" || c.running
	c.mu.Unlock()
	// the connectivity pages go along with a full round (NPM-52)
	var probesDone sync.WaitGroup
	if only == "" {
		probesDone.Add(1)
		go func() {
			defer probesDone.Done()
			c.checkProbes()
		}()
	}
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
	routes := make([][]string, len(list))
	for i, def := range list {
		if only != "" && def.ID != only {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], routes[i] = checkService(def)
		}()
	}
	wg.Wait()
	probesDone.Wait()
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
		// the chain mihomo really used for this check; the configured group
		// only when the connection was not found
		if len(routes[i]) > 0 {
			st.Path = routes[i]
		} else if def.Group != "" {
			st.Path = groupPath(def.Group, proxies)
		} else {
			st.Path = nil
		}
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
		Probes  map[string]*probeState   `json:"probes,omitempty"`
	}{c.checked, c.states, c.probes})
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

func checkService(def serviceDef) (serviceResult, []string) {
	start := time.Now()
	res := serviceResult{T: start.Unix()}
	var err error
	var route []string
	if def.Kind == "dns" {
		var ips []string
		ips, _, err = mihomoResolve("www.example.com")
		if err == nil && len(ips) == 0 {
			err = errors.New("DNS mihomo не вернул адрес")
		}
	} else {
		route, err = serviceGET(def.URL)
	}
	res.MS = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = serviceError(err)
		return res, route
	}
	res.OK = true
	return res, route
}

// serviceGET opens the address through mihomo and, while the connection is
// open, asks mihomo which rule and chain it took (outermost group first).
func serviceGET(raw string) ([]string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	var routeMu sync.Mutex
	var route []string
	lookup := func(conn net.Conn) {
		if local, ok := conn.LocalAddr().(*net.TCPAddr); ok {
			_, chain := mihomoConnectionRoute(u.Hostname(), local.Port)
			routeMu.Lock()
			route = chain
			routeMu.Unlock()
		}
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
			conn, err := socksDial(u.Hostname(), port, serviceTimeout)
			if err == nil {
				go lookup(conn)
			}
			return conn, err
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
		return nil, err
	}
	req.Header.Set("User-Agent", "HomeNet-Service-Check/1")
	resp, err := client.Do(req)
	routeOf := func() []string {
		routeMu.Lock()
		defer routeMu.Unlock()
		return route
	}
	if err != nil {
		return routeOf(), err
	}
	_, _ = io.CopyN(io.Discard, resp.Body, 4096)
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return routeOf(), fmt.Errorf("сервер ответил %d", resp.StatusCode)
	}
	return routeOf(), nil
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
	cfg := loadServiceConfig()
	a.writeJSON(w, http.StatusOK, response{"ok": true, "checked": checked, "interval": int(serviceInterval.Seconds()), "slow_ms": serviceSlowMS, "services": list,
		"config": cfg, "catalog": serviceCatalog(cfg), "probes": services.probeSnapshot()})
}

// handleServicesConfig saves the list people edited and checks new services
// at once, so their cards are not empty for two minutes.
func (a *app) handleServicesConfig(w http.ResponseWriter, r *http.Request) {
	var c serviceConfig
	if !a.decodeJSON(w, r, &c) {
		return
	}
	if err := c.normalize(); err != nil {
		a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": err.Error()})
		return
	}
	if err := saveServiceConfig(c); err != nil {
		a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
		return
	}
	if services != nil {
		_, list := services.snapshot()
		for _, s := range list {
			if len(s.History) == 0 {
				services.checkAll(s.ID)
			}
		}
	}
	a.handleServices(w, &http.Request{Method: http.MethodGet, URL: r.URL})
}
