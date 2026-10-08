package core

import (
	"context"
	"encoding/json"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"net/http"
	"sync"
	"time"
)

func (s *Server) connections(ctx context.Context) []integration.Installed {
	items := s.Registry.Snapshot()
	var wg sync.WaitGroup
	for n := range items {
		if !items[n].Enabled {
			continue
		}
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			items[n].Connection = "unavailable"
			token, err := s.workerToken(items[n].Manifest.ID)
			if err != nil {
				return
			}
			deadline, cancel := context.WithTimeout(ctx, 4*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(deadline, "GET", items[n].Manifest.Backend.Endpoint+"/internal/connection", nil)
			if err != nil {
				return
			}
			req.Header.Set("Authorization", "Bearer "+token)
			res, err := s.Client.Do(req)
			if err != nil {
				return
			}
			defer res.Body.Close()
			var body struct{ Connection string }
			if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&body) != nil {
				return
			}
			if body.Connection == "connected" || body.Connection == "unconfigured" {
				items[n].Connection = body.Connection
			}
		}(n)
	}
	wg.Wait()
	return items
}
