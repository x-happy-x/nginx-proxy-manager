package main

import (
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func testRoutes() schema.Routes {
	r := schema.DefaultRoutes()
	r.Globals.ListenIPs = []string{"192.168.1.2", "fd00::2"}
	r.Apps = []schema.App{{ID: "sublab", Upstream: schema.UpstreamApp{Address: "192.168.99.20", Port: 4192, Scheme: "http"}}}
	r.Hosts = []schema.Host{{Host: "sub.crubs.crazedns.ru", AppID: "sublab", TLS: schema.TLSConfig{CertPolicy: "off"}, Endpoints: []schema.Endpoint{{Name: "web", Listen: schema.EndpointListen{Protocol: "http", Port: 80}}, {Name: "ndns", Listen: schema.EndpointListen{Protocol: "http", Port: 24001}}}}}
	return r
}
func testGenerator(t *testing.T) *generator {
	t.Helper()
	g := newGenerator(t.TempDir())
	g.mainConf = filepath.Join(g.confRoot, "nginx.conf")
	g.binary = "/usr/sbin/nginx"
	g.verifyProcess = func() error { return nil }
	if err := writeFile(g.mainConf, "pid "+quote(filepath.Join(g.confRoot, "nginx.pid"))+";\nevents {}\nhttp { include "+quote(filepath.Join(g.confRoot, "conf.d", "*.conf"))+"; include "+quote(filepath.Join(g.sitesEnabled, "*.conf"))+"; }\n", 0o644); err != nil {
		t.Fatal(err)
	}
	return g
}
func fileBody(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestPreviewHasNoFilesystemSideEffects(t *testing.T) {
	g := newGenerator(filepath.Join(t.TempDir(), "must-not-exist"))
	g.preview = true
	r := testRoutes()
	r.Hosts[0].TLS.CertPolicy = "self_signed"
	r.Hosts[0].Endpoints[0].Listen.Protocol = "https"
	r.Hosts[0].Endpoints[0].Listen.Port = 443
	files, err := g.render(r)
	if err != nil {
		t.Fatal(err)
	}
	// maps, proxy snippet, stub, host config and 502/504 pages for the local and public entrances.
	if len(files) != 8 {
		t.Fatalf("files: %d", len(files))
	}
	if exists(g.confRoot) {
		t.Fatal("preview created nginx files")
	}
}
func TestDedicatedPortClassifiesTrafficWithoutTrustingHeaders(t *testing.T) {
	g := newGenerator("/opt/etc/homenet/proxy")
	g.preview = true
	files, err := g.render(testRoutes())
	if err != nil {
		t.Fatal(err)
	}
	body := files[filepath.Join(g.sitesEnabled, "sub.crubs.crazedns.ru.conf")]
	for _, want := range []string{"listen 192.168.1.2:80;", "listen 192.168.1.2:24001;", "listen [fd00::2]:24001;", `"traffic_source":"external"`, `"traffic_source":"local"`, `"route_host":"sub.crubs.crazedns.ru"`, `"upstream_response_time":"$upstream_response_time"`, "proxy_pass http://192.168.99.20:4192;", "proxy_set_header Host sub.crubs.crazedns.ru;", "proxy_set_header X-Forwarded-Proto https;"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(body, "$http_x_forwarded") {
		t.Fatal("trusts caller forwarded headers")
	}
	if strings.Contains(body, "$request_uri\"") {
		t.Fatal("query tokens leaked into access logs")
	}
	if routeLogFormatName("a-b.local") == routeLogFormatName("a.b-local") {
		t.Fatal("colliding nginx log formats")
	}
}
func TestStageFailureLeavesLiveConfigurationUntouched(t *testing.T) {
	g := testGenerator(t)
	old := filepath.Join(g.sitesEnabled, "old.local.conf")
	if err := writeFile(old, managedHeader+"old config\n", 0o644); err != nil {
		t.Fatal(err)
	}
	calls := 0
	g.command = func(_ string, args ...string) error {
		calls++
		if args[0] != "-t" {
			t.Fatal("reload before validation")
		}
		if strings.Contains(strings.Join(args, " "), g.mainConf) {
			t.Fatal("first validation targets live config")
		}
		if fileBody(t, old) != managedHeader+"old config\n" {
			t.Fatal("live modified before staged test")
		}
		return errors.New("invalid config")
	}
	if err := g.apply(testRoutes()); err == nil {
		t.Fatal("expected staged validation failure")
	}
	if calls != 1 {
		t.Fatalf("calls %d", calls)
	}
	if fileBody(t, old) != managedHeader+"old config\n" {
		t.Fatal("old config damaged")
	}
	if exists(g.mapsConf) {
		t.Fatal("new config leaked")
	}
}
func TestLiveValidationAndReloadFailureRollBack(t *testing.T) {
	for _, failAt := range []int{2, 3} {
		t.Run(string(rune('0'+failAt)), func(t *testing.T) {
			g := testGenerator(t)
			old := filepath.Join(g.sitesEnabled, "old.local.conf")
			if err := writeFile(old, managedHeader+"previous\n", 0o640); err != nil {
				t.Fatal(err)
			}
			foreign := filepath.Join(g.sitesEnabled, "foreign.conf")
			if err := writeFile(foreign, "# user owned\n", 0o644); err != nil {
				t.Fatal(err)
			}
			calls := 0
			g.command = func(_ string, args ...string) error {
				calls++
				if calls == failAt {
					return errors.New("injected command failure")
				}
				return nil
			}
			if err := g.apply(testRoutes()); err == nil {
				t.Fatal("expected failure")
			}
			if fileBody(t, old) != managedHeader+"previous\n" {
				t.Fatal("previous route not restored")
			}
			if fileBody(t, foreign) != "# user owned\n" {
				t.Fatal("foreign config changed")
			}
			if exists(filepath.Join(g.sitesEnabled, "sub.crubs.crazedns.ru.conf")) {
				t.Fatal("new route not rolled back")
			}
			if exists(g.mapsConf) {
				t.Fatal("new maps not rolled back")
			}
		})
	}
}
func TestSuccessfulApplyNeverRestartsOrDeletesForeignFiles(t *testing.T) {
	g := testGenerator(t)
	foreign := filepath.Join(g.sitesEnabled, "foreign.conf")
	if err := writeFile(foreign, "# own config\n", 0o644); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(g.confRoot, "sites-available", "managed-crubs", "retained.conf")
	if err := writeFile(legacy, "# leave source intact\n", 0o644); err != nil {
		t.Fatal(err)
	}
	calls := [][]string{}
	g.command = func(binary string, args ...string) error {
		if binary != "/usr/sbin/nginx" {
			t.Fatal(binary)
		}
		calls = append(calls, args)
		return nil
	}
	if err := g.apply(testRoutes()); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 3 || strings.Join(calls[2][:2], " ") != "-s reload" {
		t.Fatalf("commands: %v", calls)
	}
	if fileBody(t, foreign) != "# own config\n" || fileBody(t, legacy) != "# leave source intact\n" {
		t.Fatal("foreign files changed")
	}
	if strings.Contains(fileBody(t, filepath.Join(g.sitesEnabled, "sub.crubs.crazedns.ru.conf")), "npm-nginx-stage-") {
		t.Fatal("temporary paths leaked to live config")
	}
}
func TestForeignFilenameCollisionFailsBeforeMutation(t *testing.T) {
	g := testGenerator(t)
	path := filepath.Join(g.sitesEnabled, "sub.crubs.crazedns.ru.conf")
	if err := writeFile(path, "# another application\n", 0o644); err != nil {
		t.Fatal(err)
	}
	g.command = func(string, ...string) error { t.Fatal("must reject collision before running nginx"); return nil }
	if err := g.apply(testRoutes()); err == nil {
		t.Fatal("foreign config overwritten")
	}
	if fileBody(t, path) != "# another application\n" {
		t.Fatal("foreign data lost")
	}
}
func TestMissingDedicatedRuntimeNeverRunsCommand(t *testing.T) {
	g := testGenerator(t)
	g.verifyProcess = nil
	g.mainConf = ""
	g.command = func(string, ...string) error { t.Fatal("nginx command without dedicated identity"); return nil }
	if err := g.apply(testRoutes()); err == nil {
		t.Fatal("unsafe runtime accepted")
	}
}
func TestWildcardListenerRejected(t *testing.T) {
	g := newGenerator("/tmp/nginx")
	r := testRoutes()
	r.Globals.ListenIPs = []string{"0.0.0.0"}
	if _, err := g.render(r); err == nil {
		t.Fatal("wildcard router listener accepted")
	}
}

func TestStubListenersAndDisableAreTransactional(t *testing.T) {
	g := testGenerator(t)
	r := testRoutes()
	r.Globals.Ports.HTTPExtra = []int{8085}
	r.Globals.Ports.HTTPSExtra = []int{8445}
	g.preview = true
	files, err := g.render(r)
	if err != nil {
		t.Fatal(err)
	}
	stubPath := filepath.Join(g.confRoot, "conf.d", "npm_stub_v3.conf")
	for _, expected := range []string{"192.168.1.2:80 default_server", "192.168.1.2:8085 default_server", "192.168.1.2:443 ssl default_server", "192.168.1.2:8445 ssl default_server", "try_files $uri $uri/ =404"} {
		if !strings.Contains(files[stubPath], expected) {
			t.Fatal("stub missing", expected)
		}
	}
	g.preview = false
	g.command = func(string, ...string) error { return nil }
	if err := g.apply(r); err != nil {
		t.Fatal(err)
	}
	if !exists(stubPath) {
		t.Fatal("stub not installed")
	}
	disabled := false
	r.Globals.Stub.Enabled = &disabled
	if err := g.apply(r); err != nil {
		t.Fatal(err)
	}
	if exists(stubPath) {
		t.Fatal("disabled stub listener retained")
	}
}

func TestKeeneticCertificatesStayEncryptedAndPreviewIsRedacted(t *testing.T) {
	fixture := newGenerator(t.TempDir())
	host := schema.Host{Host: "sub.crubs.crazedns.ru", TLS: schema.TLSConfig{CertPolicy: "self_signed"}}
	crt, _, err := fixture.resolveCertPaths(host.Host, host, nil)
	if err != nil {
		t.Fatal(err)
	}
	cert := fileBody(t, crt)
	key := string(pem.EncodeToMemory(&pem.Block{Type: "ENCRYPTED PRIVATE KEY", Bytes: []byte("firmware-encrypted-fixture")}))
	source := filepath.Join(t.TempDir(), "keenetic.conf")
	if err := os.WriteFile(source, []byte("map $host $ndm_cert_1 { default \""+cert+cert+"\"; }\nmap $host $ndm_key_1 { default \""+key+"\"; }\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KEENETIC_NGINX_CONF", source)
	r := testRoutes()
	r.Hosts[0].TLS.CertPolicy = "keenetic"
	r.Hosts[0].Endpoints[0].Listen.Protocol = "https"
	r.Hosts[0].Endpoints[0].Listen.Port = 443
	g := testGenerator(t)
	g.preview = true
	files, err := g.render(r)
	if err != nil {
		t.Fatal(err)
	}
	secretPath := filepath.Join(g.confRoot, "conf.d", "npm_keenetic_v3.conf")
	if strings.Contains(files[secretPath], "BEGIN") {
		t.Fatal("preview leaked encrypted private key or certificate")
	}
	config := files[filepath.Join(g.sitesEnabled, host.Host+".conf")]
	if !strings.Contains(config, "data:$npm_ndm_cert_1") || !strings.Contains(config, "ssl_password_file /dev/random;") {
		t.Fatal("Keenetic TLS references absent")
	}
	g.preview = false
	files, err = g.render(r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(files[secretPath], "BEGIN CERTIFICATE") != 2 {
		t.Fatal("certificate chain not preserved")
	}
	if !strings.Contains(files[secretPath], "BEGIN ENCRYPTED PRIVATE KEY") || strings.Contains(files[secretPath], "BEGIN PRIVATE KEY") {
		t.Fatal("key encryption changed")
	}
	g.command = func(string, ...string) error { return nil }
	if err := g.apply(r); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(secretPath)
	if err != nil {
		t.Fatal(err)
	}
	if os.PathSeparator == '/' && info.Mode().Perm() != 0o600 {
		t.Fatal("secret map permissions", info.Mode())
	}
	r.Hosts[0].Host = "unrelated.example"
	if _, err := g.render(r); err == nil {
		t.Fatal("unmatched Keenetic certificate accepted")
	}
}
