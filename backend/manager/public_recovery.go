package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

type publicTransportError struct{ error }

func (e publicTransportError) Unwrap() error { return e.error }

type publicRecoveryBudget struct {
	ProbeWindow time.Time            `json:"probe_window"`
	LastProbe   time.Time            `json:"last_probe"`
	Probes      int                  `json:"probes"`
	Window      time.Time            `json:"window"`
	LastAttempt time.Time            `json:"last_attempt"`
	Attempts    int                  `json:"attempts"`
	Blocked     string               `json:"blocked,omitempty"`
	Failed      map[string]time.Time `json:"failed,omitempty"`
}

func (m *publicServerManager) reservePublicBanner(s publicServer, now time.Time) (time.Duration, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := m.loadRecovery(s)
	if err != nil {
		return 0, err
	}
	if b.Blocked != "" {
		return 0, fmt.Errorf("SSH-проверки остановлены")
	}
	if !b.LastProbe.IsZero() && now.Before(b.LastProbe) {
		return publicRecoveryWindow, nil
	}
	if b.ProbeWindow.IsZero() || now.Sub(b.ProbeWindow) >= publicRecoveryWindow {
		b.ProbeWindow = now
		b.Probes = 0
	}
	if b.Probes >= publicRecoveryAttempts {
		return b.ProbeWindow.Add(publicRecoveryWindow).Sub(now), nil
	}
	if next := b.LastProbe.Add(publicRecoveryInterval); now.Before(next) {
		return next.Sub(now), nil
	}
	b.LastProbe = now
	b.Probes++
	if err := integration.AtomicJSON(m.recoveryPath(s), b); err != nil {
		return 0, err
	}
	return 0, nil
}

const publicRecoveryInterval = time.Minute
const publicRecoveryWindow = 30 * time.Minute
const publicRecoveryAttempts = 6

func (m *publicServerManager) recoveryPath(s publicServer) string {
	return filepath.Join(m.dir, "recovery-"+configSHA([]byte(strings.ToLower(s.Address)+fmt.Sprint(":", s.Port)))+".json")
}
func (m *publicServerManager) loadRecovery(s publicServer) (publicRecoveryBudget, error) {
	var b publicRecoveryBudget
	raw, err := os.ReadFile(m.recoveryPath(s))
	if os.IsNotExist(err) {
		return b, nil
	}
	if err != nil {
		return b, err
	}
	err = json.Unmarshal(raw, &b)
	return b, err
}
func (m *publicServerManager) reservePublicRecovery(s publicServer, now time.Time) (time.Duration, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := m.loadRecovery(s)
	if err != nil {
		return 0, fmt.Errorf("Журнал ограничений проверок не читается: %w", err)
	}
	if b.Blocked != "" {
		return 0, fmt.Errorf("Автопроверки SSH остановлены: %s", b.Blocked)
	}
	// A clock rollback must not erase the saved rate limit.
	if !b.LastAttempt.IsZero() && now.Before(b.LastAttempt) {
		return publicRecoveryWindow, nil
	}
	if b.Window.IsZero() || now.Sub(b.Window) >= publicRecoveryWindow {
		b.Window = now
		b.Attempts = 0
	}
	for name, last := range b.Failed {
		if now.Sub(last) >= publicRecoveryWindow {
			delete(b.Failed, name)
		}
	}
	if b.Attempts >= publicRecoveryAttempts {
		return b.Window.Add(publicRecoveryWindow).Sub(now), nil
	}
	if next := b.LastAttempt.Add(publicRecoveryInterval); now.Before(next) {
		return next.Sub(now), nil
	}
	b.LastAttempt = now
	b.Attempts++
	if err := integration.AtomicJSON(m.recoveryPath(s), b); err != nil {
		return 0, err
	}
	return 0, nil
}
func (m *publicServerManager) blockPublicRecovery(s publicServer, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := m.loadRecovery(s)
	if err != nil {
		return
	}
	b.Blocked = reason
	_ = integration.AtomicJSON(m.recoveryPath(s), b)
}
func (m *publicServerManager) clearRecoveryBlockLocked(s publicServer) error {
	b, err := m.loadRecovery(s)
	if err != nil {
		return err
	}
	if b.Blocked == "" {
		return nil
	}
	b.Blocked = ""
	return integration.AtomicJSON(m.recoveryPath(s), b)
}
func publicSSHSecurityError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "unable to authenticate") || strings.Contains(message, "SSH-ключ сервера изменился") ||
		strings.Contains(strings.ToLower(message), "too many authentication failures")
}
func (m *publicServerManager) callPublicVPN(action string, input, output any) error {
	if m.vpnRPC != nil {
		return m.vpnRPC(action, input, output)
	}
	return moduleRPC("public-vpn/"+action, input, output)
}

func publicSSHBanner(ctx context.Context, address string, s publicServer) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	c, err := socksDialAt(ctx, address, s.Address, s.Port, 8*time.Second)
	if err != nil {
		return err
	}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	_ = c.SetDeadline(time.Now().Add(8 * time.Second))
	// Read only the server identification. No client identification, key,
	// username or authentication request is sent by a recovery probe.
	r := bufio.NewReaderSize(c, 256)
	for i := 0; i < 3; i++ {
		line, prefix, err := r.ReadLine()
		if err != nil {
			return err
		}
		if prefix {
			return fmt.Errorf("SSH identification too long")
		}
		if strings.HasPrefix(string(line), "SSH-2.") || strings.HasPrefix(string(line), "SSH-1.99-") {
			return nil
		}
	}
	return fmt.Errorf("SSH identification not received")
}

func (m *publicServerManager) tryPublicVPN(ctx context.Context, s publicServer, j *publicServerJob) {
	var route publicVPNStatus
	if err := m.callPublicVPN("status", publicVPNRequest{ID: s.ID}, &route); err != nil {
		m.status(j, func(st *publicServerStatus) {
			st.RecoveryNote = "Не удалось прочитать отдельную группу VPN: " + err.Error()
		})
		return
	}
	m.mu.Lock()
	budget, err := m.loadRecovery(s)
	m.mu.Unlock()
	if err != nil {
		return
	}
	chosen := ""
	for _, name := range route.Candidates {
		if name == route.Selected {
			continue
		}
		if last := budget.Failed[name]; !last.IsZero() && time.Since(last) < publicRecoveryWindow {
			continue
		}
		chosen = name
		break
	}
	if chosen == "" {
		m.status(j, func(st *publicServerStatus) {
			st.RecoveryNote = "Нет других VPN с недавней успешной проверкой; массовая проверка не запускается"
		})
		return
	}
	if wait, err := m.reservePublicBanner(s, time.Now()); err != nil || wait > 0 {
		m.status(j, func(st *publicServerStatus) {
			st.RecoveryNote = "Проверка другого VPN отложена общим ограничением частоты"
			if wait > 0 {
				st.NextProbeAt = time.Now().Add(wait)
			}
		})
		return
	}
	if err := m.callPublicVPN("select", publicVPNRequest{ID: s.ID, Node: chosen}, &route); err != nil {
		m.status(j, func(st *publicServerStatus) {
			st.RecoveryNote = "Не удалось выбрать VPN: " + err.Error()
		})
		return
	}
	m.status(j, func(st *publicServerStatus) {
		st.State = "probing"
		st.VPNGroup = route.Group
		st.VPNProxy = chosen
		st.RecoveryNote = "Одна TCP/SSH-banner проверка без авторизации"
	})
	err = publicSSHBanner(ctx, route.SOCKS, s)
	if err != nil {
		m.mu.Lock()
		b, e := m.loadRecovery(s)
		if e == nil {
			if b.Failed == nil {
				b.Failed = map[string]time.Time{}
			}
			b.Failed[chosen] = time.Now()
			_ = integration.AtomicJSON(m.recoveryPath(s), b)
		}
		m.mu.Unlock()
		m.status(j, func(st *publicServerStatus) {
			st.RecoveryNote = "VPN не открыл SSH; этот выход пропускается на 30 минут"
		})
		return
	}
	m.status(j, func(st *publicServerStatus) {
		st.RecoveryNote = "VPN открыл SSH. Восстановление туннеля после защитной паузы"
	})
}
