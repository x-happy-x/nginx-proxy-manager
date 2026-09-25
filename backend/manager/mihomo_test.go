package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"gopkg.in/yaml.v3"
)

const mihomoFixture = `# Preserve the user's complete policy.
secret: private-test-secret
mixed-port: 1080
dns:
  enable: true
  use-hosts: true
  enhanced-mode: fake-ip
  fake-ip-filter-mode: whitelist
  fake-ip-filter: ["+.local", "+.crubs.crazedns.ru"]
hosts:
  existing.local: 192.168.1.2
  remote.local: [192.168.99.10, 192.168.99.11]
proxy-providers:
  retained:
    type: http
    url: https://example.invalid/private-subscription
rules: ["MATCH,DIRECT"]
unknown-future-option: {keep: true}
`

func mihomoTestRoutes() schema.Routes {
	return schema.Routes{
		Globals: schema.Globals{ListenIPs: []string{"192.168.1.2"}},
		Hosts: []schema.Host{
			{Host: "sub.local", DNS: schema.DNSConfig{Publish: []string{"local"}, LocalRecordIP: "auto"}},
			{Host: "sub.crubs.crazedns.ru", DNS: schema.DNSConfig{Publish: []string{"local"}}},
			{Host: "external.example", DNS: schema.DNSConfig{Publish: []string{"ndns"}}},
		},
	}
}

func TestMihomoCandidatePreservesUnrelatedConfiguration(t *testing.T) {
	a := &app{}
	updated, changes, secret, err := a.mihomoHostsCandidate([]byte(mihomoFixture), mihomoTestRoutes())
	if err != nil || len(changes) != 2 || secret != "private-test-secret" {
		t.Fatalf("candidate changes=%v err=%v", changes, err)
	}
	var before, after map[string]any
	if yaml.Unmarshal([]byte(mihomoFixture), &before) != nil || yaml.Unmarshal(updated, &after) != nil {
		t.Fatal("candidate is not valid YAML")
	}
	hosts := after["hosts"].(map[string]any)
	for _, name := range []string{"sub.local", "sub.crubs.crazedns.ru"} {
		if hosts[name] != "192.168.1.2" {
			t.Fatalf("missing proxy host %s", name)
		}
		delete(hosts, name)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("configuration outside the two added hosts changed")
	}
	if !bytes.Contains(updated, []byte("# Preserve the user's complete policy.")) {
		t.Fatal("configuration comment lost")
	}
	again, changes, _, err := a.mihomoHostsCandidate(updated, mihomoTestRoutes())
	if err != nil || len(changes) != 0 || !bytes.Equal(again, updated) {
		t.Fatal("synchronization must be byte-preserving when unchanged")
	}
}

func TestMihomoCandidateRejectsConflictsAndDisabledHosts(t *testing.T) {
	for _, fixture := range []string{
		strings.Replace(mihomoFixture, "existing.local: 192.168.1.2", "sub.local: 192.168.1.99", 1),
		strings.Replace(mihomoFixture, "use-hosts: true", "use-hosts: false", 1),
		strings.Replace(mihomoFixture, "enable: true", "enable: false", 1),
		mihomoFixture + "\n---\nsecond-document: true\n",
		mihomoFixture + "\nhosts: {}\n",
	} {
		if _, _, _, err := (&app{}).mihomoHostsCandidate([]byte(fixture), mihomoTestRoutes()); err == nil {
			t.Fatal("unsafe candidate accepted")
		}
	}
}

func TestMihomoIntegrationRequiresExplicitLocalSettings(t *testing.T) {
	for _, name := range []string{"MIHOMO_CONFIG", "MIHOMO_BINARY", "MIHOMO_CONTROLLER", "MIHOMO_HOME", "MIHOMO_SECRET", "MIHOMO_DNS_MODE", "MIHOMO_HOSTS_PATH"} {
		t.Setenv(name, "")
	}
	plan, err := (&app{}).previewMihomoDNS(mihomoTestRoutes())
	if err != nil || plan.Enabled {
		t.Fatalf("unexpected default: %+v %v", plan, err)
	}
	t.Setenv("MIHOMO_CONFIG", filepath.Join(t.TempDir(), "config.yaml"))
	if _, _, err := mihomoEnvironment(); err == nil {
		t.Fatal("partial opt-in accepted")
	}
	t.Setenv("MIHOMO_BINARY", filepath.Join(t.TempDir(), "mihomo"))
	t.Setenv("MIHOMO_DNS_MODE", "config-reload")
	for _, controller := range []string{"http://192.168.1.1:9090", "http://localhost:9090", "http://127.0.0.1:9090/other", "http://user:password@127.0.0.1:9090", "http://127.0.0.1:9090?secret=x"} {
		t.Setenv("MIHOMO_CONTROLLER", controller)
		if _, _, err := mihomoEnvironment(); err == nil {
			t.Fatalf("unsafe controller accepted: %s", controller)
		}
	}
	t.Setenv("MIHOMO_CONTROLLER", "http://127.0.0.1:9090")
	if _, enabled, err := mihomoEnvironment(); err != nil || !enabled {
		t.Fatalf("valid integration rejected: %v", err)
	}
}

func TestMihomoSystemHostsPreservesForeignContentAndRemovesOwnedRecords(t *testing.T) {
	dir := t.TempDir()
	config := filepath.Join(dir, "config.yaml")
	hosts := filepath.Join(dir, "hosts")
	foreignPrefix := "# Router-owned header\r\n127.0.0.1 localhost router\r\n::1 localhost\r\n"
	foreignSuffix := "192.168.99.99 other.local # maintained elsewhere\n"
	original := foreignPrefix + mihomoHostsBegin + "\n192.168.1.2 obsolete.local\n" + mihomoHostsEnd + "\n" + foreignSuffix
	if err := os.WriteFile(config, []byte(mihomoFixture), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hosts, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	s := mihomoSettings{mode: "system-hosts", config: config, hostsPath: hosts}
	a := &app{}
	routes := mihomoTestRoutes()
	routes.Hosts = append(routes.Hosts, schema.Host{Host: "existing.local", DNS: schema.DNSConfig{Publish: []string{"local"}}})
	candidate, desired, err := a.mihomoSystemHostsCandidate(s, routes)
	if err != nil || len(desired) != 2 {
		t.Fatalf("system hosts candidate failed: %v", err)
	}
	if !bytes.HasPrefix(candidate, []byte(foreignPrefix)) || !bytes.HasSuffix(candidate, []byte(foreignSuffix)) || bytes.Contains(candidate, []byte("obsolete.local")) {
		t.Fatal("foreign content changed or stale managed entry retained")
	}
	if bytes.Contains(candidate, []byte("existing.local")) {
		t.Fatal("identical existing YAML host must not be duplicated in system hosts")
	}
	if ok, message := a.applyMihomoSystemHosts(s, mihomoTestRoutes()); !ok {
		t.Fatal(message)
	}
	actual, _ := os.ReadFile(hosts)
	if !bytes.Equal(actual, candidate) {
		t.Fatal("unexpected applied system hosts")
	}
	unchangedConfig, _ := os.ReadFile(config)
	if string(unchangedConfig) != mihomoFixture {
		t.Fatal("system-hosts mode must never modify the Mihomo configuration")
	}
	if ok, message := a.applyMihomoSystemHosts(s, mihomoTestRoutes()); !ok || !strings.Contains(message, "already synchronized") {
		t.Fatalf("idempotent sync failed: %s", message)
	}
	if ok, message := a.applyMihomoSystemHosts(s, schema.Routes{}); !ok {
		t.Fatal(message)
	}
	actual, _ = os.ReadFile(hosts)
	if string(actual) != foreignPrefix+foreignSuffix {
		t.Fatal("empty routes must remove only the manager-owned block")
	}
}

func TestMihomoSystemHostsRejectsShadowedHostsAndMalformedBlocks(t *testing.T) {
	for _, scenario := range []string{"foreign-conflict", "disabled", "yaml-wildcard", "unterminated", "duplicate-block", "end-without-begin"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			config, hosts := filepath.Join(dir, "config.yaml"), filepath.Join(dir, "hosts")
			configuration := mihomoFixture
			hostsBody := "127.0.0.1 localhost\n"
			switch scenario {
			case "foreign-conflict":
				hostsBody += "192.168.99.99 SUB.local. alias.local\n"
			case "disabled":
				configuration = strings.Replace(configuration, "use-hosts: true", "use-hosts: true\n  use-system-hosts: false", 1)
			case "yaml-wildcard":
				configuration = strings.Replace(configuration, "hosts:\n", "hosts:\n  '+.local': 192.168.99.99\n", 1)
			case "unterminated":
				hostsBody += mihomoHostsBegin + "\n192.168.1.2 sub.local\n"
			case "duplicate-block":
				hostsBody += mihomoHostsBegin + "\n" + mihomoHostsEnd + "\n" + mihomoHostsBegin + "\n" + mihomoHostsEnd + "\n"
			case "end-without-begin":
				hostsBody += mihomoHostsEnd + "\n"
			}
			if os.WriteFile(config, []byte(configuration), 0o600) != nil || os.WriteFile(hosts, []byte(hostsBody), 0o644) != nil {
				t.Fatal("write test fixtures")
			}
			s := mihomoSettings{mode: "system-hosts", config: config, hostsPath: hosts}
			if ok, _ := (&app{}).applyMihomoSystemHosts(s, mihomoTestRoutes()); ok {
				t.Fatal("unsafe system hosts candidate was applied")
			}
			actual, _ := os.ReadFile(hosts)
			if string(actual) != hostsBody {
				t.Fatal("rejected change modified system hosts")
			}
		})
	}
}

func TestMihomoSystemHostsModeNeedsNoExecutableOrController(t *testing.T) {
	dir := t.TempDir()
	config, hosts := filepath.Join(dir, "config.yaml"), filepath.Join(dir, "hosts")
	if os.WriteFile(config, []byte(mihomoFixture), 0o600) != nil || os.WriteFile(hosts, []byte("127.0.0.1 localhost\n"), 0o644) != nil {
		t.Fatal("write test fixtures")
	}
	t.Setenv("MIHOMO_DNS_MODE", "system-hosts")
	t.Setenv("MIHOMO_CONFIG", config)
	t.Setenv("MIHOMO_HOSTS_PATH", hosts)
	t.Setenv("MIHOMO_BINARY", "")
	t.Setenv("MIHOMO_CONTROLLER", "")
	plan, err := (&app{}).previewMihomoDNS(mihomoTestRoutes())
	if err != nil || !plan.Enabled || plan.Mode != "system-hosts" {
		t.Fatalf("unexpected preview: %+v err=%v", plan, err)
	}
	if ok, message := (&app{}).syncMihomoDNS(mihomoTestRoutes()); !ok {
		t.Fatal(message)
	}
}

func TestMihomoTransactionValidationAndRollback(t *testing.T) {
	for _, scenario := range []string{"validation-failure", "reload-failure", "concurrent-edit", "success"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "config.yaml")
			if err := os.WriteFile(path, []byte(mihomoFixture), 0o600); err != nil {
				t.Fatal(err)
			}
			reloads := 0
			validate := func(s mihomoSettings, staged string) error {
				candidate, err := os.ReadFile(staged)
				if err != nil || !bytes.Contains(candidate, []byte("sub.local:")) {
					t.Fatal("validator did not receive staged candidate")
				}
				active, _ := os.ReadFile(path)
				if string(active) != mihomoFixture {
					t.Fatal("active configuration changed before validation")
				}
				if scenario == "validation-failure" {
					return fmt.Errorf("invalid candidate")
				}
				if scenario == "concurrent-edit" {
					if err := os.WriteFile(path, []byte(mihomoFixture+"concurrent: true\n"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				return nil
			}
			reload := func(s mihomoSettings) error {
				reloads++
				if s.secret != "private-test-secret" {
					t.Fatal("controller secret not loaded")
				}
				if scenario == "reload-failure" && reloads == 1 {
					return fmt.Errorf("controller unavailable")
				}
				return nil
			}
			ok, message := (&app{}).applyMihomoHosts(mihomoSettings{config: path, home: dir}, mihomoTestRoutes(), validate, reload)
			if strings.Contains(message, "private-test-secret") {
				t.Fatal("result exposed controller credentials")
			}
			active, _ := os.ReadFile(path)
			switch scenario {
			case "validation-failure":
				if ok || reloads != 0 || string(active) != mihomoFixture {
					t.Fatal("validation failure changed active state")
				}
			case "reload-failure":
				if ok || reloads != 2 || string(active) != mihomoFixture || !strings.Contains(message, "runtime restored") {
					t.Fatalf("rollback did not restore file and runtime: %s", message)
				}
			case "concurrent-edit":
				if ok || reloads != 0 || !bytes.Contains(active, []byte("concurrent: true")) {
					t.Fatal("concurrent configuration edit was overwritten")
				}
			case "success":
				if !ok || reloads != 1 || !bytes.Contains(active, []byte("sub.local:")) {
					t.Fatalf("commit failed: %s", message)
				}
				backups, _ := filepath.Glob(filepath.Join(dir, ".homenet-backup-*.yaml"))
				if len(backups) != 1 {
					t.Fatal("recovery backup missing")
				}
				backup, _ := os.ReadFile(backups[0])
				if string(backup) != mihomoFixture {
					t.Fatal("backup did not preserve original configuration")
				}
			}
		})
	}
}

func TestMihomoControllerRequestAndRedirectSafety(t *testing.T) {
	var path, query, method, auth string
	var body map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, query, method, auth = r.URL.Path, r.URL.RawQuery, r.Method, r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	s := mihomoSettings{config: "/opt/etc/mihomo/config.yaml", controller: server.URL, secret: "controller-test-secret"}
	if err := mihomoReload(s); err != nil {
		t.Fatal(err)
	}
	if path != "/configs" || query != "force=false" || method != http.MethodPut || auth != "Bearer controller-test-secret" || body["path"] != s.config {
		t.Fatal("unexpected controller reload request")
	}
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, server.URL+"/leaked", http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	s.controller = redirect.URL
	if err := mihomoReload(s); err == nil || path == "/leaked" {
		t.Fatal("controller redirect was followed")
	}
}
