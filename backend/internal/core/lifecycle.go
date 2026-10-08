package core

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

func (s *Server) lifecycle(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == "POST" && r.URL.Path == "/api/platform/recover":
		if !s.Config.ManageWorkers {
			http.Error(w, "Worker management is disabled", 409)
			return
		}
		s.operations.Add(1)
		go func() {
			defer s.operations.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			_ = s.Lifecycle.Recover(ctx)
		}()
		jsonReply(w, 202, map[string]bool{"ok": true})
	case r.Method == "GET" && r.URL.Path == "/api/platform/packages":
		items, err := s.Lifecycle.Available()
		if err != nil {
			jsonReply(w, 503, map[string]any{"error": err.Error()})
			return
		}
		jsonReply(w, 200, map[string]any{"items": items, "managed": s.Config.ManageWorkers})
	case r.Method == "GET" && r.URL.Path == "/api/platform/operations":
		items, err := s.Lifecycle.History()
		if err != nil {
			jsonReply(w, 503, map[string]any{"error": err.Error()})
			return
		}
		jsonReply(w, 200, map[string]any{"items": items})
	case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/platform/operations/"):
		op, err := s.Lifecycle.Operation(strings.TrimPrefix(r.URL.Path, "/api/platform/operations/"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		jsonReply(w, 200, op)
	case r.Method == "POST" && r.URL.Path == "/api/platform/plan":
		if !s.Config.ManageWorkers {
			http.Error(w, "Worker management is disabled in this fixture", 409)
			return
		}
		var req struct {
			Changes []integration.Change `json:"changes"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768)).Decode(&req); err != nil {
			http.Error(w, "Invalid plan request", 400)
			return
		}
		op, err := s.Lifecycle.Plan(req.Changes)
		if err != nil {
			jsonReply(w, 409, map[string]any{"error": err.Error()})
			return
		}
		jsonReply(w, 200, op)
	case r.Method == "POST" && r.URL.Path == "/api/platform/apply":
		if !s.Config.ManageWorkers {
			http.Error(w, "Worker management is disabled in this fixture", 409)
			return
		}
		var req struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&req); err != nil {
			http.Error(w, "Invalid operation", 400)
			return
		}
		op, err := s.Lifecycle.Operation(req.ID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if op.Status == "planned" {
			s.operations.Add(1)
			go func() {
				defer s.operations.Done()
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
				defer cancel()
				_, _ = s.Lifecycle.Apply(ctx, req.ID)
			}()
		}
		jsonReply(w, 202, op)
	default:
		http.NotFound(w, r)
	}
}

// WaitOperations is called after HTTP requests have drained.
func (s *Server) WaitOperations() { s.operations.Wait() }
