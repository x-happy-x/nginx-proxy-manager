package main

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const routingFixture = `mode: rule
proxy-providers:
  ROUTER:
    type: http
    url: https://sub.example/secret-token
    path: ./proxy-providers/router.yaml
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      adaptive:
        enable: true
        network-key: home-uplink
        direct-allowed:
          - url: https://ya.ru
        direct-global:
          - url: https://www.gstatic.com/generate_204
        targets:
          - url: https://www.google.com/
  BACKUP:
    type: file
    path: ./proxy-providers/backup.yaml
  olcrtc:
    type: file
    path: ./olcrtc.yaml
proxies:
  - name: TS-HOME
    type: tailscale
proxy-groups:
  - name: 'EU'
    type: fallback
    use: ['ROUTER']
  - name: 'RU'
    type: fallback
    use: ['ROUTER']
    url: https://ya.ru
  - name: 'AUTO'
    type: fallback
    proxies: ['EU']
  - name: 'OLCRTC'
    type: select
    use: ['olcrtc']
  - name: 'Tailscale'
    type: select
    proxies: ['TS-HOME', REJECT]
  - name: 'Моя группа'
    type: select
    proxies: ['AUTO', DIRECT]
  - name: 'ИИ'
    type: select
    proxies: ['EU', DIRECT]
rules:
  - DOMAIN-SUFFIX,egovm.ru,DIRECT
  - GEOIP,private,DIRECT,no-resolve
  - DOMAIN-SUFFIX,login.example.org,GLOBAL
  - MATCH,Остальное
`

func routingDoc(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var v map[string]any
	if err := yaml.Unmarshal(body, &v); err != nil {
		t.Fatalf("output is not YAML: %v\n%s", err, body)
	}
	return v
}

func routingGroupNames(v map[string]any) []string {
	out := []string{}
	for _, g := range v["proxy-groups"].([]any) {
		out = append(out, g.(map[string]any)["name"].(string))
	}
	return out
}

func groupByName(v map[string]any, name string) map[string]any {
	for _, g := range v["proxy-groups"].([]any) {
		if g.(map[string]any)["name"] == name {
			return g.(map[string]any)
		}
	}
	return nil
}

func TestBuildRouting(t *testing.T) {
	s := defaultRouting()
	s.Access = []accessCheck{
		{Name: "Login", Host: "login.example.org", URL: "https://login.example.org/health"},
		{Name: "SSO", Host: "sso.example.org", URL: "https://sso.example.org/"},
	}
	if err := s.normalize(); err != nil {
		t.Fatal(err)
	}
	out, err := buildRouting([]byte(routingFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	v := routingDoc(t, out)
	names := strings.Join(routingGroupNames(v), ",")
	for _, want := range []string{"Прямые EU", "Обходы", "Быстрые", "AUTO", "Каскад", "Резерв", "ИИ прямые", "ИИ", "РФ", "Login", "SSO", "OLCRTC", "Tailscale", "Моя группа"} {
		if !strings.Contains(","+names+",", ","+want+",") {
			t.Errorf("group %q missing in %s", want, names)
		}
	}
	if strings.Contains(","+names+",", ",EU,") {
		t.Errorf("old group EU kept: %s", names)
	}
	if g := groupByName(v, "Быстрые"); g["timeout"] != 800 {
		t.Errorf("Быстрые timeout = %v", g["timeout"])
	}
	// the RU check address configured before is kept
	if g := groupByName(v, "RU"); g["url"] != "https://ya.ru" {
		t.Errorf("RU url = %v", g["url"])
	}
	// Резерв takes the providers no other group uses (BACKUP, not olcrtc)
	if g := groupByName(v, "Резерв"); len(g["use"].([]any)) != 1 || g["use"].([]any)[0] != "BACKUP" {
		t.Errorf("Резерв use = %v", g["use"])
	}
	pp := v["proxy-providers"].(map[string]any)
	ai := pp["AI"].(map[string]any)
	if ai["path"] != "./proxy-providers/router.yaml" || ai["type"] != "file" {
		t.Errorf("AI provider = %v", ai)
	}
	ad := ai["health-check"].(map[string]any)["adaptive"].(map[string]any)
	if ad["depends-on"] != "ROUTER" || ad["network-key"] != "home-uplink" {
		t.Errorf("AI adaptive = %v", ad)
	}
	// NPM-39: no flag filter — the exit country is checked by the trace target
	if _, ok := ai["filter"]; ok {
		t.Errorf("AI provider still filters by flags: %v", ai["filter"])
	}
	if ex, _ := ai["exclude-filter"].(string); !strings.Contains(ex, flag("RU")) {
		t.Errorf("AI exclude-filter = %q", ex)
	}
	trace := ad["targets"].([]any)[0].(map[string]any)
	if re, _ := trace["body-regex"].(string); !strings.Contains(re, "|KZ)") || strings.Contains(re, "EU") || strings.Contains(re, "RU") {
		t.Errorf("trace body-regex = %q", re)
	}
	if _, ok := pp["CHAIN"].(map[string]any)["override"].(map[string]any)["dialer-proxy"]; !ok {
		t.Error("CHAIN without dialer-proxy")
	}
	if pp["ROUTER"].(map[string]any)["url"] != "https://sub.example/secret-token" {
		t.Error("ROUTER changed")
	}
	rules := v["rules"].([]any)
	want := []any{"DOMAIN-SUFFIX,egovm.ru,DIRECT", "GEOIP,private,DIRECT,no-resolve", "DOMAIN,login.example.org,Login", "DOMAIN,sso.example.org,SSO", "MATCH,Остальное"}
	if len(rules) != len(want) {
		t.Fatalf("rules = %v", rules)
	}
	for i := range want {
		if rules[i] != want[i] {
			t.Errorf("rule %d = %v, want %v", i, rules[i], want[i])
		}
	}

	// building again gives the same file
	again, err := buildRouting(out, s)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != string(out) {
		t.Error("second build differs from the first")
	}
}

func TestBuildRoutingAIWithoutCheck(t *testing.T) {
	s := defaultRouting()
	s.AIServiceOK = false
	out, err := buildRouting([]byte(routingFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	ai := routingDoc(t, out)["proxy-providers"].(map[string]any)["AI"].(map[string]any)
	if _, ok := ai["filter"]; !ok {
		t.Error("without the service check the AI provider must keep the flag filter")
	}
}

func TestBuildRoutingWithoutCascade(t *testing.T) {
	s := defaultRouting()
	s.Cascade = false
	out, err := buildRouting([]byte(routingFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "Каскад") || strings.Contains(string(out), "CHAIN") {
		t.Errorf("cascade left in the config:\n%s", out)
	}
}

func TestRoutingNormalize(t *testing.T) {
	s := defaultRouting()
	s.AI = []string{"us", "Germany"}
	if err := s.normalize(); err == nil {
		t.Error("country name accepted as a code")
	}
	for _, bad := range []accessCheck{
		{Name: "", Host: "a.example.org", URL: "https://a.example.org/"},
		{Name: "AUTO", Host: "a.example.org", URL: "https://a.example.org/"},
		{Name: "A,B", Host: "a.example.org", URL: "https://a.example.org/"},
		{Name: "A", Host: "not a host", URL: "https://a.example.org/"},
		{Name: "A", Host: "a.example.org", URL: "ftp://a.example.org/"},
	} {
		s = defaultRouting()
		s.Access = []accessCheck{bad}
		if err := s.normalize(); err == nil {
			t.Errorf("access %+v accepted", bad)
		}
	}
	s = defaultRouting()
	s.Bypass = []string{" ", ""}
	if err := s.normalize(); err == nil {
		t.Error("empty bypass list accepted")
	}
	s = defaultRouting()
	s.Bypass = []string{"LTE", "lte", "Белые Списки"}
	if err := s.normalize(); err != nil || len(s.Bypass) != 2 || s.Bypass[1] != "белые списки" {
		t.Errorf("normalize bypass = %v, %v", s.Bypass, err)
	}
}

func TestWordsRE(t *testing.T) {
	if got := wordsRE([]string{"белые списки", "[free]"}); got != `(?i)(белые\s*списки|\[free\])` {
		t.Errorf("wordsRE = %s", got)
	}
}

func TestSanitizeValidatorFirstError(t *testing.T) {
	out := []byte(`time="a" level=warning msg="[CacheFile] can't open cache file: timeout"
time="b" level=error msg="proxy group[15]: Игры: 'Прямые EU2' not found"
configuration file C:\stand\mihomo\.homenet-staged-1.yaml test failed
`)
	if got := sanitizeValidator(out); got != "proxy group[15]: Игры: 'Прямые EU2' not found" {
		t.Errorf("sanitizeValidator = %q", got)
	}
	if got := sanitizeValidator([]byte(`configuration file C:\stand\mihomo\.homenet-staged-1.yaml test failed`)); strings.Contains(got, `C:\`) {
		t.Errorf("path kept: %q", got)
	}
	if got := sanitizeValidator([]byte("configuration file /opt/etc/mihomo/.homenet-staged-1.yaml test failed\n")); strings.Contains(got, "/opt/") {
		t.Errorf("path kept: %q", got)
	}
}

func TestSanitizeValidator(t *testing.T) {
	out := []byte(`time="x" level=error msg="proxy group[Стриминг]: 'Обходы2' not found; provider https://sub.example/abc?token=1 password=hunter2"`)
	got := sanitizeValidator(out)
	if strings.Contains(got, "sub.example") || strings.Contains(got, "hunter2") || !strings.Contains(got, "Обходы2") {
		t.Errorf("sanitizeValidator = %q", got)
	}
}

// ROUTING_LIVE=<config.yaml> ROUTING_OUT=<file> go test -run TestRoutingLive
// builds the block for a real config (kept out of the repository).
func TestRoutingLive(t *testing.T) {
	in, outPath := os.Getenv("ROUTING_LIVE"), os.Getenv("ROUTING_OUT")
	if in == "" || outPath == "" {
		t.Skip("ROUTING_LIVE and ROUTING_OUT not set")
	}
	body, err := os.ReadFile(in)
	if err != nil {
		t.Fatal(err)
	}
	s := defaultRouting()
	if b := os.Getenv("ROUTING_BASE"); b != "" {
		s.Base = b
	}
	out, err := buildRouting(body, s)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outPath, out, 0o600); err != nil {
		t.Fatal(err)
	}
}

// A config as the original XKeen leaves it: another provider name, no adaptive check (NPM-42).
const plainFixture = `proxy-providers:
  SUB:
    type: http
    url: https://sub.example/x
    path: ./providers/sub.yaml
    health-check:
      enable: false
      url: https://www.gstatic.com/generate_204
proxy-groups:
  - name: PROXY
    type: select
    use: [SUB]
rules:
  - MATCH,PROXY
`

func TestBuildRoutingAddsAdaptive(t *testing.T) {
	s := defaultRouting()
	s.Base = "SUB"
	out, err := buildRouting([]byte(plainFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	pp := routingDoc(t, out)["proxy-providers"].(map[string]any)
	hc := pp["SUB"].(map[string]any)["health-check"].(map[string]any)
	if hc["enable"] != true || hc["lazy"] != false || hc["interval"] != 300 {
		t.Errorf("SUB health-check = %v", hc)
	}
	ad, ok := hc["adaptive"].(map[string]any)
	if !ok || ad["network-key"] != "uplink" || len(ad["targets"].([]any)) != 2 {
		t.Fatalf("SUB adaptive = %v", hc["adaptive"])
	}
	if hc["url"] != "https://www.gstatic.com/generate_204" {
		t.Errorf("existing url changed: %v", hc["url"])
	}
	// the AI provider follows the base: service check with depends-on SUB
	aiAd := pp["AI"].(map[string]any)["health-check"].(map[string]any)["adaptive"].(map[string]any)
	if aiAd["depends-on"] != "SUB" {
		t.Errorf("AI depends-on = %v", aiAd["depends-on"])
	}
}

func TestBuildRoutingKeepsAdaptive(t *testing.T) {
	out, err := buildRouting([]byte(routingFixture), defaultRouting())
	if err != nil {
		t.Fatal(err)
	}
	ad := routingDoc(t, out)["proxy-providers"].(map[string]any)["ROUTER"].(map[string]any)["health-check"].(map[string]any)["adaptive"].(map[string]any)
	if ad["network-key"] != "home-uplink" {
		t.Errorf("existing adaptive block changed: %v", ad)
	}
}

func TestBuildRoutingWithoutBaseAdaptive(t *testing.T) {
	s := defaultRouting()
	s.Base = "SUB"
	s.BaseAdaptive = false
	out, err := buildRouting([]byte(plainFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	pp := routingDoc(t, out)["proxy-providers"].(map[string]any)
	if _, ok := pp["SUB"].(map[string]any)["health-check"].(map[string]any)["adaptive"]; ok {
		t.Error("adaptive added although switched off")
	}
	if _, ok := pp["AI"].(map[string]any)["filter"]; !ok {
		t.Error("without an adaptive base the AI provider must keep the flag filter")
	}
}

func TestBuildRoutingMissingBase(t *testing.T) {
	if _, err := buildRouting([]byte(plainFixture), defaultRouting()); err == nil || !strings.Contains(err.Error(), "ROUTER") {
		t.Errorf("missing base error = %v", err)
	}
}
