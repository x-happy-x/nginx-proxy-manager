package main

import (
	"bytes"
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func pcMagicPacket(mac string) ([]byte, error) {
	hw, err := net.ParseMAC(mac)
	if err != nil || len(hw) != 6 || hw[0]&1 != 0 || bytes.Equal(hw, make([]byte, 6)) {
		return nil, fmt.Errorf("Нужен MAC сетевого адаптера компьютера")
	}
	packet := bytes.Repeat([]byte{255}, 6)
	for i := 0; i < 16; i++ {
		packet = append(packet, hw...)
	}
	return packet, nil
}

func pcSendWake(cfg pcHostConfig) error {
	packet, err := pcMagicPacket(cfg.MAC)
	if err != nil {
		return err
	}
	address := cfg.Broadcast
	if address == "" {
		address = "255.255.255.255"
	}
	ip := net.ParseIP(address)
	if ip == nil || ip.To4() == nil {
		return fmt.Errorf("Некорректный IPv4 адрес WoL")
	}
	connection, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: ip, Port: 9})
	if err != nil {
		return err
	}
	defer connection.Close()
	connection.SetWriteDeadline(time.Now().Add(3 * time.Second))
	_, err = connection.Write(packet)
	return err
}

func (m *pcMonitor) runWakeTask(task *pcTask) {
	send := m.wake
	if send == nil {
		send = pcSendWake
	}
	err := send(task.config)
	m.mu.Lock()
	defer m.mu.Unlock()
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	task.Status = "done"
	task.Message = "Пакет WoL отправлен. Дождитесь появления компьютера в сети."
	if err != nil {
		task.Status = "error"
		task.Message = "Не удалось отправить WoL: " + err.Error()
	}
	m.journal.result(task.Host, task.ID, task.Status, task.Message)
	m.saveStateLocked()
}

// An unreachable SSH endpoint is treated as off, like HA's WoL host probe.
// Authentication/agent errors stay unknown; stale observations are never on/off.
func (m *pcMonitor) powerInfoLocked(h *pcHost) response {
	state := "unavailable"
	fresh := !h.Checked.IsZero() && time.Since(h.Checked) < 90*time.Second
	if fresh && h.Online && h.Current != nil && h.Current.TS >= time.Now().Unix()-120 && h.Current.TS <= time.Now().Unix()+30 {
		state = "on"
	}
	if fresh && !h.Online {
		if h.PowerReachable != nil {
			if *h.PowerReachable {
				state = "on"
			} else {
				state = "off"
			}
		}
		e := strings.ToLower(h.Error)
		for _, s := range []string{"connection refused", "no route to host", "connection timed out", "connect failed"} {
			if strings.Contains(e, s) {
				state = "off"
			}
		}
	}
	actions := []string{}
	if h.Config.PowerEnabled {
		if _, err := pcMagicPacket(h.Config.MAC); err == nil {
			actions = append(actions, "start")
		}
		if state == "on" && h.Online && h.Current != nil && h.Current.TS >= time.Now().Unix()-120 && h.Current.TS <= time.Now().Unix()+30 && pcIncludes(h.Current.Capabilities.PowerActions, "shutdown") {
			actions = append(actions, "shutdown")
		}
	}
	busy := false
	for _, t := range m.tasks {
		if t.Host == h.Config.ID && (t.Status == "running" || t.Status == "unknown" && time.Since(t.created) < 2*time.Minute) {
			busy = true
		}
	}
	return response{"enabled": h.Config.PowerEnabled, "state": state, "actions": actions, "busy": busy}
}

// A dedicated token grants only power operations on explicitly enabled PCs.
// Provision it over SSH at PC_DIR/power-token (0600); it is never returned by an API.
func (a *app) handlePCPowerIntegration(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if pcm == nil {
		a.writeJSON(w, 503, response{"ok": false})
		return
	}
	secret, err := os.ReadFile(filepath.Join(pcm.dir, "power-token"))
	supplied := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	token := strings.TrimSpace(string(secret))
	if err != nil || len(token) < 32 || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(token), []byte(supplied)) != 1 {
		a.writeJSON(w, 401, response{"ok": false, "error": "authentication required"})
		return
	}
	if r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		a.writeJSON(w, 403, response{"ok": false})
		return
	}
	a.handlePCPower(w, r)
}

func (a *app) handlePCPower(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		pcm.mu.Lock()
		hosts := []response{}
		for _, h := range pcm.hosts {
			if h.Config.PowerEnabled {
				hosts = append(hosts, response{"id": h.Config.ID, "name": h.Config.Name, "power": pcm.powerInfoLocked(h)})
			}
		}
		pcm.mu.Unlock()
		a.writeJSON(w, 200, response{"hosts": hosts})
	case http.MethodPost:
		var body struct {
			Host string `json:"host"`
			On   *bool  `json:"on"`
		}
		if decodePCJSON(w, r, &body) != nil || body.On == nil {
			a.writeJSON(w, 400, response{"ok": false, "error": "host and on required"})
			return
		}
		action := "shutdown"
		if *body.On {
			action = "start"
		}
		pcm.mu.Lock()
		h := pcm.find(body.Host)
		name := ""
		already := false
		if h != nil {
			name = h.Config.Name
			state := pcm.powerInfoLocked(h)["state"]
			already = h.Config.PowerEnabled && (state == "on" && *body.On || state == "off" && !*body.On)
		}
		pcm.mu.Unlock()
		if already {
			a.writeJSON(w, 200, response{"ok": true, "unchanged": true})
			return
		}
		task, status, err := pcm.submitAction(pcAction{Host: body.Host, Target: "power", Action: action, Confirm: name})
		if err != nil {
			a.writeJSON(w, status, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, 202, response{"ok": true, "task": task})
	default:
		w.Header().Set("Allow", "GET, POST")
		a.writeJSON(w, 405, response{"ok": false})
	}
}
