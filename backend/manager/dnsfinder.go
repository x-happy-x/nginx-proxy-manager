package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DNS finder: which public resolvers work from here, over which transport
// (plain UDP, DoT, DoH), directly through the operator and through mihomo,
// how fast, and whether they give real answers for blocked domains. The
// reference answer for each domain is Cloudflare DoH through mihomo.

type dnsProvider struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Note string   `json:"note,omitempty"`
	UDP  []string `json:"udp,omitempty"` // IPs
	DoT  string   `json:"dot,omitempty"` // host
	DoH  string   `json:"doh,omitempty"` // URL
}

var dnsProviders = []dnsProvider{
	{ID: "yandex", Name: "Яндекс", UDP: []string{"77.88.8.8"}, DoT: "common.dot.dns.yandex.net", DoH: "https://common.dot.dns.yandex.net/dns-query"},
	{ID: "google", Name: "Google", UDP: []string{"8.8.8.8"}, DoT: "dns.google", DoH: "https://dns.google/dns-query"},
	{ID: "cloudflare", Name: "Cloudflare", UDP: []string{"1.1.1.1"}, DoT: "one.one.one.one", DoH: "https://cloudflare-dns.com/dns-query"},
	{ID: "quad9", Name: "Quad9", UDP: []string{"9.9.9.9"}, DoT: "dns.quad9.net", DoH: "https://dns.quad9.net/dns-query"},
	{ID: "adguard", Name: "AdGuard", Note: "режет рекламу", UDP: []string{"94.140.14.14"}, DoT: "dns.adguard-dns.com", DoH: "https://dns.adguard-dns.com/dns-query"},
	{ID: "opendns", Name: "OpenDNS", UDP: []string{"208.67.222.222"}, DoH: "https://doh.opendns.com/dns-query"},
	{ID: "controld", Name: "Control D", UDP: []string{"76.76.2.0"}, DoT: "p0.freedns.controld.com", DoH: "https://freedns.controld.com/p0"},
	{ID: "mullvad", Name: "Mullvad", DoT: "dns.mullvad.net", DoH: "https://dns.mullvad.net/dns-query"},
	{ID: "comss", Name: "Comss.one", Note: "подменяет адреса заблокированных сервисов на свои прокси", DoT: "dns.comss.one", DoH: "https://dns.comss.one/dns-query"},
	{ID: "xbox", Name: "Xbox DNS", Note: "российский сервис обхода геоблока", UDP: []string{"111.88.96.50"}, DoH: "https://xbox-dns.ru/dns-query"},
}

// Domains: blocked in Russia, geo-closed from Russia, and whitelisted.
var dnsProbeDomains = []struct {
	Host, Kind string
}{
	{"youtube.com", "blocked"},
	{"rutracker.org", "blocked"},
	{"instagram.com", "blocked"},
	{"chatgpt.com", "geo"},
	{"gosuslugi.ru", "ru"},
}

type dnsCheck struct {
	Provider  string            `json:"provider"`
	Transport string            `json:"transport"` // udp | dot | doh
	Path      string            `json:"path"`      // direct | mihomo
	Target    string            `json:"target"`
	OK        bool              `json:"ok"`
	MS        float64           `json:"ms,omitempty"`
	Answered  int               `json:"answered"`
	Spoofed   []string          `json:"spoofed"` // bogus or NXDOMAIN where the reference has an answer
	Changed   []string          `json:"changed"` // other public IPs than the reference (CDNs answer by location)
	Proxied   []string          `json:"proxied"` // unrelated sites answered with one shared IP: a bypass-proxy DNS
	Error     string            `json:"error,omitempty"`
	Verdict   string            `json:"verdict"` // good | proxyish | filtered | down
	Chain     []string          `json:"chain,omitempty"`
	Answers   map[string]string `json:"answers"`
}

type dnsFinderState struct {
	mu       sync.Mutex
	running  bool
	started  int64
	finished int64
	progress int
	total    int
	checks   []dnsCheck
	ref      map[string][]string
}

var dnsFinder = &dnsFinderState{}

// ---------- transports ----------

// dnsDialer dials directly (mark 255) or through mihomo's SOCKS port; for
// the first proxied connection it records mihomo's chain into *chain.
func dnsDialer(path string, timeout time.Duration, chain *[]string) func(network, addr string) (net.Conn, error) {
	return func(network, addr string) (net.Conn, error) {
		if path == "mihomo" {
			if network != "tcp" {
				return nil, errors.New("только TCP через SOCKS")
			}
			h, p, _ := net.SplitHostPort(addr)
			port, _ := strconv.Atoi(p)
			conn, err := socksDial(h, port, timeout)
			if err == nil && chain != nil && len(*chain) == 0 {
				if local, ok := conn.LocalAddr().(*net.TCPAddr); ok {
					_, *chain = mihomoConnectionRoute(h, local.Port)
				}
			}
			return conn, err
		}
		d := net.Dialer{Timeout: timeout, Control: directControl(directMark)}
		return d.Dial(network, addr)
	}
}

func queryPacket(host string) (uint16, []byte) {
	id := uint16(rand.Intn(65535))
	return id, buildDNSQuery(id, host)
}

// dnsUDPDirect: plain DNS over UDP past mihomo.
func dnsUDPDirect(server, host string) ([]string, int, error) {
	ips, rcode, err := udpResolve(net.JoinHostPort(server, "53"), host, true)
	code := 0
	for k, v := range dnsRcodes {
		if v == rcode {
			code = k
		}
	}
	return ips, code, err
}

// dnsTCP53: DNS over TCP port 53 — the way to send "plain" DNS through the
// SOCKS proxy.
func dnsTCP53(dial func(string, string) (net.Conn, error), server, host string) ([]string, int, error) {
	conn, err := dial("tcp", net.JoinHostPort(server, "53"))
	if err != nil {
		return nil, 0, err
	}
	defer conn.Close()
	return dnsOverStream(conn, host)
}

func dnsOverStream(conn net.Conn, host string) ([]string, int, error) {
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, q := queryPacket(host)
	msg := binary.BigEndian.AppendUint16(nil, uint16(len(q)))
	if _, err := conn.Write(append(msg, q...)); err != nil {
		return nil, 0, err
	}
	head := make([]byte, 2)
	if _, err := io.ReadFull(conn, head); err != nil {
		return nil, 0, err
	}
	body := make([]byte, binary.BigEndian.Uint16(head))
	if _, err := io.ReadFull(conn, body); err != nil {
		return nil, 0, err
	}
	return parseDNSResponse(body)
}

func dnsDoT(dial func(string, string) (net.Conn, error), server, host string) ([]string, int, error) {
	conn, err := dial("tcp", net.JoinHostPort(server, "853"))
	if err != nil {
		return nil, 0, err
	}
	tc := tls.Client(conn, &tls.Config{ServerName: server, MinVersion: tls.VersionTLS12})
	_ = tc.SetDeadline(time.Now().Add(6 * time.Second))
	if err := tc.Handshake(); err != nil {
		conn.Close()
		return nil, 0, err
	}
	defer tc.Close()
	return dnsOverStream(tc, host)
}

func dnsDoH(dial func(string, string) (net.Conn, error), endpoint, host string) ([]string, int, error) {
	transport := &http.Transport{
		DialContext:         func(_ context.Context, network, addr string) (net.Conn, error) { return dial(network, addr) },
		TLSHandshakeTimeout: 6 * time.Second,
		ForceAttemptHTTP2:   true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 8 * time.Second, Transport: transport}
	_, q := queryPacket(host)
	binary.BigEndian.PutUint16(q, 0) // RFC 8484: ID 0 keeps answers cacheable
	req, _ := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(q))
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, 0, err
	}
	return parseDNSResponse(body)
}

// ---------- run ----------

type dnsJob struct {
	provider  dnsProvider
	transport string
	path      string
	target    string
}

func (s *dnsFinderState) start() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return false
	}
	var jobs []dnsJob
	for _, p := range dnsProviders {
		for _, path := range []string{"direct", "mihomo"} {
			for _, ip := range p.UDP {
				jobs = append(jobs, dnsJob{p, "udp", path, ip})
			}
			if p.DoT != "" {
				jobs = append(jobs, dnsJob{p, "dot", path, p.DoT})
			}
			if p.DoH != "" {
				jobs = append(jobs, dnsJob{p, "doh", path, p.DoH})
			}
		}
	}
	// The operator's own resolvers, as the MikroTik got them.
	netmon.mu.Lock()
	var opDNS []string
	if netmon.view.System != nil {
		opDNS = append(opDNS, netmon.view.System.DNSServers...)
	}
	netmon.mu.Unlock()
	op := dnsProvider{ID: "operator", Name: "DNS оператора", Note: "выдан MikroTik по LTE"}
	for _, ip := range opDNS {
		jobs = append(jobs, dnsJob{op, "udp", "direct", ip})
	}
	jobs = append(jobs, dnsJob{dnsProvider{ID: "mikrotik", Name: "MikroTik", Note: "кэш MikroTik → оператор"}, "udp", "direct", "192.168.188.1"})

	s.running, s.started, s.finished, s.progress, s.total, s.checks = true, time.Now().Unix(), 0, 0, len(jobs), nil
	go s.run(jobs)
	return true
}

func (s *dnsFinderState) run(jobs []dnsJob) {
	ref := map[string][]string{}
	for _, d := range dnsProbeDomains {
		if ips, _, err := dohResolve(d.Host, true); err == nil && len(ips) > 0 {
			ref[d.Host] = ips
		} else if ips, _, err := dohResolve(d.Host, false); err == nil {
			ref[d.Host] = ips
		}
	}
	results := make([]dnsCheck, len(jobs))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i, job := range jobs {
		wg.Add(1)
		go func(i int, job dnsJob) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[i] = runDNSJob(job, ref)
			s.mu.Lock()
			s.progress++
			s.mu.Unlock()
		}(i, job)
	}
	wg.Wait()
	s.mu.Lock()
	s.checks, s.ref, s.running, s.finished = results, ref, false, time.Now().Unix()
	s.mu.Unlock()
}

func runDNSJob(job dnsJob, ref map[string][]string) (c dnsCheck) {
	c = dnsCheck{Provider: job.provider.ID, Transport: job.transport, Path: job.path, Target: job.target, Spoofed: []string{}, Changed: []string{}, Proxied: []string{}, Answers: map[string]string{}}
	ipOwners := map[string][]string{}
	var chain []string
	dial := dnsDialer(job.path, 6*time.Second, &chain)
	defer func() { c.Chain = chain }()
	var times []float64
	var lastErr error
	for _, d := range dnsProbeDomains {
		started := time.Now()
		var ips []string
		var rcode int
		var err error
		switch {
		case job.transport == "udp" && job.path == "direct":
			ips, rcode, err = dnsUDPDirect(job.target, d.Host)
		case job.transport == "udp":
			ips, rcode, err = dnsTCP53(dial, job.target, d.Host)
		case job.transport == "dot":
			ips, rcode, err = dnsDoT(dial, job.target, d.Host)
		default:
			ips, rcode, err = dnsDoH(dial, job.target, d.Host)
		}
		if err != nil {
			lastErr = err
			c.Answers[d.Host] = "ошибка"
			// A resolver that cannot answer the first two is down: skip the rest.
			if c.Answered == 0 && len(times) == 0 && d.Host == dnsProbeDomains[1].Host {
				break
			}
			continue
		}
		times = append(times, float64(time.Since(started).Microseconds())/1000)
		c.Answered++
		want := ref[d.Host]
		switch {
		case len(ips) == 0 && len(want) > 0:
			c.Spoofed = append(c.Spoofed, d.Host)
			c.Answers[d.Host] = firstNonEmpty(dnsRcodes[rcode], "пусто")
		case bogusAnswer(ips, false):
			c.Spoofed = append(c.Spoofed, d.Host)
			c.Answers[d.Host] = strings.Join(ips, ", ")
		default:
			c.Answers[d.Host] = strings.Join(ips, ", ")
			for _, ip := range ips {
				ipOwners[ip] = append(ipOwners[ip], d.Host)
			}
			set := map[string]bool{}
			for _, ip := range want {
				set[ip] = true
			}
			if len(want) > 0 && !intersects(ips, set) && !sameNet24(ips, want) {
				c.Changed = append(c.Changed, d.Host)
			}
		}
	}
	if c.Answered == 0 {
		c.Verdict = "down"
		if lastErr != nil {
			c.Error = shortNetErr(lastErr).Error()
		}
		return c
	}
	// Different services never share an address, unless the resolver points
	// them all at its own proxy (Comss, Xbox DNS and the like).
	proxied := map[string]bool{}
	for _, hosts := range ipOwners {
		if len(hosts) >= 2 {
			for _, h := range hosts {
				proxied[h] = true
			}
		}
	}
	for _, d := range dnsProbeDomains {
		if proxied[d.Host] {
			c.Proxied = append(c.Proxied, d.Host)
		}
	}
	sort.Float64s(times)
	c.MS = round2(times[len(times)/2])
	c.OK = true
	switch {
	case len(c.Spoofed) > 0:
		c.Verdict = "filtered"
	case len(c.Proxied) >= 2:
		c.Verdict = "proxyish"
	default:
		c.Verdict = "good"
	}
	if c.Answered < len(dnsProbeDomains) && c.Verdict == "good" {
		c.Verdict = "partial"
	}
	return c
}

// sameNet24: CDNs answer with neighbouring addresses; a shared /24 counts as
// the same answer.
func sameNet24(a, b []string) bool {
	prefix := func(ip string) string {
		if i := strings.LastIndex(ip, "."); i > 0 {
			return ip[:i]
		}
		return ip
	}
	set := map[string]bool{}
	for _, ip := range b {
		set[prefix(ip)] = true
	}
	for _, ip := range a {
		if set[prefix(ip)] {
			return true
		}
	}
	return false
}

// ---------- HTTP ----------

func (a *app) handleDNSFinderGet(w http.ResponseWriter) {
	dnsFinder.mu.Lock()
	defer dnsFinder.mu.Unlock()
	domains := []map[string]string{}
	for _, d := range dnsProbeDomains {
		domains = append(domains, map[string]string{"host": d.Host, "kind": d.Kind})
	}
	a.writeJSON(w, http.StatusOK, response{
		"ok": true, "running": dnsFinder.running, "started": dnsFinder.started, "finished": dnsFinder.finished,
		"progress": dnsFinder.progress, "total": dnsFinder.total, "checks": dnsFinder.checks, "reference": dnsFinder.ref,
		"providers": append(append([]dnsProvider{}, dnsProviders...),
			dnsProvider{ID: "operator", Name: "DNS оператора", Note: "выдан MikroTik по LTE"},
			dnsProvider{ID: "mikrotik", Name: "MikroTik", Note: "кэш MikroTik → оператор"}),
		"domains":        domains,
		"mihomo_servers": mihomoNameservers(),
	})
}

func (a *app) handleDNSFinderRun(w http.ResponseWriter) {
	dnsFinder.start()
	a.writeJSON(w, http.StatusOK, response{"ok": true})
}
