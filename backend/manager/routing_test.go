package main

import (
	"encoding/json"
	"os"
	"fmt"
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
	for _, want := range []string{"Прямые EU", "Обходы", "AUTO", "Каскад", "Резерв", "ИИ прямые", "ИИ", "РФ", "Игры", "Telegram", "Подписки", "Login", "SSO", "OLCRTC", "Tailscale", "Моя группа"} {
		if !strings.Contains(","+names+",", ","+want+",") {
			t.Errorf("group %q missing in %s", want, names)
		}
	}
	if strings.Contains(","+names+",", ",EU,") {
		t.Errorf("old group EU kept: %s", names)
	}
	// NPM-44: AUTO takes the leaf groups directly, the direct ones count only
	// within FastMS, every fallback switches after two failed connections
	if strings.Contains(","+names+",", ",Быстрые,") {
		t.Errorf("old group Быстрые kept: %s", names)
	}
	if g := groupByName(v, "AUTO"); !equalAny(g["proxies"], "Прямые EU", "Прямые мир", "Обходы", "Каскад") || g["interval"] != 120 {
		t.Errorf("AUTO = %v", g)
	}
	if g := groupByName(v, "Прямые EU"); g["timeout"] != 800 || g["interval"] != 600 {
		t.Errorf("Прямые EU = %v", g)
	}
	for _, name := range []string{"Прямые EU", "Обходы", "RU", "Каскад", "AUTO", "ИИ", "РФ", "Игры", "Telegram", "Подписки", "Login"} {
		if g := groupByName(v, name); g["type"] != "fallback" || g["max-failed-times"] != 2 {
			t.Errorf("%s: type %v, max-failed-times %v", name, g["type"], g["max-failed-times"])
		}
	}
	for name, want := range map[string][]string{
		"Login":    {"DIRECT"},
		"Игры":     {"DIRECT", "Обходы", "AUTO"},
		"РФ":       {"DIRECT", "RU", "Обходы", "AUTO"},
		"Telegram": {"Обходы", "Каскад", "Прямые EU"},
		"Подписки": {"DIRECT", "Обходы", "Каскад"},
	} {
		if g := groupByName(v, name); !equalAny(g["proxies"], want...) {
			t.Errorf("%s proxies = %v, want %v", name, g["proxies"], want)
		}
	}
	// every bypass and cascade node is checked by the address itself
	if g := groupByName(v, "Login"); g["interval"] != 300 || g["url"] != "https://login.example.org/health" || !equalAny(g["use"], "ROUTER", "CHAIN") || !strings.HasSuffix(g["filter"].(string), "|⛓") {
		t.Errorf("Login = %v", g)
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
	router := pp["ROUTER"].(map[string]any)
	if router["url"] != "https://sub.example/secret-token" {
		t.Error("ROUTER changed")
	}
	// NPM-44: the subscription downloads through its own group and is checked
	// every 15 minutes; file providers download nothing
	if router["proxy"] != "Подписки" || router["health-check"].(map[string]any)["interval"] != 900 {
		t.Errorf("ROUTER proxy = %v, health-check = %v", router["proxy"], router["health-check"])
	}
	if _, ok := pp["BACKUP"].(map[string]any)["proxy"]; ok {
		t.Error("file provider got a proxy")
	}
	if ai["health-check"].(map[string]any)["interval"] != 900 {
		t.Errorf("AI health-check interval = %v", ai["health-check"].(map[string]any)["interval"])
	}
	rules := v["rules"].([]any)
	want := []any{"DOMAIN-SUFFIX,egovm.ru,DIRECT", "GEOIP,private,DIRECT,no-resolve", "DST-PORT,53,HomeNet DNS", "DOMAIN,login.example.org,Login", "DOMAIN,sso.example.org,SSO",
		"GEOSITE,telegram,Telegram", "GEOIP,telegram,Telegram,no-resolve", "MATCH,Остальное"}
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

func equalAny(v any, want ...string) bool {
	l, ok := v.([]any)
	if !ok || len(l) != len(want) {
		return false
	}
	for i := range want {
		if l[i] != want[i] {
			return false
		}
	}
	return true
}

// NPM-50: passive check on the groups of nodes only; AI by exit country with
// fork 7 and no provider copy; off — as before.
func TestBuildRoutingStage2(t *testing.T) {
	s := defaultRouting()
	s.Access = []accessCheck{{Name: "Login", Host: "login.example.org", URL: "https://login.example.org/"}}
	s.coreExitCountries = true
	out, err := buildRouting([]byte(routingFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	v := routingDoc(t, out)
	for _, name := range []string{"Прямые EU", "Обходы", "RU", "Каскад", "ИИ прямые", "ИИ обходы", "Login"} {
		if groupByName(v, name)["passive-check"] != true {
			t.Errorf("%s without passive-check", name)
		}
	}
	for _, name := range []string{"AUTO", "ИИ", "РФ", "Telegram", "Игры", "Подписки"} {
		if _, ok := groupByName(v, name)["passive-check"]; ok {
			t.Errorf("group of groups %s got passive-check", name)
		}
	}
	ai := groupByName(v, "ИИ обходы")
	if !equalAny(ai["use"], "ROUTER") || ai["exit-countries"] == nil {
		t.Errorf("ИИ обходы = %v", ai)
	}
	if cs, _ := ai["exit-countries"].([]any); len(cs) == 0 || cs[0] == "EU" {
		t.Errorf("exit-countries = %v", ai["exit-countries"])
	}
	if _, ok := v["proxy-providers"].(map[string]any)["AI"]; ok {
		t.Error("AI provider copy kept with exit countries")
	}
	// passive off, older core: as before
	s.PassiveCheck, s.coreExitCountries = false, false
	old, err := buildRouting(out, s)
	if err != nil {
		t.Fatal(err)
	}
	v = routingDoc(t, old)
	if _, ok := groupByName(v, "Обходы")["passive-check"]; ok {
		t.Error("passive-check without the setting")
	}
	if !equalAny(groupByName(v, "ИИ обходы")["use"], "AI") {
		t.Errorf("old core: ИИ обходы = %v", groupByName(v, "ИИ обходы"))
	}
	if _, ok := v["proxy-providers"].(map[string]any)["AI"]; !ok {
		t.Error("old core: AI provider missing")
	}
	for in, want := range map[string]bool{"v1.19.32-fork.7": true, "v1.19.32-fork.12-local": true, "v1.19.32-fork.6": false, "v1.19.32": false, "": false} {
		if forkAtLeast(in, 7) != want {
			t.Errorf("forkAtLeast(%q, 7) != %v", in, want)
		}
	}
}

// NPM-46: the dns outbound comes first in proxies, once, and goes with the
// interception off; the user's proxies stay.
func TestBuildRoutingDNSIntercept(t *testing.T) {
	s := defaultRouting()
	out, err := buildRouting([]byte(routingFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	px := routingDoc(t, out)["proxies"].([]any)
	if len(px) != 2 || px[0].(map[string]any)["name"] != "HomeNet DNS" || px[0].(map[string]any)["type"] != "dns" || px[1].(map[string]any)["name"] != "TS-HOME" {
		t.Fatalf("proxies = %v", px)
	}
	s.DNSIntercept = false
	off, err := buildRouting(out, s)
	if err != nil {
		t.Fatal(err)
	}
	v := routingDoc(t, off)
	if px := v["proxies"].([]any); len(px) != 1 || px[0].(map[string]any)["name"] != "TS-HOME" {
		t.Errorf("proxies without interception = %v", px)
	}
	for _, r := range v["rules"].([]any) {
		if strings.Contains(r.(string), "HomeNet DNS") {
			t.Errorf("DNS rule kept: %v", r)
		}
	}
}

// Without the Telegram group its rules go and the user's ones apply again;
// a proxy or a longer interval the user set on a provider stays (NPM-44).
func TestBuildRoutingTelegramOffKeepsUserProvider(t *testing.T) {
	s := defaultRouting()
	on, err := buildRouting([]byte(routingFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	s.Telegram = false
	user := strings.Replace(string(on), "proxy: Подписки", "proxy: DIRECT", 1)
	user = strings.Replace(user, "interval: 900", "interval: 3600", 1)
	out, err := buildRouting([]byte(user), s)
	if err != nil {
		t.Fatal(err)
	}
	v := routingDoc(t, out)
	if groupByName(v, "Telegram") != nil {
		t.Error("Telegram group kept")
	}
	for _, r := range v["rules"].([]any) {
		if strings.HasSuffix(r.(string), ",Telegram") || strings.Contains(r.(string), ",Telegram,") {
			t.Errorf("Telegram rule kept: %v", r)
		}
	}
	router := v["proxy-providers"].(map[string]any)["ROUTER"].(map[string]any)
	if router["proxy"] != "DIRECT" || router["health-check"].(map[string]any)["interval"] != 3600 {
		t.Errorf("user's ROUTER settings changed: proxy %v, health-check %v", router["proxy"], router["health-check"])
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

// ROUTING_LIVE=<config.yaml> ROUTING_OUT=<file> [ROUTING_SETTINGS=<routing.json>] go test -run TestRoutingLive
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
	// ROUTING_SETTINGS=<routing.json> takes the router's own settings
	if p := os.Getenv("ROUTING_SETTINGS"); p != "" {
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatal(err)
		}
	}
	if b := os.Getenv("ROUTING_BASE"); b != "" {
		s.Base = b
	}
	// ROUTING_CORE=<core version> as the handler reads it (fork 7: AI by country)
	s.coreExitCountries = forkAtLeast(os.Getenv("ROUTING_CORE"), 7)
	if err := s.normalize(); err != nil {
		t.Fatal(err)
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
	if hc["enable"] != true || hc["lazy"] != false || hc["interval"] != 900 {
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

func TestYandexWhitelistProbeFirst(t *testing.T) {
	cfg := []byte(`proxy-providers:
  ROUTER:
    type: http
    url: https://example.test/sub
    path: ./proxy-providers/router.yaml
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 900
      adaptive:
        enable: true
        direct-allowed:
          - url: https://ya.ru
            expected-status: 200-399
proxy-groups: []
rules: []
`)
	s := defaultRouting()
	s.Base = "ROUTER"
	out, err := buildRouting(cfg, s)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	y, ya := strings.Index(text, routingYandex204), strings.Index(text, "https://ya.ru")
	if y < 0 || ya < 0 || y > ya {
		t.Fatalf("Yandex 204 is not the first whitelist probe:\n%s", text)
	}
	again, err := buildRouting(out, s)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(again), routingYandex204) != strings.Count(text, routingYandex204) {
		t.Fatal("the probe was added twice")
	}
	if !strings.Contains(text, "expected-status: 200-399") {
		t.Fatal("RU group still wants 200 only")
	}
}

func TestRoutingTorrents(t *testing.T) {
	s := defaultRouting()
	s.Torrents = true
	s.TorrentDevices = []string{" 192.168.1.50 ", "192.168.1.50"}
	if err := s.normalize(); err != nil {
		t.Fatal(err)
	}
	if len(s.TorrentDevices) != 1 || s.TorrentDevices[0] != "192.168.1.50" {
		t.Fatalf("devices: %v", s.TorrentDevices)
	}
	out, err := buildRouting([]byte(routingFixture), s)
	if err != nil {
		t.Fatal(err)
	}
	// built twice: the rules are not doubled
	out, err = buildRouting(out, s)
	if err != nil {
		t.Fatal(err)
	}
	v := routingDoc(t, out)
	g := groupByName(v, routingTorrents)
	if g["type"] != "select" || !strings.HasPrefix(fmt.Sprint(g["proxies"]), "[DIRECT Обходы AUTO") {
		t.Fatalf("group: %v", g)
	}
	rules := strings.Join(toStrings(v["rules"]), "\n")
	for _, want := range torrentRules(s.TorrentDevices) {
		if strings.Count(rules, want) != 1 {
			t.Errorf("rule %q: %d times", want, strings.Count(rules, want))
		}
	}
	bad := s
	bad.TorrentDevices = []string{"8.8.8.8"}
	if bad.normalize() == nil {
		t.Fatal("a public address must not pass as a download device")
	}
	off := defaultRouting()
	out, _ = buildRouting(out, off)
	if strings.Contains(string(out), routingTorrents) {
		t.Fatal("turned off: the group and its rules must go")
	}
}

func toStrings(v any) []string {
	out := []string{}
	if list, ok := v.([]any); ok {
		for _, x := range list {
			out = append(out, fmt.Sprint(x))
		}
	}
	return out
}
