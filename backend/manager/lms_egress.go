package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// This private registry is installed together with authenticated HTTP listeners.
// It is not a browser-facing Mihomo configuration or a source of proxy secrets.
type lmsEgressRegistry struct {
	Nodes  map[string]string `json:"nodes"`
	Routes []lmsEgressRoute  `json:"routes"`
}
type lmsEgressRoute struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Proxy    string `json:"proxy"`
	Listen   string `json:"listen"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}
type lmsPublicRoute struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	Available      bool     `json:"available"`
	SupportedTypes []string `json:"supportedTypes"`
	Scope          string   `json:"scope"`
}
type lmsObserved struct {
	Host       string   `json:"host"`
	Chains     []string `json:"chains"`
	Rule       string   `json:"rule"`
	ObservedAt string   `json:"observedAt"`
}

var lmsRouteID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

func lmsRegistry() (lmsEgressRegistry, error) {
	var registry lmsEgressRegistry
	raw, err := os.ReadFile(filepath.Join(coreStateDir(), "lms-egress.json"))
	if err != nil {
		return registry, err
	}
	if len(raw) > 65536 {
		return registry, fmt.Errorf("LMS egress registry too large")
	}
	if err = json.Unmarshal(raw, &registry); err != nil {
		return registry, fmt.Errorf("invalid LMS egress registry")
	}
	if len(registry.Nodes) == 0 || len(registry.Nodes) > 32 || len(registry.Routes) > 24 {
		return registry, fmt.Errorf("invalid LMS egress registry limits")
	}
	for id, source := range registry.Nodes {
		if !lmsRouteID.MatchString(id) || net.ParseIP(source) == nil {
			return registry, fmt.Errorf("invalid LMS node identity")
		}
	}
	seen := map[string]bool{}
	for _, route := range registry.Routes {
		if !lmsRouteID.MatchString(route.ID) || seen[route.ID] || route.Label == "" || len(route.Label) > 160 || route.Proxy == "" || route.Port < 34000 || route.Port > 34999 || net.ParseIP(route.Listen) == nil || len(route.Username) < 4 || len(route.Password) < 32 {
			return registry, fmt.Errorf("invalid LMS route")
		}
		seen[route.ID] = true
	}
	return registry, nil
}

func lmsObservedConnections(connections []mihomoConn, source, host string, now time.Time) []lmsObserved {
	result := []lmsObserved{}
	seen := map[string]bool{}
	for _, connection := range connections {
		if connection.Metadata.SourceIP != source {
			continue
		}
		actual := connHost(connection)
		if host != "" && !strings.EqualFold(actual, host) {
			continue
		}
		if len(connection.Chains) == 0 {
			continue
		}
		key := actual + "\n" + strings.Join(connection.Chains, "\n")
		if seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, lmsObserved{actual, connection.Chains, connection.Rule, now.UTC().Format(time.RFC3339)})
		if len(result) == 100 {
			break
		}
	}
	return result
}

func (a *app) handleLMSEgress(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		a.writeJSON(w, 405, response{"error": "method not allowed"})
		return
	}
	registry, err := lmsRegistry()
	if err != nil {
		a.writeJSON(w, 503, response{"error": "LMS egress is not configured"})
		return
	}
	source, ok := registry.Nodes[r.URL.Query().Get("node")]
	if !ok {
		a.writeJSON(w, 403, response{"error": "LMS node is not approved"})
		return
	}
	settings, err := coreSettings()
	if err != nil {
		a.writeJSON(w, 503, response{"error": "Mihomo is unavailable"})
		return
	}
	var current struct {
		Connections []mihomoConn `json:"connections"`
	}
	if err = publicVPNController(r.Context(), settings, "GET", "/connections", nil, &current); err != nil {
		a.writeJSON(w, 503, response{"error": "Current network paths are unavailable"})
		return
	}
	routes := []lmsPublicRoute{}
	for _, route := range registry.Routes {
		routes = append(routes, lmsPublicRoute{route.ID, route.Label, true, []string{"DIRECT", "YTDLP", "ARIA2C"}, "download"})
	}
	now := time.Now()
	a.writeJSON(w, 200, response{"enabled": true, "routes": routes, "observed": lmsObservedConnections(current.Connections, source, r.URL.Query().Get("host"), now), "checkedAt": now.UTC().Format(time.RFC3339)})
}
