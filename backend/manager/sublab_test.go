package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func subLabFixture(t *testing.T) (*httptest.Server, *slState) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("MIHOMO_STATE_DIR", filepath.Join(dir, "state"))
	t.Setenv("MIHOMO_CONFIG", filepath.Join(dir, "config.yaml"))
	t.Setenv("MIHOMO_CONTROLLER", "http://127.0.0.1:9")
	t.Setenv("MIHOMO_HOME", dir)
	if err := os.WriteFile(coreConfigPath(), []byte(sampleCoreConfig), 0600); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-session" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/favorites":
			_, _ = w.Write([]byte(`{"ok":true,"favorites":[{"shortId":"router-1","title":"Router 1","payload":{"sub_url":"merge:bundle"}},{"shortId":"plain","title":"Plain","payload":{"sub_url":"https://example.invalid/private"}}]}`))
		case "/api/merged-sources/bundle":
			_, _ = w.Write([]byte(`{"ok":true,"source":{"items":[{"title":"Reserve","sub_url":"https://example.invalid/secret-source","device":"router","profile":"custom","filter":{"pattern":"reserve","onEmpty":"error"}},{"title":"Ordinary","sub_url":"https://example.invalid/ordinary"}]}}`))
		case "/sub":
			if r.URL.Query().Get("output") != "yml" || r.URL.Query().Get("sub_url") == "" {
				t.Error("download lost converter parameters")
			}
			if strings.Contains(r.URL.Query().Get("sub_url"), "secret-source") && (r.URL.Query().Get("device") != "router" || r.URL.Query().Get("profile") != "custom") {
				t.Error("member device/profile lost")
			}
			fallthrough
		case "/l/plain", "/l/router-1":
			w.Header().Set("Content-Type", "text/yaml")
			w.Header().Set("subscription-userinfo", "upload=3; download=5; total=1000; expire=1800000000")
			_, _ = w.Write([]byte("proxies:\n  - {name: reserve NL, type: ss, server: 192.0.2.1, port: 443, cipher: aes-128-gcm, password: fixture-key}\n  - {name: direct NL, type: ss, server: 192.0.2.2, port: 443, cipher: aes-128-gcm, password: fixture-key}\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	s := &slState{URL: srv.URL, Token: "fixture-session", Groups: []string{"PROXY"}, Selected: []slSelection{{ID: "router-1", Split: true}, {ID: "plain"}}}
	return srv, s
}

func TestSubLabSplitPreservesParametersFiltersAndUnrelatedConfig(t *testing.T) {
	_, s := subLabFixture(t)
	if err := slCatalog(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	candidate, managed, err := slCandidate(context.Background(), *s, []byte(sampleCoreConfig))
	if err != nil {
		t.Fatal(err)
	}
	if len(managed) != 3 {
		t.Fatalf("wanted three separate providers: %+v", managed)
	}
	var cfg struct {
		Secret    string                    `yaml:"secret"`
		Providers map[string]map[string]any `yaml:"proxy-providers"`
		Groups    []struct {
			Use []string `yaml:"use"`
		} `yaml:"proxy-groups"`
	}
	if err = yaml.Unmarshal(candidate, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Secret != "top-secret" || len(cfg.Providers) != 4 || len(cfg.Groups[0].Use) != 4 || cfg.Groups[0].Use[0] != "ROUTER" {
		t.Fatalf("lost existing data: %s", candidate)
	}
	if managed[0].Nodes != 1 || managed[0].Expire != 1800000000 {
		t.Fatalf("filter/expiry lost: %+v", managed[0])
	}
	b, _ := os.ReadFile(managed[0].Path)
	if strings.Contains(string(b), "direct NL") || !strings.Contains(string(b), "reserve NL") {
		t.Fatalf("filter ignored: %s", b)
	}
	// Reimporting the same set creates neither duplicate references nor paths.
	s.Managed = managed
	again, managed2, err := slCandidate(context.Background(), *s, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(again, candidate) || managed2[0].Path != managed[0].Path {
		t.Fatalf("non-idempotent sync: %s", again)
	}
	s.Selected = nil
	removed, remaining, err := slCandidate(context.Background(), *s, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 0 || strings.Contains(string(removed), "SL-") || !strings.Contains(string(removed), "ROUTER") {
		t.Fatalf("bad removal: %s", removed)
	}
}

func TestSubLabSyncPreservesHealthInterval(t *testing.T) {
	_, s := subLabFixture(t)
	if err := slCatalog(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	candidate, managed, err := slCandidate(context.Background(), *s, []byte(sampleCoreConfig))
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := yaml.Unmarshal(candidate, &cfg); err != nil {
		t.Fatal(err)
	}
	providers := cfg["proxy-providers"].(map[string]any)
	health := providers[managed[0].Provider].(map[string]any)["health-check"].(map[string]any)
	if health["interval"] != 600 {
		t.Fatalf("new subscription interval: %v", health["interval"])
	}
	health["interval"] = 1800
	custom, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s.Managed = managed
	again, _, err := slCandidate(context.Background(), *s, custom)
	if err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(again, &cfg); err != nil {
		t.Fatal(err)
	}
	providers = cfg["proxy-providers"].(map[string]any)
	health = providers[managed[0].Provider].(map[string]any)["health-check"].(map[string]any)
	if health["interval"] != 1800 {
		t.Fatalf("subscription update reset the custom interval: %v", health["interval"])
	}
}

func TestSubLabSyncFailurePreservesActiveDataAndSelection(t *testing.T) {
	_, s := subLabFixture(t)
	bad := func(mihomoSettings, string) error { return errors.New("validator rejected fixture") }
	reloaded := 0
	reload := func(mihomoSettings) error { reloaded++; return nil }
	if err := slSynchronize(context.Background(), s, bad, reload); err == nil {
		t.Fatal("invalid config accepted")
	}
	b, _ := os.ReadFile(coreConfigPath())
	if string(b) != sampleCoreConfig || len(s.Managed) != 0 || s.LastSync != 0 || reloaded != 0 {
		t.Fatal("failed validation changed active config/state")
	}
	good := func(mihomoSettings, string) error { return nil }
	if err := slSynchronize(context.Background(), s, good, reload); err != nil {
		t.Fatal(err)
	}
	if len(s.Managed) != 3 || s.LastSync == 0 || reloaded != 1 {
		t.Fatal("successful sync not recorded")
	}
	if err := slSave(*s); err != nil {
		t.Fatal(err)
	}
	loaded, err := slLoad()
	if err != nil || len(loaded.Managed) != 3 || loaded.Token != s.Token {
		t.Fatalf("state did not survive restart: %v", err)
	}
	old, _ := os.ReadFile(s.Managed[0].Path)
	s.Catalog[0].Children[0].Filter.Pattern = "no-match"
	active, _ := os.ReadFile(coreConfigPath())
	_, partial, err := slCandidate(context.Background(), *s, active)
	if err != nil || partial[0].Error == "" || partial[0].Path != s.Managed[0].Path || partial[0].Nodes != s.Managed[0].Nodes {
		t.Fatalf("source failure did not preserve previous data: %v %+v", err, partial)
	}
	still, _ := os.ReadFile(s.Managed[0].Path)
	if !bytes.Equal(old, still) {
		t.Fatal("failed sync changed active provider file")
	}
}

func TestSubLabPublicAPIHidesCredentialsAndRejectsCrossOrigin(t *testing.T) {
	_, s := subLabFixture(t)
	if err := slCatalog(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if err := slSave(*s); err != nil {
		t.Fatal(err)
	}
	a := &app{}
	rec := httptest.NewRecorder()
	a.handle(rec, httptest.NewRequest("GET", "/api/core/sublab", nil))
	for _, secret := range []string{"fixture-session", "secret-source", "example.invalid", "payload", "fixture-key"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("read API leaked %s", secret)
		}
	}
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"title":"Router 1"`) {
		t.Fatalf("missing catalog %s", rec.Body.String())
	}
	req := httptest.NewRequest("POST", "http://example.com/api/core/sublab/sync", strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://foreign.invalid")
	rec = httptest.NewRecorder()
	a.handle(rec, req)
	if rec.Code != 403 {
		t.Fatalf("foreign origin accepted: %d", rec.Code)
	}
}

func TestSubLabDownloadFiltersAndAccessErrors(t *testing.T) {
	_, s := subLabFixture(t)
	if err := slCatalog(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	child := s.Catalog[0].Children[0]
	child.Filter.Pattern = "missing"
	child.Filter.OnEmpty = "skip"
	_, count, _, err := slDownload(context.Background(), *s, child)
	if err != nil || count != 0 {
		t.Fatalf("skip: %d %v", count, err)
	}
	child.Filter.OnEmpty = "all"
	_, count, _, err = slDownload(context.Background(), *s, child)
	if err != nil || count != 2 {
		t.Fatalf("fallback all: %d %v", count, err)
	}
	child.Filter.Pattern = "(?<=lookbehind)unsupported"
	if _, _, _, err = slDownload(context.Background(), *s, child); err == nil {
		t.Fatal("unsupported expression silently changed semantics")
	}
	s.Token = "expired"
	if err = slCatalog(context.Background(), s); err == nil {
		t.Fatal("expired account accepted")
	}
	if len(s.Catalog) != 2 {
		t.Fatal("failure lost catalog")
	}
	s.Selected = []slSelection{{ID: "revoked"}}
	if _, err = slPicked(*s); err == nil {
		t.Fatal("revoked selection silently removed")
	}
}

func TestSubLabCreateDoesNotRetryOrLoseExistingFavorites(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MIHOMO_STATE_DIR", dir)
	creates := 0
	saved := []map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/favorites" && r.Method == "GET":
			_, _ = w.Write([]byte(`{"ok":true,"favorites":[{"title":"existing","payload":{"sub_url":"https://old.invalid"}}]}`))
		case r.URL.Path == "/api/favorites" && r.Method == "PUT":
			var body struct {
				Favorites []map[string]any `json:"favorites"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			saved = body.Favorites
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.URL.Path == "/api/short-links":
			creates++
			_, _ = w.Write([]byte(`{"ok":true,"link":{"id":"new"},"urls":{"shortUrl":"https://sub.invalid/l/new"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	if err := slSave(slState{URL: srv.URL, Token: "fixture"}); err != nil {
		t.Fatal(err)
	}
	a := &app{}
	rec := httptest.NewRecorder()
	a.handleSubLab(rec, httptest.NewRequest("POST", "/api/core/sublab/create", strings.NewReader(`{"title":"new","url":"https://new.invalid/private","tags":["router"]}`)))
	if rec.Code != 200 || creates != 1 || len(saved) != 2 || saved[0]["title"] != "existing" || saved[1]["shortId"] != "new" {
		t.Fatalf("bad creation: %d %d %+v %s", rec.Code, creates, saved, rec.Body.String())
	}
}

func TestSubLabUsageAttributionModesAndPersistence(t *testing.T) {
	now := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	tc := newTrafficCollector(filepath.Join(t.TempDir(), "traffic.gz"), now)
	tc.observeUplink(now, "normal")
	c := mihomoConn{ID: "c", Upload: 100, Download: 200, ProviderChains: []string{"SL-a", "SL-a", "", "COMPATIBLE"}}
	tc.observe(now, 100, 200, []mihomoConn{c}) // startup baseline
	c.Upload += 10
	c.Download += 20
	tc.observe(now.Add(5*time.Second), 110, 220, []mihomoConn{c})
	rows := slUsageReport(tc, now)
	if len(rows) != 1 || rows[0].Modes["normal"].Up != 10 || rows[0].Modes["normal"].Down != 20 || rows[0].Modes["normal"].ActiveSeconds != 5 || rows[0].Advice != "wait" {
		t.Fatalf("bad baseline/dedupe: %+v", rows)
	}
	tc.observeUplink(now.Add(time.Minute), "whitelist")
	c.Upload += 30
	c.Download += 40
	tc.observe(now.Add(time.Minute), 140, 260, []mihomoConn{c})
	rows = slUsageReport(tc, now)
	if rows[0].Modes["whitelist"].Up != 30 || rows[0].Modes["whitelist"].ActiveSeconds != 0 {
		t.Fatal("mode switch/gap counted incorrectly")
	}
	tc.save()
	loaded := newTrafficCollector(tc.path, now)
	if len(slUsageReport(loaded, now)) != 1 || len(slUsageReport(loaded, now.Add(31*24*time.Hour))) != 0 {
		t.Fatal("usage persistence/retention failed")
	}
}

func TestSubLabHealthFreshnessAndConservativeRenewal(t *testing.T) {
	now := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	tc := &trafficCollector{}
	tc.observeUplink(now, "whitelist")
	providers := map[string]providerSnapshot{
		"a":     {VehicleType: "File", Adaptive: &adaptiveSnapshot{Mode: "whitelist", Results: map[string]adaptiveResult{"node": {OK: true, At: now}}}},
		"stale": {VehicleType: "File", Adaptive: &adaptiveSnapshot{Mode: "whitelist", Results: map[string]adaptiveResult{"old": {OK: true, At: now.Add(-time.Hour)}}}},
	}
	tc.slHealth(now, providers)
	tc.slHealth(now, providers)
	r := slUsageReport(tc, now)
	if len(r) != 1 || r[0].Modes["whitelist"].Observed != 1 || r[0].Modes["whitelist"].Exclusive != 1 || r[0].Advice != "wait" {
		t.Fatalf("stale probes/double sample/early recommendation: %+v", r)
	}
	s := tc.slStat(now, "a", "whitelist")
	s.Observed = 7 * 24 * 60
	s.Exclusive = 30
	if r = slUsageReport(tc, now); r[0].Advice != "keep" {
		t.Fatalf("unique reserve not valued: %+v", r)
	}
	s.Exclusive = 0
	if r = slUsageReport(tc, now); r[0].Advice != "review" {
		t.Fatalf("expected human review: %+v", r)
	}
}

func TestSubLabRoutingKeepsExplicitProviderUses(t *testing.T) {
	_, s := subLabFixture(t)
	if err := slCatalog(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	s.Groups = []string{"ИИ"}
	candidate, managed, err := slCandidate(context.Background(), *s, []byte(routingFixture))
	if err != nil {
		t.Fatal(err)
	}
	built, err := buildRouting(candidate, defaultRouting())
	if err != nil {
		t.Fatal(err)
	}
	_, root, err := yamlRoot(built)
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range yamlGet(root, "proxy-groups").Content {
		if scalar(mapGet(g, "name")) == "ИИ" {
			seen := map[string]bool{}
			for _, v := range mapGet(g, "use").Content {
				seen[v.Value] = true
			}
			for _, p := range managed {
				if !seen[p.Provider] {
					t.Fatalf("routing dropped %s", p.Provider)
				}
			}
			return
		}
	}
	t.Fatal("routing lost target group")
}

func TestSubLabPasswordLoginAndImportAreSeparateFromApply(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MIHOMO_STATE_DIR", dir)
	logins := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/auth/password":
			logins++
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b["login"] != "test-user" || b["password"] != "ephemeral-fixture-password" {
				t.Error("login body invalid")
			}
			_, _ = w.Write([]byte(`{"ok":true,"token":"session-fixture"}`))
		case "/api/favorites":
			_, _ = w.Write([]byte(`{"ok":true,"favorites":[]}`))
		case "/api/short-links/bundle":
			_, _ = w.Write([]byte(`{"ok":true,"link":{"id":"bundle","title":"Bundle","params":{"sub_url":"merge:sources"}}}`))
		case "/api/merged-sources/sources":
			_, _ = w.Write([]byte(`{"ok":true,"source":{"items":[{"title":"A","sub_url":"https://a.invalid"},{"title":"B","sub_url":"https://b.invalid"}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	a := &app{}
	rec := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]string{"url": srv.URL, "username": "test-user", "password": "ephemeral-fixture-password"})
	a.handleSubLab(rec, httptest.NewRequest("POST", "/api/core/sublab/connect", bytes.NewReader(body)))
	if rec.Code != 200 || logins != 1 {
		t.Fatalf("login failed: %d %s", rec.Code, rec.Body.String())
	}
	raw, _ := os.ReadFile(filepath.Join(slDir(), "state.json"))
	if strings.Contains(string(raw), "ephemeral-fixture-password") {
		t.Fatal("password persisted")
	}
	body, _ = json.Marshal(map[string]string{"url": srv.URL + "/l/bundle"})
	rec = httptest.NewRecorder()
	a.handleSubLab(rec, httptest.NewRequest("POST", "/api/core/sublab/import", bytes.NewReader(body)))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"imported_id":"bundle"`) {
		t.Fatalf("import failed: %d %s", rec.Code, rec.Body.String())
	}
	s, err := slLoad()
	if err != nil || len(s.Selected) != 0 || len(s.Managed) != 0 || len(s.Catalog[0].Children) != 2 {
		t.Fatal("import applied config or changed saved selection")
	}
	// Even with an expired token, pause is local and does not call Sub Lab.
	s.Token = "expired"
	s.Every = 3600
	if err = slSave(s); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	a.handleSubLab(rec, httptest.NewRequest("POST", "/api/core/sublab/pause", strings.NewReader(`{}`)))
	s, _ = slLoad()
	if rec.Code != 200 || s.Every != 0 {
		t.Fatal("cannot pause offline")
	}
}

func TestSubLabBoardShowsNamedAndUnavailableSourcesSeparately(t *testing.T) {
	_, s := subLabFixture(t)
	s.Managed = []slManaged{{Provider: "SL-one", Title: "One", Nodes: 2}, {Provider: "SL-two", Title: "Two", Error: "Sub Lab HTTP 502"}}
	if err := slSave(*s); err != nil {
		t.Fatal(err)
	}
	rows := boardSources(map[string]boardProvider{"SL-one": {VehicleType: "File"}}, nil, "")
	if len(rows) != 2 || rows[0]["title"] != "One" || rows[1]["title"] != "Two" || rows[1]["error"] != "Sub Lab HTTP 502" {
		t.Fatalf("named/failed sources not shown separately: %+v", rows)
	}
}

// Explicit opt-in only: a private snapshot supplied outside git. The catalog
// comes from that snapshot, while every conversion goes to the real panel.
// No live config, subscriptions, favorites or deployed files are changed.
func TestSubLabRealBundleSeparateProviders(t *testing.T) {
	fixture := os.Getenv("SUBLAB_REAL_FIXTURE")
	if fixture == "" {
		t.Skip("set SUBLAB_REAL_FIXTURE for the requested live bundle")
	}
	_, s := subLabFixture(t)
	raw, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Link struct {
			ID     string         `json:"id"`
			Title  string         `json:"title"`
			Params map[string]any `json:"params"`
		} `json:"link"`
		Source json.RawMessage `json:"source"`
	}
	if err = json.Unmarshal(raw, &data); err != nil {
		t.Fatal("invalid private fixture")
	}
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/favorites":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "favorites": []any{map[string]any{"shortId": data.Link.ID, "title": data.Link.Title, "payload": data.Link.Params}}})
		case strings.HasPrefix(r.URL.Path, "/api/merged-sources/"):
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "source": data.Source})
		case r.URL.Path == "/sub":
			req, e := http.NewRequestWithContext(r.Context(), "GET", "https://sub.nl.cdn6.ru/sub?"+r.URL.RawQuery, nil)
			if e != nil {
				t.Error("bad conversion request")
				w.WriteHeader(502)
				return
			}
			req.Header.Set("User-Agent", "HomeNet-SubLab/1.0")
			resp, e := slHTTP().Do(req)
			if e != nil {
				t.Error("live converter unavailable")
				w.WriteHeader(502)
				return
			}
			defer resp.Body.Close()
			w.Header().Set("subscription-userinfo", resp.Header.Get("subscription-userinfo"))
			w.WriteHeader(resp.StatusCode)
			_, _ = io.Copy(w, io.LimitReader(resp.Body, 8<<20))
		default:
			http.NotFound(w, r)
		}
	}))
	defer live.Close()
	s.URL = live.URL
	s.Selected = []slSelection{{ID: data.Link.ID, Split: true}}
	if err = slCatalog(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	_, managed, err := slCandidate(context.Background(), *s, []byte(sampleCoreConfig))
	if err != nil {
		t.Fatal(err)
	}
	if len(managed) != 6 {
		t.Fatalf("wanted six separate subscriptions, got %d", len(managed))
	}
	for _, p := range managed {
		if p.Error != "" {
			t.Logf("%s: unavailable (%s)", p.Title, p.Error)
		} else {
			t.Logf("%s: %d servers", p.Title, p.Nodes)
		}
	}
}
