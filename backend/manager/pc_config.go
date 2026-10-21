package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var pcUserRE = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`)

func normalizePCHosts(hosts []pcHostConfig) {
	for i := range hosts {
		h := &hosts[i]
		h.ID = strings.TrimSpace(h.ID)
		h.Name = strings.TrimSpace(h.Name)
		h.Address = strings.TrimSpace(h.Address)
		h.User = strings.TrimSpace(h.User)
		if h.Port == 0 {
			h.Port = 22
		}
	}
}

func validatePCHosts(hosts []pcHostConfig) error {
	if len(hosts) > 32 {
		return fmt.Errorf("Не больше 32 компьютеров")
	}
	seen := map[string]bool{}
	for _, h := range hosts {
		if !pvhIDRe.MatchString(h.ID) || seen[h.ID] {
			return fmt.Errorf("Идентификатор должен быть уникальным: латиница в нижнем регистре, цифры и дефис, до 32 символов")
		}
		seen[h.ID] = true
		if h.Name == "" || len([]rune(h.Name)) > 40 || strings.ContainsAny(h.Name, "<>\r\n") {
			return fmt.Errorf("Имя компьютера: от 1 до 40 символов")
		}
		if net.ParseIP(h.Address) == nil && !pvhHostRe.MatchString(h.Address) {
			return fmt.Errorf("Адрес компьютера: IP или имя хоста")
		}
		if h.Port < 1 || h.Port > 65535 {
			return fmt.Errorf("Порт: от 1 до 65535")
		}
		if !pcUserRE.MatchString(h.User) {
			return fmt.Errorf("Укажите локального SSH-пользователя (латиница, цифры, точка, дефис и подчёркивание)")
		}
	}
	return nil
}

func (m *pcMonitor) keyPath() string { return filepath.Join(m.dir, "id_dropbear") }

func (m *pcMonitor) publicKey(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tool := getenv("PC_KEYGEN", "/opt/bin/dropbearkey")
	if err := os.MkdirAll(filepath.Join(m.dir, ".ssh"), 0700); err != nil {
		return "", err
	}
	if _, err := os.Stat(m.keyPath()); os.IsNotExist(err) {
		if _, err := exec.CommandContext(ctx, tool, "-t", "ed25519", "-f", m.keyPath()).CombinedOutput(); err != nil {
			return "", fmt.Errorf("Не удалось создать SSH-ключ компьютеров")
		}
	}
	out, err := exec.CommandContext(ctx, tool, "-y", "-f", m.keyPath()).Output()
	if err != nil {
		return "", fmt.Errorf("SSH-ключ не читается")
	}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && strings.HasPrefix(f[0], "ssh-") {
			return f[0] + " " + f[1] + " homenet-pc@router", nil
		}
	}
	return "", fmt.Errorf("SSH-ключ не распознан")
}

func (m *pcMonitor) knownHost(h pcHostConfig) bool {
	b, err := os.ReadFile(filepath.Join(m.dir, ".ssh", "known_hosts"))
	if err != nil {
		return false
	}
	want := "[" + h.Address + "]:" + strconv.Itoa(h.Port)
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		for _, name := range strings.Split(f[0], ",") {
			if name == want || (h.Port == 22 && name == h.Address) {
				return true
			}
		}
	}
	return false
}

func (m *pcMonitor) saveHosts(hosts []pcHostConfig) error {
	b, err := json.MarshalIndent(response{"hosts": hosts}, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(m.dir, 0700); err != nil {
		return err
	}
	tmp := filepath.Join(m.dir, ".hosts.json.tmp")
	if err = os.WriteFile(tmp, append(b, '\n'), 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(m.dir, "hosts.json"))
}

func (m *pcMonitor) applyHosts(hosts []pcHostConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := make([]*pcHost, 0, len(hosts))
	for _, cfg := range hosts {
		h := m.find(cfg.ID)
		if h == nil || h.Config.Address != cfg.Address || h.Config.Port != cfg.Port || h.Config.User != cfg.User {
			h = &pcHost{History: []pcSample{}}
		}
		h.Config = cfg
		next = append(next, h)
	}
	m.hosts = next
	m.loadErr = ""
}

func decodePCJSON(w http.ResponseWriter, r *http.Request, out any) error {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("Ожидается один JSON-документ")
	}
	return nil
}

func (a *app) handlePCConfig(w http.ResponseWriter, r *http.Request) {
	m := pcm
	switch {
	case r.URL.Path == "/api/pc/config" && r.Method == http.MethodGet:
		m.configMu.Lock()
		key, err := m.publicKey(r.Context())
		m.configMu.Unlock()
		m.mu.Lock()
		hosts := []response{}
		for _, h := range m.hosts {
			hosts = append(hosts, response{"id": h.Config.ID, "name": h.Config.Name, "address": h.Config.Address, "port": h.Config.Port, "user": h.Config.User, "pinned": m.knownHost(h.Config)})
		}
		m.mu.Unlock()
		out := response{"hosts": hosts, "public_key": key}
		if err != nil {
			out["key_error"] = err.Error()
		}
		a.writeJSON(w, 200, out)
	case r.URL.Path == "/api/pc/config" && r.Method == http.MethodPut:
		var body struct {
			Hosts []pcHostConfig `json:"hosts"`
		}
		if err := decodePCJSON(w, r, &body); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": "Некорректный список компьютеров"})
			return
		}
		normalizePCHosts(body.Hosts)
		if err := validatePCHosts(body.Hosts); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
			return
		}
		m.configMu.Lock()
		err := m.saveHosts(body.Hosts)
		if err == nil {
			m.applyHosts(body.Hosts)
		}
		m.configMu.Unlock()
		if err != nil {
			a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
			return
		}
		managedGo(m.pollAll)
		a.writeJSON(w, 200, response{"ok": true})
	case r.URL.Path == "/api/pc/config/test" && r.Method == http.MethodPost:
		var body struct {
			pcHostConfig
			Trust bool `json:"trust"`
		}
		if err := decodePCJSON(w, r, &body); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": "Некорректные параметры подключения"})
			return
		}
		body.ID, body.Name = "test", "test"
		hosts := []pcHostConfig{body.pcHostConfig}
		normalizePCHosts(hosts)
		if err := validatePCHosts(hosts); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, 200, m.test(r.Context(), hosts[0], body.Trust))
	default:
		a.writeJSON(w, 405, response{"ok": false, "error": "method not allowed"})
	}
}

func (m *pcMonitor) test(ctx context.Context, cfg pcHostConfig, trust bool) response {
	if !m.knownHost(cfg) && !trust {
		return response{"ok": false, "pinned": false, "error": "Ключ компьютера не закреплён — нажмите «Проверить и доверять»"}
	}
	m.configMu.Lock()
	_, err := m.publicKey(ctx)
	m.configMu.Unlock()
	if err != nil {
		return response{"ok": false, "error": err.Error()}
	}
	start := time.Now()
	b, stderr, err := m.fetch(ctx, cfg, "ping", trust)
	out := response{"pinned": m.knownHost(cfg), "latency_ms": time.Since(start).Milliseconds()}
	if fp := regexp.MustCompile(`(?i)fingerprint (?:is )?(\S+)`).FindStringSubmatch(stderr); len(fp) > 1 {
		out["fingerprint"] = strings.TrimRight(fp[1], ").")
	}
	if err != nil {
		out["ok"], out["error"] = false, err.Error()
		return out
	}
	var ping struct {
		OK    bool   `json:"ok"`
		Agent string `json:"agent"`
		Host  string `json:"host"`
		OS    string `json:"os"`
	}
	if json.Unmarshal(b, &ping) != nil || !ping.OK || ping.Host == "" || (ping.OS != "linux" && ping.OS != "windows") {
		out["ok"], out["error"] = false, "Компьютер ответил не как агент HomeNet PC"
		return out
	}
	out["ok"], out["agent"], out["host"], out["os"] = true, ping.Agent, ping.Host, ping.OS
	return out
}
