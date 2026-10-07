package integration

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// Gateway must be mounted behind Core's Account authorization and write guard.
// Token is resolved server-side; browser cookies and identity headers never reach workers.
type Gateway struct {
	Registry  *Registry
	Token     func(string) (string, error)
	Transport http.RoundTripper
}

func (g Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/api/integrations/"), "/", 2)
	if len(parts) != 2 || !ValidID(parts[0]) {
		http.NotFound(w, r)
		return
	}
	var item *Installed
	for _, i := range g.Registry.Snapshot() {
		if i.Manifest.ID == parts[0] {
			copy := i
			item = &copy
			break
		}
	}
	if item == nil {
		http.NotFound(w, r)
		return
	}
	if !item.Enabled {
		http.Error(w, "integration disabled", http.StatusConflict)
		return
	}
	p := "/" + parts[1]
	if !item.Manifest.Allows(p) {
		http.Error(w, "integration API not allowed", http.StatusForbidden)
		return
	}
	if r.Method != "GET" && r.Method != "POST" && r.Method != "PUT" && r.Method != "PATCH" && r.Method != "DELETE" {
		http.Error(w, "method not allowed", 405)
		return
	}
	upgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	if r.Header.Get("Upgrade") != "" {
		origin, err := url.Parse(r.Header.Get("Origin"))
		if !upgrade || r.Method != "GET" || err != nil || origin.Host != r.Host || (origin.Scheme != "http" && origin.Scheme != "https") || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			http.Error(w, "cross-origin or unsupported upgrade", 403)
			return
		}
	}
	token, err := g.Token(item.Manifest.ID)
	if err != nil || token == "" {
		http.Error(w, "integration credentials unavailable", 503)
		return
	}
	target, err := url.Parse(item.Manifest.Backend.Endpoint)
	if err != nil {
		http.Error(w, "invalid integration endpoint", 503)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	proxy := &httputil.ReverseProxy{
		Transport:     g.Transport,
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.Path = p
			pr.Out.URL.RawPath = ""
			pr.Out.Host = target.Host
			pr.Out.Header = make(http.Header)
			for _, key := range []string{"Content-Type", "Accept", "Last-Event-ID"} {
				if v := pr.In.Header.Get(key); v != "" {
					pr.Out.Header.Set(key, v)
				}
			}
			pr.Out.Header.Set("Authorization", "Bearer "+token)
			if upgrade {
				pr.Out.Header.Set("Connection", "Upgrade")
				pr.Out.Header.Set("Upgrade", "websocket")
				for _, key := range []string{"Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions"} {
					pr.Out.Header.Set(key, pr.In.Header.Get(key))
				}
			}
		},
		ModifyResponse: func(res *http.Response) error {
			if res.StatusCode >= 300 && res.StatusCode < 400 {
				return fmt.Errorf("worker redirect rejected")
			}
			res.Header.Del("Set-Cookie")
			res.Header.Del("Access-Control-Allow-Origin")
			res.Header.Set("Cache-Control", "no-store")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) { http.Error(w, "integration unavailable", 502) },
	}
	proxy.ServeHTTP(w, r)
}
