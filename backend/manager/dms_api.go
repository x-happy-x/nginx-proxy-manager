package main

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// handleDMSProxy keeps the privileged DMS credential exclusively on the router.
// It is reached after accessGuard and the regular same-origin write checks.
func (a *app) handleDMSProxy(w http.ResponseWriter, r *http.Request) {
	suffix := strings.TrimPrefix(r.URL.Path, "/api/dms/")
	allowed := r.Method == "GET" && (suffix == "apps" || suffix == "jobs" || strings.HasPrefix(suffix, "jobs/")) || r.Method == "POST" && (suffix == "install" || suffix == "packages" || suffix == "rollback")
	if !allowed {
		a.writeJSON(w, 404, response{"ok": false, "error": "dms_endpoint_not_found"})
		return
	}
	endpoint := getenv("DMS_API_URL", "http://127.0.0.1:63416")
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost" || parsed.Hostname() == "::1"))) {
		a.writeJSON(w, 503, response{"ok": false, "error": "invalid_dms_api_url"})
		return
	}
	token, err := os.ReadFile(getenv("DMS_TOKEN_FILE", "/opt/dms/token"))
	if err != nil || len(strings.TrimSpace(string(token))) < 32 {
		if suffix == "apps" && r.Method == "GET" {
			a.dmsLegacyApps(w)
			return
		}
		a.writeJSON(w, 503, response{"ok": false, "error": "DMS API РЅРµ РЅР°СЃС‚СЂРѕРµРЅ: СѓСЃС‚Р°РЅРѕРІРёС‚Рµ СЃРµСЂРІРёСЃ Рё С„Р°Р№Р» С‚РѕРєРµРЅР°"})
		return
	}
	path := "/v1/" + suffix
	if suffix == "packages" && r.URL.Query().Get("dry_run") == "true" {
		path += "?dry_run=true"
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, strings.TrimRight(endpoint, "/")+path, r.Body)
	if err != nil {
		a.writeJSON(w, 400, response{"ok": false, "error": "invalid_request"})
		return
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	client := &http.Client{Timeout: 3 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		if suffix == "apps" && r.Method == "GET" {
			a.dmsLegacyApps(w)
			return
		}
		a.writeJSON(w, 503, response{"ok": false, "error": "DMS API РЅРµРґРѕСЃС‚СѓРїРµРЅ"})
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.StatusCode)
	io.Copy(w, io.LimitReader(res.Body, 4<<20))
}

func (a *app) dmsLegacyApps(w http.ResponseWriter) {
	items, err := listDMSApps(getenv("DMS_ROOT", "/opt/dms"))
	if err != nil {
		a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, 200, response{"ok": true, "items": items, "service_version": dmsServiceVersion(getenv("DMS_SERVICE_BIN", "/opt/bin/dms-service")), "api_available": false})
}
