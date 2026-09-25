package main

import (
	"encoding/json"
	"fmt"
	"gopkg.in/yaml.v3"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func (a *app) routesPath() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.activeRoutesPath
}

func (a *app) setRoutesPath(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errEmptyPath
	}
	resolved, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	root, err := filepath.Abs(a.baseDir)
	if err != nil {
		return "", err
	}
	ext := strings.ToLower(filepath.Ext(resolved))
	if filepath.Dir(resolved) != root || (ext != ".yml" && ext != ".yaml") {
		return "", fmt.Errorf("select a YAML routes file in the HomeNet project directory")
	}
	if actual, err := filepath.EvalSymlinks(resolved); err == nil && actual != resolved {
		return "", fmt.Errorf("symlink route profiles are not allowed")
	}
	if _, err := os.Stat(resolved); err == nil {
		if _, err := schema.LoadRoutes(resolved); err != nil {
			return "", err
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	a.mu.Lock()
	a.activeRoutesPath = resolved
	a.mu.Unlock()
	return resolved, nil
}

func (a *app) handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Cache-Control", "no-store")
	}
	switch r.Method {
	case http.MethodGet:
		a.handleGet(w, r)
	case http.MethodPost:
		if origin := r.Header.Get("Origin"); origin != "" {
			parsed, err := url.Parse(origin)
			if err != nil || parsed.Host != r.Host {
				a.writeJSON(w, http.StatusForbidden, response{"ok": false, "error": "cross_origin_write_denied"})
				return
			}
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			a.writeJSON(w, http.StatusForbidden, response{"ok": false, "error": "cross_site_write_denied"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
		// Network probes take seconds and touch no config: keep them off
		// the operation lock so an analysis never blocks an apply.
		if strings.HasPrefix(r.URL.Path, "/api/network/") {
			a.handleNetworkPost(w, r)
			return
		}
		a.operationMu.Lock()
		defer a.operationMu.Unlock()
		a.handlePost(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *app) handleGet(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch path {
	case "/api/launcher":
		a.handleLauncherGet(w)
	case "/api/launcher/status":
		a.handleLauncherStatus(w, r)
	case "/api/resources":
		a.handleResources(w, r)
	case "/api/network":
		a.handleNetwork(w, r)
	case "/api/network/scan":
		a.handleScanGet(w)
	case "/api/network/topology":
		a.handleTopology(w)
	case "/api/routes":
		routes, err := schema.LoadRoutes(a.routesPath())
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		body := response{
			"schema_version": routes.SchemaVersion,
			"globals":        routes.Globals,
			"apps":           routes.Apps,
			"hosts":          routes.Hosts,
			"certs":          routes.Certs,
			"_routes_file":   a.routesPath(),
		}
		a.writeJSON(w, http.StatusOK, body)
	case "/api/routes/files":
		body := a.listRouteFiles()
		body["ok"] = true
		a.writeJSON(w, http.StatusOK, body)
	case "/api/ca/status":
		a.writeJSON(w, http.StatusOK, response{"ok": true, "installed": a.hasLocalCA()})
	case "/api/cert/list":
		a.writeJSON(w, http.StatusOK, response{"ok": true, "items": a.listLocalCerts()})
	case "/api/nginx/logs":
		limit := atoiDefault(r.URL.Query().Get("limit"), 200)
		logType := r.URL.Query().Get("type")
		if logType == "" {
			logType = "access"
		}
		logFile := getenv("NGINX_ACCESS_LOG", "/opt/var/log/homenet/access.log")
		if logType != "access" {
			logFile = getenv("NGINX_ERROR_LOG", "/opt/var/log/homenet/error.log")
		}
		lines, err := readLogFile(logFile, limit, r.URL.Query().Get("filter"))
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "lines": lines})
	case "/api/nginx/route-logs":
		a.handleRouteLogs(w, r, false)
	case "/api/nginx/stats":
		a.handleStats(w, r)
	case "/api/dns/plan":
		routes, err := schema.LoadRoutes(a.routesPath())
		if err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
			return
		}
		plan, err := a.previewMihomoDNS(routes)
		if err != nil {
			a.writeJSON(w, 400, response{"ok": false, "error": err.Error(), "plan": plan})
			return
		}
		a.writeJSON(w, 200, response{"ok": true, "plan": plan})
	case "/api/nginx/route-logs/errors":
		a.handleRouteLogs(w, r, true)
	case "/api/nginx/status":
		a.writeJSON(w, http.StatusOK, response{"ok": true, "status": a.nginxStatus()})
	case "/api/dms/apps":
		items, err := listDMSApps(getenv("DMS_ROOT", "/opt/dms"))
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{
			"ok":              true,
			"items":           items,
			"service_version": dmsServiceVersion(getenv("DMS_SERVICE_BIN", "/opt/bin/dms-service")),
		})
	case "/api/nginx/configs":
		a.writeJSON(w, http.StatusOK, response{"ok": true, "items": a.configCatalog()})
	case "/api/nginx/config/read":
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		item := a.configByID(id)
		if item == nil {
			a.writeJSON(w, http.StatusNotFound, response{"ok": false, "error": "config_not_found"})
			return
		}
		if !item.Exists {
			a.writeJSON(w, http.StatusNotFound, response{"ok": false, "error": "config_missing"})
			return
		}
		body, err := os.ReadFile(item.Path)
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "item": item, "content": string(body)})
	case "/api/ui/bind":
		host, port := a.readUIBind()
		a.writeJSON(w, http.StatusOK, response{"ok": true, "host": host, "port": port})
	case "/api/ca/download":
		a.sendPEM(w, a.localCACert, "local-ca.crt")
	case "/api/cert/download":
		host := r.URL.Query().Get("host")
		if !validRouterHost(host) {
			http.Error(w, "host required", http.StatusBadRequest)
			return
		}
		kind := r.URL.Query().Get("kind")
		if kind == "key" {
			a.sendPEM(w, filepath.Join(a.nginxConfRoot, "selfsigned", host+".key"), host+".key")
			return
		}
		a.sendPEM(w, filepath.Join(a.nginxConfRoot, "selfsigned", host+".crt"), host+".crt")
	case "/api/ip-hosts":
		items, err := a.listIPHosts()
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "items": items})
	case "/api/ndns/http":
		data, err := a.ndnsHTTPGet()
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "data": data})
	case "/api/ndns/port-suggest":
		port, err := a.ndnsSuggestPort(20000, 59999)
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "port": port})
	case "/":
		if a.resolveStaticPath(a.reactIndexRel) != "" {
			a.serveStatic(w, a.reactIndexRel)
			return
		}
		if a.resolveStaticPath("index.html") != "" {
			a.serveStatic(w, "index.html")
			return
		}
		http.NotFound(w, r)
	default:
		if strings.HasPrefix(path, "/static/") {
			a.serveStatic(w, strings.TrimPrefix(path, "/static/"))
			return
		}
		http.NotFound(w, r)
	}
}

func (a *app) handlePost(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch path {
	case "/api/launcher":
		a.handleLauncherSave(w, r)
	case "/api/routes":
		var routes schema.Routes
		if err := json.NewDecoder(r.Body).Decode(&routes); err != nil {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "invalid_json"})
			return
		}
		if routes.SchemaVersion != "2.1" {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "schema_version_must_be_2_1"})
			return
		}
		if err := schema.ResolveAutoPorts(&routes); err != nil {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": err.Error()})
			return
		}
		if err := schema.SaveRoutes(a.routesPath(), routes); err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true})
	case "/api/routes/select":
		var payload struct {
			Path string `json:"path"`
		}
		if !a.decodeJSON(w, r, &payload) {
			return
		}
		resolved, err := a.setRoutesPath(payload.Path)
		if err != nil {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": err.Error()})
			return
		}
		if _, err := os.Stat(resolved); os.IsNotExist(err) {
			if err := schema.SaveRoutes(resolved, schema.DefaultRoutes()); err != nil {
				a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
				return
			}
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "path": resolved})
	case "/api/routes/backup":
		ok, out, filePath := a.backupRoutesFile()
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out, "path": filePath})
	case "/api/apply/check":
		ok, output := a.checkRoutes()
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": output})
	case "/api/apply":
		ok, output := a.applyManagedRoutes()
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": output})
	case "/api/stub/apply":
		a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "Save stub settings in routes, then use Apply to validate and activate safely"})
	case "/api/stub/upload":
		var payload struct {
			Content string `json:"content"`
		}
		if !a.decodeJSON(w, r, &payload) {
			return
		}
		if payload.Content == "" {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "empty_content"})
			return
		}
		ok, out := a.saveStubContent(payload.Content)
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out})
	case "/api/nginx/config/write":
		var payload struct {
			ID      string `json:"id"`
			Content string `json:"content"`
		}
		if !a.decodeJSON(w, r, &payload) {
			return
		}
		item := a.configByID(strings.TrimSpace(payload.ID))
		if item == nil {
			a.writeJSON(w, http.StatusNotFound, response{"ok": false, "error": "config_not_found"})
			return
		}
		if !item.Editable {
			a.writeJSON(w, http.StatusForbidden, response{"ok": false, "error": "configuration is generated or protected; edit routes instead"})
			return
		}
		if item.ID == "routes_v21" {
			var routes schema.Routes
			if err := yaml.Unmarshal([]byte(payload.Content), &routes); err != nil {
				a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
				return
			}
			if err := schema.ResolveAutoPorts(&routes); err != nil {
				a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
				return
			}
			if err := schema.SaveRoutes(a.routesPath(), routes); err != nil {
				a.writeJSON(w, 400, response{"ok": false, "error": err.Error()})
				return
			}
			a.writeJSON(w, 200, response{"ok": true, "output": "Saved validated routes draft; Apply activates it"})
			return
		}
		if item.Path == "" {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "bad_config_path"})
			return
		}
		if err := os.MkdirAll(filepath.Dir(item.Path), 0o755); err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		if err := os.WriteFile(item.Path, []byte(payload.Content), 0o644); err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "output": "saved " + item.Path})
	case "/api/ca/upload":
		var payload struct {
			CertPEM string `json:"cert_pem"`
			KeyPEM  string `json:"key_pem"`
		}
		if !a.decodeJSON(w, r, &payload) {
			return
		}
		if !strings.Contains(payload.CertPEM, "BEGIN CERTIFICATE") || !strings.Contains(payload.KeyPEM, "BEGIN") {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "invalid_pem"})
			return
		}
		ok, out := a.saveLocalCA(payload.CertPEM, payload.KeyPEM)
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out})
	case "/api/ca/generate":
		var payload struct {
			Subject map[string]string `json:"subject"`
		}
		if !a.decodeJSON(w, r, &payload) {
			return
		}
		ok, out := a.generateLocalCA(payload.Subject)
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out})
	case "/api/cert/test":
		var payload struct {
			Host string `json:"host"`
			Port int    `json:"port"`
		}
		if !a.decodeJSON(w, r, &payload) {
			return
		}
		if !validRouterHost(payload.Host) {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "host_required"})
			return
		}
		if payload.Port == 0 {
			payload.Port = 443
		}
		ok, out := a.testCertificate(payload.Host, payload.Port)
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out})
	case "/api/cert/delete":
		var payload struct {
			Host string `json:"host"`
		}
		if !a.decodeJSON(w, r, &payload) {
			return
		}
		if !validRouterHost(payload.Host) {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "host_required"})
			return
		}
		ok := a.deleteLocalCert(payload.Host)
		out := "not_found"
		if ok {
			out = "deleted"
		}
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out})
	case "/api/ca/issue":
		force := false
		switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("force"))) {
		case "1", "true", "yes":
			force = true
		}
		ok, out := a.issueLocalCAForRoutes(force)
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out})
	case "/api/ip-hosts/add", "/api/ip-hosts/delete":
		var payload struct {
			Host    string `json:"host"`
			Address string `json:"address"`
		}
		if !a.decodeJSON(w, r, &payload) {
			return
		}
		if !validRouterHost(payload.Host) || !validRouterIP(payload.Address) {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "host_address_required"})
			return
		}
		var ok bool
		var out string
		if strings.HasSuffix(path, "/add") {
			ok, out = a.runNDMC("ip host " + payload.Host + " " + payload.Address)
		} else {
			ok, out = a.deleteIPHost(payload.Host, payload.Address)
		}
		if ok {
			ok, out = a.runNDMC("system configuration save")
		}
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out})
	case "/api/ndns/proxy/save", "/api/ndns/proxy/delete":
		var payload map[string]any
		if !a.decodeJSON(w, r, &payload) {
			return
		}
		if strings.HasSuffix(path, "/save") {
			item, _ := payload["item"].(map[string]any)
			oldName, _ := payload["old_name"].(string)
			ok, out := a.ndnsProxyApply(item, oldName)
			a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out})
			return
		}
		name, _ := payload["name"].(string)
		ok, out := a.ndnsProxyDelete(name)
		a.writeJSON(w, http.StatusOK, response{"ok": ok, "output": out})
	case "/api/ui/restart":
		restartCmd := getenv("UI_RESTART_CMD", "/opt/etc/init.d/S99nginx-manager-lite restart")
		go func() {
			time.Sleep(1 * time.Second)
			cmd := exec.Command("sh", "-c", restartCmd+" >/tmp/nginx-manager-lite-restart.log 2>&1")
			_ = cmd.Run()
		}()
		a.writeJSON(w, http.StatusOK, response{"ok": true, "output": "ui restart scheduled"})
	default:
		http.NotFound(w, r)
	}
}

func (a *app) decodeJSON(w http.ResponseWriter, r *http.Request, dest any) bool {
	if err := json.NewDecoder(r.Body).Decode(dest); err != nil {
		a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "invalid_json"})
		return false
	}
	return true
}

func (a *app) writeJSON(w http.ResponseWriter, status int, payload any) {
	body, _ := json.Marshal(payload)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
