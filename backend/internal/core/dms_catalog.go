package core

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

// DMS contributes application addresses independently of Proxy. Keep a public
// snapshot so the portal continues working while the package service is offline.
func (s *Server) dmsCatalog() []schema.App {
	file := filepath.Join(s.Config.StateDir, "dms-portal.json")
	var apps []schema.App
	if body, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(body, &apps)
	}
	token, err := os.ReadFile(s.Config.DMSTokenFile)
	if err != nil {
		return apps
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", s.Config.DMSURL+"/v1/apps", nil)
	if err != nil {
		return apps
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	res, err := s.Client.Do(req)
	if err != nil {
		return apps
	}
	defer res.Body.Close()
	var response struct {
		Items []struct {
			PortalApps []schema.App `json:"portal_apps"`
		} `json:"items"`
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&response) != nil {
		return apps
	}
	apps = []schema.App{}
	for _, item := range response.Items {
		apps = append(apps, item.PortalApps...)
	}
	_ = integration.AtomicJSON(file, apps)
	return apps
}
