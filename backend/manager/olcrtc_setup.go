package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"gopkg.in/yaml.v3"
)

// OLCRTC servers (NPM-56). HomeNet sets up the user's own server over SSH:
// it builds olcrtc there, starts one systemd service per variant of the link
// (a Jitsi instance × a transport), adds a node for each to the router's
// olcrtc file provider and keeps the ones that really carry traffic. A loop
// on the router then watches the variant the OLCRTC group uses and moves to a
// working one, picking new variants on the server when none work.
// Instructions followed: github.com/openlibrecommunity/olcrtc docs/manual.ru.md.

const (
	olcProvider  = "olcrtc"
	olcGroup     = "OLCRTC"
	olcGoVersion = "1.26.3"
	olcRepo      = "https://github.com/openlibrecommunity/olcrtc"
	// the olcrtc the router's core embeds (mihomo fork go.mod): builds with
	// another wire format do not connect, so the server builds this one
	olcCommit     = "92b2332769c3dd5000584366201572efc448065f"
	olcDir        = "/opt/olcrtc"
	olcCheckURL   = "https://www.gstatic.com/generate_204"
	olcKeepMax    = 3
	olcEventsKeep = 40
)

// Public Jitsi instances from olcrtc's docs/jitsi.instances.yaml; most sit on
// Russian addresses and stay reachable in the whitelist mode.
var olcInstances = []string{
	"meet.egovm.ru", "conference.ct.placetime.team", "jitsy.amateusfox.online", "meet.mamba.group", "meet.ecopsy.com",
	"meet.mirox.chat", "webinar.knomary.dev", "meet.playform.ru", "webinar.devknomarylms.ru", "zgn-y-vc01.zignotch.com",
	"conf.expressmoney.com", "m.catonmoon.com", "conf.hyperia.space", "jitsi.etudevs.ru", "meet.riddlerx.org",
}
var olcTransports = []string{"datachannel", "vp8channel", "seichannel", "videochannel"}

type olcVariant struct {
	Provider  string `json:"provider,omitempty"` // jitsi | telemost | wbstream; empty — jitsi
	Node      string `json:"node"`
	Instance  string `json:"instance"`
	Transport string `json:"transport"`
	Room      string `json:"room"`
	Unit      string `json:"unit"`
	// External: a container set up by olcrtc's own srv.sh; HomeNet keeps it
	// but never stops it. Key: the variant's key when not the server's one.
	External string `json:"external,omitempty"`
	Key      string `json:"key,omitempty"`
	// WL: "ok" or "fail" when checked while the uplink was in the whitelist
	// mode, empty when not checked in it yet; WLAt: when.
	WL   string `json:"wl,omitempty"`
	WLAt int64  `json:"wl_at,omitempty"`
}

// olcFound is an olcrtc already running on the server (olcrtc's srv.sh).
type olcFound struct {
	Container string `json:"container"`
	Status    string `json:"status"`
	Dir       string `json:"dir"`
	Provider  string `json:"provider"`
	Room      string `json:"room"`
	Transport string `json:"transport"`
	InTmp     bool   `json:"in_tmp"`
	Node      string `json:"node,omitempty"` // the router's node with the same room
	key       string
}

type olcServer struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Host     string       `json:"host"`
	Port     int          `json:"port"`
	User     string       `json:"user"`
	HostKey  string       `json:"host_key,omitempty"`
	Key      string       `json:"key,omitempty"` // the link's encryption key; never sent to the browser
	Arch     string       `json:"arch,omitempty"`
	Mode     string       `json:"mode,omitempty"` // whitelist | normal
	Variants []olcVariant `json:"variants"`
	// Where the server's traffic leaves for the internet, asked through one
	// of its nodes (NPM-59); the flag of Country goes into its node names.
	Country   string `json:"country,omitempty"`
	City      string `json:"city,omitempty"`
	ExitIP    string `json:"exit_ip,omitempty"`
	ISP       string `json:"isp,omitempty"`
	CountryAt int64  `json:"country_at,omitempty"`
	Created   int64  `json:"created"`
}

type olcEvent struct {
	T    int64  `json:"t"`
	Kind string `json:"kind"` // ok | warn | fail
	Text string `json:"text"`
}

type olcCheck struct {
	T   int64  `json:"t"`
	OK  bool   `json:"ok"`
	MS  int    `json:"ms"`
	Err string `json:"error,omitempty"`
}

type olcStore struct {
	// Route: «весь трафик через OLCRTC» is on — what each manual group had
	// chosen before, to put back (NPM-61).
	Route   map[string]string   `json:"route,omitempty"`
	Auto    bool                `json:"auto"`
	Servers []*olcServer        `json:"servers"`
	Events  []olcEvent          `json:"events"`
	Checks  map[string]olcCheck `json:"checks"`
}

type olcStep struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Status   string   `json:"status"` // wait | run | ok | fail | skip
	Detail   string   `json:"detail,omitempty"`
	Log      []string `json:"log,omitempty"`
	Fix      string   `json:"fix,omitempty"`
	FixLabel string   `json:"fix_label,omitempty"`
	MS       int64    `json:"ms,omitempty"`
}

type olcTry struct {
	Label  string `json:"label"`
	State  string `json:"state"` // wait | run | ok | fail | skip
	Result string `json:"result,omitempty"`
}

type olcJob struct {
	ID      string     `json:"id"`
	Server  string     `json:"server"`
	Kind    string     `json:"kind"` // setup | repick
	Running bool       `json:"running"`
	Done    bool       `json:"done"`
	OK      bool       `json:"ok"`
	Error   string     `json:"error,omitempty"`
	Waiting string     `json:"waiting,omitempty"` // a step waiting for «Исправить» or «Пропустить»
	Started int64      `json:"started"`
	Ended   int64      `json:"ended,omitempty"`
	Steps   []*olcStep `json:"steps"`
	Tries   []olcTry   `json:"tries"`
	Result  []olcCheck `json:"result,omitempty"`
	Found   []olcFound `json:"found"`
	resume  chan string
}

type olcState struct {
	mu    sync.Mutex
	path  string
	st    olcStore
	job   *olcJob
	fails int // failed checks of the selected variant in a row
	ran   bool
	wasWL bool
}

var olc *olcState

func olcStatePath() string { return filepath.Join(coreStateDir(), "olcrtc.json") }
func olcKeyPath() string   { return filepath.Join(coreStateDir(), "olcrtc_ed25519") }

func (a *app) startOlcrtc() {
	olc = &olcState{path: olcStatePath(), st: olcStore{Auto: true, Checks: map[string]olcCheck{}}}
	if body, err := os.ReadFile(olc.path); err == nil {
		_ = json.Unmarshal(body, &olc.st)
		if olc.st.Checks == nil {
			olc.st.Checks = map[string]olcCheck{}
		}
	}
	if os.Getenv("MAINTENANCE_DISABLED") == "1" || os.Getenv("MIHOMO_TRAFFIC_DISABLED") == "1" {
		return
	}
	managedGo(olc.autoLoop)
}

func (o *olcState) saveLocked() {
	body, err := json.MarshalIndent(o.st, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(o.path), 0o700)
	tmp := o.path + ".tmp"
	if os.WriteFile(tmp, body, 0o600) == nil {
		_ = os.Rename(tmp, o.path)
	}
}

func (o *olcState) event(kind, text string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.st.Events = append([]olcEvent{{T: time.Now().Unix(), Kind: kind, Text: text}}, o.st.Events...)
	if len(o.st.Events) > olcEventsKeep {
		o.st.Events = o.st.Events[:olcEventsKeep]
	}
	o.saveLocked()
}

// ---------- the router's SSH key ----------

func olcSigner() (ssh.Signer, error) {
	if body, err := os.ReadFile(olcKeyPath()); err == nil {
		return ssh.ParsePrivateKey(body)
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(priv, "homenet@router")
	if err != nil {
		return nil, err
	}
	_ = os.MkdirAll(filepath.Dir(olcKeyPath()), 0o700)
	if err := os.WriteFile(olcKeyPath(), pem.EncodeToMemory(block), 0o600); err != nil {
		return nil, err
	}
	return ssh.NewSignerFromKey(priv)
}

func olcPublicKey() string {
	s, err := olcSigner()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.PublicKey()))) + " homenet@router"
}

// ---------- mihomo calls ----------

func mihomoDo(method, path string, body any, out any, timeout time.Duration) error {
	controller, secret := mihomoController()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, controller+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Message == "" {
			e.Message = strings.TrimSpace(string(raw))
		}
		return fmt.Errorf("mihomo %d: %s", resp.StatusCode, e.Message)
	}
	if out != nil && len(raw) > 0 {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// olcNodeCheck opens generate_204 through one node of the olcrtc provider.
func olcNodeCheck(node string, timeout time.Duration) olcCheck {
	start := time.Now()
	var res struct {
		Delay int `json:"delay"`
	}
	q := url.Values{"url": {olcCheckURL}, "timeout": {strconv.Itoa(int(timeout / time.Millisecond))}}
	err := mihomoDo(http.MethodGet, "/providers/proxies/"+url.PathEscape(olcProvider)+"/"+url.PathEscape(node)+"/healthcheck?"+q.Encode(), nil, &res, timeout+5*time.Second)
	c := olcCheck{T: start.Unix()}
	if err != nil {
		c.Err = shortErr(err)
	} else if res.Delay <= 0 {
		c.Err = "нет ответа"
	} else {
		c.OK, c.MS = true, res.Delay
	}
	return c
}

func shortErr(err error) string {
	s := err.Error()
	if len(s) > 160 {
		s = s[:160] + "…"
	}
	return s
}

type olcNodeInfo struct {
	Name      string
	Room      string
	Transport string
	Provider  string
}

// olcNodes lists the nodes of the olcrtc provider in their order.
func olcNodes() ([]olcNodeInfo, error) {
	var body struct {
		Proxies []map[string]any `json:"proxies"`
	}
	if err := mihomoDo(http.MethodGet, "/providers/proxies/"+url.PathEscape(olcProvider)+"/proxies", nil, &body, 8*time.Second); err != nil {
		return nil, err
	}
	out := []olcNodeInfo{}
	for _, p := range body.Proxies {
		s := func(k string) string { v, _ := p[k].(string); return v }
		out = append(out, olcNodeInfo{Name: s("name"), Room: s("room-id"), Transport: s("transport"), Provider: s("auth-provider")})
	}
	return out, nil
}

func olcSelected() string {
	var g struct {
		Now string `json:"now"`
	}
	_ = mihomoGet("/proxies/"+url.PathEscape(olcGroup), &g)
	return g.Now
}

func olcSelect(node string) error {
	return mihomoDo(http.MethodPut, "/proxies/"+url.PathEscape(olcGroup), map[string]string{"name": node}, nil, 8*time.Second)
}

// ---------- SSH ----------

type olcSSH struct {
	c    *ssh.Client
	sudo string
}

func olcDial(s *olcServer, password string) (*olcSSH, string, error) {
	signer, err := olcSigner()
	if err != nil {
		return nil, "", err
	}
	var seenKey string
	hostKeyCB := func(_ string, _ net.Addr, key ssh.PublicKey) error {
		got := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
		if s.HostKey != "" && s.HostKey != got {
			return errors.New("ключ сервера изменился — это другой сервер или его переустановили; удалите сервер и добавьте заново")
		}
		seenKey = got
		return nil
	}
	addr := net.JoinHostPort(s.Host, strconv.Itoa(s.Port))
	cfg := &ssh.ClientConfig{User: s.User, Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyCallback: hostKeyCB, Timeout: 15 * time.Second}
	c, err := ssh.Dial("tcp", addr, cfg)
	how := "ключ HomeNet"
	if err != nil && password != "" {
		cfg.Auth = []ssh.AuthMethod{ssh.Password(password), ssh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
			ans := make([]string, len(qs))
			for i := range qs {
				ans[i] = password
			}
			return ans, nil
		})}
		c, err = ssh.Dial("tcp", addr, cfg)
		how = "пароль, ключ HomeNet добавлен"
		if err == nil {
			conn := &olcSSH{c: c}
			pub := olcPublicKey()
			if _, e := conn.run("mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qF "+shq(strings.Fields(pub)[1])+" ~/.ssh/authorized_keys || echo "+shq(pub)+" >> ~/.ssh/authorized_keys)", 20*time.Second); e != nil {
				c.Close()
				return nil, "", fmt.Errorf("не удалось положить ключ HomeNet: %w", e)
			}
		}
	}
	if err != nil {
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, "", errors.New("сервер не принял вход: добавьте ключ HomeNet в ~/.ssh/authorized_keys или введите пароль")
		}
		return nil, "", err
	}
	if seenKey != "" {
		s.HostKey = seenKey
	}
	conn := &olcSSH{c: c}
	if s.User != "root" {
		conn.sudo = "sudo -n "
	}
	return conn, how, nil
}

func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// run executes a shell command and returns its combined output.
func (x *olcSSH) run(cmd string, timeout time.Duration) (string, error) {
	sess, err := x.c.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	// stdout and stderr are copied by two goroutines: one buffer needs a lock
	out := &lockedBuffer{}
	sess.Stdout, sess.Stderr = out, out
	done := make(chan error, 1)
	go func() { done <- sess.Run("sh -c " + shq(cmd)) }()
	select {
	case err = <-done:
	case <-time.After(timeout):
		_ = sess.Signal(ssh.SIGKILL)
		err = fmt.Errorf("команда не закончилась за %s", timeout)
	}
	return strings.TrimSpace(out.String()), err
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func (x *olcSSH) root(cmd string, timeout time.Duration) (string, error) {
	return x.run(x.sudo+"sh -c "+shq(cmd), timeout)
}

// ---------- the job ----------

func (o *olcState) snapshot() map[string]any {
	o.mu.Lock()
	defer o.mu.Unlock()
	servers := make([]olcServer, 0, len(o.st.Servers))
	for _, s := range o.st.Servers {
		cp := *s
		cp.Key, cp.HostKey = "", ""
		cp.Variants = append([]olcVariant{}, s.Variants...)
		for i := range cp.Variants {
			cp.Variants[i].Key = ""
		}
		servers = append(servers, cp)
	}
	checks := map[string]olcCheck{}
	for k, v := range o.st.Checks {
		checks[k] = v
	}
	var job *olcJob
	if o.job != nil {
		cp := *o.job
		cp.Steps = make([]*olcStep, len(o.job.Steps))
		for i, st := range o.job.Steps {
			c := *st
			c.Log = append([]string(nil), st.Log...)
			cp.Steps[i] = &c
		}
		cp.Tries = append([]olcTry(nil), o.job.Tries...)
		cp.Found = append([]olcFound{}, o.job.Found...)
		job = &cp
	}
	if job != nil && job.Tries == nil {
		job.Tries = []olcTry{}
	}
	route := map[string]string{}
	for k, v := range o.st.Route {
		route[k] = v
	}
	return map[string]any{"route": route, "auto": o.st.Auto, "servers": servers, "events": append([]olcEvent{}, o.st.Events...), "checks": checks, "job": job,
		"pubkey": olcPublicKey(), "instances": olcInstances, "transports": olcTransports, "channel": olcChannelMode()}
}

func (j *olcJob) step(id string) *olcStep {
	for _, s := range j.Steps {
		if s.ID == id {
			return s
		}
	}
	return nil
}

type olcSetupReq struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Host       string   `json:"host"`
	Port       int      `json:"port"`
	User       string   `json:"user"`
	Password   string   `json:"password"`
	Instances  []string `json:"instances"`
	Transports []string `json:"transports"`
	Keep       int      `json:"keep"`
	Mode       string   `json:"mode"` // whitelist | normal
	// rooms people made themselves: Telemost and WB Stream cannot be made by
	// olcrtc, an own Jitsi has its own address
	Rooms []olcRoomReq `json:"rooms"`
}

type olcRoomReq struct {
	Provider  string `json:"provider"`
	Room      string `json:"room"`
	Transport string `json:"transport"`
}

// What works where, from olcrtc's docs/settings.ru.md: Telemost dropped the
// data channel, WB Stream's guests cannot publish data.
var olcProviderTransports = map[string][]string{
	"jitsi":    {"datachannel", "vp8channel", "seichannel", "videochannel"},
	"telemost": {"vp8channel", "videochannel"},
	"wbstream": {"vp8channel", "seichannel", "videochannel"},
}

// olcProviderHost is the address the router must reach directly for a provider.
func olcProviderHost(provider, room string) string {
	switch provider {
	case "telemost":
		return "telemost.yandex.ru"
	case "wbstream":
		return "stream.wb.ru"
	}
	return olcHost(room)
}

// olcRoomID turns a pasted link into the room id olcrtc expects: the full URL
// for Jitsi, the last part of the link for Telemost and WB Stream.
func olcRoomID(provider, room string) string {
	room = strings.TrimSpace(room)
	if provider == "jitsi" {
		if !strings.Contains(room, "://") {
			room = "https://" + room
		}
		return strings.TrimSuffix(room, "/")
	}
	if u, err := url.Parse(room); err == nil && u.Host != "" {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		return parts[len(parts)-1]
	}
	return strings.Trim(room, "/")
}

func olcTransportFor(provider, want string) string {
	list := olcProviderTransports[provider]
	for _, t := range list {
		if t == want {
			return t
		}
	}
	if len(list) == 0 {
		return want
	}
	return list[0]
}

var olcHostRe = regexp.MustCompile(`^[A-Za-z0-9.\-:\[\]]{1,253}$`)
var olcUserRe = regexp.MustCompile(`^[a-z_][a-z0-9_.\-]{0,31}$`)

func (o *olcState) start(kind string, req olcSetupReq) (*olcJob, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.job != nil && o.job.Running {
		return nil, errors.New("уже идёт настройка — дождитесь конца")
	}
	var srv *olcServer
	if kind == "repick" {
		for _, s := range o.st.Servers {
			if s.ID == req.ID {
				srv = s
			}
		}
		if srv == nil {
			return nil, errors.New("сервера нет в списке")
		}
		if req.Mode == "whitelist" || req.Mode == "normal" {
			srv.Mode = req.Mode
		}
	} else {
		req.Host = strings.TrimSpace(req.Host)
		if req.Port == 0 {
			req.Port = 22
		}
		if req.User == "" {
			req.User = "root"
		}
		if !olcHostRe.MatchString(req.Host) || !olcUserRe.MatchString(req.User) || req.Port < 1 || req.Port > 65535 {
			return nil, errors.New("проверьте адрес, порт и пользователя")
		}
		name := strings.TrimSpace(req.Name)
		if name == "" {
			name = req.Host
		}
		for _, s := range o.st.Servers {
			if s.Host == req.Host && s.Port == req.Port {
				srv = s
			}
		}
		if srv == nil {
			srv = &olcServer{ID: randHex(6), Created: time.Now().Unix()}
			o.st.Servers = append(o.st.Servers, srv)
		}
		srv.Name, srv.Host, srv.Port, srv.User = name, req.Host, req.Port, req.User
		srv.Mode = "whitelist"
		if req.Mode == "normal" {
			srv.Mode = "normal"
		}
	}
	j := &olcJob{ID: randHex(6), Server: srv.ID, Kind: kind, Running: true, Started: time.Now().Unix(), resume: make(chan string, 1)}
	steps := [][2]string{{"ssh", "SSH-подключение"}, {"check", "Проверка сервера"}, {"existing", "Что уже установлено"}}
	if kind == "setup" {
		steps = append(steps, [][2]string{{"swap", "Память для сборки"}, {"packages", "git, curl и openssl"}, {"go", "Go " + olcGoVersion}, {"source", "Исходники olcrtc"}, {"build", "Сборка olcrtc"}, {"key", "Ключ шифрования"}, {"service", "Служба olcrtc@"}}...)
	}
	steps = append(steps, [][2]string{{"pick", "Подбор вариантов"}, {"final", "Проверка связи"}}...)
	for _, s := range steps {
		j.Steps = append(j.Steps, &olcStep{ID: s[0], Title: s[1], Status: "wait"})
	}
	o.job = j
	o.saveLocked()
	go o.runJob(j, srv, req)
	return j, nil
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// set changes a step under the lock; the browser polls the snapshot.
func (o *olcState) set(j *olcJob, id string, f func(s *olcStep)) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if s := j.step(id); s != nil {
		f(s)
	}
}

func (o *olcState) logf(j *olcJob, id, line string) {
	o.set(j, id, func(s *olcStep) {
		for _, l := range strings.Split(line, "\n") {
			if l = strings.TrimRight(l, "\r "); l != "" {
				s.Log = append(s.Log, l)
			}
		}
		if len(s.Log) > 60 {
			s.Log = s.Log[len(s.Log)-60:]
		}
	})
}

// do runs one step: its function returns the detail line or an error.
func (o *olcState) do(j *olcJob, id string, f func() (string, error)) error {
	start := time.Now()
	o.set(j, id, func(s *olcStep) { s.Status, s.Detail = "run", "" })
	detail, err := f()
	o.set(j, id, func(s *olcStep) {
		s.MS = time.Since(start).Milliseconds()
		if err != nil {
			s.Status, s.Detail = "fail", err.Error()
		} else if s.Status == "run" {
			s.Status, s.Detail = "ok", detail
		}
	})
	return err
}

func (o *olcState) finish(j *olcJob, ok bool, msg string) {
	o.mu.Lock()
	j.Running, j.Done, j.OK, j.Ended, j.Waiting = false, true, ok, time.Now().Unix(), ""
	if !ok {
		j.Error = msg
	}
	for _, s := range j.Steps {
		if s.Status == "wait" || s.Status == "run" {
			s.Status = "skip"
		}
	}
	o.saveLocked()
	o.mu.Unlock()
}

func (o *olcState) wait(j *olcJob, id, fix, label string) string {
	o.set(j, id, func(s *olcStep) { s.Fix, s.FixLabel = fix, label })
	o.mu.Lock()
	j.Waiting = id
	o.mu.Unlock()
	act := <-j.resume
	o.mu.Lock()
	j.Waiting = ""
	o.mu.Unlock()
	o.set(j, id, func(s *olcStep) { s.Fix, s.FixLabel = "", "" })
	return act
}

func (o *olcState) runJob(j *olcJob, srv *olcServer, req olcSetupReq) {
	var x *olcSSH
	defer func() {
		if x != nil {
			x.c.Close()
		}
	}()
	err := o.do(j, "ssh", func() (string, error) {
		c, how, err := olcDial(srv, req.Password)
		if err != nil {
			return "", err
		}
		x = c
		o.mu.Lock()
		o.saveLocked()
		o.mu.Unlock()
		return fmt.Sprintf("%s@%s · вход: %s", srv.User, srv.Host, how), nil
	})
	if err != nil {
		o.finish(j, false, err.Error())
		return
	}
	var memMB, swapMB int
	if err := o.do(j, "check", func() (string, error) {
		out, err := x.run(`uname -m; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; nproc; awk '/MemTotal/{print int($2/1024)}' /proc/meminfo; awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo; df -Pm / | awk 'NR==2{print $4}'; command -v systemctl >/dev/null && echo systemd || echo none`, 20*time.Second)
		o.logf(j, "check", out)
		if err != nil {
			return "", err
		}
		f := strings.Split(out, "\n")
		if len(f) < 7 {
			return "", errors.New("сервер не ответил на проверку")
		}
		arch := map[string]string{"x86_64": "amd64", "aarch64": "arm64"}[strings.TrimSpace(f[0])]
		if arch == "" {
			return "", fmt.Errorf("архитектура %s не поддерживается: нужен x86_64 или aarch64", f[0])
		}
		if strings.TrimSpace(f[6]) != "systemd" {
			return "", errors.New("на сервере нет systemd — HomeNet ставит olcrtc как службу systemd")
		}
		srv.Arch = arch
		memMB, _ = strconv.Atoi(strings.TrimSpace(f[3]))
		swapMB, _ = strconv.Atoi(strings.TrimSpace(f[4]))
		disk, _ := strconv.Atoi(strings.TrimSpace(f[5]))
		return fmt.Sprintf("%s · %s · %s ядер · %d МБ памяти · swap %d МБ · %d ГБ свободно", strings.TrimSpace(f[1]), f[0], strings.TrimSpace(f[2]), memMB, swapMB, disk/1024), nil
	}); err != nil {
		o.finish(j, false, err.Error())
		return
	}

	migrate := false
	installed := false
	var found []olcFound
	if err := o.do(j, "existing", func() (string, error) {
		out, err := x.root(olcExistingCmd, 40*time.Second)
		o.logf(j, "existing", olcMaskKeys(out))
		if err != nil {
			return "", fmt.Errorf("%s: %s", err, olcLast(out))
		}
		var own []string
		found, own = parseOlcExisting(out)
		installed = olcInstalled(out)
		if nodes, err := olcNodes(); err == nil {
			for i := range found {
				for _, n := range nodes {
					if olcSameRoom(n.Room, found[i].Room) {
						found[i].Node = n.Name
					}
				}
			}
		}
		o.mu.Lock()
		j.Found = append([]olcFound{}, found...)
		o.mu.Unlock()
		parts := []string{}
		if len(own) > 0 {
			parts = append(parts, "прошлая установка HomeNet: "+strings.Join(own, ", "))
		}
		for _, f := range found {
			p := fmt.Sprintf("olcrtc из srv.sh — контейнер %s (%s), %s %s · %s", f.Container, f.Status, f.Provider, olcHost(f.Room), f.Transport)
			if f.Node != "" {
				p += " = узел «" + f.Node + "» на роутере"
			}
			if f.InTmp {
				p += "; файлы лежат в /tmp"
			}
			parts = append(parts, p)
		}
		if len(parts) == 0 {
			return "ничего не установлено — ставим с нуля", nil
		}
		return strings.Join(parts, "; "), nil
	}); err != nil {
		o.finish(j, false, err.Error())
		return
	}
	inTmp := false
	for _, f := range found {
		inTmp = inTmp || f.InTmp
	}
	if j.Kind == "setup" && inTmp {
		switch o.wait(j, "existing", "migrate", "Перенести в службу HomeNet") {
		case "cancel":
			o.finish(j, false, "настройка отменена")
			return
		case "fix":
			migrate = true
		}
	}
	// what already runs becomes a variant of this server, not a stranger to pick around
	for _, f := range found {
		if f.Room == "" || olcProviderTransports[f.Provider] == nil {
			continue
		}
		known := false
		for _, v := range srv.Variants {
			known = known || olcSameRoom(v.Room, f.Room)
		}
		if known {
			continue
		}
		v := olcVariant{Provider: f.Provider, Node: f.Node, Instance: olcProviderHost(f.Provider, f.Room), Transport: f.Transport, Room: f.Room, External: f.Container, Key: f.key}
		if v.Node == "" {
			v.Node = olcNodeName(srv, f.Provider, v.Instance, v.Transport, o.olcTaken())
			node := map[string]any{"name": v.Node, "type": "olcrtc", "auth-provider": f.Provider, "room-id": v.Room, "transport": v.Transport, "encryption-key": f.key, "dns-server": "127.0.0.1:1053", "idle-timeout": "10m"}
			if err := mihomoDo(http.MethodPost, "/providers/proxies/"+url.PathEscape(olcProvider)+"/proxies", node, nil, 15*time.Second); err != nil {
				o.logf(j, "existing", "узел для "+f.Container+" не добавлен: "+shortErr(err))
				continue
			}
		}
		o.mu.Lock()
		srv.Variants = append(srv.Variants, v)
		o.saveLocked()
		o.mu.Unlock()
	}

	if j.Kind == "repick" && !installed {
		o.finish(j, false, "на сервере нет olcrtc от HomeNet нужной версии — один раз запустите полную настройку, дальше варианты меняются без неё")
		return
	}
	if j.Kind == "setup" && installed && !migrate {
		for _, id := range []string{"swap", "packages", "go", "source", "build", "service"} {
			o.set(j, id, func(s *olcStep) {
				s.Status, s.Detail = "skip", "уже установлено, версия совпадает с ядром роутера"
			})
		}
		if err := o.do(j, "key", func() (string, error) {
			out, err := x.root("cat "+olcDir+"/olcrtc.key", 20*time.Second)
			key := strings.TrimSpace(out)
			if err != nil || !olcKeyRe.MatchString(key) || len(key) != 64 {
				return "", errors.New("не удалось прочитать ключ на сервере")
			}
			o.mu.Lock()
			srv.Key = key
			o.saveLocked()
			o.mu.Unlock()
			return "ключ уже есть на сервере", nil
		}); err != nil {
			o.finish(j, false, err.Error())
			return
		}
	} else if j.Kind == "setup" {
		// build needs ~4 GB: memory and swap together
		if memMB+swapMB < 3500 {
			o.set(j, "swap", func(s *olcStep) {
				s.Status = "fail"
				s.Detail = fmt.Sprintf("%d МБ памяти и %d МБ swap — сборка olcrtc на таком сервере обрывается", memMB, swapMB)
			})
			act := o.wait(j, "swap", "swap", "Включить swap 4 ГБ и продолжить")
			if act == "cancel" {
				o.finish(j, false, "настройка отменена")
				return
			}
			if act == "fix" {
				if err := o.do(j, "swap", func() (string, error) {
					out, err := x.root(`[ -f /swapfile ] || (fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096) && chmod 600 /swapfile && (swapon --show | grep -q /swapfile || (mkswap /swapfile && swapon /swapfile)) && (grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab) && free -m | awk '/Swap/{print $2}'`, 5*time.Minute)
					o.logf(j, "swap", out)
					if err != nil {
						return "", err
					}
					return "swap 4 ГБ включён и прописан в /etc/fstab", nil
				}); err != nil {
					o.finish(j, false, err.Error())
					return
				}
			} else {
				o.set(j, "swap", func(s *olcStep) {
					s.Status, s.Detail = "skip", "пропущено — сборка может упасть"
				})
			}
		} else {
			o.set(j, "swap", func(s *olcStep) { s.Status, s.Detail = "ok", "памяти хватает" })
		}

		steps := []struct {
			id      string
			cmd     string
			timeout time.Duration
			detail  string
		}{
			{"packages", `if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates openssl tar; elif command -v dnf >/dev/null; then dnf install -y -q git curl ca-certificates openssl tar; elif command -v pacman >/dev/null; then pacman -Sy --noconfirm --needed git curl ca-certificates openssl tar; else echo "нет apt-get, dnf или pacman" >&2; exit 1; fi; git --version`, 10 * time.Minute, "git, curl, openssl установлены"},
			{"go", fmt.Sprintf(`if /usr/local/go/bin/go version 2>/dev/null | grep -q 'go%[1]s'; then /usr/local/go/bin/go version; else curl -fsSL https://go.dev/dl/go%[1]s.linux-%[2]s.tar.gz -o /tmp/go.tgz && rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz && /usr/local/go/bin/go version; fi`, olcGoVersion, srv.Arch), 10 * time.Minute, "Go " + olcGoVersion},
			{"source", fmt.Sprintf(`mkdir -p %[1]s/src && cd %[1]s/src && ([ -d .git ] || git init -q) && (git remote get-url origin >/dev/null 2>&1 || git remote add origin %[2]s) && git fetch -q --depth 1 origin %[3]s && git reset -q --hard FETCH_HEAD && git log -1 --format='%%h %%cs'`, olcDir, olcRepo, olcCommit), 5 * time.Minute, "исходники olcrtc той же версии, что в ядре роутера"},
			{"build", fmt.Sprintf(`cd %[1]s/src && h=$(git rev-parse --short HEAD) && if [ -x %[1]s/olcrtc ] && [ "$(cat %[1]s/.built 2>/dev/null)" = "$h" ]; then echo "уже собран из этой версии $h"; else CGO_ENABLED=0 GOFLAGS=-buildvcs=false /usr/local/go/bin/go build -trimpath -ldflags "-s -w" -o %[1]s/olcrtc.new ./cmd/olcrtc && mv %[1]s/olcrtc.new %[1]s/olcrtc && echo "$h" > %[1]s/.built && echo "собран $h"; fi`, olcDir), 30 * time.Minute, "olcrtc"},
		}
		for _, st := range steps {
			st := st
			if err := o.do(j, st.id, func() (string, error) {
				out, err := x.root(st.cmd, st.timeout)
				o.logf(j, st.id, out)
				if err != nil {
					if st.id == "build" && strings.Contains(out, "signal: killed") {
						return "", errors.New("сборке не хватило памяти — включите swap и запустите настройку заново")
					}
					return "", fmt.Errorf("%s: %s", err, olcLast(out))
				}
				return st.detail + " · " + olcLast(out), nil
			}); err != nil {
				o.finish(j, false, err.Error())
				return
			}
		}
		if err := o.do(j, "key", func() (string, error) {
			out, err := x.root(fmt.Sprintf(`[ -s %[1]s/olcrtc.key ] || (umask 077 && if [ -s ~/.olcrtc_key ]; then tr -dc 0-9a-f < ~/.olcrtc_key | head -c 64 > %[1]s/olcrtc.key; else openssl rand -hex 32 > %[1]s/olcrtc.key; fi); cat %[1]s/olcrtc.key`, olcDir), 30*time.Second)
			key := strings.TrimSpace(out)
			if err != nil || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(key) {
				return "", errors.New("не удалось создать ключ шифрования")
			}
			o.mu.Lock()
			srv.Key = key
			o.saveLocked()
			o.mu.Unlock()
			return "ключ 64 hex — только на сервере и роутере; уже существующий ключ olcrtc сохранён", nil
		}); err != nil {
			o.finish(j, false, err.Error())
			return
		}
		if err := o.do(j, "service", func() (string, error) {
			unit := fmt.Sprintf(`[Unit]
Description=olcrtc %%i (HomeNet)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%[1]s/olcrtc %[1]s/%%i.yaml
WorkingDirectory=%[1]s
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`, olcDir)
			out, err := x.root("cat > /etc/systemd/system/olcrtc@.service <<'EOF'\n"+unit+"EOF\nsystemctl daemon-reload && echo ok", 30*time.Second)
			o.logf(j, "service", out)
			if err != nil {
				return "", err
			}
			return "olcrtc@.service — по службе на вариант, переживёт перезагрузку", nil
		}); err != nil {
			o.finish(j, false, err.Error())
			return
		}
	}
	if migrate {
		o.migrate(j, x, srv)
	}
	if srv.Key == "" && installed {
		if out, err := x.root("cat "+olcDir+"/olcrtc.key", 20*time.Second); err == nil && len(strings.TrimSpace(out)) == 64 {
			o.mu.Lock()
			srv.Key = strings.TrimSpace(out)
			o.saveLocked()
			o.mu.Unlock()
		}
	}
	if srv.Key == "" {
		o.finish(j, false, "у сервера нет ключа — настройте его заново")
		return
	}

	kept := o.pick(j, x, srv, req)
	if len(kept) == 0 {
		o.set(j, "final", func(s *olcStep) { s.Status, s.Detail = "fail", "ни один вариант не заработал" })
		o.finish(j, false, "ни один вариант не заработал: проверьте, открываются ли площадки Jitsi с сервера")
		o.event("fail", srv.Name+": ни один вариант связи не заработал")
		return
	}
	_ = o.do(j, "final", func() (string, error) {
		results := []olcCheck{}
		best := ""
		for _, v := range kept {
			c := olcNodeCheck(v.Node, 15*time.Second)
			results = append(results, c)
			o.mu.Lock()
			o.st.Checks[v.Node] = c
			o.mu.Unlock()
			if c.OK && best == "" {
				best = v.Node
			}
		}
		o.mu.Lock()
		j.Result = results
		o.mu.Unlock()
		if best == "" {
			return "", errors.New("варианты поднялись, но повторная проверка не прошла — попробуйте ещё раз")
		}
		if cur := olcSelected(); cur == "" || !(olc.workingNode(cur)) {
			_ = olcSelect(best)
		}
		note := ""
		// where the server exits: its flag goes into the node names (NPM-59)
		if cc, city, ip, isp, err := olcExit(best); err == nil && cc != "" {
			o.mu.Lock()
			srv.Country, srv.City, srv.ExitIP, srv.ISP, srv.CountryAt = cc, city, ip, isp, time.Now().Unix()
			o.saveLocked()
			o.mu.Unlock()
			note += " · выход " + strings.TrimSpace(cc+" "+city)
		}
		if srv.Mode == "whitelist" {
			if olcChannelMode() == "whitelist" {
				note = " · проверены при белых списках"
			} else {
				note = " · при белых списках проверятся сами, когда они включатся"
			}
		}
		return fmt.Sprintf("рабочих вариантов %d · generate_204 через %s за %d мс%s", len(kept), best, results[0].MS, note), nil
	})
	o.finish(j, true, "")
	o.event("ok", fmt.Sprintf("%s: %s, рабочих вариантов %d", srv.Name, map[string]string{"setup": "сервер настроен", "repick": "варианты подобраны заново"}[j.Kind], len(kept)))
	go o.tidy()
}

func olcLast(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	l := strings.TrimSpace(lines[len(lines)-1])
	if len(l) > 140 {
		l = l[:140] + "…"
	}
	return l
}

func (o *olcState) workingNode(node string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	c, ok := o.st.Checks[node]
	return ok && c.OK && time.Now().Unix()-c.T < 1800
}

// pick starts one service per candidate variant, adds its node and keeps the
// ones that carry traffic; the variants that no longer work are removed.
func (o *olcState) pick(j *olcJob, x *olcSSH, srv *olcServer, req olcSetupReq) []olcVariant {
	instances := req.Instances
	if len(instances) == 0 {
		instances = olcInstances
	}
	transports := req.Transports
	if len(transports) == 0 {
		transports = []string{"datachannel", "vp8channel"}
	}
	keep := req.Keep
	if keep <= 0 || keep > olcKeepMax {
		keep = 2
	}
	type cand struct{ inst, tr string }
	cands := []cand{}
	// one transport across every instance before the next transport
	for _, tr := range transports {
		for _, in := range instances {
			cands = append(cands, cand{in, tr})
		}
	}
	o.mu.Lock()
	j.Tries = nil
	for _, c := range cands {
		j.Tries = append(j.Tries, olcTry{Label: c.inst + " · " + c.tr, State: "wait"})
	}
	o.mu.Unlock()
	setTry := func(i int, state, res string) {
		o.mu.Lock()
		j.Tries[i].State, j.Tries[i].Result = state, res
		o.mu.Unlock()
	}

	kept := []olcVariant{}
	type room struct{ provider, id, tr string }
	rooms := []room{}
	for _, rq := range req.Rooms {
		pr := rq.Provider
		if _, ok := olcProviderTransports[pr]; !ok || strings.TrimSpace(rq.Room) == "" {
			continue
		}
		id := olcRoomID(pr, rq.Room)
		if id == "" || len(id) > 300 {
			continue
		}
		rooms = append(rooms, room{pr, id, olcTransportFor(pr, rq.Transport)})
	}
	o.mu.Lock()
	tries := []olcTry{}
	for _, rm := range rooms {
		tries = append(tries, olcTry{Label: map[string]string{"telemost": "Телемост", "wbstream": "WB Stream", "jitsi": "свой Jitsi"}[rm.provider] + " · " + olcShortRoom(rm.id) + " · " + rm.tr, State: "wait"})
	}
	j.Tries = append(tries, j.Tries...)
	o.mu.Unlock()
	offset := len(rooms)
	_ = o.do(j, "pick", func() (string, error) {
		// what still works stays; the dead are taken down first
		wl := olcChannelMode() == "whitelist"
		for _, v := range srv.Variants {
			c := olcNodeCheck(v.Node, 15*time.Second)
			if c.OK && wl {
				v.WL, v.WLAt = "ok", time.Now().Unix()
			}
			if c.OK && srv.Mode == "whitelist" && !wl && v.WL == "fail" {
				o.dropVariant(x, v)
				o.logf(j, "pick", "убран "+v.Node+": при белых списках не работал")
				continue
			}
			if c.OK {
				kept = append(kept, v)
				o.logf(j, "pick", "оставлен рабочий "+v.Node)
			} else if v.External != "" {
				o.logf(j, "pick", "не отвечает контейнер "+v.External+" ("+v.Node+"): оставлен как есть, в подборе не участвует")
			} else {
				o.dropVariant(x, v)
				o.logf(j, "pick", "убран нерабочий "+v.Node+": "+c.Err)
			}
		}
		for i, rm := range rooms {
			dup := false
			for _, v := range kept {
				dup = dup || olcSameRoom(v.Room, rm.id)
			}
			if dup {
				setTry(i, "ok", "уже работает")
				continue
			}
			setTry(i, "run", "поднимаю…")
			v, res, ok := o.tryVariantIn(x, srv, rm.provider, rm.id, rm.tr)
			if ok {
				kept = append(kept, v)
				setTry(i, "ok", res)
			} else {
				setTry(i, "fail", res)
			}
		}
		for i0, c := range cands {
			i := i0 + offset
			if len(kept) >= keep+len(rooms) {
				setTry(i, "skip", "достаточно рабочих")
				continue
			}
			if dup := func() bool {
				for _, v := range kept {
					if v.Instance == c.inst && v.Transport == c.tr {
						return true
					}
				}
				return false
			}(); dup {
				setTry(i, "ok", "уже работает")
				continue
			}
			setTry(i, "run", "поднимаю…")
			v, res, ok := o.tryVariant(x, srv, c.inst, c.tr)
			if ok {
				kept = append(kept, v)
				setTry(i, "ok", res)
			} else {
				setTry(i, "fail", res)
			}
		}
		o.mu.Lock()
		srv.Variants = kept
		o.saveLocked()
		o.mu.Unlock()
		if len(kept) == 0 {
			return "", errors.New("рабочих вариантов не нашлось")
		}
		names := []string{}
		for _, v := range kept {
			names = append(names, v.Instance+" · "+v.Transport)
		}
		return fmt.Sprintf("рабочих %d: %s", len(kept), strings.Join(names, ", ")), nil
	})
	return kept
}

func (o *olcState) tryVariant(x *olcSSH, srv *olcServer, inst, tr string) (olcVariant, string, bool) {
	return o.tryVariantIn(x, srv, "jitsi", fmt.Sprintf("https://%s/homenet-%s", inst, randHex(6)), tr)
}

func olcShortRoom(id string) string {
	id = strings.TrimPrefix(strings.TrimPrefix(id, "https://"), "http://")
	if len(id) > 28 {
		return id[:28] + "…"
	}
	return id
}

func (o *olcState) tryVariantIn(x *olcSSH, srv *olcServer, provider, room, tr string) (olcVariant, string, bool) {
	inst := olcProviderHost(provider, room)
	// an alternative to the VPN must not need it: the router reaches the call service straight
	if err := olcDirectReach(inst); err != nil {
		return olcVariant{}, "не открывается из дома без VPN: " + err.Error(), false
	}
	unit := fmt.Sprintf("v%s-%s", randHex(3), tr)
	v := olcVariant{Provider: provider, Node: olcNodeName(srv, provider, inst, tr, o.olcTaken()), Instance: inst, Transport: tr, Room: room, Unit: unit}
	cfg := fmt.Sprintf("mode: srv\nauth:\n  provider: %s\nroom:\n  id: %q\ncrypto:\n  key_file: %q\nnet:\n  transport: %s\n  dns: \"8.8.8.8:53\"\nliveness:\n  interval: 10s\n  timeout: 15s\n  failures: 4\n", provider, room, olcDir+"/olcrtc.key", tr)
	if out, err := x.root(fmt.Sprintf("cat > %s/%s.yaml <<'EOF'\n%sEOF\nsystemctl enable --now olcrtc@%s >/dev/null 2>&1 && sleep 6 && systemctl is-active olcrtc@%s", olcDir, unit, cfg, unit, unit), time.Minute); err != nil {
		_, _ = x.root(fmt.Sprintf("journalctl -u olcrtc@%s -n 20 --no-pager", unit), 20*time.Second)
		o.dropUnit(x, v)
		return v, "служба не запустилась: " + olcLast(out), false
	}
	node := map[string]any{"name": v.Node, "type": "olcrtc", "auth-provider": provider, "room-id": room, "transport": tr, "encryption-key": srv.Key, "dns-server": "127.0.0.1:1053", "idle-timeout": "10m"}
	if err := mihomoDo(http.MethodPost, "/providers/proxies/"+url.PathEscape(olcProvider)+"/proxies", node, nil, 15*time.Second); err != nil {
		o.dropUnit(x, v)
		return v, "роутер не принял узел: " + shortErr(err), false
	}
	// a Jitsi session takes a few seconds to come up on both ends
	var c olcCheck
	for attempt := 0; attempt < 3; attempt++ {
		c = olcNodeCheck(v.Node, 15*time.Second)
		if c.OK {
			break
		}
		time.Sleep(4 * time.Second)
	}
	o.mu.Lock()
	o.st.Checks[v.Node] = c
	o.mu.Unlock()
	if !c.OK {
		o.dropVariant(x, v)
		return v, "не открывается: " + c.Err, false
	}
	if olcChannelMode() == "whitelist" {
		v.WL, v.WLAt = "ok", time.Now().Unix()
		return v, fmt.Sprintf("работает при белых списках · %d мс", c.MS), true
	}
	return v, fmt.Sprintf("работает · %d мс", c.MS), true
}

// olcChannelMode: the uplink's mode as the fork's adaptive check sees it.
func olcChannelMode() string {
	var body struct {
		Providers map[string]providerSnapshot `json:"providers"`
	}
	if err := mihomoGet("/providers/proxies", &body); err != nil {
		return "unknown"
	}
	best, mode := -1, "unknown"
	for _, p := range body.Providers {
		if p.Adaptive != nil && len(p.Proxies) > best {
			best, mode = len(p.Proxies), p.Adaptive.Mode
		}
	}
	return mode
}

// olcDirectReach opens the Jitsi instance straight through the uplink,
// past mihomo, with Yandex's DNS — the way it must work without the VPN.
func olcDirectReach(inst string) error {
	tr := probeTransport(dialDirect, inst)
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get("https://" + inst + "/")
	if err != nil {
		return errors.New(serviceError(err))
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("площадка ответила %d", resp.StatusCode)
	}
	return nil
}

func (o *olcState) dropVariant(x *olcSSH, v olcVariant) {
	if v.External != "" {
		return // olcrtc's own container: not ours to stop or forget on the router
	}
	_ = mihomoDo(http.MethodDelete, "/providers/proxies/"+url.PathEscape(olcProvider)+"/proxies/"+url.PathEscape(v.Node), nil, nil, 10*time.Second)
	o.dropUnit(x, v)
}

// dropUnit stops the variant's service on the server and leaves the router
// alone: a try that never added its node must not delete one by that name.
func (o *olcState) dropUnit(x *olcSSH, v olcVariant) {
	if v.External == "" && x != nil && v.Unit != "" {
		_, _ = x.root(fmt.Sprintf("systemctl disable --now olcrtc@%[2]s >/dev/null 2>&1; rm -f %[1]s/%[2]s.yaml", olcDir, v.Unit), 30*time.Second)
	}
}

// olcHostLabel: a host without its top-level domain — meet.riddlerx.org →
// meet.riddlerx. The first label alone («meet») made two variants on
// different Jitsi share a node name, and a failed try deleted the working
// node of the other (NPM-59).
func olcHostLabel(provider, inst string) string {
	switch provider {
	case "telemost":
		return "telemost"
	case "wbstream":
		return "wb"
	}
	if i := strings.LastIndex(inst, "."); i > 0 {
		return inst[:i]
	}
	return inst
}

// olcFlag: "NL" → 🇳🇱.
func olcFlag(cc string) string {
	if len(cc) != 2 {
		return ""
	}
	cc = strings.ToUpper(cc)
	if cc[0] < 'A' || cc[0] > 'Z' || cc[1] < 'A' || cc[1] > 'Z' {
		return ""
	}
	return string([]rune{0x1F1E6 + rune(cc[0]-'A'), 0x1F1E6 + rune(cc[1]-'A')})
}

// olcNodeName: «🇳🇱 OLC VDSKA meet.riddlerx/datachannel», unique among taken.
func olcNodeName(srv *olcServer, provider, inst, tr string, taken map[string]bool) string {
	base := fmt.Sprintf("OLC %s %s/%s", srv.Name, olcHostLabel(provider, inst), tr)
	if f := olcFlag(srv.Country); f != "" {
		base = f + " " + base
	}
	name := base
	for i := 2; taken[name]; i++ {
		name = fmt.Sprintf("%s %d", base, i)
	}
	return name
}

// olcTaken: every node name in the olcrtc provider and in the servers' records.
func (o *olcState) olcTaken() map[string]bool {
	taken := map[string]bool{}
	if nodes, err := olcNodes(); err == nil {
		for _, n := range nodes {
			taken[n.Name] = true
		}
	}
	o.mu.Lock()
	for _, s := range o.st.Servers {
		for _, v := range s.Variants {
			taken[v.Node] = true
		}
	}
	o.mu.Unlock()
	return taken
}

// olcExit asks the core where traffic through the node leaves (MIHOMO-16).
func olcExit(node string) (cc, city, ip, isp string, err error) {
	var res struct {
		Country string `json:"country"`
		City    string `json:"city"`
		IP      string `json:"ip"`
		ISP     string `json:"isp"`
	}
	if err = mihomoDo(http.MethodGet, "/providers/proxies/"+url.PathEscape(olcProvider)+"/"+url.PathEscape(node)+"/exit?timeout=15000", nil, &res, 25*time.Second); err != nil {
		return
	}
	return strings.ToUpper(res.Country), res.City, res.IP, res.ISP, nil
}

// olcNodeConfig: the router node of a variant, as the core keeps it.
func olcNodeConfig(srv *olcServer, v olcVariant) map[string]any {
	key := v.Key
	if key == "" {
		key = srv.Key
	}
	provider := v.Provider
	if provider == "" {
		provider = "jitsi"
	}
	return map[string]any{"name": v.Node, "type": "olcrtc", "auth-provider": provider, "room-id": v.Room, "transport": v.Transport, "encryption-key": key, "dns-server": "127.0.0.1:1053", "idle-timeout": "10m"}
}

// tidy: the servers' exit countries, flags in their node names, and nodes
// the router lost put back. Runs in the background loop and on request.
func (o *olcState) tidy() {
	nodes, err := olcNodes()
	if err != nil {
		return
	}
	have := map[string]bool{}
	for _, n := range nodes {
		have[n.Name] = true
	}
	o.mu.Lock()
	servers := append([]*olcServer(nil), o.st.Servers...)
	o.mu.Unlock()
	for _, srv := range servers {
		o.mu.Lock()
		variants := append([]olcVariant(nil), srv.Variants...)
		known := srv.Country != "" && time.Since(time.Unix(srv.CountryAt, 0)) < 24*time.Hour
		o.mu.Unlock()
		// lost: the record has the variant, the core does not
		for _, v := range variants {
			if have[v.Node] || srv.Key == "" && v.Key == "" {
				continue
			}
			if err := mihomoDo(http.MethodPost, "/providers/proxies/"+url.PathEscape(olcProvider)+"/proxies", olcNodeConfig(srv, v), nil, 15*time.Second); err == nil {
				have[v.Node] = true
				o.event("warn", fmt.Sprintf("узла «%s» не было на роутере — вернул", v.Node))
			}
		}
		if !known {
			for _, v := range variants {
				if !o.workingNode(v.Node) {
					continue
				}
				cc, city, ip, isp, err := olcExit(v.Node)
				if err != nil || cc == "" {
					continue
				}
				o.mu.Lock()
				if srv.Country != cc && srv.Country != "" {
					o.mu.Unlock()
					o.event("warn", fmt.Sprintf("%s: страна выхода сменилась — %s вместо %s", srv.Name, cc, srv.Country))
					o.mu.Lock()
				}
				srv.Country, srv.City, srv.ExitIP, srv.ISP, srv.CountryAt = cc, city, ip, isp, time.Now().Unix()
				o.saveLocked()
				o.mu.Unlock()
				break
			}
		}
		o.flagNames(srv, have)
	}
}

// flagNames puts the server's flag in front of its node names: the core
// renames the node, and the record, checks and the OLCRTC choice follow.
func (o *olcState) flagNames(srv *olcServer, have map[string]bool) {
	o.mu.Lock()
	flag := olcFlag(srv.Country)
	variants := append([]olcVariant(nil), srv.Variants...)
	o.mu.Unlock()
	if flag == "" {
		return
	}
	selected := olcSelected()
	for _, v := range variants {
		if !have[v.Node] || strings.HasPrefix(v.Node, flag+" ") || olcHasFlag(v.Node) {
			continue
		}
		name := flag + " " + v.Node
		for i := 2; have[name]; i++ {
			name = fmt.Sprintf("%s %s %d", flag, v.Node, i)
		}
		if err := mihomoDo(http.MethodPut, "/providers/proxies/"+url.PathEscape(olcProvider)+"/proxies/"+url.PathEscape(v.Node), map[string]any{"name": name}, nil, 15*time.Second); err != nil {
			continue
		}
		have[name], have[v.Node] = true, false
		o.mu.Lock()
		for i := range srv.Variants {
			if srv.Variants[i].Node == v.Node {
				srv.Variants[i].Node = name
			}
		}
		if c, ok := o.st.Checks[v.Node]; ok {
			o.st.Checks[name] = c
			delete(o.st.Checks, v.Node)
		}
		o.saveLocked()
		o.mu.Unlock()
		if selected == v.Node {
			_ = olcSelect(name)
		}
	}
}

// olcRouteSkip: groups that stay as they are when all traffic goes through
// OLCRTC — QUIC is rejected on purpose, the access checks have their own path.
var olcRouteSkip = map[string]bool{"QUIC": true}

// route on: every manual group with OLCRTC among its members switches to it,
// the previous choice remembered; off: each gets its choice back (NPM-61).
func (o *olcState) route(on bool) error {
	var all struct {
		Proxies map[string]struct {
			Type string   `json:"type"`
			Now  string   `json:"now"`
			All  []string `json:"all"`
		} `json:"proxies"`
	}
	if err := mihomoDo(http.MethodGet, "/proxies", nil, &all, 15*time.Second); err != nil {
		return err
	}
	o.mu.Lock()
	saved := map[string]string{}
	for k, v := range o.st.Route {
		saved[k] = v
	}
	o.mu.Unlock()
	if !on {
		var failed []string
		for g, prev := range saved {
			if prev == "" {
				continue
			}
			if err := mihomoDo(http.MethodPut, "/proxies/"+url.PathEscape(g), map[string]any{"name": prev}, nil, 10*time.Second); err != nil {
				failed = append(failed, g)
			}
		}
		o.mu.Lock()
		o.st.Route = nil
		o.saveLocked()
		o.mu.Unlock()
		o.event("ok", "трафик вернулся на прежние группы")
		if len(failed) > 0 {
			return fmt.Errorf("не вернулись: %s", strings.Join(failed, ", "))
		}
		return nil
	}
	switched := []string{}
	for name, g := range all.Proxies {
		if g.Type != "Selector" || olcRouteSkip[name] || !slices.Contains(g.All, olcGroup) {
			continue
		}
		if g.Now == olcGroup {
			continue
		}
		if err := mihomoDo(http.MethodPut, "/proxies/"+url.PathEscape(name), map[string]any{"name": olcGroup}, nil, 10*time.Second); err != nil {
			continue
		}
		if _, ok := saved[name]; !ok {
			saved[name] = g.Now
		}
		switched = append(switched, name)
	}
	if len(saved) == 0 {
		return errors.New("ни одна ручная группа не содержит OLCRTC — примените «Маршрутизацию», чтобы он появился в ALL и других группах")
	}
	sort.Strings(switched)
	o.mu.Lock()
	o.st.Route = saved
	o.saveLocked()
	o.mu.Unlock()
	o.event("warn", "весь трафик через OLCRTC: "+strings.Join(switched, ", "))
	return nil
}

// olcHasFlag: the name already carries a flag emoji, ours or the user's.
func olcHasFlag(name string) bool {
	for _, r := range name {
		if r >= 0x1F1E6 && r <= 0x1F1FF {
			return true
		}
	}
	return false
}

// ---------- the background loop ----------

// autoLoop watches the variant OLCRTC uses: two failed checks in a row and it
// moves to the first working variant; every ten minutes it checks them all;
// with none working on the user's own server it picks new ones over SSH.
func (o *olcState) autoLoop() {
	if !workerWait(90 * time.Second) {
		return
	}
	n := 0
	lastRepick := map[string]time.Time{}
	for workerWait(time.Minute) {
		n++
		o.mu.Lock()
		auto := o.st.Auto
		busy := o.job != nil && o.job.Running
		o.mu.Unlock()
		if !auto || busy {
			continue
		}
		nodes, err := olcNodes()
		if err != nil || len(nodes) == 0 {
			continue
		}
		cur := olcSelected()
		wl := olcChannelMode() == "whitelist"
		// the first minutes of a whitelist spell check every variant: that is the test that matters
		if wl && !o.wasWL {
			n = 0
		}
		o.wasWL = wl
		if n%10 == 1 || n == 0 {
			o.tidy()
			if fresh, err := olcNodes(); err == nil && len(fresh) > 0 {
				nodes = fresh
				cur = olcSelected()
			}
			for _, nd := range nodes {
				c := olcNodeCheck(nd.Name, 15*time.Second)
				o.mu.Lock()
				o.st.Checks[nd.Name] = c
				o.mu.Unlock()
			}
		} else if cur != "" {
			c := olcNodeCheck(cur, 15*time.Second)
			o.mu.Lock()
			o.st.Checks[cur] = c
			o.mu.Unlock()
		}
		if wl {
			o.markWhitelist()
		}
		o.mu.Lock()
		curOK := o.st.Checks[cur].OK
		if curOK {
			o.fails = 0
		} else {
			o.fails++
		}
		fails := o.fails
		o.saveLocked()
		o.mu.Unlock()
		if curOK || fails < 2 {
			continue
		}
		switched := false
		for _, nd := range nodes {
			if nd.Name == cur {
				continue
			}
			c := olcNodeCheck(nd.Name, 15*time.Second)
			o.mu.Lock()
			o.st.Checks[nd.Name] = c
			o.mu.Unlock()
			if c.OK && olcSelect(nd.Name) == nil {
				o.event("warn", fmt.Sprintf("«%s» не ответил 2 раза подряд → переключился на «%s» (%d мс)", cur, nd.Name, c.MS))
				o.mu.Lock()
				o.fails = 0
				o.mu.Unlock()
				switched = true
				break
			}
		}
		if switched {
			continue
		}
		// nothing works: own servers get new variants, at most once an hour each
		o.mu.Lock()
		ids := []string{}
		for _, s := range o.st.Servers {
			if s.Key != "" && time.Since(lastRepick[s.ID]) > time.Hour {
				ids = append(ids, s.ID)
			}
		}
		o.mu.Unlock()
		for _, id := range ids {
			lastRepick[id] = time.Now()
			if _, err := o.start("repick", olcSetupReq{ID: id}); err == nil {
				o.event("warn", "ни один вариант не отвечает → подбираю новые на своём сервере по SSH")
				break
			}
		}
	}
}

// ---------- HTTP ----------

func (a *app) handleOlcrtcGet(w http.ResponseWriter) {
	if olc == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "OLCRTC не запущен"})
		return
	}
	snap := olc.snapshot()
	snap["ok"] = true
	snap["selected"] = olcSelected()
	a.writeJSON(w, http.StatusOK, response(snap))
}

func (a *app) handleOlcrtcPost(w http.ResponseWriter, r *http.Request) {
	if olc == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "OLCRTC не запущен"})
		return
	}
	fail := func(err error) { a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": err.Error()}) }
	switch strings.TrimPrefix(r.URL.Path, "/api/core/olcrtc/") {
	case "setup", "repick":
		var req olcSetupReq
		if !a.decodeJSON(w, r, &req) {
			return
		}
		kind := strings.TrimPrefix(r.URL.Path, "/api/core/olcrtc/")
		if _, err := olc.start(kind, req); err != nil {
			fail(err)
			return
		}
	case "resume":
		var req struct {
			Action string `json:"action"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		olc.mu.Lock()
		j := olc.job
		waiting := j != nil && j.Waiting != ""
		olc.mu.Unlock()
		if !waiting {
			fail(errors.New("настройка ничего не ждёт"))
			return
		}
		if req.Action != "fix" && req.Action != "skip" && req.Action != "cancel" {
			fail(errors.New("неизвестное действие"))
			return
		}
		j.resume <- req.Action
	case "auto":
		var req struct {
			Auto bool `json:"auto"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		olc.mu.Lock()
		olc.st.Auto = req.Auto
		olc.saveLocked()
		olc.mu.Unlock()
		olc.event("ok", map[bool]string{true: "автоподбор включён", false: "автоподбор выключен"}[req.Auto])
	case "check":
		var req struct {
			Node string `json:"node"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		names := []string{req.Node}
		if req.Node == "" {
			nodes, err := olcNodes()
			if err != nil {
				fail(err)
				return
			}
			names = names[:0]
			for _, n := range nodes {
				names = append(names, n.Name)
			}
		}
		var wg sync.WaitGroup
		for _, n := range names {
			wg.Add(1)
			go func(n string) {
				defer wg.Done()
				c := olcNodeCheck(n, 15*time.Second)
				olc.mu.Lock()
				olc.st.Checks[n] = c
				olc.mu.Unlock()
			}(n)
		}
		wg.Wait()
		olc.mu.Lock()
		olc.saveLocked()
		olc.mu.Unlock()
	case "route":
		var req struct {
			On bool `json:"on"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		if err := olc.route(req.On); err != nil {
			fail(err)
			return
		}
	case "tidy":
		olc.mu.Lock()
		for _, s := range olc.st.Servers {
			s.CountryAt = 0
		}
		olc.mu.Unlock()
		olc.tidy()
	case "main":
		var req struct {
			Node string `json:"node"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		if err := olcSelect(req.Node); err != nil {
			fail(err)
			return
		}
		olc.event("ok", "основным вручную стал «"+req.Node+"»")
	case "remove":
		var req struct {
			ID string `json:"id"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		olc.mu.Lock()
		var srv *olcServer
		rest := olc.st.Servers[:0]
		for _, s := range olc.st.Servers {
			if s.ID == req.ID {
				srv = s
			} else {
				rest = append(rest, s)
			}
		}
		olc.st.Servers = rest
		olc.saveLocked()
		olc.mu.Unlock()
		if srv != nil {
			go func(s *olcServer) {
				x, _, err := olcDial(s, "")
				for _, v := range s.Variants {
					if err == nil {
						olc.dropVariant(x, v)
					} else {
						olc.dropVariant(nil, v)
					}
				}
				if err == nil {
					x.c.Close()
				}
			}(srv)
			olc.event("ok", "сервер «"+srv.Name+"» убран из HomeNet")
		}
	default:
		http.NotFound(w, r)
		return
	}
	a.handleOlcrtcGet(w)
}

// What may already run on the server: HomeNet's own install and olcrtc's
// srv.sh containers with the config each one runs from.
const olcExistingCmd = `echo "HOMENET:"; for f in /opt/olcrtc/olcrtc /opt/olcrtc/olcrtc.key /etc/systemd/system/olcrtc@.service; do [ -e "$f" ] && echo "F $f"; done; [ -s /opt/olcrtc/.built ] && echo "B $(cat /opt/olcrtc/.built)"
systemctl list-units --all 'olcrtc@*' --no-legend --plain 2>/dev/null | awk '{print "U", $1, $3}'
echo "PODMAN:"
if command -v podman >/dev/null; then for c in $(podman ps -a --filter name=olcrtc --format '{{.Names}}'); do
d=$(podman inspect "$c" --format '{{range .Mounts}}{{if eq .Destination "/app"}}{{.Source}}{{end}}{{end}}'); st=$(podman inspect "$c" --format '{{.State.Status}}')
echo "C $c $st $d"; if [ -f "$d/config.yaml" ]; then sed 's/^/  /' "$d/config.yaml"; fi; done; fi
echo "END"`

var olcKeyRe = regexp.MustCompile(`[0-9a-f]{64}`)

func olcMaskKeys(s string) string { return olcKeyRe.ReplaceAllString(s, "<ключ>") }

// olcInstalled: HomeNet's own olcrtc is there, built from the version the router embeds.
func olcInstalled(out string) bool {
	has := func(p string) bool { return strings.Contains(out, "F "+p+"\n") || strings.HasSuffix(out, "F "+p) }
	built := ""
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "B ") {
			built = strings.TrimSpace(l[2:])
		}
	}
	return has("/opt/olcrtc/olcrtc") && has("/opt/olcrtc/olcrtc.key") && has("/etc/systemd/system/olcrtc@.service") && built != "" && strings.HasPrefix(olcCommit, built)
}

func parseOlcExisting(out string) ([]olcFound, []string) {
	var found []olcFound
	own := []string{}
	var cur *olcFound
	var cfg []string
	flush := func() {
		if cur == nil {
			return
		}
		var c struct {
			Auth struct {
				Provider string `yaml:"provider"`
			} `yaml:"auth"`
			Room struct {
				ID string `yaml:"id"`
			} `yaml:"room"`
			Crypto struct {
				Key string `yaml:"key"`
			} `yaml:"crypto"`
			Net struct {
				Transport string `yaml:"transport"`
			} `yaml:"net"`
		}
		_ = yaml.Unmarshal([]byte(strings.Join(cfg, "\n")), &c)
		cur.Provider, cur.Room, cur.Transport, cur.key = c.Auth.Provider, c.Room.ID, c.Net.Transport, c.Crypto.Key
		found = append(found, *cur)
		cur, cfg = nil, nil
	}
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "F /opt/olcrtc/olcrtc.key"):
			own = append(own, "ключ")
		case strings.HasPrefix(line, "F /etc/systemd/system/olcrtc@.service"):
			own = append(own, "служба olcrtc@")
		case strings.HasPrefix(line, "B "):
			own = append(own, "версия "+strings.TrimSpace(line[2:]))
		case strings.HasPrefix(line, "F /opt/olcrtc/olcrtc"):
			own = append(own, "olcrtc собран")
		case strings.HasPrefix(line, "U "):
			if f := strings.Fields(line); len(f) >= 3 {
				own = append(own, f[1]+" "+f[2])
			}
		case strings.HasPrefix(line, "C "):
			flush()
			if f := strings.Fields(line); len(f) >= 3 {
				cur = &olcFound{Container: f[1], Status: f[2]}
				if len(f) >= 4 {
					cur.Dir = f[3]
					cur.InTmp = strings.HasPrefix(f[3], "/tmp/") || strings.HasPrefix(f[3], "/var/tmp/")
				}
			}
		case strings.HasPrefix(line, "  ") && cur != nil:
			cfg = append(cfg, line[2:])
		case line == "END":
			flush()
		}
	}
	flush()
	return found, own
}

func olcHost(room string) string {
	if u, err := url.Parse(room); err == nil && u.Host != "" {
		return u.Host
	}
	return strings.SplitN(strings.TrimPrefix(room, "//"), "/", 2)[0]
}

func olcSameRoom(a, b string) bool {
	norm := func(s string) string {
		s = strings.TrimSuffix(strings.TrimSpace(strings.ToLower(s)), "/")
		return strings.TrimPrefix(strings.TrimPrefix(s, "https://"), "http://")
	}
	return a != "" && norm(a) == norm(b)
}

// migrate moves srv.sh containers that live in /tmp into HomeNet's own
// services: same room, transport and key, so the router's node keeps working.
func (o *olcState) migrate(j *olcJob, x *olcSSH, srv *olcServer) {
	o.mu.Lock()
	vars := append([]olcVariant(nil), srv.Variants...)
	o.mu.Unlock()
	for i, v := range vars {
		if v.External == "" || v.Key == "" {
			continue
		}
		unit := fmt.Sprintf("m%s-%s", randHex(3), v.Transport)
		pr := v.Provider
		if pr == "" {
			pr = "jitsi"
		}
		cfg := fmt.Sprintf("mode: srv\nauth:\n  provider: %s\nroom:\n  id: %q\ncrypto:\n  key_file: %q\nnet:\n  transport: %s\n  dns: \"8.8.8.8:53\"\n", pr, v.Room, olcDir+"/"+unit+".key", v.Transport)
		cmd := fmt.Sprintf("umask 077 && printf %%s %[1]s > %[2]s/%[3]s.key && cat > %[2]s/%[3]s.yaml <<'EOF'\n%[4]sEOF\npodman stop %[5]s >/dev/null && systemctl enable --now olcrtc@%[3]s >/dev/null 2>&1 && sleep 6 && systemctl is-active olcrtc@%[3]s", shq(v.Key), olcDir, unit, cfg, shq(v.External))
		out, err := x.root(cmd, time.Minute)
		ok := err == nil
		if ok {
			var c olcCheck
			for attempt := 0; attempt < 3 && !c.OK; attempt++ {
				if attempt > 0 {
					time.Sleep(4 * time.Second)
				}
				c = olcNodeCheck(v.Node, 15*time.Second)
			}
			ok = c.OK
			if !ok {
				out = "узел не ответил после переноса: " + c.Err
			}
		}
		if !ok {
			_, _ = x.root(fmt.Sprintf("systemctl disable --now olcrtc@%[2]s >/dev/null 2>&1; rm -f %[1]s/%[2]s.yaml %[1]s/%[2]s.key; podman start %[3]s >/dev/null", olcDir, unit, shq(v.External)), time.Minute)
			o.logf(j, "service", "перенос "+v.External+" не удался, контейнер запущен обратно: "+olcLast(olcMaskKeys(out)))
			continue
		}
		_, _ = x.root("podman rm "+shq(v.External)+" >/dev/null", 30*time.Second)
		o.logf(j, "service", fmt.Sprintf("контейнер %s перенесён в olcrtc@%s — та же комната и ключ, узел на роутере не менялся", v.External, unit))
		vars[i].External, vars[i].Unit = "", unit
	}
	o.mu.Lock()
	srv.Variants = vars
	o.saveLocked()
	o.mu.Unlock()
}

// markWhitelist records, while the uplink is in the whitelist mode, how each
// variant of the user's servers did in its last check.
func (o *olcState) markWhitelist() {
	o.mu.Lock()
	defer o.mu.Unlock()
	now := time.Now().Unix()
	for _, s := range o.st.Servers {
		for i, v := range s.Variants {
			c, ok := o.st.Checks[v.Node]
			if !ok || now-c.T > 900 {
				continue
			}
			state := "fail"
			if c.OK {
				state = "ok"
			}
			s.Variants[i].WL, s.Variants[i].WLAt = state, c.T
		}
	}
	o.saveLocked()
}
