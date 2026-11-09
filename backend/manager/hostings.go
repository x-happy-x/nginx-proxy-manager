package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Provider credentials are write-only. Upstream access/SSH fields are never
// decoded into the inventory, returned to the browser, or cached on disk.
type hostingAccount struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	Token    string `json:"token"`
}
type hostingServer struct {
	ID          string `json:"id"`
	Account     string `json:"account"`
	Name        string `json:"name"`
	IP          string `json:"ip"`
	Country     string `json:"country"`
	CountryCode string `json:"country_code"`
	CPU         string `json:"cpu"`
	RAM         string `json:"ram"`
	Disk        string `json:"disk"`
	OS          string `json:"os"`
	Status      string `json:"status"`
	State       string `json:"state"`
}
type hostingSnapshot struct {
	Servers []hostingServer `json:"servers"`
	Checked int64           `json:"checked_at"`
	LastOK  int64           `json:"last_ok"`
	Error   string          `json:"error,omitempty"`
}
type hostingMonitor struct {
	mu       sync.Mutex
	pollMu   sync.Mutex
	dir      string
	accounts []hostingAccount
	views    map[string]hostingSnapshot
	loadErr  string
	client   *http.Client
}

var hostings *hostingMonitor

func newHostingMonitor(dir string, transport http.RoundTripper) *hostingMonitor {
	if transport == nil {
		transport = hostingCurlTransport{}
	}
	m := &hostingMonitor{dir: dir, views: map[string]hostingSnapshot{}, client: &http.Client{Transport: transport, Timeout: 20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if b, err := os.ReadFile(filepath.Join(dir, "accounts.json")); err == nil {
		if json.Unmarshal(b, &m.accounts) != nil {
			m.loadErr = "Не удалось прочитать подключения хостингов"
		}
	} else if !os.IsNotExist(err) {
		m.loadErr = "Хранилище подключений недоступно"
	}
	if b, err := os.ReadFile(filepath.Join(dir, "inventory.json")); err == nil {
		_ = json.Unmarshal(b, &m.views)
	}
	if m.views == nil {
		m.views = map[string]hostingSnapshot{}
	}
	return m
}
func (a *app) startHostings() {
	hostings = newHostingMonitor(getenv("HOSTINGS_DIR", "/opt/etc/homenet/hostings"), nil)
	managedGo(func() {
		hostings.poll(workerContext)
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-workerContext.Done():
				return
			case <-ticker.C:
				hostings.poll(workerContext)
			}
		}
	})
}
func (m *hostingMonitor) save(name string, value any) error {
	if err := os.MkdirAll(m.dir, 0700); err != nil {
		return fmt.Errorf("Не удалось открыть хранилище хостингов")
	}
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(m.dir, ".hostings-*")
	if err != nil {
		return fmt.Errorf("Не удалось сохранить подключения")
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(b, '\n'))
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return fmt.Errorf("Не удалось сохранить подключения")
	}
	return os.Rename(tmp, filepath.Join(m.dir, name))
}

// The provider's Cloudflare API front rejects Go's TLS client with an HTML
// challenge. Use the installed curl TLS stack, keeping the token off argv and
// disabling config files, proxies and redirects. Only this provider is allowed.
type hostingCurlTransport struct{}
type hostingBuffer struct{ buffer bytes.Buffer }

func (b *hostingBuffer) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > 4<<20 {
		return 0, fmt.Errorf("provider response exceeds limit")
	}
	return b.buffer.Write(p)
}
func (hostingCurlTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method != "GET" || r.URL.Scheme != "https" || r.URL.Host != "api.ishosting.com" || r.URL.User != nil {
		return nil, fmt.Errorf("unsupported provider request")
	}
	quote := func(s string) string { return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"` }
	config := "url = " + quote(r.URL.String()) + "\n"
	for _, key := range []string{"X-Api-Token", "Accept", "Accept-Language", "User-Agent"} {
		value := r.Header.Get(key)
		if strings.ContainsAny(value, "\r\n") {
			return nil, fmt.Errorf("invalid provider header")
		}
		config += "header = " + quote(key+": "+value) + "\n"
	}
	binary := "/opt/bin/curl"
	if _, err := os.Stat(binary); err != nil {
		binary = "curl"
	}
	cmd := exec.CommandContext(r.Context(), binary, "--disable", "--silent", "--show-error", "--proto", "=https", "--noproxy", "*", "--connect-timeout", "10", "--max-time", "20", "--max-filesize", "4194304", "--write-out", "\n%{http_code}", "--config", "-")
	cmd.Stdin = strings.NewReader(config)
	var output hostingBuffer
	cmd.Stdout = &output
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("provider request failed")
	}
	data := output.buffer.Bytes()
	i := bytes.LastIndexByte(data, '\n')
	if i < 0 {
		return nil, fmt.Errorf("invalid provider status")
	}
	code, err := strconv.Atoi(string(data[i+1:]))
	if err != nil || code < 100 || code > 599 {
		return nil, fmt.Errorf("invalid provider status")
	}
	return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(data[:i])), Request: r}, nil
}

type hostingField struct {
	Name string `json:"name"`
}
type hostingVPS struct {
	ID       json.RawMessage `json:"id"`
	Name     string          `json:"name"`
	Location struct {
		Name string `json:"name"`
		Code string `json:"code"`
	} `json:"location"`
	Network struct {
		PublicIP string `json:"public_ip"`
	} `json:"network"`
	Platform struct {
		Config struct {
			CPU   hostingField `json:"cpu"`
			RAM   hostingField `json:"ram"`
			Drive hostingField `json:"drive"`
			OS    hostingField `json:"os"`
		} `json:"config"`
	} `json:"platform"`
	Status struct {
		Code  string `json:"code"`
		State struct {
			Code string `json:"code"`
		} `json:"state"`
	} `json:"status"`
}

func (v hostingVPS) id() string { return strings.Trim(string(v.ID), "\"") }

var hostingID = regexp.MustCompile(`^[0-9]{1,20}$`)

func (m *hostingMonitor) call(ctx context.Context, account hostingAccount, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.ishosting.com"+path, nil)
	if err != nil {
		return fmt.Errorf("Некорректный запрос к хостингу")
	}
	req.Header.Set("X-Api-Token", account.Token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "en")
	req.Header.Set("User-Agent", "HomeNet-hostings/1.0")
	res, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("is*hosting не отвечает: проверьте соединение")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		switch res.StatusCode {
		case 401:
			return fmt.Errorf("API-ключ is*hosting не принят или истёк")
		case 403:
			return fmt.Errorf("is*hosting отклонил доступ: проверьте разрешения ключа и ограничения IP")
		case 429:
			return fmt.Errorf("Лимит запросов is*hosting: повторите позже")
		}
		return fmt.Errorf("is*hosting вернул HTTP %d", res.StatusCode)
	}
	if json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(out) != nil {
		return fmt.Errorf("is*hosting вернул некорректный ответ")
	}
	return nil
}
func (m *hostingMonitor) inventory(ctx context.Context, account hostingAccount) ([]hostingServer, error) {
	servers := []hostingServer{}
	seen := map[string]bool{}
	for page := 0; page < 10; page++ {
		var list []hostingVPS
		if err := m.call(ctx, account, fmt.Sprintf("/vps/list?limit=50&offset=%d", page*50), &list); err != nil {
			return nil, err
		}
		for _, item := range list {
			id := item.id()
			if !hostingID.MatchString(id) || seen[id] {
				return nil, fmt.Errorf("is*hosting вернул некорректную страницу серверов")
			}
			seen[id] = true
			var v hostingVPS
			if err := m.call(ctx, account, "/vps/"+id, &v); err != nil {
				return nil, err
			}
			if v.id() != id {
				return nil, fmt.Errorf("is*hosting вернул другой сервер")
			}
			x := hostingServer{ID: id, Account: account.ID, Name: v.Name, IP: v.Network.PublicIP, Country: v.Location.Name, CountryCode: v.Location.Code, Status: v.Status.Code, State: v.Status.State.Code}
			x.CPU, x.RAM, x.Disk, x.OS = v.Platform.Config.CPU.Name, v.Platform.Config.RAM.Name, v.Platform.Config.Drive.Name, v.Platform.Config.OS.Name
			servers = append(servers, x)
		}
		if len(list) < 50 {
			return servers, nil
		}
	}
	return nil, fmt.Errorf("Список серверов превышает лимит интеграции (500)")
}
func (m *hostingMonitor) poll(ctx context.Context) {
	m.pollMu.Lock()
	defer m.pollMu.Unlock()
	m.mu.Lock()
	accounts := append([]hostingAccount{}, m.accounts...)
	m.mu.Unlock()
	for _, account := range accounts {
		ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
		servers, err := m.inventory(ctx, account)
		cancel()
		m.mu.Lock()
		current := false
		for _, c := range m.accounts {
			if c.ID == account.ID && c.Token == account.Token {
				current = true
			}
		}
		if current {
			v := m.views[account.ID]
			v.Checked = time.Now().Unix()
			if err != nil {
				v.Error = err.Error()
			} else {
				v.Servers = servers
				v.LastOK = v.Checked
				v.Error = ""
			}
			m.views[account.ID] = v
			if err := m.save("inventory.json", m.views); err != nil {
				m.loadErr = "Не удалось сохранить снимок хостингов"
			}
		}
		m.mu.Unlock()
	}
}
func (m *hostingMonitor) snapshot() response {
	m.mu.Lock()
	defer m.mu.Unlock()
	accounts := []response{}
	servers := []hostingServer{}
	for _, c := range m.accounts {
		v := m.views[c.ID]
		accounts = append(accounts, response{"id": c.ID, "name": c.Name, "provider": c.Provider, "token_set": c.Token != "", "checked_at": v.Checked, "last_ok": v.LastOK, "error": v.Error, "servers": len(v.Servers)})
		servers = append(servers, v.Servers...)
	}
	return response{"ok": true, "accounts": accounts, "servers": servers, "error": m.loadErr, "refresh_seconds": 300, "providers": []response{{"id": "ishosting", "name": "is*hosting"}}}
}
func (a *app) handleHostings(w http.ResponseWriter, r *http.Request) {
	m := hostings
	if m == nil {
		a.writeJSON(w, 503, response{"ok": false, "error": "Хостинги не запущены"})
		return
	}
	if r.Method == "GET" && r.URL.Path == "/api/hostings/overview" {
		a.writeJSON(w, 200, m.snapshot())
		return
	}
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var body struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Provider string `json:"provider"`
		Token    string `json:"token"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body) != nil {
		a.writeJSON(w, 400, response{"ok": false, "error": "Некорректный запрос"})
		return
	}
	fail := func(err error) { a.writeJSON(w, 400, response{"ok": false, "error": err.Error()}) }
	switch r.URL.Path {
	case "/api/hostings/refresh":
		m.poll(r.Context())
		a.writeJSON(w, 200, m.snapshot())
	case "/api/hostings/accounts":
		m.pollMu.Lock()
		defer m.pollMu.Unlock()
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.loadErr != "" {
			fail(fmt.Errorf("Сначала восстановите хранилище подключений"))
			return
		}
		if body.Provider != "ishosting" {
			fail(fmt.Errorf("Выберите поддерживаемый хостинг"))
			return
		}
		name := strings.TrimSpace(body.Name)
		if name == "" || len(name) > 100 {
			fail(fmt.Errorf("Укажите название до 100 символов"))
			return
		}
		accounts := append([]hostingAccount{}, m.accounts...)
		index := -1
		for i, c := range accounts {
			if c.ID == body.ID {
				index = i
			}
		}
		if body.ID != "" && index < 0 {
			fail(fmt.Errorf("Подключение не найдено"))
			return
		}
		if index < 0 {
			if len(accounts) >= 8 {
				fail(fmt.Errorf("Разрешено до 8 подключений"))
				return
			}
			body.ID = randHex(6)
			accounts = append(accounts, hostingAccount{ID: body.ID})
			index = len(accounts) - 1
		}
		token := strings.TrimSpace(body.Token)
		if token == "" {
			token = accounts[index].Token
		}
		if len(token) < 16 || len(token) > 512 || strings.ContainsAny(token, " \r\n\t") {
			fail(fmt.Errorf("Укажите API-ключ без пробелов"))
			return
		}
		accounts[index] = hostingAccount{ID: body.ID, Name: name, Provider: body.Provider, Token: token}
		if err := m.save("accounts.json", accounts); err != nil {
			fail(err)
			return
		}
		if m.accounts != nil && index < len(m.accounts) && m.accounts[index].Token != token {
			delete(m.views, body.ID)
			if err := m.save("inventory.json", m.views); err != nil {
				m.loadErr = "Не удалось обновить снимок хостингов"
			}
		}
		m.accounts = accounts
		a.writeJSON(w, 200, response{"ok": true, "id": body.ID})
	case "/api/hostings/accounts/remove":
		m.pollMu.Lock()
		defer m.pollMu.Unlock()
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.loadErr != "" {
			fail(fmt.Errorf("Сначала восстановите хранилище подключений"))
			return
		}
		accounts := []hostingAccount{}
		for _, c := range m.accounts {
			if c.ID != body.ID {
				accounts = append(accounts, c)
			}
		}
		if err := m.save("accounts.json", accounts); err != nil {
			fail(err)
			return
		}
		m.accounts = accounts
		delete(m.views, body.ID)
		_ = m.save("inventory.json", m.views)
		a.writeJSON(w, 200, response{"ok": true})
	default:
		http.NotFound(w, r)
	}
}
