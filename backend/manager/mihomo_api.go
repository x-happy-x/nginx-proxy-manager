package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// The browser never talks to the Mihomo controller directly: /api/mihomo/*
// is a curated bridge. The secret stays on the router and only the calls the
// console needs are forwarded. Anything that could read arbitrary files
// (PUT /configs with a path or payload), change the controller itself or
// replace the UI is refused here, not in the frontend.

const mihomoAPIPrefix = "/api/mihomo"

type mihomoRoute struct {
	method  string
	pattern *regexp.Regexp
}

func mihomoRoutes(spec ...string) []mihomoRoute {
	routes := make([]mihomoRoute, 0, len(spec))
	for _, line := range spec {
		method, path, _ := strings.Cut(line, " ")
		// {} is one escaped path segment.
		re := "^" + strings.ReplaceAll(regexp.QuoteMeta(path), `\{\}`, `[^/]+`) + "$"
		routes = append(routes, mihomoRoute{method, regexp.MustCompile(re)})
	}
	return routes
}

var mihomoAllowed = mihomoRoutes(
	"GET /version",
	"GET /configs",
	"PATCH /configs",
	"PUT /configs",
	"POST /configs/geo",
	"GET /traffic",
	"GET /memory",
	"GET /logs",
	"GET /stats",
	"GET /connections",
	"DELETE /connections",
	"DELETE /connections/{}",
	"DELETE /connections/smart/{}",
	"GET /proxies",
	"GET /proxies/{}",
	"PUT /proxies/{}",
	"DELETE /proxies/{}",
	"GET /proxies/{}/delay",
	"GET /proxies/{}/tailscale",
	"PUT /proxies/{}/tailscale/exit-node",
	"PUT /proxies/{}/tailscale/running",
	"GET /group",
	"GET /group/{}",
	"GET /group/{}/delay",
	"GET /group/weights",
	"GET /providers/proxies",
	"GET /providers/proxies/{}",
	"PUT /providers/proxies/{}",
	"GET /providers/proxies/{}/healthcheck",
	"GET /providers/proxies/{}/{}/healthcheck",
	"GET /providers/proxies/{}/proxies",
	"POST /providers/proxies/{}/proxies",
	"PUT /providers/proxies/{}/proxies/{}",
	"DELETE /providers/proxies/{}/proxies/{}",
	"GET /rules",
	"PATCH /rules/disable",
	"PUT /rules/{}",
	"GET /providers/rules",
	"PUT /providers/rules/{}",
	"GET /dns/query",
	"POST /cache/fakeip/flush",
	"POST /cache/dns/flush",
	"POST /cache/smart/flush",
	"POST /restart",
	"POST /upgrade",
)

// Runtime keys the console may change without touching config.yaml.
// external-controller, secret, external-ui and friends are deliberately absent.
var mihomoPatchKeys = map[string]bool{
	"mode": true, "log-level": true, "allow-lan": true, "ipv6": true, "tun": true,
	"mixed-port": true, "port": true, "socks-port": true, "redir-port": true, "tproxy-port": true,
	"sniffing": true, "unified-delay": true, "tcp-concurrent": true,
}

func mihomoPathAllowed(method, path string) bool {
	if strings.Contains(path, "..") || strings.Contains(path, "//") {
		return false
	}
	for _, route := range mihomoAllowed {
		if route.method == method && route.pattern.MatchString(path) {
			return true
		}
	}
	return false
}

// mihomoControllerURL is the loopback controller origin; anything else is refused
// so a tampered environment cannot turn the bridge into an open proxy.
func mihomoControllerURL() (*url.URL, string, error) {
	controller, secret := mihomoController()
	u, err := url.Parse(controller)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || (u.Path != "" && u.Path != "/") {
		return nil, "", fmt.Errorf("MIHOMO_CONTROLLER должен быть локальным адресом http://127.0.0.1:порт")
	}
	if ip := net.ParseIP(u.Hostname()); ip == nil || !ip.IsLoopback() {
		return nil, "", fmt.Errorf("MIHOMO_CONTROLLER должен указывать на loopback-адрес")
	}
	u.Path = ""
	return u, secret, nil
}

func sameOriginRequest(r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host != r.Host {
			return false
		}
	}
	return r.Header.Get("Sec-Fetch-Site") != "cross-site"
}

// checkMihomoBody enforces the request-body rules for the few calls that take one.
// It returns the (possibly unchanged) body to forward.
func checkMihomoBody(method, path string, body []byte) error {
	switch {
	case method == http.MethodPut && path == "/configs":
		// Only "reload the file Mihomo already uses". Config edits go through
		// /api/core/config, which validates and keeps a backup.
		var req map[string]any
		if len(bytes.TrimSpace(body)) > 0 {
			if err := json.Unmarshal(body, &req); err != nil {
				return fmt.Errorf("invalid_json")
			}
		}
		for k, v := range req {
			if s, ok := v.(string); !ok || s != "" {
				return fmt.Errorf("PUT /configs принимает только пустые path и payload, поле %q запрещено", k)
			}
		}
	case method == http.MethodPatch && path == "/configs":
		var req map[string]json.RawMessage
		if err := json.Unmarshal(body, &req); err != nil {
			return fmt.Errorf("invalid_json")
		}
		for k := range req {
			if !mihomoPatchKeys[k] {
				return fmt.Errorf("параметр %q нельзя менять из HomeNet", k)
			}
		}
	}
	return nil
}

func (a *app) handleMihomoAPI(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.EscapedPath(), mihomoAPIPrefix)
	if rest == "" {
		rest = "/"
	}
	if !mihomoPathAllowed(r.Method, rest) {
		a.writeJSON(w, http.StatusForbidden, response{"ok": false, "error": "mihomo_path_denied", "path": rest, "method": r.Method})
		return
	}
	upgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	if (r.Method != http.MethodGet || upgrade) && !sameOriginRequest(r) {
		a.writeJSON(w, http.StatusForbidden, response{"ok": false, "error": "cross_origin_denied"})
		return
	}
	target, secret, err := mihomoControllerURL()
	if err != nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": err.Error()})
		return
	}
	var body []byte
	if r.Body != nil && r.Method != http.MethodGet {
		body, err = io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "body_read_failed"})
			return
		}
		if err := checkMihomoBody(r.Method, rest, body); err != nil {
			a.writeJSON(w, http.StatusForbidden, response{"ok": false, "error": err.Error()})
			return
		}
	}
	query := r.URL.Query()
	query.Del("token")
	proxy := &httputil.ReverseProxy{
		// Streams (/traffic, /memory, /logs, /connections) are chunked
		// HTTP when not upgraded; flush them as they arrive.
		FlushInterval: -1,
		Transport:     &http.Transport{Proxy: nil, ResponseHeaderTimeout: 70 * time.Second},
		Director: func(q *http.Request) {
			q.URL.Scheme, q.URL.Host = target.Scheme, target.Host
			q.URL.RawPath = rest
			q.URL.Path, _ = url.PathUnescape(rest)
			q.URL.RawQuery = query.Encode()
			q.Host = target.Host
			q.Header.Del("Cookie")
			q.Header.Del("Authorization")
			q.Header.Del("Origin")
			q.Header.Del("Referer")
			for _, h := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-Ip"} {
				q.Header.Del(h)
			}
			if secret != "" {
				q.Header.Set("Authorization", "Bearer "+secret)
			}
			if body != nil {
				q.Body = io.NopCloser(bytes.NewReader(body))
				q.ContentLength = int64(len(body))
			}
		},
		ModifyResponse: func(res *http.Response) error {
			res.Header.Del("Access-Control-Allow-Origin")
			res.Header.Del("Access-Control-Allow-Credentials")
			if res.StatusCode >= 300 && res.StatusCode < 400 {
				res.Header.Del("Location")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			a.writeJSON(w, http.StatusBadGateway, response{"ok": false, "error": "mihomo_unreachable", "detail": shortNetErr(err).Error()})
		},
	}
	proxy.ServeHTTP(w, r)
}
