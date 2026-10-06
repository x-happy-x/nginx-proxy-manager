package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Connectivity pages (NPM-52): the addresses phones and browsers use to tell
// whether there is internet, opened straight through the uplink and through
// mihomo with the devices' rules. Straight answers tell the uplink's mode (a
// Yandex page opens while Google's does not — the whitelist), through mihomo
// whether the VPN carries the rest. Cloudflare's trace names the exit.

type probeDef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	What string `json:"what"`
	URL  string `json:"url"`
	// "ru": kept by the whitelist; "world": not
	Region string `json:"region"`
	Status int    `json:"status"`
	Body   string `json:"body,omitempty"`
	Trace  bool   `json:"trace,omitempty"`
}

var connProbes = []probeDef{
	{ID: "yandex", Name: "Яндекс", What: "generate_204 Яндекс Браузера", URL: "https://api.browser.yandex.ru/generate_204", Region: "ru", Status: 204},
	{ID: "yandex-http", Name: "Яндекс (HTTP)", What: "то же без шифрования", URL: "http://api.browser.yandex.ru/generate_204", Region: "ru", Status: 204},
	{ID: "gstatic", Name: "Google gstatic", What: "проверка связи Android и Chrome", URL: "https://www.gstatic.com/generate_204", Region: "world", Status: 204},
	{ID: "google", Name: "Google", What: "generate_204 на www.google.com", URL: "https://www.google.com/generate_204", Region: "world", Status: 204},
	{ID: "cloudflare", Name: "Cloudflare", What: "проверка связи Cloudflare WARP", URL: "https://cp.cloudflare.com/generate_204", Region: "world", Status: 204},
	{ID: "miui", Name: "Xiaomi", What: "проверка связи MIUI, без шифрования", URL: "http://connect.rom.miui.com/generate_204", Region: "world", Status: 204},
	{ID: "apple", Name: "Apple", What: "проверка связи iPhone и Mac", URL: "http://captive.apple.com/hotspot-detect.html", Region: "world", Status: 200, Body: "Success"},
	{ID: "microsoft", Name: "Microsoft", What: "значок сети в Windows", URL: "http://www.msftconnecttest.com/connecttest.txt", Region: "world", Status: 200, Body: "Microsoft Connect Test"},
	{ID: "firefox", Name: "Firefox", What: "проверка связи Firefox", URL: "http://detectportal.firefox.com/success.txt", Region: "world", Status: 200, Body: "success"},
	{ID: "trace", Name: "Где выход в интернет", What: "Cloudflare: страна и адрес выхода", URL: "https://1.1.1.1/cdn-cgi/trace", Region: "world", Status: 200, Body: "loc=", Trace: true},
}

type probeResult struct {
	T      int64  `json:"t"`
	OK     bool   `json:"ok"`
	MS     int64  `json:"ms"`
	Status int    `json:"status,omitempty"`
	Error  string `json:"error,omitempty"`
}

type probeWay struct {
	History []probeResult `json:"history"`
	// trace: the exit's country and address
	Loc  string   `json:"loc,omitempty"`
	IP   string   `json:"ip,omitempty"`
	Path []string `json:"path,omitempty"`
}

type probeState struct {
	probeDef
	Direct probeWay `json:"direct"`
	Mihomo probeWay `json:"mihomo"`
}

// directResolver asks Yandex's DNS straight through the uplink: the router's
// own resolver may hand out mihomo's fake addresses, and 1.1.1.1 is not in
// the whitelist.
var directResolver = &net.Resolver{
	PreferGo: true,
	Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		d := net.Dialer{Timeout: 3 * time.Second, Control: directControl(directMark)}
		return d.DialContext(ctx, network, "77.88.8.8:53")
	},
}

func probeTransport(dial func(ctx context.Context, host string, port int) (net.Conn, error), host string) *http.Transport {
	return &http.Transport{
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			_, p, _ := net.SplitHostPort(addr)
			port, _ := strconv.Atoi(p)
			return dial(ctx, host, port)
		},
		TLSClientConfig:       &tls.Config{ServerName: host},
		TLSHandshakeTimeout:   serviceTimeout,
		ResponseHeaderTimeout: serviceTimeout,
		DisableKeepAlives:     true,
	}
}

func dialDirect(ctx context.Context, host string, port int) (net.Conn, error) {
	ip := host
	if net.ParseIP(host) == nil {
		ips, err := directResolver.LookupIPAddr(ctx, host)
		if err != nil || len(ips) == 0 {
			return nil, errors.New("DNS Яндекса не ответил")
		}
		for _, a := range ips {
			if a.IP.To4() != nil {
				ip = a.IP.String()
				break
			}
		}
		if ip == host {
			ip = ips[0].IP.String()
		}
	}
	d := net.Dialer{Timeout: serviceTimeout, Control: directControl(directMark)}
	return d.DialContext(ctx, "tcp", net.JoinHostPort(ip, strconv.Itoa(port)))
}

// probeGET opens a page one way and checks the answer: the status, and a
// piece of the body when the page has a known one.
func probeGET(def probeDef, viaMihomo bool) (probeResult, string, []string) {
	start := time.Now()
	res := probeResult{T: start.Unix()}
	u, err := url.Parse(def.URL)
	if err != nil {
		res.Error = "неверный адрес"
		return res, "", nil
	}
	host := u.Hostname()
	var routeMu sync.Mutex
	var route []string
	dial := dialDirect
	if viaMihomo {
		dial = func(_ context.Context, h string, port int) (net.Conn, error) {
			conn, err := socksDial(h, port, serviceTimeout)
			if err == nil {
				go func() {
					if local, ok := conn.LocalAddr().(*net.TCPAddr); ok {
						_, chain := mihomoConnectionRoute(h, local.Port)
						routeMu.Lock()
						route = chain
						routeMu.Unlock()
					}
				}()
			}
			return conn, err
		}
	}
	tr := probeTransport(dial, host)
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: serviceTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequest(http.MethodGet, def.URL, nil)
	req.Header.Set("User-Agent", "HomeNet-Connectivity/1")
	resp, err := client.Do(req)
	res.MS = time.Since(start).Milliseconds()
	routeOf := func() []string {
		routeMu.Lock()
		defer routeMu.Unlock()
		return route
	}
	if err != nil {
		res.Error = serviceError(err)
		if strings.Contains(err.Error(), "DNS Яндекса") {
			res.Error = "DNS Яндекса не ответил"
		}
		return res, "", routeOf()
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	resp.Body.Close()
	res.Status = resp.StatusCode
	switch {
	case resp.StatusCode != def.Status:
		res.Error = fmt.Sprintf("ответ %d вместо %d", resp.StatusCode, def.Status)
	case def.Body != "" && !strings.Contains(string(body), def.Body):
		res.Error = "чужая страница вместо ожидаемой"
	default:
		res.OK = true
	}
	return res, string(body), routeOf()
}

func traceField(body, key string) string {
	for _, line := range strings.Split(body, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), key+"="); ok {
			return v
		}
	}
	return ""
}

// checkProbes opens every page both ways at once; called with the services.
func (c *serviceChecker) checkProbes() {
	type out struct {
		res   probeResult
		body  string
		route []string
	}
	results := make([][2]out, len(connProbes))
	var wg sync.WaitGroup
	for i, def := range connProbes {
		for k, via := range []bool{false, true} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r, body, route := probeGET(def, via)
				results[i][k] = out{r, body, route}
			}()
		}
	}
	wg.Wait()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.probes == nil {
		c.probes = map[string]*probeState{}
	}
	known := map[string]bool{}
	for i, def := range connProbes {
		known[def.ID] = true
		st := c.probes[def.ID]
		if st == nil {
			st = &probeState{}
			c.probes[def.ID] = st
		}
		st.probeDef = def
		for k, p := range []*probeWay{&st.Direct, &st.Mihomo} {
			r := results[i][k]
			p.History = append(p.History, r.res)
			if len(p.History) > serviceKeep {
				p.History = p.History[len(p.History)-serviceKeep:]
			}
			if def.Trace && r.res.OK {
				p.Loc, p.IP = traceField(r.body, "loc"), traceField(r.body, "ip")
			}
			if k == 1 {
				p.Path = r.route
			}
		}
	}
	for id := range c.probes {
		if !known[id] {
			delete(c.probes, id)
		}
	}
}

func (c *serviceChecker) probeSnapshot() []probeState {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []probeState{}
	for _, def := range connProbes {
		st, ok := c.probes[def.ID]
		if !ok {
			out = append(out, probeState{probeDef: def, Direct: probeWay{History: []probeResult{}}, Mihomo: probeWay{History: []probeResult{}}})
			continue
		}
		cp := *st
		cp.Direct.History = append([]probeResult(nil), st.Direct.History...)
		cp.Mihomo.History = append([]probeResult(nil), st.Mihomo.History...)
		cp.Mihomo.Path = append([]string(nil), st.Mihomo.Path...)
		out = append(out, cp)
	}
	return out
}
