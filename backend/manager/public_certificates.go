package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/publictls"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"golang.org/x/crypto/ssh"
)

type publicCertificate struct {
	Host        string `json:"host"`
	Certificate string `json:"certificate"`
	Key         string `json:"key"`
}

func localPublicForwards(forwards []publicForward) []publicForward {
	out := []publicForward{}
	for _, f := range forwards {
		if f.Local {
			out = append(out, f)
		}
	}
	return out
}

func publicCertificateScript(s publicServer, forwards []publicForward, prepare bool) string {
	mode, packages := "export", "python3"
	if prepare {
		mode, packages = "certificates", "python3 nginx certbot"
	}
	payload, _ := json.Marshal(response{"mode": mode, "id": s.ID, "address": s.Address, "email": s.Email, "forwards": forwards})
	return publicPythonScript(payload, packages)
}

func (m *publicServerManager) savePublicCertificates(s publicServer, forwards []publicForward, body string) (bool, error) {
	var certs []publicCertificate
	if len(body) > 4<<20 || json.Unmarshal([]byte(body), &certs) != nil {
		return false, fmt.Errorf("Некорректный ответ сертификатов")
	}
	wanted := map[string]bool{}
	for _, f := range forwards {
		wanted[f.Host] = true
	}
	if len(certs) != len(wanted) {
		return false, fmt.Errorf("Сервер вернул неполный список сертификатов")
	}
	// Validate the complete response before persisting any private key.
	for _, c := range certs {
		if !wanted[c.Host] {
			return false, fmt.Errorf("Сервер вернул неожиданный сертификат")
		}
		delete(wanted, c.Host)
		if err := publictls.Validate(c.Host, []byte(c.Certificate), []byte(c.Key), time.Now()); err != nil {
			return false, err
		}
	}
	changed := false
	for _, c := range certs {
		update, err := publictls.Save(m.app.nginxConfRoot, s.ID, c.Host, []byte(c.Certificate), []byte(c.Key), time.Now())
		if err != nil {
			return changed, err
		}
		changed = changed || update
	}
	return changed, nil
}

// Called only by Apply, after router/DNS preflight and before activating local
// DNS. Draft preparation exposes HTTP-01 plus a 503, never the application.
func (a *app) preparePublicCertificates(routes schema.Routes) error {
	m := a.publicServers
	if m == nil {
		for _, h := range routes.Hosts {
			if h.TLS.CertPolicy == "public_vps" {
				return fmt.Errorf("Модуль VPS не запущен")
			}
		}
		return nil
	}
	m.mu.Lock()
	servers := append([]publicServer{}, m.servers...)
	m.mu.Unlock()
	for _, s := range servers {
		forwards := localPublicForwards(publicForwards(routes, s.ID))
		missing := []publicForward{}
		for _, f := range forwards {
			if _, _, err := publictls.Paths(a.nginxConfRoot, s.ID, f.Host, time.Now()); err != nil {
				missing = append(missing, f)
			}
		}
		if len(missing) == 0 {
			continue
		}
		ctx, cancel := context.WithTimeout(workerContext, 10*time.Minute)
		err := func() error {
			if s.AutoVPN {
				wait, err := m.reservePublicRecovery(s, time.Now())
				if err != nil {
					return err
				}
				if wait > 0 {
					return fmt.Errorf("%s: защитная пауза SSH, повторите применение через %s", s.Name, wait.Round(time.Second))
				}
				var route publicVPNStatus
				if err := m.callPublicVPN("ensure", publicVPNRequest{ID: s.ID}, &route); err != nil {
					return err
				}
				s.SOCKS = route.SOCKS
			}
			key, err := publicKeyFile(m.dir, s.ID, "admin")
			if err != nil {
				return err
			}
			c, _, err := dialPublicSSH(ctx, s, []ssh.AuthMethod{ssh.PublicKeys(key)}, false)
			if err != nil {
				if publicSSHSecurityError(err) {
					m.blockPublicRecovery(s, err.Error())
				}
				return err
			}
			defer c.Close()
			body, err := publicSSHRun(ctx, c, publicCertificateScript(s, missing, true))
			if err != nil {
				return err
			}
			_, err = m.savePublicCertificates(s, missing, body)
			return err
		}()
		cancel()
		if err != nil {
			return err
		}
	}
	return nil
}

func (m *publicServerManager) refreshPublicCertificates(ctx context.Context, c *ssh.Client, s publicServer, forwards []publicForward) error {
	local := localPublicForwards(forwards)
	if len(local) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, err := publicSSHRun(ctx, c, publicCertificateScript(s, local, false))
	if err != nil {
		return err
	}
	m.app.operationMu.Lock()
	defer m.app.operationMu.Unlock()
	changed, err := m.savePublicCertificates(s, local, body)
	if err != nil {
		return err
	}
	m.app.publicCertificatesDirty = m.app.publicCertificatesDirty || changed
	if m.app.publicCertificatesDirty {
		// Re-render the applied snapshot only. Never activate an unsaved UI draft.
		if err := m.app.recoverProxyOperation(); err != nil {
			return err
		}
		if _, err := runCommand(m.app.genRoutesPath, "--config", m.app.appliedRoutesPath()); err != nil {
			return fmt.Errorf("Не удалось обновить локальный HTTPS: %w", err)
		}
		m.app.publicCertificatesDirty = false
	}
	return nil
}
