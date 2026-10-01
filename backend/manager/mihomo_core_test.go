package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const sampleCoreConfig = `# main profile
mixed-port: 7890
secret: "top-secret"
external-controller: 127.0.0.1:9090
# providers below
proxy-providers:
  ROUTER:
    type: http
    url: https://sub.example.net/abc
    interval: 21600
proxy-groups:
  - name: PROXY
    type: select
    use: [ROUTER]
rules:
  - GEOSITE,youtube,PROXY
  - MATCH,DIRECT
`

func TestBuildCandidateReplacesSectionsAndKeepsTheRest(t *testing.T) {
	edit := configEdit{Set: map[string]json.RawMessage{
		"rules":           json.RawMessage(`["DOMAIN-SUFFIX,chatgpt.com,PROXY","GEOSITE,youtube,PROXY","MATCH,DIRECT"]`),
		"proxy-providers": json.RawMessage(`{"ROUTER":{"type":"http","url":"https://sub.example.net/abc","interval":21600},"vpn":{"type":"http","url":"https://vpn.example.com/s","interval":43200}}`),
	}}
	out, err := buildCandidate([]byte(sampleCoreConfig), edit)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{"# main profile", "secret: \"top-secret\"", "external-controller: 127.0.0.1:9090", "chatgpt.com", "https://vpn.example.com/s"} {
		if !strings.Contains(s, want) {
			t.Errorf("candidate lacks %q:\n%s", want, s)
		}
	}
	changes := diffConfig([]byte(sampleCoreConfig), out)
	got := map[string]bool{}
	for _, c := range changes {
		got[c.Section+"/"+c.Kind+"/"+c.Item] = true
	}
	if !got["rules/added/DOMAIN-SUFFIX,chatgpt.com,PROXY"] || !got["proxy-providers/added/vpn"] || len(changes) != 2 {
		t.Fatalf("unexpected diff %+v", changes)
	}
}

func TestBuildCandidateRefusesProtectedSections(t *testing.T) {
	_, err := buildCandidate([]byte(sampleCoreConfig), configEdit{Set: map[string]json.RawMessage{"external-controller": json.RawMessage(`"0.0.0.0:9090"`)}})
	if err == nil {
		t.Fatal("controller address must not be editable")
	}
}

func TestRawYAMLKeepsSecretAndController(t *testing.T) {
	masked, sections, err := maskConfig([]byte(sampleCoreConfig))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(masked), "top-secret") {
		t.Fatal("secret leaked into the masked YAML")
	}
	if _, ok := sections["rules"]; !ok {
		t.Fatal("rules section missing")
	}
	if _, ok := sections["secret"]; ok {
		t.Fatal("secret must not be a section")
	}
	edited := strings.Replace(string(masked), "127.0.0.1:9090", "0.0.0.0:9090", 1)
	edited = strings.Replace(edited, "mixed-port: 7890", "mixed-port: 7895", 1)
	out, err := buildCandidate([]byte(sampleCoreConfig), configEdit{YAML: &edited})
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := yaml.Unmarshal(out, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["secret"] != "top-secret" || cfg["external-controller"] != "127.0.0.1:9090" || cfg["mixed-port"] != 7895 {
		t.Fatalf("protected keys not restored or edit lost: %v", cfg)
	}
}

func TestCoreConfigWriteRejectsStaleSHA(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(cfg, []byte(sampleCoreConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MIHOMO_CONFIG", cfg)
	t.Setenv("MIHOMO_CONTROLLER", "http://127.0.0.1:9")
	a := &app{}
	body, _ := json.Marshal(configEdit{SHA: "stale", Set: map[string]json.RawMessage{"mode": json.RawMessage(`"global"`)}})
	req := httptest.NewRequest("POST", "/api/core/config/check", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	a.handle(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale sha must conflict, got %d %s", rec.Code, rec.Body.String())
	}
	// A current sha without a binary reports the diff but cannot validate.
	t.Setenv("MIHOMO_BINARY", filepath.Join(dir, "missing-mihomo"))
	body, _ = json.Marshal(configEdit{SHA: configSHA([]byte(sampleCoreConfig)), Set: map[string]json.RawMessage{"mode": json.RawMessage(`"global"`)}})
	rec = httptest.NewRecorder()
	a.handle(rec, httptest.NewRequest("POST", "/api/core/config/apply", bytes.NewReader(body)))
	if rec.Code != http.StatusFailedDependency || !strings.Contains(rec.Body.String(), `"section":"mode"`) {
		t.Fatalf("expected diff without validator, got %d %s", rec.Code, rec.Body.String())
	}
	if raw, _ := os.ReadFile(cfg); string(raw) != sampleCoreConfig {
		t.Fatal("config must stay untouched")
	}
}

func TestDeviceLabelsRoundTrip(t *testing.T) {
	t.Setenv("MIHOMO_STATE_DIR", t.TempDir())
	if err := saveCoreLabels(map[string]string{"192.168.1.30": " Ноутбук ", "192.168.1.31": ""}); err != nil {
		t.Fatal(err)
	}
	labels := loadCoreLabels()
	if labels["192.168.1.30"] != "Ноутбук" || len(labels) != 1 {
		t.Fatalf("unexpected labels %v", labels)
	}
	if saveCoreLabels(map[string]string{"1.1.1.1": "a\nb"}) == nil {
		t.Fatal("multi-line names must be refused")
	}
}

func TestStarterConfigIsValidYAMLWithAdaptiveCheck(t *testing.T) {
	body, err := starterConfig(installRequest{SubscriptionURL: "https://sub.example.net/x", Provider: "ROUTER", Adaptive: true})
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := yaml.Unmarshal(body, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["external-controller"] != "127.0.0.1:9090" || len(cfg["secret"].(string)) < 32 {
		t.Fatal("controller must be loopback with a generated secret")
	}
	hc := cfg["proxy-providers"].(map[string]any)["ROUTER"].(map[string]any)["health-check"].(map[string]any)
	if hc["adaptive"].(map[string]any)["enable"] != true {
		t.Fatal("adaptive health check missing")
	}
	if validateInstallRequest(&installRequest{SubscriptionURL: "file:///etc/passwd"}) == nil {
		t.Fatal("non-http subscription must be refused")
	}
}
