package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Blocking analyzer. One target is checked stage by stage over three paths:
//
//   direct   — from the Netcraze with mark 255, i.e. past mihomo straight to
//              the MikroTik and the LTE operator (what DPI/ТСПУ sees);
//   mihomo   — through mihomo's SOCKS port, with the same rules LAN clients get;
//   mikrotik — /ping and /tool/fetch on the MikroTik itself (its own DNS).
//
// Stages: DNS -> TCP -> TLS (real SNI, and a neutral SNI to tell SNI filtering
// from an IP block) -> HTTP (provider stub pages) -> bulk (the 16–20 KB freeze
// ТСПУ applies to foreign hosting).

const (
	directMark  = 255
	neutralSNI  = "vk.com" // whitelisted everywhere; only used against the target's IP
	bulkEnough  = 64 << 10
	freezeLow   = 10 << 10
	freezeHigh  = 32 << 10
	probeUA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
	dohEndpoint = "https://cloudflare-dns.com/dns-query"
)

type probeStep struct {
	ID     string  `json:"id"` // dns | tcp | tls | http | bulk | ping
	Title  string  `json:"title"`
	Status string  `json:"status"`          // ok | fail | warn | skip
	Cause  string  `json:"cause,omitempty"` // sni: the same IP answers another SNI
	MS     float64 `json:"ms,omitempty"`
	Detail string  `json:"detail,omitempty"`
}

type probePath struct {
	ID      string      `json:"id"` // direct | mihomo | mikrotik
	Title   string      `json:"title"`
	Verdict string      `json:"verdict"` // ok | dns | ip | sni | tls | stub | throttle | http | error | skip
	Summary string      `json:"summary"`
	FailAt  string      `json:"fail_at,omitempty"`
	Steps   []probeStep `json:"steps"`
	Rule    string      `json:"rule,omitempty"`
	Chain   []string    `json:"chain,omitempty"`
}

type dnsAnswer struct {
	ID       string   `json:"id"`
	Resolver string   `json:"resolver"`
	Via      string   `json:"via"`
	IPs      []string `json:"ips"`
	Rcode    string   `json:"rcode,omitempty"`
	MS       float64  `json:"ms"`
	Error    string   `json:"error,omitempty"`
	Verdict  string   `json:"verdict"` // ok | differs | empty | bogus | error | reference
}

type clientRoute struct {
	Via    string   `json:"via"` // mihomo | ipset | unknown
	Ipset  string   `json:"ipset,omitempty"`
	Rule   string   `json:"rule,omitempty"`
	Chain  []string `json:"chain,omitempty"`
	Direct bool     `json:"direct"` // leaves through the operator without a proxy
}

type analysis struct {
	Target  string      `json:"target"`
	Host    string      `json:"host"`
	Port    int         `json:"port"`
	Path    string      `json:"path"`
	At      int64       `json:"at"`
	MS      float64     `json:"ms"`
	IP      string      `json:"ip,omitempty"`
	DNS     []dnsAnswer `json:"dns"`
	Paths   []probePath `json:"paths"`
	Clients clientRoute `json:"clients"`
	Verdict string      `json:"verdict"` // open | bypassed | blocked | down | proxy-broken | partial
	Summary string      `json:"summary"`
	Hints   []string    `json:"hints"`
}

var hostPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`)

// parseProbeTarget accepts "host", "host/path", "https://host:port/path".
func parseProbeTarget(raw string) (host string, port int, path string, err error) {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "" {
		return "", 0, "", errors.New("пустая цель")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return "", 0, "", fmt.Errorf("не похоже на домен или URL: %q", raw)
	}
	if u.Scheme != "https" {
		return "", 0, "", errors.New("проверяется только https")
	}
	host = strings.TrimSuffix(u.Hostname(), ".")
	if net.ParseIP(host) == nil && (!hostPattern.MatchString(host) || !strings.Contains(host, ".")) {
		return "", 0, "", fmt.Errorf("некорректное имя хоста %q", host)
	}
	port = 443
	if p := u.Port(); p != "" {
		port, _ = strconv.Atoi(p)
		if port <= 0 || port > 65535 {
			return "", 0, "", errors.New("некорректный порт")
		}
	}
	path = u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	return host, port, path, nil
}

func msSince(t time.Time) float64 { return round2(float64(time.Since(t).Microseconds()) / 1000) }

// analyze runs every requested path in parallel. paths: direct, mihomo, mikrotik.
func analyze(target string, paths []string) (analysis, error) {
	host, port, path, err := parseProbeTarget(target)
	if err != nil {
		return analysis{}, err
	}
	started := time.Now()
	res := analysis{Target: target, Host: host, Port: port, Path: path, At: started.Unix(), DNS: []dnsAnswer{}, Paths: []probePath{}, Hints: []string{}}
	want := map[string]bool{}
	for _, p := range paths {
		want[p] = true
	}
	if len(want) == 0 {
		want = map[string]bool{"direct": true, "mihomo": true, "mikrotik": true}
	}

	res.DNS = resolveAll(host)
	ip := pickIP(res.DNS)
	res.IP = ip

	var wg sync.WaitGroup
	results := map[string]probePath{}
	var mu sync.Mutex
	run := func(id string, fn func() probePath) {
		if !want[id] {
			return
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			p := fn()
			mu.Lock()
			results[id] = p
			mu.Unlock()
		}()
	}
	run("direct", func() probePath { return probeDirect(host, port, path, ip, res.DNS) })
	run("mihomo", func() probePath { return probeMihomo(host, port, path, res.DNS) })
	run("mikrotik", func() probePath { return probeMikrotik(host, port, path, ip, res.DNS) })
	wg.Wait()
	for _, id := range []string{"direct", "mihomo", "mikrotik"} {
		if p, ok := results[id]; ok {
			res.Paths = append(res.Paths, p)
		}
	}
	res.Clients = clientRouteFor(ip, results["mihomo"])
	summarize(&res, results)
	res.MS = msSince(started)
	return res, nil
}

// ---------- DNS ----------

func resolveAll(host string) []dnsAnswer {
	if net.ParseIP(host) != nil {
		return []dnsAnswer{{ID: "literal", Resolver: "IP-адрес", Via: "без DNS", IPs: []string{host}, Verdict: "reference"}}
	}
	type job struct {
		id, name, via string
		fn            func() ([]string, string, error)
	}
	jobs := []job{
		{"doh", "Cloudflare DoH", "через mihomo, зашифровано — эталон", func() ([]string, string, error) { return dohResolve(host, true) }},
		{"mihomo", "mihomo", "то, что получают клиенты LAN", func() ([]string, string, error) { return mihomoResolve(host) }},
		{"mikrotik", "MikroTik → DNS оператора", "UDP 192.168.188.1", func() ([]string, string, error) {
			return udpResolve(getenv("MIKROTIK_DNS", "192.168.188.1")+":53", host, false)
		}},
		{"yandex", "77.88.8.8", "UDP напрямую через оператора", func() ([]string, string, error) { return udpResolve("77.88.8.8:53", host, true) }},
		{"cloudflare", "1.1.1.1", "UDP напрямую через оператора", func() ([]string, string, error) { return udpResolve("1.1.1.1:53", host, true) }},
	}
	out := make([]dnsAnswer, len(jobs))
	var wg sync.WaitGroup
	for i, j := range jobs {
		wg.Add(1)
		go func(i int, j job) {
			defer wg.Done()
			started := time.Now()
			ips, rcode, err := j.fn()
			a := dnsAnswer{ID: j.id, Resolver: j.name, Via: j.via, IPs: ips, Rcode: rcode, MS: msSince(started)}
			if a.IPs == nil {
				a.IPs = []string{}
			}
			if err != nil {
				a.Error = err.Error()
			}
			out[i] = a
		}(i, j)
	}
	wg.Wait()
	if out[0].Error != "" || len(out[0].IPs) == 0 {
		// The proxy may be down: fall back to DoH straight through the operator.
		started := time.Now()
		ips, rcode, err := dohResolve(host, false)
		if err == nil && len(ips) > 0 {
			out[0] = dnsAnswer{ID: "doh", Resolver: "Cloudflare DoH", Via: "напрямую, зашифровано — эталон", IPs: ips, Rcode: rcode, MS: msSince(started)}
		}
	}
	reference := map[string]bool{}
	for _, ip := range out[0].IPs {
		reference[ip] = true
	}
	for i := range out {
		a := &out[i]
		switch {
		case i == 0:
			a.Verdict = "reference"
			if a.Error != "" {
				a.Verdict = "error"
			}
		case a.Error != "":
			a.Verdict = "error"
		case len(a.IPs) == 0:
			a.Verdict = "empty"
		case bogusAnswer(a.IPs, a.ID == "mihomo"):
			a.Verdict = "bogus"
		case len(reference) > 0 && !intersects(a.IPs, reference):
			a.Verdict = "differs"
		default:
			a.Verdict = "ok"
		}
	}
	return out
}

func intersects(ips []string, set map[string]bool) bool {
	for _, ip := range ips {
		if set[ip] {
			return true
		}
	}
	return false
}

var bogusNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, cidr := range []string{"0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "198.18.0.0/15"} {
		_, n, _ := net.ParseCIDR(cidr)
		out = append(out, n)
	}
	return out
}()

// bogusAnswer: a public name resolving into private space is a provider stub
// (mihomo's own fake-ip range is expected for its answers).
func bogusAnswer(ips []string, fakeIPOK bool) bool {
	for _, raw := range ips {
		ip := net.ParseIP(raw)
		if ip == nil {
			continue
		}
		for _, n := range bogusNets {
			if n.Contains(ip) && !(fakeIPOK && n.String() == "198.18.0.0/15") {
				return true
			}
		}
	}
	return false
}

// pickIP prefers the encrypted reference answer, then any sane one.
func pickIP(answers []dnsAnswer) string {
	for _, want := range []string{"reference", "ok", "differs"} {
		for _, a := range answers {
			if a.Verdict == want {
				for _, ip := range a.IPs {
					if parsed := net.ParseIP(ip); parsed != nil && parsed.To4() != nil && !bogusAnswer([]string{ip}, false) {
						return ip
					}
				}
			}
		}
	}
	return ""
}

var dnsRcodes = map[int]string{0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED"}

func udpResolve(server, host string, marked bool) ([]string, string, error) {
	d := net.Dialer{Timeout: 3 * time.Second}
	if marked {
		d.Control = directControl(directMark)
	}
	conn, err := d.Dial("udp", server)
	if err != nil {
		return nil, "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	id := uint16(rand.Intn(65535))
	if _, err := conn.Write(buildDNSQuery(id, host)); err != nil {
		return nil, "", err
	}
	buf := make([]byte, 1500)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return nil, "", fmt.Errorf("нет ответа за 3 с")
		}
		if n >= 2 && binary.BigEndian.Uint16(buf) == id {
			ips, rcode, err := parseDNSResponse(buf[:n])
			return ips, dnsRcodes[rcode], err
		}
	}
}

func buildDNSQuery(id uint16, host string) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, [6]uint16{id, 0x0100, 1, 0, 0, 0})
	for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
		b.WriteByte(byte(len(label)))
		b.WriteString(label)
	}
	b.WriteByte(0)
	_ = binary.Write(&b, binary.BigEndian, [2]uint16{1, 1}) // A, IN
	return b.Bytes()
}

func parseDNSResponse(msg []byte) ([]string, int, error) {
	if len(msg) < 12 {
		return nil, 0, errors.New("короткий DNS-ответ")
	}
	rcode := int(msg[3] & 0x0F)
	qd, an := int(binary.BigEndian.Uint16(msg[4:])), int(binary.BigEndian.Uint16(msg[6:]))
	off := 12
	skipName := func() error {
		for off < len(msg) {
			l := int(msg[off])
			switch {
			case l == 0:
				off++
				return nil
			case l&0xC0 == 0xC0:
				off += 2
				return nil
			default:
				off += l + 1
			}
		}
		return errors.New("битое имя в DNS-ответе")
	}
	for i := 0; i < qd; i++ {
		if err := skipName(); err != nil {
			return nil, rcode, err
		}
		off += 4
	}
	var ips []string
	for i := 0; i < an; i++ {
		if err := skipName(); err != nil {
			return ips, rcode, err
		}
		if off+10 > len(msg) {
			break
		}
		typ := binary.BigEndian.Uint16(msg[off:])
		rdlen := int(binary.BigEndian.Uint16(msg[off+8:]))
		off += 10
		if off+rdlen > len(msg) {
			break
		}
		if typ == 1 && rdlen == 4 {
			ips = append(ips, net.IP(msg[off:off+4]).String())
		}
		off += rdlen
	}
	return ips, rcode, nil
}

type dnsJSON struct {
	Status int `json:"Status"`
	Answer []struct {
		Type int    `json:"type"`
		Data string `json:"data"`
	} `json:"Answer"`
}

func (d dnsJSON) ips() []string {
	var out []string
	for _, a := range d.Answer {
		if a.Type == 1 {
			out = append(out, a.Data)
		}
	}
	return out
}

func dohResolve(host string, viaProxy bool) ([]string, string, error) {
	transport := &http.Transport{TLSHandshakeTimeout: 5 * time.Second}
	if viaProxy {
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			h, p, _ := net.SplitHostPort(addr)
			port, _ := strconv.Atoi(p)
			return socksDial(h, port, 6*time.Second)
		}
	} else {
		d := &net.Dialer{Timeout: 5 * time.Second, Control: directControl(directMark)}
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			// Skip the local resolver: 1.1.1.1 serves cloudflare-dns.com too.
			_, p, _ := net.SplitHostPort(addr)
			return d.DialContext(ctx, network, net.JoinHostPort("1.1.1.1", p))
		}
		transport.TLSClientConfig = &tls.Config{ServerName: "cloudflare-dns.com"}
	}
	client := &http.Client{Timeout: 8 * time.Second, Transport: transport}
	defer transport.CloseIdleConnections()
	req, _ := http.NewRequest(http.MethodGet, dohEndpoint+"?type=A&name="+url.QueryEscape(host), nil)
	req.Header.Set("Accept", "application/dns-json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", shortNetErr(err)
	}
	defer resp.Body.Close()
	var body dnsJSON
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body); err != nil {
		return nil, "", fmt.Errorf("DoH ответил %d", resp.StatusCode)
	}
	return body.ips(), dnsRcodes[body.Status], nil
}

func mihomoController() (string, string) {
	controller := strings.TrimRight(getenv("MIHOMO_CONTROLLER", "http://127.0.0.1:9090"), "/")
	secret := os.Getenv("MIHOMO_SECRET")
	if secret == "" {
		if raw, err := os.ReadFile(getenv("MIHOMO_CONFIG", "/opt/etc/mihomo/config.yaml")); err == nil {
			if m := regexp.MustCompile(`(?m)^secret:\s*['"]?([^'"\s#]+)`).FindSubmatch(raw); m != nil {
				secret = string(m[1])
			}
		}
	}
	return controller, secret
}

func mihomoGet(path string, out any) error {
	controller, secret := mihomoController()
	req, err := http.NewRequest(http.MethodGet, controller+path, nil)
	if err != nil {
		return err
	}
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("контроллер mihomo ответил %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

func mihomoResolve(host string) ([]string, string, error) {
	var body dnsJSON
	if err := mihomoGet("/dns/query?type=A&name="+url.QueryEscape(host), &body); err != nil {
		return nil, "", err
	}
	return body.ips(), dnsRcodes[body.Status], nil
}

// ---------- SOCKS5 through mihomo ----------

func socksDial(host string, port int, timeout time.Duration) (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", getenv("MIHOMO_SOCKS", "127.0.0.1:7891"), timeout)
	if err != nil {
		return nil, fmt.Errorf("SOCKS-порт mihomo недоступен: %w", err)
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	fail := func(err error) (net.Conn, error) {
		conn.Close()
		return nil, err
	}
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		return fail(err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
		return fail(errors.New("mihomo отказал в SOCKS-рукопожатии"))
	}
	req := []byte{5, 1, 0}
	if ip := net.ParseIP(host).To4(); ip != nil {
		req = append(append(req, 1), ip...)
	} else {
		req = append(append(req, 3, byte(len(host))), host...)
	}
	req = binary.BigEndian.AppendUint16(req, uint16(port))
	if _, err := conn.Write(req); err != nil {
		return fail(err)
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return fail(fmt.Errorf("mihomo не ответил на CONNECT: %w", err))
	}
	if head[1] != 0 {
		codes := map[byte]string{1: "общая ошибка", 2: "запрещено правилами", 3: "сеть недоступна", 4: "хост недоступен", 5: "соединение отклонено", 6: "TTL истёк"}
		return fail(fmt.Errorf("mihomo: %s (код %d)", codes[head[1]], head[1]))
	}
	skip := map[byte]int{1: 4 + 2, 4: 16 + 2}[head[3]]
	if head[3] == 3 {
		l := make([]byte, 1)
		if _, err := io.ReadFull(conn, l); err != nil {
			return fail(err)
		}
		skip = int(l[0]) + 2
	}
	if _, err := io.CopyN(io.Discard, conn, int64(skip)); err != nil {
		return fail(err)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

// proxyReachable: a tiny HTTP request through mihomo (used by the monitor).
func proxyReachable(host string, port int, timeout time.Duration) (bool, error) {
	conn, err := socksDial(host, port, timeout)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	fmt.Fprintf(conn, "HEAD /generate_204 HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host)
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return false, shortNetErr(err)
	}
	return strings.HasPrefix(line, "HTTP/"), nil
}

// ---------- TCP / TLS / HTTP stages ----------

// countingConn counts raw bytes read (TLS records included), which is what
// the ТСПУ 16–20 KB rule counts.
type countingConn struct {
	net.Conn
	read int64
}

func (c *countingConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.read += int64(n)
	return n, err
}

func shortNetErr(err error) error {
	if err == nil {
		return nil
	}
	var ne net.Error
	msg := err.Error()
	switch {
	case errors.As(err, &ne) && ne.Timeout():
		return errors.New("таймаут")
	case strings.Contains(msg, "connection reset"):
		return errors.New("соединение сброшено (RST)")
	case strings.Contains(msg, "connection refused"):
		return errors.New("соединение отклонено")
	case strings.Contains(msg, "no route to host"), strings.Contains(msg, "network is unreachable"):
		return errors.New("нет маршрута")
	case errors.Is(err, io.EOF), strings.Contains(msg, "EOF"):
		return errors.New("соединение закрыто без ответа")
	}
	if i := strings.LastIndex(msg, ": "); i > 0 && len(msg)-i < 80 {
		return errors.New(msg[i+2:])
	}
	return err
}

// tlsServerAnswered: an alert from the server still proves it was reached.
func tlsServerAnswered(err error) bool {
	return err != nil && strings.Contains(err.Error(), "remote error")
}

func tlsStep(conn net.Conn, sni string, timeout time.Duration) (*tls.Conn, probeStep, error) {
	step := probeStep{ID: "tls", Title: "TLS"}
	started := time.Now()
	tc := tls.Client(conn, &tls.Config{ServerName: sni, InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}, MinVersion: tls.VersionTLS12}) //nolint:gosec // probing, the cert is checked by hand below
	_ = conn.SetDeadline(time.Now().Add(timeout))
	err := tc.Handshake()
	step.MS = msSince(started)
	if err != nil {
		step.Status, step.Detail = "fail", "SNI "+sni+": "+shortNetErr(err).Error()
		return nil, step, err
	}
	state := tc.ConnectionState()
	step.Status = "ok"
	versions := map[uint16]string{tls.VersionTLS12: "TLS 1.2", tls.VersionTLS13: "TLS 1.3"}
	step.Detail = versions[state.Version]
	if len(state.PeerCertificates) > 0 {
		cert := state.PeerCertificates[0]
		issuer := cert.Issuer.CommonName
		if issuer == "" && len(cert.Issuer.Organization) > 0 {
			issuer = cert.Issuer.Organization[0]
		}
		if err := cert.VerifyHostname(sni); err != nil {
			step.Status = "warn"
			step.Detail += fmt.Sprintf(" · сертификат не для %s (выдан %s) — возможна заглушка или подмена", sni, issuer)
		} else {
			step.Detail += " · сертификат " + issuer
		}
	}
	return tc, step, nil
}

var stubPattern = regexp.MustCompile(`(?i)warning\.rt\.ru|blocked|blocklist|zapret|rkn\.gov|eais|fz-?139|stop\.|lawfilter|block\.`)

// httpSteps sends GET and reads up to bulkEnough raw bytes, classifying the
// response (stub page) and the transfer (freeze after 16–20 KB).
func httpSteps(tc *tls.Conn, raw *countingConn, host, path string) []probeStep {
	httpStep := probeStep{ID: "http", Title: "HTTP"}
	bulk := probeStep{ID: "bulk", Title: "Объём 16–20 КБ"}
	started := time.Now()
	_ = tc.SetDeadline(time.Now().Add(8 * time.Second))
	fmt.Fprintf(tc, "GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: %s\r\nAccept: text/html,*/*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n", path, host, probeUA)
	var head bytes.Buffer
	buf := make([]byte, 16<<10)
	headerDone, complete := false, false
	var plain, bodyStart, contentLength int64 = 0, 0, -1
	var readErr error
	deadline := time.Now().Add(15 * time.Second)
	for raw.read < bulkEnough && time.Now().Before(deadline) {
		_ = tc.SetReadDeadline(time.Now().Add(6 * time.Second))
		n, err := tc.Read(buf)
		plain += int64(n)
		if !headerDone && n > 0 {
			head.Write(buf[:n])
			if i := bytes.Index(head.Bytes(), []byte("\r\n\r\n")); i >= 0 || head.Len() > 64<<10 {
				headerDone = true
				httpStep.MS = msSince(started)
				bodyStart = int64(i + 4)
				contentLength = headerContentLength(head.String())
			}
		}
		// A known-length body read in full is a complete answer, whatever
		// the proxy does with the connection afterwards.
		if headerDone && contentLength >= 0 && plain-bodyStart >= contentLength {
			complete = true
			break
		}
		if err != nil {
			readErr = err
			break
		}
	}
	got := raw.read
	kb := fmt.Sprintf("%.1f КБ", float64(got)/1024)
	if head.Len() == 0 {
		httpStep.Status = "fail"
		httpStep.MS = msSince(started)
		httpStep.Detail = "нет ответа: " + shortNetErr(readErr).Error() + fmt.Sprintf(" (получено %s вместе с рукопожатием)", kb)
		bulk.Status, bulk.Detail = "skip", "нет данных"
		if got >= freezeLow && got <= freezeHigh {
			bulk.Status, bulk.Detail = "fail", "соединение замерло на "+kb+" — похоже на ТСПУ"
		}
		return []probeStep{httpStep, bulk}
	}
	status, location := parseHTTPHead(head.String())
	httpStep.Status = "ok"
	httpStep.Detail = status
	if location != "" {
		httpStep.Detail += " → " + location
	}
	if strings.Contains(status, " 451") || (location != "" && stubPattern.MatchString(location)) {
		httpStep.Status = "fail"
		httpStep.Detail = "заглушка блокировки: " + httpStep.Detail
	}
	finished := complete || errors.Is(readErr, io.EOF) || (readErr != nil && strings.Contains(readErr.Error(), "close_notify"))
	switch {
	case got >= bulkEnough:
		bulk.Status, bulk.Detail = "ok", "получено "+kb+" без обрыва"
	case finished && got < 24<<10:
		bulk.Status, bulk.Detail = "skip", "ответ целиком "+kb+" — мало, чтобы проверить порог 16–20 КБ"
	case finished:
		bulk.Status, bulk.Detail = "ok", "ответ получен целиком, "+kb
	case got >= freezeLow && got <= freezeHigh:
		bulk.Status, bulk.Detail = "fail", "поток замер на "+kb+" ("+shortNetErr(readErr).Error()+") — типичный обрыв ТСПУ"
	default:
		bulk.Status, bulk.Detail = "warn", "поток прервался на "+kb+": "+shortNetErr(readErr).Error()
	}
	return []probeStep{httpStep, bulk}
}

func headerContentLength(head string) int64 {
	for _, line := range strings.Split(head, "\r\n")[1:] {
		if line == "" {
			break
		}
		if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(k), "content-length") {
			if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
				return n
			}
		}
	}
	return -1
}

func parseHTTPHead(head string) (status, location string) {
	lines := strings.Split(head, "\r\n")
	if len(lines) > 0 {
		status = strings.TrimSpace(lines[0])
		if len(status) > 60 {
			status = status[:60]
		}
	}
	for _, line := range lines[1:] {
		if line == "" {
			break
		}
		if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(k), "location") {
			location = strings.TrimSpace(v)
			if len(location) > 120 {
				location = location[:120] + "…"
			}
		}
	}
	return
}

func dnsStepFrom(answers []dnsAnswer, id, title string) probeStep {
	for _, a := range answers {
		if a.ID != id {
			continue
		}
		step := probeStep{ID: "dns", Title: title, MS: a.MS}
		switch a.Verdict {
		case "ok", "reference":
			step.Status, step.Detail = "ok", strings.Join(a.IPs, ", ")
		case "differs":
			step.Status, step.Detail = "warn", strings.Join(a.IPs, ", ")+" — не совпадает с эталоном (бывает у CDN)"
		case "bogus":
			step.Status, step.Detail = "fail", strings.Join(a.IPs, ", ")+" — подмена: частный адрес вместо настоящего"
		case "empty":
			step.Status, step.Detail = "fail", "адрес не отдан ("+firstNonEmpty(a.Rcode, "пусто")+")"
		default:
			step.Status, step.Detail = "fail", a.Error
		}
		return step
	}
	return probeStep{ID: "dns", Title: title, Status: "skip"}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// ---------- paths ----------

func finishPath(p *probePath) {
	for _, s := range p.Steps {
		if s.Status != "fail" {
			continue
		}
		p.FailAt = s.ID
		switch s.ID {
		case "dns":
			p.Verdict, p.Summary = "dns", "DNS: "+s.Detail
		case "tcp":
			p.Verdict, p.Summary = "ip", "TCP не соединяется — блокировка по IP или сервер недоступен"
		case "tls":
			p.Verdict, p.Summary = "tls", "TLS не устанавливается: "+s.Detail
			switch s.Cause {
			case "sni":
				p.Verdict, p.Summary = "sni", "ТСПУ режет по имени сайта (SNI): с другим SNI тот же IP отвечает"
			case "freeze":
				p.Verdict, p.Summary = "freeze", "TCP соединяется, но дальше данные не идут ни с каким SNI — ТСПУ глушит этот IP (так режут зарубежные хостинги и CDN)"
			}
		case "http":
			p.Verdict, p.Summary = "http", s.Detail
			if strings.HasPrefix(s.Detail, "заглушка") {
				p.Verdict = "stub"
			}
		case "bulk":
			p.Verdict, p.Summary = "throttle", s.Detail
		default:
			p.Verdict, p.Summary = "error", s.Detail
		}
		return
	}
	p.Verdict, p.Summary = "ok", "работает"
	for _, s := range p.Steps {
		if s.Status == "warn" {
			p.Summary = "работает, есть замечания"
			break
		}
	}
}

func skipRest(p *probePath, ids ...string) {
	titles := map[string]string{"tcp": "TCP", "tls": "TLS", "http": "HTTP", "bulk": "Объём 16–20 КБ"}
	for _, id := range ids {
		p.Steps = append(p.Steps, probeStep{ID: id, Title: titles[id], Status: "skip"})
	}
}

func probeDirect(host string, port int, path, ip string, answers []dnsAnswer) probePath {
	p := probePath{ID: "direct", Title: "Netcraze напрямую"}
	p.Steps = append(p.Steps, dnsStepFrom(answers, "yandex", "DNS 77.88.8.8"))
	if ip == "" {
		p.Steps = append(p.Steps, probeStep{ID: "tcp", Title: "TCP", Status: "fail", Detail: "не удалось узнать IP ни одним резолвером"})
		skipRest(&p, "tls", "http", "bulk")
		finishPath(&p)
		return p
	}
	d := net.Dialer{Timeout: 6 * time.Second, Control: directControl(directMark)}
	addr := net.JoinHostPort(ip, strconv.Itoa(port))
	started := time.Now()
	conn, err := d.Dial("tcp", addr)
	tcp := probeStep{ID: "tcp", Title: "TCP", MS: msSince(started)}
	if err != nil {
		tcp.Status, tcp.Detail = "fail", addr+": "+shortNetErr(err).Error()
		if ping := localPing(ip, 2); ping.OK {
			tcp.Detail += fmt.Sprintf(" · ICMP до %s проходит (%.0f мс) — порт закрыт или фильтруется", ip, ping.AvgMS)
		}
		p.Steps = append(p.Steps, tcp)
		skipRest(&p, "tls", "http", "bulk")
		finishPath(&p)
		return p
	}
	tcp.Status, tcp.Detail = "ok", addr
	p.Steps = append(p.Steps, tcp)
	raw := &countingConn{Conn: conn}
	defer conn.Close()
	tc, step, err := tlsStep(raw, host, 8*time.Second)
	p.Steps = append(p.Steps, step)
	if err != nil {
		if !tlsServerAnswered(err) {
			// Same IP, neutral SNI: if that works, the name is what is filtered.
			if alt, aerr := d.Dial("tcp", addr); aerr == nil {
				_, altStep, altErr := tlsStep(alt, neutralSNI, 6*time.Second)
				alt.Close()
				if altErr == nil || tlsServerAnswered(altErr) {
					p.Steps[len(p.Steps)-1].Cause = "sni"
					p.Steps[len(p.Steps)-1].Detail += " · с SNI " + neutralSNI + " тот же IP отвечает"
				} else {
					p.Steps[len(p.Steps)-1].Detail += " · с SNI " + neutralSNI + " тоже нет ответа"
					if strings.Contains(altStep.Detail, "таймаут") && strings.Contains(step.Detail, "таймаут") {
						p.Steps[len(p.Steps)-1].Cause = "freeze"
					}
				}
			}
		}
		skipRest(&p, "http", "bulk")
		finishPath(&p)
		return p
	}
	p.Steps = append(p.Steps, httpSteps(tc, raw, host, path)...)
	finishPath(&p)
	return p
}

func probeMihomo(host string, port int, path string, answers []dnsAnswer) probePath {
	p := probePath{ID: "mihomo", Title: "Netcraze через mihomo"}
	dns := dnsStepFrom(answers, "mihomo", "DNS mihomo")
	started := time.Now()
	conn, err := socksDial(host, port, 10*time.Second)
	tcp := probeStep{ID: "tcp", Title: "Соединение через прокси", MS: msSince(started)}
	if err != nil {
		p.Steps = append(p.Steps, dns)
		tcp.Status, tcp.Detail = "fail", err.Error()
		p.Steps = append(p.Steps, tcp)
		skipRest(&p, "tls", "http", "bulk")
		finishPath(&p)
		return p
	}
	defer conn.Close()
	raw := &countingConn{Conn: conn}
	tc, step, tlsErr := tlsStep(raw, host, 10*time.Second)
	// While the connection is open, ask mihomo which rule and chain it used.
	if local, ok := conn.LocalAddr().(*net.TCPAddr); ok {
		p.Rule, p.Chain = mihomoConnectionRoute(host, local.Port)
	}
	if len(p.Chain) > 0 && !strings.EqualFold(p.Chain[len(p.Chain)-1], "DIRECT") {
		dns.Status, dns.Detail = "skip", "имя резолвит прокси-узел"
	}
	p.Steps = append(p.Steps, dns)
	tcp.Status, tcp.Detail = "ok", strings.Join(p.Chain, " → ")
	p.Steps = append(p.Steps, tcp, step)
	if tlsErr != nil {
		skipRest(&p, "http", "bulk")
		finishPath(&p)
		return p
	}
	p.Steps = append(p.Steps, httpSteps(tc, raw, host, path)...)
	finishPath(&p)
	return p
}

func mihomoConnectionRoute(host string, localPort int) (string, []string) {
	var body struct {
		Connections []struct {
			Chains      []string `json:"chains"`
			Rule        string   `json:"rule"`
			RulePayload string   `json:"rulePayload"`
			Metadata    struct {
				Host       string `json:"host"`
				SourcePort string `json:"sourcePort"`
				DestIP     string `json:"destinationIP"`
			} `json:"metadata"`
		} `json:"connections"`
	}
	for attempt := 0; attempt < 3; attempt++ {
		if err := mihomoGet("/connections", &body); err != nil {
			return "", nil
		}
		for _, c := range body.Connections {
			if c.Metadata.SourcePort == strconv.Itoa(localPort) && (c.Metadata.Host == host || c.Metadata.DestIP == host) {
				rule := c.Rule
				if c.RulePayload != "" {
					rule += " (" + c.RulePayload + ")"
				}
				// mihomo lists the chain from the node outwards.
				chain := make([]string, 0, len(c.Chains))
				for i := len(c.Chains) - 1; i >= 0; i-- {
					chain = append(chain, c.Chains[i])
				}
				return rule, chain
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	return "", nil
}

func probeMikrotik(host string, port int, path, ip string, answers []dnsAnswer) probePath {
	p := probePath{ID: "mikrotik", Title: "MikroTik напрямую"}
	p.Steps = append(p.Steps, dnsStepFrom(answers, "mikrotik", "DNS оператора"))
	creds, err := readROSCredentials(getenv("MIKROTIK_CREDENTIALS_FILE", "/opt/etc/homenet/secrets/mikrotik.env"))
	if err != nil {
		p.Steps = []probeStep{{ID: "tcp", Title: "RouterOS API", Status: "fail", Detail: err.Error()}}
		p.Verdict, p.Summary = "skip", err.Error()
		return p
	}
	conn, err := dialROS(creds, 5*time.Second)
	if err != nil {
		p.Steps = []probeStep{{ID: "tcp", Title: "RouterOS API", Status: "fail", Detail: err.Error()}}
		p.Verdict, p.Summary = "skip", "MikroTik недоступен: "+err.Error()
		return p
	}
	defer conn.Close()
	if ip != "" {
		ping := rosPing(conn, ip, 3)
		step := probeStep{ID: "ping", Title: "ICMP до " + ip, Status: "warn", Detail: "нет ответа (многие серверы не отвечают на ping)"}
		if ping.OK {
			step.Status, step.MS, step.Detail = "ok", ping.AvgMS, fmt.Sprintf("потери %.0f%%", ping.Loss)
		}
		p.Steps = append(p.Steps, step)
	}
	target := fmt.Sprintf("https://%s:%d%s", host, port, path)
	started := time.Now()
	reply, err := conn.Run(25*time.Second, "/tool/fetch", "=url="+target, "=mode=https", "=output=none", "=check-certificate=no", "=duration=15s")
	elapsed := msSince(started)
	var downloaded int64
	finished := false
	for _, row := range reply.Rows {
		if v := rosInt(row["downloaded"]); v > downloaded {
			downloaded = v // KiB
		}
		finished = finished || row["status"] == "finished"
	}
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	lower := strings.ToLower(msg)
	kb := fmt.Sprintf("%d КБ", downloaded)
	add := func(id, title, status, detail string) {
		p.Steps = append(p.Steps, probeStep{ID: id, Title: title, Status: status, Detail: detail})
	}
	switch {
	case err == nil && !finished && downloaded == 0:
		// fetch stops silently when =duration= runs out.
		add("tcp", "TCP / TLS", "fail", "за 15 с не пришло ни байта — соединение повисло")
		skipRest(&p, "tls", "http", "bulk")
	case err == nil && !finished:
		add("tcp", "TCP", "ok", "")
		add("tls", "TLS", "ok", "")
		add("http", "HTTP", "ok", "")
		status := "warn"
		if downloaded*1024 >= freezeLow && downloaded*1024 <= freezeHigh {
			status = "fail"
		}
		add("bulk", "Объём 16–20 КБ", status, "за 15 с получено только "+kb+" — поток замер")
	case err == nil:
		add("tcp", "TCP", "ok", "")
		add("tls", "TLS", "ok", "")
		add("http", "HTTP", "ok", "fetch завершён за "+strconv.FormatFloat(elapsed/1000, 'f', 1, 64)+" с")
		if downloaded*1024 < 24<<10 {
			add("bulk", "Объём 16–20 КБ", "skip", "получено "+kb+" — мало для проверки")
		} else {
			add("bulk", "Объём 16–20 КБ", "ok", "получено "+kb)
		}
	case strings.Contains(lower, "resolv"):
		// The fetch never started; the DNS stage already shows why.
		if p.Steps[0].Status != "fail" {
			p.Steps[0].Status, p.Steps[0].Detail = "fail", msg
		}
		skipRest(&p, "tcp", "tls", "http", "bulk")
	case strings.Contains(lower, "status"):
		add("tcp", "TCP", "ok", "")
		add("tls", "TLS", "ok", "")
		detail := strings.TrimPrefix(msg, "failure: ")
		status := "ok"
		if strings.Contains(msg, "451") || stubPattern.MatchString(msg) {
			status, detail = "fail", "заглушка блокировки: "+detail
		}
		add("http", "HTTP", status, detail)
		add("bulk", "Объём 16–20 КБ", "skip", "fetch не читает тело при коде ошибки")
	case downloaded > 0:
		add("tcp", "TCP", "ok", "")
		add("tls", "TLS", "ok", "")
		add("http", "HTTP", "ok", "")
		status := "warn"
		if downloaded*1024 >= freezeLow && downloaded*1024 <= freezeHigh {
			status = "fail"
		}
		add("bulk", "Объём 16–20 КБ", status, "оборвалось на "+kb+": "+msg)
	case strings.Contains(lower, "ssl") || strings.Contains(lower, "tls") || strings.Contains(lower, "handshake"):
		add("tcp", "TCP", "ok", "")
		add("tls", "TLS", "fail", msg)
		skipRest(&p, "http", "bulk")
	case strings.Contains(lower, "timeout") || strings.Contains(lower, "timed out") || strings.Contains(lower, "connect"):
		add("tcp", "TCP / TLS", "fail", msg+" — fetch не различает TCP и TLS")
		skipRest(&p, "tls", "http", "bulk")
	default:
		add("http", "fetch", "fail", msg)
	}
	finishPath(&p)
	return p
}

// ---------- verdict ----------

func clientRouteFor(ip string, mihomo probePath) clientRoute {
	route := clientRoute{Via: "unknown"}
	if ip != "" {
		for _, set := range []string{"geo_exclude", "user_exclude", "ext_exclude"} {
			if exec.Command("ipset", "test", set, ip).Run() == nil {
				// XKeen's iptables return these before mihomo sees them.
				return clientRoute{Via: "ipset", Ipset: set, Direct: true}
			}
		}
	}
	if mihomo.Rule != "" || len(mihomo.Chain) > 0 {
		route = clientRoute{Via: "mihomo", Rule: mihomo.Rule, Chain: mihomo.Chain}
		route.Direct = len(mihomo.Chain) > 0 && strings.EqualFold(mihomo.Chain[len(mihomo.Chain)-1], "DIRECT")
	}
	return route
}

var verdictWords = map[string]string{
	"dns": "DNS", "ip": "блокировка по IP", "sni": "ТСПУ по SNI", "tls": "TLS не устанавливается",
	"stub": "заглушка", "throttle": "ТСПУ: обрыв 16–20 КБ", "freeze": "ТСПУ глушит IP", "http": "ошибка HTTP", "error": "ошибка",
}

func summarize(res *analysis, paths map[string]probePath) {
	direct, hasDirect := paths["direct"]
	mihomo, hasMihomo := paths["mihomo"]
	directOK := hasDirect && direct.Verdict == "ok"
	mihomoOK := hasMihomo && mihomo.Verdict == "ok"
	switch {
	case hasDirect && hasMihomo && directOK && mihomoOK:
		res.Verdict, res.Summary = "open", "Открыт и напрямую, и через mihomo"
	case hasDirect && hasMihomo && !directOK && mihomoOK:
		res.Verdict, res.Summary = "bypassed", "Заблокирован у оператора ("+verdictWords[direct.Verdict]+"), через mihomo работает"
	case hasDirect && hasMihomo && directOK && !mihomoOK:
		res.Verdict, res.Summary = "proxy-broken", "Напрямую работает, а через mihomo — нет ("+mihomo.Summary+")"
	case hasDirect && hasMihomo:
		res.Verdict, res.Summary = "down", "Не работает ни напрямую ("+verdictWords[direct.Verdict]+"), ни через mihomo"
	case hasDirect && directOK, hasMihomo && mihomoOK:
		res.Verdict, res.Summary = "open", "Работает"
	default:
		res.Verdict, res.Summary = "blocked", "Не работает"
	}
	if hasDirect && !directOK && res.Clients.Direct {
		why := "правило mihomo " + res.Clients.Rule
		if res.Clients.Via == "ipset" {
			why = "IP в списке " + res.Clients.Ipset + " (мимо mihomo)"
		}
		res.Hints = append(res.Hints, "Клиенты LAN идут к нему напрямую ("+why+"), а напрямую он заблокирован — нужно правило через прокси.")
		if res.Verdict == "bypassed" {
			res.Verdict = "partial"
		}
	}
	if directOK && res.Clients.Via == "mihomo" && !res.Clients.Direct && len(res.Clients.Chain) > 0 {
		res.Hints = append(res.Hints, "Напрямую сайт открыт, а клиенты идут через "+strings.Join(res.Clients.Chain, " → ")+" — можно пустить его напрямую и не тратить прокси.")
	}
	for _, a := range res.DNS {
		switch {
		case a.Verdict == "bogus":
			res.Hints = append(res.Hints, "Резолвер «"+a.Resolver+"» подменяет адрес ("+strings.Join(a.IPs, ", ")+") — блокировка на уровне DNS.")
		case a.Verdict == "empty" && len(res.DNS[0].IPs) > 0:
			res.Hints = append(res.Hints, "Резолвер «"+a.Resolver+"» не отдаёт адрес ("+firstNonEmpty(a.Rcode, "пустой ответ")+"), хотя он существует — блокировка на уровне DNS.")
		}
	}
	if mt, ok := paths["mikrotik"]; ok && hasDirect && mt.Verdict != "skip" && (mt.Verdict == "ok") != directOK {
		res.Hints = append(res.Hints, "MikroTik и Netcraze напрямую видят разное: MikroTik — «"+mt.Summary+"», Netcraze — «"+direct.Summary+"». MikroTik ходит через DNS оператора.")
	}
}
