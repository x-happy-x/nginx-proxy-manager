package core

import (
	"crypto/subtle"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

// This exact endpoint uses its own server credential. It cannot proxy arbitrary
// PC APIs; normal module management continues to require an Account administrator.
func (s *Server) pcPower(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(filepath.Join(s.Config.StateDir, "credentials", "pc-power.token"))
	token := strings.TrimSpace(string(b))
	if err != nil || len(token) < 32 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
		http.Error(w, "authentication required", 401)
		return
	}
	if r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "browser request denied", 403)
		return
	}
	if r.Method != "GET" && r.Method != "POST" {
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", 405)
		return
	}
	copy := r.Clone(r.Context())
	copy.URL.Path = "/api/integrations/pc/api/pc/power"
	copy.URL.RawPath = ""
	copy.URL.RawQuery = ""
	integration.Gateway{Registry: s.Registry, Token: s.workerToken}.ServeHTTP(w, copy)
}
