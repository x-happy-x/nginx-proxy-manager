package core

import (
	"crypto/subtle"
	"encoding/json"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// Private worker-to-worker contracts do not accept Account sessions. Only the
// Proxy credential may publish its catalog or participate in the VPN DNS contract.
func (s *Server) internal(w http.ResponseWriter, r *http.Request) {
	token, err := s.workerToken("proxy")
	if err != nil || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
		http.Error(w, "Unauthorized", 401)
		return
	}
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
		return
	}
	s.Lifecycle.Stable(func() {
		if r.Context().Err() != nil {
			return
		}
		enabled := false
		for _, i := range s.Registry.Snapshot() {
			if i.Manifest.ID == "proxy" && i.Enabled {
				enabled = true
			}
		}
		if !enabled {
			http.Error(w, "Proxy is disabled", 409)
			return
		}
		if r.URL.Path == "/internal/proxy/portal" {
			var doc PortalDocument
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&doc); err != nil {
				http.Error(w, "Invalid catalog", 400)
				return
			}
			if err := integration.AtomicJSON(filepath.Join(s.Config.StateDir, "portal.json"), doc); err != nil {
				http.Error(w, "Catalog publication failed", 500)
				return
			}
			jsonReply(w, 200, map[string]bool{"ok": true})
			return
		}
		action := strings.TrimPrefix(r.URL.Path, "/internal/proxy/vpn-dns/")
		if action != "preview" && action != "prepare" && action != "apply" && action != "commit" && action != "rollback" {
			http.NotFound(w, r)
			return
		}
		for _, i := range s.Registry.Snapshot() {
			if i.Manifest.ID != "vpn" || !i.Enabled {
				continue
			}
			credential, err := s.workerToken("vpn")
			if err != nil {
				http.Error(w, "VPN credentials unavailable", 503)
				return
			}
			q, err := http.NewRequestWithContext(r.Context(), "POST", i.Manifest.Backend.Endpoint+"/internal/vpn-dns/"+action, http.MaxBytesReader(w, r.Body, 2<<20))
			if err != nil {
				http.Error(w, "Invalid request", 400)
				return
			}
			q.Header.Set("Authorization", "Bearer "+credential)
			q.Header.Set("Content-Type", "application/json")
			client := *s.Client
			client.Timeout = 75 * time.Second
			res, err := client.Do(q)
			if err != nil {
				http.Error(w, "VPN unavailable", 503)
				return
			}
			defer res.Body.Close()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(res.StatusCode)
			_, _ = io.Copy(w, io.LimitReader(res.Body, 2<<20))
			return
		}
		http.Error(w, "VPN integration is not enabled", 424)
	})
}
