package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"golang.org/x/crypto/ssh"
)

type publicServer struct {
	AutoVPN     bool   `json:"auto_vpn,omitempty"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Address     string `json:"address"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	Fingerprint string `json:"fingerprint"`
	SOCKS       string `json:"socks,omitempty"`
	Email       string `json:"email,omitempty"`
}
type publicForward struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Disabled bool   `json:"disabled,omitempty"`
	Local    bool   `json:"local,omitempty"`
}
type publicServerStatus struct {
	VPNGroup     string          `json:"vpn_group,omitempty"`
	VPNProxy     string          `json:"vpn_proxy,omitempty"`
	NextProbeAt  time.Time       `json:"next_probe_at,omitempty"`
	RecoveryNote string          `json:"recovery_note,omitempty"`
	State        string          `json:"state"`
	Error        string          `json:"error,omitempty"`
	ConnectedAt  time.Time       `json:"connected_at,omitempty"`
	CheckedAt    time.Time       `json:"checked_at,omitempty"`
	Reconnects   int             `json:"reconnects"`
	Domains      []publicForward `json:"domains"`
	Metrics      json.RawMessage `json:"metrics,omitempty"`
}
type publicServerJob struct {
	config string
	cancel context.CancelFunc
	status publicServerStatus
}
type publicServerManager struct {
	mu        sync.Mutex
	dir       string
	app       *app
	servers   []publicServer
	jobs      map[string]*publicServerJob
	loadError string
	vpnRPC    func(string, any, any) error
}

func validatePublicServer(s publicServer) error {
	if s.AutoVPN && s.SOCKS != "" {
		h, _, err := net.SplitHostPort(s.SOCKS)
		if err != nil || !net.ParseIP(h).IsLoopback() {
			return errors.New("Автоподбор VPN работает с локальным mihomo; внешний SOCKS настраивается отдельно")
		}
	}
	if !pvhIDRe.MatchString(s.ID) || len(s.ID) > 16 || s.Name == "" || len([]rune(s.Name)) > 80 {
		return errors.New("Укажите ID латиницей до 16 символов и имя сервера")
	}
	if net.ParseIP(s.Address) == nil && !schema.ValidHostname(s.Address) {
		return errors.New("Некорректный адрес сервера")
	}
	if s.Port < 1 || s.Port > 65535 || !pvhUserRe.MatchString(s.User) {
		return errors.New("Некорректный SSH-порт или пользователь")
	}
	if s.User != "root" {
		return errors.New("Для автоматической настройки нужен SSH-пользователь root")
	}
	if s.Fingerprint != "" && !strings.HasPrefix(s.Fingerprint, "SHA256:") {
		return errors.New("Некорректный отпечаток SSH")
	}
	if s.SOCKS != "" {
		h, p, e := net.SplitHostPort(s.SOCKS)
		n, _ := strconv.Atoi(p)
		if e != nil || net.ParseIP(h) == nil || n < 1 || n > 65535 {
			return errors.New("SOCKS mihomo: IP:порт, например 127.0.0.1:7890")
		}
	}
	if strings.ContainsAny(s.Email, "\r\n\x00") || (s.Email != "" && (!strings.Contains(s.Email, "@") || len(s.Email) > 254)) {
		return errors.New("Некорректный email ACME")
	}
	return nil
}

func (a *app) startPublicServers() {
	m := &publicServerManager{dir: getenv("PUBLIC_SERVERS_DIR", filepath.Join(a.baseDir, ".runtime", "public-servers")), app: a, jobs: map[string]*publicServerJob{}}
	b, err := os.ReadFile(filepath.Join(m.dir, "servers.json"))
	if err == nil {
		if err = json.Unmarshal(b, &m.servers); err == nil {
			for _, s := range m.servers {
				if err = validatePublicServer(s); err != nil {
					break
				}
			}
		}
	}
	if err != nil && !os.IsNotExist(err) {
		m.loadError = "Не удалось прочитать серверы: " + err.Error()
		m.servers = nil
	}
	a.publicServers = m
	every(5*time.Second, m.reconcile)
	managedGo(func() {
		<-workerContext.Done()
		m.mu.Lock()
		defer m.mu.Unlock()
		for _, j := range m.jobs {
			j.cancel()
		}
	})
}

func publicKeyFile(dir, id, purpose string) (ssh.Signer, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, id+"-"+purpose+".key")
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		_, key, e := ed25519.GenerateKey(rand.Reader)
		if e != nil {
			return nil, e
		}
		block, e := ssh.MarshalPrivateKey(key, "homenet-public")
		if e != nil {
			return nil, e
		}
		b = pem.EncodeToMemory(block)
		f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return nil, e
		}
		_, e = f.Write(b)
		closeErr := f.Close()
		if e != nil {
			return nil, e
		}
		if closeErr != nil {
			return nil, closeErr
		}
	} else if err != nil {
		return nil, err
	}
	return ssh.ParsePrivateKey(b)
}

func publicBootstrapAuth(managed ssh.Signer, privateKey, password string) ([]ssh.AuthMethod, error) {
	signers := []ssh.Signer{managed}
	if privateKey != "" {
		key, err := ssh.ParsePrivateKey([]byte(privateKey))
		if err != nil {
			return nil, errors.New("Не удалось прочитать приватный SSH-ключ")
		}
		signers = append(signers, key)
	}
	// ssh uses only the first AuthMethod of each type. Supply all candidate
	// keys through one publickey method so an unregistered managed key cannot
	// hide the existing key used for the first connection.
	auth := []ssh.AuthMethod{ssh.PublicKeys(signers...)}
	if password != "" {
		auth = append(auth, ssh.Password(password))
	}
	return auth, nil
}

func dialPublicSSH(ctx context.Context, s publicServer, auth []ssh.AuthMethod, inspect bool) (*ssh.Client, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	address := net.JoinHostPort(s.Address, strconv.Itoa(s.Port))
	var c net.Conn
	var err error
	if s.SOCKS != "" {
		c, err = socksDialAt(ctx, s.SOCKS, s.Address, s.Port, 15*time.Second)
	} else {
		c, err = (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return nil, "", err
	}
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	fingerprint := ""
	cfg := &ssh.ClientConfig{User: s.User, Auth: auth, HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
		fingerprint = ssh.FingerprintSHA256(k)
		if inspect {
			return errors.New("host key inspection")
		}
		if s.Fingerprint == "" || fingerprint != s.Fingerprint {
			return errors.New("SSH-ключ сервера изменился; проверьте отпечаток")
		}
		return nil
	}}
	cc, ch, rq, err := ssh.NewClientConn(c, address, cfg)
	if err != nil {
		_ = c.Close()
		return nil, fingerprint, err
	}
	_ = c.SetDeadline(time.Time{})
	return ssh.NewClient(cc, ch, rq), fingerprint, nil
}

// Closing the client interrupts blocked sessions and keepalive requests as well
// as active forwards. A timeout never leaves a background remote setup running
// intentionally; provisioning is idempotent and validated on the next attempt.
func publicSSHRun(ctx context.Context, c *ssh.Client, script string) (string, error) {
	s, err := c.NewSession()
	if err != nil {
		return "", err
	}
	defer s.Close()
	s.Stdin = strings.NewReader(script)
	var stdout, stderr bytes.Buffer
	s.Stdout = &stdout
	s.Stderr = &stderr
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	err = s.Run("sh -s")
	if err != nil {
		return "", fmt.Errorf("SSH: %w: %.1200s", err, stderr.String()+stdout.String())
	}
	return stdout.String(), nil
}

func (m *publicServerManager) saveServers(servers []publicServer) error {
	if err := os.MkdirAll(m.dir, 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(servers, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(m.dir, ".servers-*")
	if err != nil {
		return err
	}
	path := f.Name()
	defer os.Remove(path)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	ce := f.Close()
	if err == nil {
		err = ce
	}
	if err != nil {
		return err
	}
	if err = os.Rename(path, filepath.Join(m.dir, "servers.json")); err != nil {
		return err
	}
	m.servers = servers
	return nil
}

func (a *app) handlePublicServers(w http.ResponseWriter, r *http.Request) {
	m := a.publicServers
	if m == nil {
		a.writeJSON(w, 503, response{"ok": false, "error": "Модуль публикации не запущен"})
		return
	}
	if r.Method == "GET" && r.URL.Path == "/api/routes/public/servers" {
		m.mu.Lock()
		defer m.mu.Unlock()
		items := []response{}
		for _, s := range m.servers {
			status := publicServerStatus{State: "waiting", Domains: []publicForward{}}
			if j := m.jobs[s.ID]; j != nil {
				status = j.status
			}
			items = append(items, response{"server": s, "status": status})
		}
		a.writeJSON(w, 200, response{"ok": true, "items": items, "error": m.loadError})
		return
	}
	if r.Method != "POST" {
		a.writeJSON(w, 405, response{"ok": false, "error": "method not allowed"})
		return
	}
	var req struct {
		Server     publicServer `json:"server"`
		PrivateKey string       `json:"private_key"`
		Password   string       `json:"password"`
	}
	if err := decodePCJSON(w, r, &req); err != nil {
		a.writeJSON(w, 400, response{"ok": false, "error": "Некорректный запрос"})
		return
	}
	s := req.Server
	if err := validatePublicServer(s); err != nil {
		a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	dialServer := s
	if s.AutoVPN && (r.URL.Path == "/api/routes/public/inspect" || r.URL.Path == "/api/routes/public/save") {
		var route publicVPNStatus
		if err := m.callPublicVPN("ensure", publicVPNRequest{ID: s.ID}, &route); err != nil {
			a.writeJSON(w, 503, response{"ok": false, "error": err.Error()})
			return
		}
		dialServer.SOCKS = route.SOCKS
	}
	switch r.URL.Path {
	case "/api/routes/public/inspect":
		_, fp, err := dialPublicSSH(ctx, dialServer, nil, true)
		if fp != "" {
			a.writeJSON(w, 200, response{"ok": true, "fingerprint": fp})
			return
		}
		a.writeJSON(w, 400, response{"ok": false, "error": fmt.Sprint(err)})
	case "/api/routes/public/save":
		if s.Fingerprint == "" {
			a.writeJSON(w, 400, response{"ok": false, "error": "Сначала проверьте и подтвердите отпечаток SSH"})
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.loadError != "" {
			a.writeJSON(w, 409, response{"ok": false, "error": m.loadError})
			return
		}
		if len(m.servers) >= 32 {
			found := false
			for _, old := range m.servers {
				found = found || old.ID == s.ID
			}
			if !found {
				a.writeJSON(w, 400, response{"ok": false, "error": "Не больше 32 серверов"})
				return
			}
		}
		signer, err := publicKeyFile(m.dir, s.ID, "admin")
		if err != nil {
			a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
			return
		}
		auth, err := publicBootstrapAuth(signer, req.PrivateKey, req.Password)
		if err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
			return
		}
		c, _, err := dialPublicSSH(ctx, dialServer, auth, false)
		if err == nil {
			pub := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))) + " homenet-public-admin-" + s.ID
			_, err = publicSSHRun(ctx, c, "set -eu\n[ \"$(id -u)\" = 0 ]\nmkdir -p /root/.ssh\nchmod 700 /root/.ssh\ntouch /root/.ssh/authorized_keys\nchmod 600 /root/.ssh/authorized_keys\ngrep -qF "+shq(pub)+" /root/.ssh/authorized_keys || printf '%s\\n' "+shq(pub)+" >> /root/.ssh/authorized_keys\n")
			_ = c.Close()
		}
		if err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
			return
		}
		next := append([]publicServer{}, m.servers...)
		found := false
		for i := range next {
			if next[i].ID == s.ID {
				next[i] = s
				found = true
			}
		}
		if !found {
			next = append(next, s)
		}
		if err = m.saveServers(next); err != nil {
			a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
			return
		}
		_ = m.clearRecoveryBlockLocked(s)
		a.writeJSON(w, 200, response{"ok": true})
	case "/api/routes/public/reconnect":
		m.mu.Lock()
		for _, old := range m.servers {
			if old.ID == s.ID {
				_ = m.clearRecoveryBlockLocked(old)
			}
		}
		if j := m.jobs[s.ID]; j != nil {
			j.cancel()
			delete(m.jobs, s.ID)
		}
		m.mu.Unlock()
		a.writeJSON(w, 200, response{"ok": true})
	case "/api/routes/public/remove":
		// Do not strand active or saved publications on a deleted server.
		for _, path := range []string{a.routesPath(), a.appliedRoutesPath()} {
			routes, err := schema.LoadRoutes(path)
			if err != nil {
				a.writeJSON(w, 409, response{"ok": false, "error": err.Error()})
				return
			}
			for _, h := range routes.Hosts {
				if h.Publication != nil && h.Publication.ServerID == s.ID {
					a.writeJSON(w, 409, response{"ok": false, "error": "Сначала удалите или перенесите домены сервера и примените маршруты"})
					return
				}
			}
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		next := []publicServer{}
		for _, old := range m.servers {
			if old.ID != s.ID {
				next = append(next, old)
			}
		}
		if err := m.saveServers(next); err != nil {
			a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
			return
		}
		if j := m.jobs[s.ID]; j != nil {
			j.cancel()
			delete(m.jobs, s.ID)
		}
		a.writeJSON(w, 200, response{"ok": true})
	default:
		a.writeJSON(w, 404, response{"ok": false, "error": "not found"})
	}
}

func publicForwards(routes schema.Routes, id string) []publicForward {
	out := []publicForward{}
	for _, h := range routes.Hosts {
		if h.Publication != nil && h.Publication.ServerID == id {
			for _, ep := range h.Endpoints {
				if ep.Name == "vps" {
					out = append(out, publicForward{Host: h.Host, Port: schema.NormalizePort(ep.Listen.Port, 0), Disabled: !schema.PublicationEnabled(routes.Globals, h, ep), Local: h.TLS.CertPolicy == "public_vps"})
				}
			}
		}
	}
	return out
}

func (m *publicServerManager) reconcile() {
	// Only the committed applied snapshot can start a tunnel, never a draft.
	if _, err := os.Stat(m.app.appliedRoutesPath()); err != nil && !os.IsNotExist(err) {
		return
	}
	routes, err := schema.LoadRoutes(m.app.appliedRoutesPath())
	if err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.servers {
		forwards := publicForwards(routes, s.ID)
		b, _ := json.Marshal([]any{s, forwards})
		version := string(b)
		if j := m.jobs[s.ID]; j != nil {
			if j.config == version {
				continue
			}
			j.cancel()
		}
		ctx, cancel := context.WithCancel(workerContext)
		job := &publicServerJob{config: version, cancel: cancel, status: publicServerStatus{State: "connecting", Domains: forwards}}
		m.jobs[s.ID] = job
		managedGo(func() { m.run(ctx, s, forwards, job) })
	}
}

func (m *publicServerManager) status(j *publicServerJob, fn func(*publicServerStatus)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	fn(&j.status)
}

func (m *publicServerManager) run(ctx context.Context, s publicServer, forwards []publicForward, j *publicServerJob) {
	delay := 5 * time.Second
	for ctx.Err() == nil {
		if s.AutoVPN {
			wait, err := m.reservePublicRecovery(s, time.Now())
			if err != nil {
				m.status(j, func(st *publicServerStatus) { st.State = "blocked"; st.Error = err.Error() })
				<-ctx.Done()
				return
			}
			if wait > 0 {
				m.status(j, func(st *publicServerStatus) {
					st.State = "cooldown"
					st.NextProbeAt = time.Now().Add(wait)
					st.RecoveryNote = "Щадящая проверка: не чаще раза в минуту, до 6 попыток за 30 минут"
				})
				t := time.NewTimer(wait)
				select {
				case <-ctx.Done():
					t.Stop()
					return
				case <-t.C:
				}
				continue
			}
		}
		err := m.serve(ctx, s, forwards, j)
		if ctx.Err() != nil {
			return
		}
		if s.AutoVPN && publicSSHSecurityError(err) {
			m.blockPublicRecovery(s, err.Error())
			m.status(j, func(st *publicServerStatus) {
				st.State = "blocked"
				st.Error = "SSH-доступ отклонён или ключ сервера изменился. Автопроверки остановлены; проверьте ключи и нажмите «Переподключить»."
			})
			<-ctx.Done()
			return
		}
		var pathError publicTransportError
		if s.AutoVPN && errors.As(err, &pathError) {
			m.tryPublicVPN(ctx, s, j)
		}
		m.status(j, func(st *publicServerStatus) {
			st.State = "reconnecting"
			st.Error = fmt.Sprint(err)
			st.Reconnects++
			st.CheckedAt = time.Now()
		})
		if s.AutoVPN {
			delay = time.Minute
		}
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		if delay < time.Minute {
			delay *= 2
			if delay > time.Minute {
				delay = time.Minute
			}
		}
	}
}

func (m *publicServerManager) serve(ctx context.Context, s publicServer, forwards []publicForward, j *publicServerJob) error {
	if s.AutoVPN {
		var route publicVPNStatus
		if err := m.callPublicVPN("ensure", publicVPNRequest{ID: s.ID}, &route); err != nil {
			return err
		}
		s.SOCKS = route.SOCKS
		m.status(j, func(st *publicServerStatus) {
			st.VPNGroup = route.Group
			st.VPNProxy = route.Selected
			st.NextProbeAt = time.Time{}
			st.RecoveryNote = "Отдельная группа VPN; активных проверок при работающем туннеле нет"
		})
	}
	admin, err := publicKeyFile(m.dir, s.ID, "admin")
	if err != nil {
		return err
	}
	c, _, err := dialPublicSSH(ctx, s, []ssh.AuthMethod{ssh.PublicKeys(admin)}, false)
	if err != nil {
		return publicTransportError{err}
	}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	tunnel, err := publicKeyFile(m.dir, s.ID, "tunnel")
	if err != nil {
		return err
	}
	{
		m.status(j, func(st *publicServerStatus) { st.State = "configuring"; st.Error = "" })
		setupCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		_, err = publicSSHRun(setupCtx, c, publicProvisionScript(s, forwards, string(ssh.MarshalAuthorizedKey(tunnel.PublicKey()))))
		cancel()
		if err != nil {
			var exit *ssh.ExitError
			if !errors.As(err, &exit) {
				return publicTransportError{err}
			}
			return err
		}
	}
	var tc *ssh.Client
	var tunnelDone chan error
	activeForwards := []publicForward{}
	for _, f := range forwards {
		if !f.Disabled {
			activeForwards = append(activeForwards, f)
		}
	}
	if len(activeForwards) > 0 {
		ts := s
		ts.User = "homenet-tunnel-" + s.ID
		tc, _, err = dialPublicSSH(ctx, ts, []ssh.AuthMethod{ssh.PublicKeys(tunnel)}, false)
		if err != nil {
			return publicTransportError{err}
		}
		defer tc.Close()
		tunnelDone = make(chan error, 1)
		go func() { tunnelDone <- tc.Wait() }()
		stopTunnel := context.AfterFunc(ctx, func() { _ = tc.Close() })
		defer stopTunnel()
		for _, f := range activeForwards {
			ln, e := tc.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(f.Port)))
			if e != nil {
				return fmt.Errorf("%s: reverse forward: %w", f.Host, e)
			}
			defer ln.Close()
			go publicAcceptForward(ctx, ln, f.Port)
		}
	}
	m.status(j, func(st *publicServerStatus) { st.State = "online"; st.Error = ""; st.ConnectedAt = time.Now() })
	lastCertificates := time.Time{}
	for ctx.Err() == nil {
		if time.Since(lastCertificates) >= time.Hour {
			if err := m.refreshPublicCertificates(ctx, c, s, forwards); err != nil {
				m.status(j, func(st *publicServerStatus) { st.Error = "Локальный сертификат: " + err.Error() })
			} else {
				lastCertificates = time.Now()
				m.status(j, func(st *publicServerStatus) { st.Error = "" })
			}
		}
		probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		body, e := publicSSHRun(probeCtx, c, publicMetricsScript)
		cancel()
		if e != nil {
			var exit *ssh.ExitError
			if errors.As(e, &exit) {
				return e
			}
			return publicTransportError{e}
		}
		if !json.Valid([]byte(body)) {
			return errors.New("Сервер вернул некорректные метрики")
		}
		m.status(j, func(st *publicServerStatus) { st.Metrics = json.RawMessage(body); st.CheckedAt = time.Now() })
		if tc != nil {
			done := make(chan error, 1)
			go func() { _, _, e := tc.SendRequest("keepalive@openssh.com", true, nil); done <- e }()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case e := <-done:
				if e != nil {
					return publicTransportError{e}
				}
			case <-time.After(10 * time.Second):
				return publicTransportError{errors.New("Туннель не отвечает на keepalive")}
			}
		}
		t := time.NewTimer(15 * time.Second)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case err := <-tunnelDone:
			t.Stop()
			if err == nil {
				err = errors.New("SSH-туннель закрыт сервером")
			}
			return publicTransportError{err}
		case <-t.C:
		}
	}
	return ctx.Err()
}

func publicAcceptForward(ctx context.Context, ln net.Listener, port int) {
	for {
		remote, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			defer remote.Close()
			local, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
			if err != nil {
				return
			}
			defer local.Close()
			stop := context.AfterFunc(ctx, func() { _ = remote.Close(); _ = local.Close() })
			defer stop()
			done := make(chan struct{})
			go func() {
				_, _ = io.Copy(local, remote)
				if c, ok := local.(*net.TCPConn); ok {
					_ = c.CloseWrite()
				}
				close(done)
			}()
			_, _ = io.Copy(remote, local)
			_ = remote.Close()
			_ = local.Close()
			<-done
		}()
	}
}

const publicMetricsScript = `python3 - <<'PY'
import json,os,shutil,socket
m={k:int(v.split()[0])*1024 for k,v in (line.split(':',1) for line in open('/proc/meminfo'))}
d=shutil.disk_usage('/')
print(json.dumps(dict(host=socket.gethostname(),load1=os.getloadavg()[0],cores=os.cpu_count(),memory_total=m['MemTotal'],memory_used=m['MemTotal']-m.get('MemAvailable',m['MemFree']),disk_total=d.total,disk_used=d.used,uptime=int(float(open('/proc/uptime').read().split()[0])))))
PY
`

func publicProvisionScript(s publicServer, forwards []publicForward, key string) string {
	payload, _ := json.Marshal(response{"id": s.ID, "address": s.Address, "email": s.Email, "forwards": forwards, "key": strings.TrimSpace(key)})
	packages := "python3"
	if len(forwards) > 0 {
		packages += " nginx certbot"
	}
	return publicPythonScript(payload, packages)
}

func publicPythonScript(payload []byte, packages string) string {
	return "set -eu\nexport DEBIAN_FRONTEND=noninteractive\nfor tool in " + packages + "; do if ! command -v \"$tool\" >/dev/null; then\n command -v apt-get >/dev/null || { echo 'Поддерживаются Debian/Ubuntu с apt-get'; exit 1; }\n apt-get update -qq >&2\n apt-get install -y -qq " + packages + " >&2\n break\nfi; done\npython3 - " + shq(base64.StdEncoding.EncodeToString(payload)) + " <<'HOMENET_PUBLIC_PY'\n" + publicProvisionPython + "\nHOMENET_PUBLIC_PY\n"
}

//go:embed public_provision.py
var publicProvisionPython string
