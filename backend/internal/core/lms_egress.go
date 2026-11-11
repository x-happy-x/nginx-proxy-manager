package core

import (
	"crypto/subtle"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

var lmsNodeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
var lmsHost = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,253}$`)

// A server credential can read this narrow egress contract, never manage Mihomo.
func (s *Server) lmsEgress(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(filepath.Join(s.Config.StateDir, "credentials", "lms-egress.token"))
	token := strings.TrimSpace(string(b))
	if err != nil || len(token) < 32 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}
	if r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "browser request denied", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	if !lmsNodeID.MatchString(query.Get("node")) || (query.Get("host") != "" && !lmsHost.MatchString(query.Get("host"))) || len(query["node"]) != 1 || len(query["host"]) > 1 {
		http.Error(w, "invalid node or host", http.StatusBadRequest)
		return
	}
	copy := r.Clone(r.Context())
	copy.URL.Path = "/api/integrations/vpn/api/mihomo/lms-egress"
	copy.URL.RawPath = ""
	copy.URL.RawQuery = url.Values{"node": {query.Get("node")}, "host": {query.Get("host")}}.Encode()
	integration.Gateway{Registry: s.Registry, Token: s.workerToken}.ServeHTTP(w, copy)
}
