package main

// NPM-74: the «Proxmox» integration. Each host runs homenet-pve-agent, which
// samples itself every 10 s and keeps a day of history. This worker reads the
// prepared documents over SSH with a key that the host restricts to the
// agent's forced command, and serves them to the module UI. Power operations
// require capabilities explicitly enabled for that key when installing the agent.
// Widget and attention endpoints answer from memory and never touch the network.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type pvhHostConfig struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Address string `json:"address"`
	Port    int    `json:"port"`
	User    string `json:"user"`
}

// Only the fields the worker itself reasons about; the UI receives the raw document.
type pvhSnapshot struct {
	Host string `json:"host"`
	TS   int64  `json:"ts"`
	Node struct {
		CPU     float64  `json:"cpu"`
		Uptime  int64    `json:"uptime"`
		CPUTemp *float64 `json:"cpu_temp"`
		Mem     struct {
			Total float64 `json:"total"`
			Used  float64 `json:"used"`
		} `json:"mem"`
		Swap struct {
			Total float64 `json:"total"`
			Used  float64 `json:"used"`
		} `json:"swap"`
	} `json:"node"`
	Temps []struct {
		Chip  string   `json:"chip"`
		Label string   `json:"label"`
		C     float64  `json:"c"`
		Crit  *float64 `json:"crit"`
	} `json:"temps"`
	Guests []struct {
		VMID     int    `json:"vmid"`
		Name     string `json:"name"`
		Type     string `json:"type"`
		Status   string `json:"status"`
		Template bool   `json:"template"`
		Lock     string `json:"lock"`
	} `json:"guests"`
	Storage []struct {
		Name    string  `json:"name"`
		Used    float64 `json:"used"`
		Total   float64 `json:"total"`
		Active  bool    `json:"active"`
		Enabled bool    `json:"enabled"`
	} `json:"storage"`
	ZFS []struct {
		Name   string `json:"name"`
		Health string `json:"health"`
	} `json:"zfs"`
	Disks []struct {
		Dev    string   `json:"dev"`
		Model  string   `json:"model"`
		Health *bool    `json:"health"`
		Temp   *float64 `json:"temp"`
		Wear   *float64 `json:"wear"`
	} `json:"disks"`
	Cluster struct {
		Name    string `json:"name"`
		Quorate bool   `json:"quorate"`
		Nodes   []struct {
			Name   string `json:"name"`
			IP     string `json:"ip"`
			Online bool   `json:"online"`
		} `json:"nodes"`
	} `json:"cluster"`
	FailedUnits []string `json:"failed_units"`
	Updates     *int     `json:"updates"`
	Backups     []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		End    int64  `json:"end"`
	} `json:"backups"`
}

type pvhHost struct {
	Config       pvhHostConfig
	Online       bool
	Error        string
	Checked      time.Time
	LastOK       time.Time
	Since        time.Time // when the current online/offline state began
	LatencyMS    int64
	Current      json.RawMessage
	Hardware     json.RawMessage
	Parsed       *pvhSnapshot
	History      json.RawMessage
	HistoryAt    time.Time
	Capabilities pvhCapabilities
}

type pvhMonitor struct {
	mu      sync.Mutex
	dir     string
	client  string
	hosts   []*pvhHost
	loadErr string
	tasks   []*pvhTask
	request func(context.Context, pvhHostConfig, string) ([]byte, error)
}

var pvh *pvhMonitor

func pvhDir() string { return getenv("PVE_DIR", "/opt/etc/homenet/pve") }

func newPVHMonitor() *pvhMonitor {
	m := &pvhMonitor{dir: pvhDir(), client: getenv("PVE_SSH_CLIENT", "/opt/bin/dbclient")}
	b, err := os.ReadFile(filepath.Join(m.dir, "hosts.json"))
	if os.IsNotExist(err) {
		return m // nothing configured yet: the «Настройка» page adds servers
	}
	if err != nil {
		m.loadErr = "Список серверов не читается: " + err.Error()
		return m
	}
	hosts, err := parsePVHConfig(b)
	if err != nil {
		m.loadErr = "Список серверов повреждён: " + err.Error()
		return m
	}
	for _, h := range hosts {
		m.hosts = append(m.hosts, &pvhHost{Config: h})
	}
	return m
}

// parsePVHConfig fills defaults; entries without an id or address are skipped as before.
func parsePVHConfig(b []byte) ([]pvhHostConfig, error) {
	var cfg struct {
		Hosts []pvhHostConfig `json:"hosts"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, err
	}
	out := []pvhHostConfig{}
	for _, h := range cfg.Hosts {
		if h.ID == "" || h.Address == "" {
			continue
		}
		if h.Port == 0 {
			h.Port = 22
		}
		if h.User == "" {
			h.User = "root"
		}
		if h.Name == "" {
			h.Name = h.ID
		}
		out = append(out, h)
	}
	return out, nil
}

// One loop over the current list: servers added or removed on the settings page
// are picked up on the next round without restarting the worker.
func (a *app) startPVE() {
	pvh = newPVHMonitor()
	every(15*time.Second, pvh.pollAll)
}

func (m *pvhMonitor) pollAll() {
	m.mu.Lock()
	hosts := append([]*pvhHost(nil), m.hosts...)
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, h := range hosts {
		wg.Add(1)
		go func(h *pvhHost) { defer wg.Done(); m.poll(h) }(h)
	}
	wg.Wait()
	m.pollTasks()
}

// fetch runs the agent's forced command. The key is accepted by the host only for
// `homenet-pve-agent serve`; the agent independently validates every request.
func (m *pvhMonitor) fetch(ctx context.Context, h pvhHostConfig, request string) ([]byte, error) {
	if m.request != nil {
		return m.request(ctx, h, request)
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	args := []string{"-T", "-i", filepath.Join(m.dir, "id_dropbear"), "-p", strconv.Itoa(h.Port), h.User + "@" + h.Address, request}
	cmd := exec.CommandContext(ctx, m.client, args...)
	// dbclient keeps known_hosts in $HOME/.ssh; the pinned host keys live here.
	cmd.Env = append(os.Environ(), "HOME="+m.dir)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if ctx.Err() != nil {
			msg = "нет ответа за 12 с"
		}
		if msg == "" {
			msg = err.Error()
		}
		if i := strings.LastIndex(msg, "\n"); i >= 0 {
			msg = msg[i+1:]
		}
		return out.Bytes(), fmt.Errorf("%s", msg)
	}
	return out.Bytes(), nil
}

func (m *pvhMonitor) poll(h *pvhHost) {
	started := time.Now()
	m.mu.Lock()
	cfg := h.Config
	m.mu.Unlock()
	b, err := m.fetch(workerContext, cfg, "bundle")
	var bundle struct {
		Current      json.RawMessage `json:"current"`
		Hardware     json.RawMessage `json:"hardware"`
		Capabilities pvhCapabilities `json:"capabilities"`
	}
	var snap pvhSnapshot
	if err == nil {
		if err = json.Unmarshal(b, &bundle); err == nil {
			if len(bundle.Current) == 0 || string(bundle.Current) == "null" {
				err = fmt.Errorf("агент ещё не собрал данные")
			} else {
				err = json.Unmarshal(bundle.Current, &snap)
			}
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	h.Checked = now
	h.LatencyMS = time.Since(started).Milliseconds()
	online := err == nil && now.Unix()-snap.TS < 90
	if err == nil && !online {
		err = fmt.Errorf("агент не обновлял данные %s", humanAge(now.Unix()-snap.TS))
	}
	if online != h.Online || h.Since.IsZero() {
		h.Since = now
	}
	h.Online = online
	if err != nil {
		h.Error = err.Error()
		return
	}
	h.Error = ""
	h.LastOK = now
	h.Current = bundle.Current
	if len(bundle.Hardware) > 0 && string(bundle.Hardware) != "null" {
		h.Hardware = bundle.Hardware
	}
	h.Parsed = &snap
	h.Capabilities = bundle.Capabilities
}

func humanAge(sec int64) string {
	switch {
	case sec < 120:
		return fmt.Sprintf("%d с", sec)
	case sec < 7200:
		return fmt.Sprintf("%d мин", sec/60)
	default:
		return fmt.Sprintf("%d ч", sec/3600)
	}
}

func (m *pvhMonitor) find(id string) *pvhHost {
	for _, h := range m.hosts {
		if h.Config.ID == id {
			return h
		}
	}
	return nil
}

func rawOrNull(b json.RawMessage) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("null")
	}
	return b
}

func (a *app) handlePVE(w http.ResponseWriter, r *http.Request) {
	if pvh == nil {
		http.Error(w, "integration not started", 503)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/pve/config") {
		a.handlePVEConfig(w, r)
		return
	}
	if r.URL.Path == "/api/pve/actions" || r.URL.Path == "/api/pve/tasks" {
		a.handlePVEActions(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	switch r.URL.Path {
	case "/api/pve/overview":
		a.writeJSON(w, 200, pvh.overview())
	case "/api/pve/history":
		pvh.history(w, r)
	case "/api/pve/widgets/hosts":
		a.writeJSON(w, 200, pvh.widgetHosts())
	case "/api/pve/widgets/temps":
		a.writeJSON(w, 200, pvh.widgetTemps())
	case "/api/pve/widgets/guests":
		a.writeJSON(w, 200, pvh.widgetGuests())
	case "/api/pve/summary/attention":
		a.writeJSON(w, 200, response{"items": pvh.attention()})
	default:
		http.NotFound(w, r)
	}
}

func (m *pvhMonitor) overview() response {
	m.mu.Lock()
	defer m.mu.Unlock()
	hosts := []response{}
	for _, h := range m.hosts {
		item := response{
			"id": h.Config.ID, "name": h.Config.Name, "address": h.Config.Address, "online": h.Online, "error": h.Error,
			"latency_ms": h.LatencyMS, "current": rawOrNull(h.Current), "hardware": rawOrNull(h.Hardware),
			"capabilities": h.Capabilities,
		}
		if !h.Checked.IsZero() {
			item["checked_at"] = h.Checked.UTC().Format(time.RFC3339)
		}
		if !h.LastOK.IsZero() {
			item["last_ok"] = h.LastOK.UTC().Format(time.RFC3339)
		}
		hosts = append(hosts, item)
	}
	return response{"hosts": hosts, "configured": len(m.hosts) > 0, "error": m.loadErr}
}

// History is a day of minute points (~100 KB); it is fetched when the UI asks and
// shared between viewers for a minute instead of being kept fresh in the background.
func (m *pvhMonitor) history(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	h := m.find(r.URL.Query().Get("host"))
	if h == nil {
		m.mu.Unlock()
		http.Error(w, "unknown host", 404)
		return
	}
	cached, at, cfg := h.History, h.HistoryAt, h.Config
	m.mu.Unlock()
	if len(cached) == 0 || time.Since(at) > time.Minute {
		b, err := m.fetch(r.Context(), cfg, "history")
		if err != nil {
			if len(cached) == 0 {
				http.Error(w, err.Error(), 502)
				return
			}
		} else if json.Valid(b) {
			cached = b
			m.mu.Lock()
			h.History, h.HistoryAt = b, time.Now()
			m.mu.Unlock()
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(cached)
}

func pct(used, total float64) float64 {
	if total <= 0 {
		return 0
	}
	return 100 * used / total
}

func (m *pvhMonitor) updatedAt() string {
	var last time.Time
	for _, h := range m.hosts {
		if h.LastOK.After(last) {
			last = h.LastOK
		}
	}
	if last.IsZero() {
		return ""
	}
	return last.UTC().Format(time.RFC3339)
}

func (m *pvhMonitor) widgetHosts() response {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := []response{}
	state, notes := "ok", []string{}
	for _, h := range m.hosts {
		if !h.Online || h.Parsed == nil {
			items = append(items, response{"text": h.Config.Name + " · нет связи", "ok": false})
			state = "bad"
			continue
		}
		s := h.Parsed
		text := fmt.Sprintf("%s · CPU %.0f%% · память %.0f%%", h.Config.Name, s.Node.CPU, pct(s.Node.Mem.Used, s.Node.Mem.Total))
		if s.Node.CPUTemp != nil {
			text += fmt.Sprintf(" · %.0f °C", *s.Node.CPUTemp)
		}
		items = append(items, response{"text": text, "ok": true})
		running := 0
		for _, g := range s.Guests {
			if g.Status == "running" {
				running++
			}
		}
		notes = append(notes, fmt.Sprintf("%s: %d запущено", h.Config.Name, running))
	}
	if len(m.hosts) == 0 {
		state = "unknown"
	} else if state == "ok" && len(m.attentionLocked()) > 0 {
		state = "warn"
	}
	label := "Все хосты на связи"
	offline := []string{}
	for _, h := range m.hosts {
		if !h.Online {
			offline = append(offline, h.Config.Name)
		}
	}
	if len(offline) > 0 {
		label = "Нет связи: " + strings.Join(offline, ", ")
	} else if len(m.hosts) == 0 {
		label = "Хосты не настроены"
	}
	return response{"state": state, "updated_at": m.updatedAt(), "note": strings.Join(notes, " · "), "body": response{"label": label, "items": items}}
}

func (m *pvhMonitor) widgetTemps() response {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := []response{}
	state := "ok"
	for _, h := range m.hosts {
		if h.Parsed == nil || !h.Online {
			continue
		}
		s := h.Parsed
		if s.Node.CPUTemp != nil {
			st := tempState(*s.Node.CPUTemp, 80, 90)
			items = append(items, response{"text": h.Config.Name + " · процессор", "value": fmt.Sprintf("%.0f °C", *s.Node.CPUTemp), "state": st, "page": "pvehw"})
			state = worseState(state, st)
		}
		for _, d := range s.Disks {
			if d.Temp != nil {
				st := tempState(*d.Temp, 60, 70)
				items = append(items, response{"text": h.Config.Name + " · " + shortModel(d.Model, d.Dev), "value": fmt.Sprintf("%.0f °C", *d.Temp), "state": st, "page": "pvehw"})
				state = worseState(state, st)
			}
		}
	}
	if len(items) == 0 {
		state = "unknown"
	}
	more := 0
	if len(items) > 8 {
		more, items = len(items)-8, items[:8]
	}
	return response{"state": state, "updated_at": m.updatedAt(), "body": response{"items": items, "more": more}}
}

func (m *pvhMonitor) widgetGuests() response {
	m.mu.Lock()
	defer m.mu.Unlock()
	running, total, hosts := 0, 0, 0
	for _, h := range m.hosts {
		if h.Parsed == nil || !h.Online {
			continue
		}
		hosts++
		for _, g := range h.Parsed.Guests {
			if g.Template {
				continue
			}
			total++
			if g.Status == "running" {
				running++
			}
		}
	}
	state := "ok"
	if hosts == 0 {
		state = "unknown"
	}
	return response{"state": state, "updated_at": m.updatedAt(), "note": fmt.Sprintf("на %d хостах, всего %d", hosts, total),
		"body": response{"value": strconv.Itoa(running), "unit": "запущено"}}
}

func tempState(c, warn, bad float64) string {
	switch {
	case c >= bad:
		return "bad"
	case c >= warn:
		return "warn"
	}
	return "ok"
}

func worseState(a, b string) string {
	rank := map[string]int{"unknown": 0, "ok": 1, "warn": 2, "bad": 3}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

func shortModel(model, dev string) string {
	model = strings.TrimSpace(model)
	if model == "" {
		return dev
	}
	if len([]rune(model)) > 22 {
		return string([]rune(model)[:22]) + "…"
	}
	return model
}

func (m *pvhMonitor) attention() []response {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.attentionLocked()
}

func (m *pvhMonitor) attentionLocked() []response {
	items := []response{}
	add := func(id, severity, text, page string, since time.Time) {
		item := response{"id": id, "severity": severity, "text": text, "action": response{"label": "Открыть", "page": page}}
		if !since.IsZero() {
			item["since"] = since.UTC().Format(time.RFC3339)
		}
		items = append(items, item)
	}
	if m.loadErr != "" {
		add("config", "warning", "Proxmox: "+m.loadErr, "pve", time.Time{})
	}
	for _, h := range m.hosts {
		name, id := h.Config.Name, h.Config.ID
		if !h.Online {
			if !h.Checked.IsZero() {
				add(id+"-offline", "critical", fmt.Sprintf("%s (%s) не отвечает: %s", name, h.Config.Address, h.Error), "pve", h.Since)
			}
			continue
		}
		s := h.Parsed
		if s == nil {
			continue
		}
		if s.Node.CPUTemp != nil && *s.Node.CPUTemp >= 85 {
			add(id+"-cpu-temp", "warning", fmt.Sprintf("%s: процессор нагрелся до %.0f °C", name, *s.Node.CPUTemp), "pvehw", time.Time{})
		}
		if p := pct(s.Node.Mem.Used, s.Node.Mem.Total); p >= 92 {
			add(id+"-mem", "warning", fmt.Sprintf("%s: занято %.0f%% памяти", name, p), "pve", time.Time{})
		}
		if s.Node.Swap.Total > 0 && pct(s.Node.Swap.Used, s.Node.Swap.Total) >= 50 {
			add(id+"-swap", "info", fmt.Sprintf("%s: используется %.0f%% swap", name, pct(s.Node.Swap.Used, s.Node.Swap.Total)), "pve", time.Time{})
		}
		for _, st := range s.Storage {
			if st.Enabled && !st.Active {
				add(id+"-st-"+st.Name, "warning", fmt.Sprintf("%s: хранилище %s недоступно", name, st.Name), "pvestorage", time.Time{})
			} else if p := pct(st.Used, st.Total); st.Active && p >= 90 {
				add(id+"-st-"+st.Name, "warning", fmt.Sprintf("%s: хранилище %s заполнено на %.0f%%", name, st.Name, p), "pvestorage", time.Time{})
			}
		}
		for _, z := range s.ZFS {
			if z.Health != "ONLINE" {
				add(id+"-zfs-"+z.Name, "critical", fmt.Sprintf("%s: ZFS-пул %s в состоянии %s", name, z.Name, z.Health), "pvestorage", time.Time{})
			}
		}
		for _, d := range s.Disks {
			label := shortModel(d.Model, d.Dev)
			if d.Health != nil && !*d.Health {
				add(id+"-smart-"+d.Dev, "critical", fmt.Sprintf("%s: SMART диска %s сообщает о неисправности", name, label), "pvehw", time.Time{})
			}
			if d.Wear != nil && *d.Wear >= 80 {
				add(id+"-wear-"+d.Dev, "warning", fmt.Sprintf("%s: ресурс диска %s израсходован на %.0f%%", name, label, *d.Wear), "pvehw", time.Time{})
			}
			if d.Temp != nil && *d.Temp >= 65 {
				add(id+"-dtemp-"+d.Dev, "warning", fmt.Sprintf("%s: диск %s нагрелся до %.0f °C", name, label, *d.Temp), "pvehw", time.Time{})
			}
		}
		if len(s.FailedUnits) > 0 {
			add(id+"-units", "warning", fmt.Sprintf("%s: не работают службы: %s", name, strings.Join(s.FailedUnits, ", ")), "pve", time.Time{})
		}
		for _, b := range s.Backups {
			if b.Status != "OK" && b.Status != "running" && b.End > 0 && time.Since(time.Unix(b.End, 0)) < 48*time.Hour {
				add(id+"-backup-"+b.ID, "warning", fmt.Sprintf("%s: резервная копия %s завершилась с ошибкой: %s", name, b.ID, b.Status), "pvestorage", time.Unix(b.End, 0))
				break
			}
		}
	}
	// A cluster is reported by each of its members: say it once.
	seen := map[string]bool{}
	for _, h := range m.hosts {
		if !h.Online || h.Parsed == nil || h.Parsed.Cluster.Name == "" {
			continue
		}
		c := h.Parsed.Cluster
		if !c.Quorate && !seen["quorum"] {
			seen["quorum"] = true
			add("cluster-quorum", "critical", fmt.Sprintf("Кластер %s без кворума: изменения конфигурации и запуск машин заблокированы", c.Name), "pve", time.Time{})
		}
		for _, n := range c.Nodes {
			if !n.Online && !seen["node-"+n.Name] {
				seen["node-"+n.Name] = true
				add("cluster-node-"+n.Name, "critical", fmt.Sprintf("Кластер %s: узел %s (%s) не в сети", c.Name, n.Name, n.IP), "pve", time.Time{})
			}
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i]["severity"] == "critical" && items[j]["severity"] != "critical" })
	return items
}
