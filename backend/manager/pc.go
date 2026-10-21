package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type pcHostConfig struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Address string `json:"address"`
	Port    int    `json:"port"`
	User    string `json:"user"`
}

type pcSnapshot struct {
	V      int    `json:"v"`
	TS     int64  `json:"ts"`
	Host   string `json:"host"`
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	Agent  string `json:"agent"`
	Uptime int64  `json:"uptime"`
	CPU    struct {
		Percent *float64 `json:"percent"`
		Cores   int      `json:"cores"`
		Model   string   `json:"model"`
	} `json:"cpu"`
	Memory struct {
		Total     uint64 `json:"total"`
		Used      uint64 `json:"used"`
		Available uint64 `json:"available"`
	} `json:"memory"`
	Disks []struct {
		Path  string `json:"path"`
		Total uint64 `json:"total"`
		Used  uint64 `json:"used"`
		Free  uint64 `json:"free"`
	} `json:"disks"`
	Network []struct {
		Name      string `json:"name"`
		RX        uint64 `json:"rx_bytes"`
		TX        uint64 `json:"tx_bytes"`
		Aggregate bool   `json:"aggregate"`
	} `json:"network"`
	WSL []struct {
		Name    string `json:"name"`
		State   string `json:"state"`
		Version int    `json:"version"`
	} `json:"wsl"`
	Docker []struct {
		Context    string `json:"context"`
		Available  bool   `json:"available"`
		Error      string `json:"error,omitempty"`
		Containers []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Image  string `json:"image"`
			State  string `json:"state"`
			Status string `json:"status"`
			Ports  string `json:"ports"`
		} `json:"containers"`
	} `json:"docker"`
	Capabilities struct {
		DockerActions []string `json:"docker_actions"`
		WSLActions    []string `json:"wsl_actions"`
	} `json:"capabilities"`
	Errors []string `json:"errors"`
}

type pcSample struct {
	T        int64    `json:"t"`
	CPU      *float64 `json:"cpu"`
	MemUsed  uint64   `json:"mem_used"`
	MemTotal uint64   `json:"mem_total"`
	RX       float64  `json:"net_rx_bps"`
	TX       float64  `json:"net_tx_bps"`
}

type pcHost struct {
	Config    pcHostConfig
	Online    bool
	Error     string
	Checked   time.Time
	LastOK    time.Time
	LatencyMS int64
	Current   *pcSnapshot
	History   []pcSample
}

type pcMonitor struct {
	mu       sync.Mutex
	pollMu   sync.Mutex
	configMu sync.Mutex
	dir      string
	client   string
	hosts    []*pcHost
	tasks    []*pcTask
	loadErr  string
	request  func(context.Context, pcHostConfig, string, bool) ([]byte, string, error)
}

var pcm *pcMonitor

func newPCMonitor() *pcMonitor {
	m := &pcMonitor{dir: getenv("PC_DIR", "/opt/etc/homenet/pc"), client: getenv("PC_SSH_CLIENT", "/opt/bin/dbclient")}
	b, err := os.ReadFile(filepath.Join(m.dir, "hosts.json"))
	if os.IsNotExist(err) {
		return m
	}
	if err != nil {
		m.loadErr = "Список компьютеров не читается: " + err.Error()
		return m
	}
	var data struct {
		Hosts []pcHostConfig `json:"hosts"`
	}
	if json.Unmarshal(b, &data) != nil {
		m.loadErr = "Список компьютеров повреждён"
		return m
	}
	normalizePCHosts(data.Hosts)
	if err := validatePCHosts(data.Hosts); err != nil {
		m.loadErr = err.Error()
		return m
	}
	for _, cfg := range data.Hosts {
		m.hosts = append(m.hosts, &pcHost{Config: cfg, History: []pcSample{}})
	}
	return m
}

func (a *app) startPC() { pcm = newPCMonitor(); every(30*time.Second, pcm.pollAll) }

func (m *pcMonitor) fetch(ctx context.Context, h pcHostConfig, command string, trust bool) ([]byte, string, error) {
	if m.request != nil {
		return m.request(ctx, h, command, trust)
	}
	if !m.knownHost(h) && !trust {
		return nil, "", fmt.Errorf("Ключ компьютера не закреплён; сначала проверьте подключение и доверие")
	}
	timeout := 35 * time.Second
	if strings.HasPrefix(command, "control ") {
		timeout = 90 * time.Second
	}
	if command == "ping" {
		timeout = 12 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := []string{"-T", "-i", m.keyPath(), "-p", strconv.Itoa(h.Port)}
	if trust && !m.knownHost(h) {
		args = append(args, "-y")
	}
	args = append(args, h.User+"@"+h.Address, command)
	cmd := exec.CommandContext(ctx, m.client, args...)
	cmd.Env = append(os.Environ(), "HOME="+m.dir)
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	err := cmd.Run()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if ctx.Err() != nil {
			msg = "Истекло время ожидания ответа компьютера"
		}
		if i := strings.LastIndex(msg, "\n"); i >= 0 {
			msg = msg[i+1:]
		}
		if msg == "" {
			msg = err.Error()
		}
		return out.Bytes(), stderr.String(), fmt.Errorf("%s", msg)
	}
	return out.Bytes(), stderr.String(), nil
}

func (m *pcMonitor) find(id string) *pcHost {
	for _, h := range m.hosts {
		if h.Config.ID == id {
			return h
		}
	}
	return nil
}

func (m *pcMonitor) pollAll() {
	m.pollMu.Lock()
	defer m.pollMu.Unlock()
	m.mu.Lock()
	hosts := append([]*pcHost(nil), m.hosts...)
	m.mu.Unlock()
	var wg sync.WaitGroup
	limit := make(chan struct{}, 4)
	for _, h := range hosts {
		wg.Add(1)
		go func(h *pcHost) { defer wg.Done(); limit <- struct{}{}; defer func() { <-limit }(); m.poll(h) }(h)
	}
	wg.Wait()
}

func (m *pcMonitor) poll(h *pcHost) {
	start := time.Now()
	m.mu.Lock()
	cfg := h.Config
	m.mu.Unlock()
	b, _, err := m.fetch(workerContext, cfg, "snapshot", false)
	var snap pcSnapshot
	if err == nil {
		err = json.Unmarshal(b, &snap)
		if err == nil && (snap.V != 1 || snap.Host == "" || (snap.OS != "linux" && snap.OS != "windows") || snap.TS < time.Now().Unix()-120 || snap.TS > time.Now().Unix()+30) {
			err = fmt.Errorf("Агент вернул несовместимые или устаревшие данные")
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// A response from an old address must not replace a newly configured host.
	if m.find(cfg.ID) != h || h.Config.Address != cfg.Address || h.Config.Port != cfg.Port || h.Config.User != cfg.User {
		return
	}
	h.Checked = time.Now()
	h.LatencyMS = time.Since(start).Milliseconds()
	h.Online = err == nil
	if err != nil {
		h.Error = err.Error()
		return
	}
	h.Error = ""
	h.LastOK = h.Checked
	point := pcSample{T: snap.TS / 60 * 60, CPU: snap.CPU.Percent, MemUsed: snap.Memory.Used, MemTotal: snap.Memory.Total}
	if prev := h.Current; prev != nil && snap.TS > prev.TS && snap.TS-prev.TS < 300 {
		old := map[string][2]uint64{}
		for _, n := range prev.Network {
			if n.Aggregate {
				old[n.Name] = [2]uint64{n.RX, n.TX}
			}
		}
		for _, n := range snap.Network {
			if !n.Aggregate {
				continue
			}
			if p, ok := old[n.Name]; ok {
				if n.RX >= p[0] {
					point.RX += float64(n.RX-p[0]) * 8 / float64(snap.TS-prev.TS)
				}
				if n.TX >= p[1] {
					point.TX += float64(n.TX-p[1]) * 8 / float64(snap.TS-prev.TS)
				}
			}
		}
	}
	h.Current = &snap
	if n := len(h.History); n > 0 && h.History[n-1].T == point.T {
		h.History[n-1] = point
	} else {
		h.History = append(h.History, point)
	}
	if len(h.History) > 1440 {
		h.History = h.History[len(h.History)-1440:]
	}
}

func (a *app) handlePC(w http.ResponseWriter, r *http.Request) {
	if pcm == nil {
		a.writeJSON(w, 503, response{"ok": false, "error": "Интеграция не запущена"})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/pc/config") {
		a.handlePCConfig(w, r)
		return
	}
	if r.URL.Path == "/api/pc/actions" || r.URL.Path == "/api/pc/tasks" {
		a.handlePCActions(w, r)
		return
	}
	if r.Method != http.MethodGet {
		a.writeJSON(w, 405, response{"ok": false, "error": "method not allowed"})
		return
	}
	switch r.URL.Path {
	case "/api/pc/overview":
		a.writeJSON(w, 200, pcm.overview())
	case "/api/pc/history":
		pcm.mu.Lock()
		h := pcm.find(r.URL.Query().Get("host"))
		points := []pcSample{}
		if h != nil {
			points = append(points, h.History...)
		}
		pcm.mu.Unlock()
		if h == nil {
			a.writeJSON(w, 404, response{"ok": false, "error": "Компьютер не найден"})
			return
		}
		a.writeJSON(w, 200, response{"step": 60, "points": points})
	case "/api/pc/widgets/hosts":
		a.writeJSON(w, 200, pcm.widget())
	case "/api/pc/summary/attention":
		a.writeJSON(w, 200, response{"items": pcm.attention()})
	default:
		http.NotFound(w, r)
	}
}

func (m *pcMonitor) overview() response {
	m.mu.Lock()
	defer m.mu.Unlock()
	hosts := []response{}
	for _, h := range m.hosts {
		item := response{"id": h.Config.ID, "name": h.Config.Name, "address": h.Config.Address, "online": h.Online, "error": h.Error, "current": h.Current, "latency_ms": h.LatencyMS}
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

func (m *pcMonitor) widget() response {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := []response{}
	state := "ok"
	var updated time.Time
	for _, h := range m.hosts {
		text := h.Config.Name + " · нет связи"
		if h.Online && h.Current != nil {
			text = fmt.Sprintf("%s · %s · память %.0f%%", h.Config.Name, h.Current.OS, pct(float64(h.Current.Memory.Used), float64(h.Current.Memory.Total)))
			if h.Current.CPU.Percent != nil {
				text += fmt.Sprintf(" · CPU %.0f%%", *h.Current.CPU.Percent)
			}
		} else {
			state = "warn"
		}
		items = append(items, response{"text": text, "ok": h.Online})
		if h.LastOK.After(updated) {
			updated = h.LastOK
		}
	}
	if len(items) == 0 {
		state = "unknown"
	}
	stamp := ""
	if !updated.IsZero() {
		stamp = updated.UTC().Format(time.RFC3339)
	}
	return response{"state": state, "updated_at": stamp, "body": response{"label": fmt.Sprintf("Компьютеров: %d", len(items)), "items": items}}
}

func (m *pcMonitor) attention() []response {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := []response{}
	add := func(id, text string) {
		items = append(items, response{"id": id, "severity": "warning", "text": text, "action": response{"label": "Открыть", "page": "pc"}})
	}
	if m.loadErr != "" {
		add("config", m.loadErr)
	}
	for _, h := range m.hosts {
		if !h.Online {
			if !h.Checked.IsZero() {
				add(h.Config.ID+"-offline", h.Config.Name+": нет связи с агентом")
			}
			continue
		}
		if s := h.Current; s != nil {
			if pct(float64(s.Memory.Used), float64(s.Memory.Total)) >= 92 {
				add(h.Config.ID+"-mem", h.Config.Name+": занято больше 92% памяти")
			}
			for i, d := range s.Disks {
				if pct(float64(d.Used), float64(d.Total)) >= 90 {
					add(fmt.Sprintf("%s-disk-%d", h.Config.ID, i), h.Config.Name+": заполнен диск "+d.Path)
				}
			}
		}
	}
	return items
}
