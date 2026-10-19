package main

// NPM-75: the «Сервера» settings page. Servers are kept in PVE_DIR/hosts.json and
// can be added, changed and removed from the UI. The router's key is shown so it
// can be authorized on a host for the agent's read-only forced command; a host key
// is pinned once, after an explicit «Проверить и доверять» on that page.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

var (
	pvhIDRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	pvhUserRe = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	pvhHostRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
)

func validatePVHHosts(hosts []pvhHostConfig) error {
	if len(hosts) > 32 {
		return fmt.Errorf("не больше 32 серверов")
	}
	seen := map[string]bool{}
	for i, h := range hosts {
		n := i + 1
		if !pvhIDRe.MatchString(h.ID) {
			return fmt.Errorf("сервер %d: идентификатор — латиница в нижнем регистре, цифры и дефис, до 32 символов", n)
		}
		if seen[h.ID] {
			return fmt.Errorf("сервер %d: идентификатор %s повторяется", n, h.ID)
		}
		seen[h.ID] = true
		if name := strings.TrimSpace(h.Name); name == "" || len([]rune(name)) > 40 || strings.ContainsAny(name, "<>\n\r") {
			return fmt.Errorf("сервер %s: имя от 1 до 40 символов", h.ID)
		}
		if net.ParseIP(h.Address) == nil && !pvhHostRe.MatchString(h.Address) {
			return fmt.Errorf("сервер %s: адрес — IP или имя хоста", h.ID)
		}
		if h.Port < 1 || h.Port > 65535 {
			return fmt.Errorf("сервер %s: порт от 1 до 65535", h.ID)
		}
		if !pvhUserRe.MatchString(h.User) {
			return fmt.Errorf("сервер %s: недопустимое имя пользователя", h.ID)
		}
	}
	return nil
}

func (m *pvhMonitor) keyPath() string { return filepath.Join(m.dir, "id_dropbear") }

// publicKey returns the router's key in OpenSSH form, creating the key on first use.
func (m *pvhMonitor) publicKey(ctx context.Context) (string, error) {
	tool := getenv("PVE_KEYGEN", "/opt/bin/dropbearkey")
	if _, err := os.Stat(m.keyPath()); os.IsNotExist(err) {
		if err := os.MkdirAll(m.dir, 0700); err != nil {
			return "", err
		}
		if out, err := exec.CommandContext(ctx, tool, "-t", "ed25519", "-f", m.keyPath()).CombinedOutput(); err != nil {
			return "", fmt.Errorf("ключ не создан: %s", strings.TrimSpace(string(out)))
		}
	}
	out, err := exec.CommandContext(ctx, tool, "-y", "-f", m.keyPath()).Output()
	if err != nil {
		return "", fmt.Errorf("ключ не читается")
	}
	for _, line := range strings.Split(string(out), "\n") {
		if f := strings.Fields(line); len(f) >= 2 && strings.HasPrefix(f[0], "ssh-") {
			return f[0] + " " + f[1] + " homenet-servers@router", nil
		}
	}
	return "", fmt.Errorf("ключ не распознан")
}

// knownHost reports whether a host key is pinned for the address.
func (m *pvhMonitor) knownHost(address string) bool {
	b, err := os.ReadFile(filepath.Join(m.dir, ".ssh", "known_hosts"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if f := strings.Fields(line); len(f) >= 2 {
			for _, name := range strings.Split(f[0], ",") {
				if name == address {
					return true
				}
			}
		}
	}
	return false
}

func (m *pvhMonitor) saveHosts(hosts []pvhHostConfig) error {
	b, err := json.MarshalIndent(map[string]any{"hosts": hosts}, "", "  ")
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

// applyHosts swaps the list, keeping the collected state of servers whose address did not change.
func (m *pvhMonitor) applyHosts(hosts []pvhHostConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old := map[string]*pvhHost{}
	for _, h := range m.hosts {
		old[h.Config.ID] = h
	}
	next := make([]*pvhHost, 0, len(hosts))
	for _, c := range hosts {
		if h := old[c.ID]; h != nil && h.Config.Address == c.Address && h.Config.Port == c.Port && h.Config.User == c.User {
			h.Config = c
			next = append(next, h)
			continue
		}
		next = append(next, &pvhHost{Config: c})
	}
	m.hosts, m.loadErr = next, ""
}

func (a *app) handlePVEConfig(w http.ResponseWriter, r *http.Request) {
	m := pvh
	switch {
	case r.URL.Path == "/api/pve/config" && r.Method == http.MethodGet:
		key, err := m.publicKey(r.Context())
		m.mu.Lock()
		hosts := []response{}
		for _, h := range m.hosts {
			hosts = append(hosts, response{"id": h.Config.ID, "name": h.Config.Name, "address": h.Config.Address, "port": h.Config.Port, "user": h.Config.User, "pinned": m.knownHost(h.Config.Address)})
		}
		m.mu.Unlock()
		out := response{"hosts": hosts, "public_key": key}
		if err != nil {
			out["key_error"] = err.Error()
		}
		a.writeJSON(w, 200, out)
	case r.URL.Path == "/api/pve/config" && (r.Method == http.MethodPut || r.Method == http.MethodPost):
		var body struct {
			Hosts []pvhHostConfig `json:"hosts"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": "invalid_json"})
			return
		}
		for i := range body.Hosts {
			h := &body.Hosts[i]
			h.ID, h.Name, h.Address, h.User = strings.TrimSpace(h.ID), strings.TrimSpace(h.Name), strings.TrimSpace(h.Address), strings.TrimSpace(h.User)
			if h.Port == 0 {
				h.Port = 22
			}
			if h.User == "" {
				h.User = "root"
			}
		}
		if err := validatePVHHosts(body.Hosts); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
			return
		}
		if err := m.saveHosts(body.Hosts); err != nil {
			a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
			return
		}
		m.applyHosts(body.Hosts)
		managedGo(m.pollAll)
		a.writeJSON(w, 200, response{"ok": true})
	case r.URL.Path == "/api/pve/config/test" && r.Method == http.MethodPost:
		var h pvhHostConfig
		var body struct {
			pvhHostConfig
			Trust bool `json:"trust"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": "invalid_json"})
			return
		}
		h = body.pvhHostConfig
		h.ID, h.Name = "test", "test"
		if h.Port == 0 {
			h.Port = 22
		}
		if h.User == "" {
			h.User = "root"
		}
		if err := validatePVHHosts([]pvhHostConfig{h}); err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, 200, m.test(r.Context(), h, body.Trust))
	default:
		http.Error(w, "method not allowed", 405)
	}
}

// test asks the agent for «ping». Without trust an unknown host key fails the check;
// with trust dbclient pins it (-y) and reports the fingerprint it accepted.
func (m *pvhMonitor) test(ctx context.Context, h pvhHostConfig, trust bool) response {
	pinned := m.knownHost(h.Address)
	if !pinned && !trust {
		return response{"ok": false, "pinned": false, "error": "Ключ этого сервера ещё не закреплён — нажмите «Проверить и доверять»"}
	}
	if _, err := m.publicKey(ctx); err != nil {
		return response{"ok": false, "error": err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	args := []string{"-T", "-i", m.keyPath(), "-p", strconv.Itoa(h.Port)}
	if !pinned {
		args = append(args, "-y")
	}
	args = append(args, h.User+"@"+h.Address, "ping")
	_ = os.MkdirAll(filepath.Join(m.dir, ".ssh"), 0700)
	cmd := exec.CommandContext(ctx, m.client, args...)
	cmd.Env = append(os.Environ(), "HOME="+m.dir)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	started := time.Now()
	err := cmd.Run()
	res := response{"latency_ms": time.Since(started).Milliseconds(), "pinned": m.knownHost(h.Address)}
	if fp := regexp.MustCompile(`(?i)fingerprint (?:is )?(\S+)`).FindStringSubmatch(errb.String()); fp != nil {
		res["fingerprint"] = strings.TrimRight(fp[1], ").")
	}
	if err != nil {
		msg := strings.TrimSpace(errb.String())
		if ctx.Err() != nil {
			msg = "нет ответа за 12 с"
		}
		if i := strings.LastIndex(msg, "\n"); i >= 0 {
			msg = msg[i+1:]
		}
		if strings.Contains(msg, "unsupported request") || strings.Contains(msg, "Permission denied") || strings.Contains(msg, "No auth methods") {
			msg += " — проверьте, что ключ роутера добавлен на сервер командой установки агента"
		}
		res["ok"], res["error"] = false, msg
		return res
	}
	var ping struct {
		OK    bool   `json:"ok"`
		Agent string `json:"agent"`
		Host  string `json:"host"`
	}
	if json.Unmarshal(out.Bytes(), &ping) != nil || !ping.OK {
		res["ok"], res["error"] = false, "сервер ответил не как агент HomeNet"
		return res
	}
	res["ok"], res["agent"], res["host"] = true, ping.Agent, ping.Host
	return res
}
