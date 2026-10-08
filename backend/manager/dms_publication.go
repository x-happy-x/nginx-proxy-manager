package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

// Import only edits the Proxy draft. The ordinary preview/apply transaction owns
// nginx, DNS and VPN publication; DMS never writes those files in modular mode.
func (a *app) importDMSRoutes(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Apps        []schema.App  `json:"apps"`
		Hosts       []schema.Host `json:"hosts"`
		RemoveApps  []string      `json:"remove_apps"`
		RemoveHosts []string      `json:"remove_hosts"`
	}
	if !a.decodeJSON(w, r, &input) {
		return
	}
	routes, err := schema.LoadRoutes(a.routesPath())
	if err != nil {
		a.writeJSON(w, 409, response{"error": err.Error()})
		return
	}
	apps := map[string]bool{}
	hosts := map[string]bool{}
	for _, id := range input.RemoveApps {
		apps[id] = true
	}
	for _, app := range input.Apps {
		apps[app.ID] = true
	}
	for _, host := range input.RemoveHosts {
		hosts[host] = true
	}
	for _, host := range input.Hosts {
		hosts[host.Host] = true
	}
	keptApps := []schema.App{}
	keptHosts := []schema.Host{}
	for _, app := range routes.Apps {
		if !apps[app.ID] {
			keptApps = append(keptApps, app)
		}
	}
	for _, host := range routes.Hosts {
		if !hosts[host.Host] {
			keptHosts = append(keptHosts, host)
		}
	}
	routes.Apps = append(keptApps, input.Apps...)
	routes.Hosts = append(keptHosts, input.Hosts...)
	if _, err := os.Stat(a.routesPath()); err == nil {
		if ok, output, _ := a.backupRoutesFile(); !ok {
			a.writeJSON(w, 409, response{"error": output})
			return
		}
	} else if !os.IsNotExist(err) {
		a.writeJSON(w, 409, response{"error": err.Error()})
		return
	}
	body, err := json.Marshal(routes)
	if err != nil {
		a.writeJSON(w, 400, response{"error": err.Error()})
		return
	}
	q := r.Clone(r.Context())
	q.URL.Path = "/api/routes"
	q.Body = io.NopCloser(bytes.NewReader(body))
	a.handlePost(w, q)
}
