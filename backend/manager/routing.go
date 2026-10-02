package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

/*
 * Routing (NPM-34): HomeNet owns the proxy groups of config.yaml and builds
 * them from a few settings — which nodes are bypass ones (limited traffic),
 * the delay ceiling for direct ones, the countries for AI services, the check
 * addresses and the cascade. Rules and other sections stay the user's; only
 * the two Tailnt rules are kept in place. Groups HomeNet does not know
 * (OLCRTC, Tailscale, the user's own) are preserved.
 */

type routingSettings struct {
	Base        string   `json:"base"`
	Bypass      []string `json:"bypass"`
	Junk        []string `json:"junk"`
	FastMS      int      `json:"fast_ms"`
	EU          []string `json:"eu"`
	AI          []string `json:"ai"`
	Never       []string `json:"never"`
	RUCheck     string   `json:"ru_check"`
	Headscale   string   `json:"headscale_check"`
	Keycloak    string   `json:"keycloak_check"`
	Cascade     bool     `json:"cascade"`
	AIServiceOK bool     `json:"ai_service_check"`
}

var euCountries = strings.Fields("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE EU GB CH NO IS")

func defaultRouting() routingSettings {
	return routingSettings{
		Base:        "ROUTER",
		Bypass:      []string{"обход", "white", "белые списки", "белый список", "whitelist", "4g", "lte", "мобильн", "mobile"},
		Junk:        []string{"[free]", "только tg"},
		FastMS:      800,
		EU:          append([]string{}, euCountries...),
		AI:          append(append([]string{}, euCountries...), strings.Fields("US CA JP KR SG AU KZ")...),
		Never:       strings.Fields("RU BY HK CN MO IR KP"),
		RUCheck:     "https://habr.com/ru/feed/",
		Headscale:   "https://headscale.tailnt.ru/health",
		Keycloak:    "https://keycloak.tailnt.ru/",
		Cascade:     true,
		AIServiceOK: true,
	}
}

// Group names HomeNet generates; any other group in config.yaml is kept.
var routingManaged = map[string]bool{
	"Прямые EU": true, "Прямые мир": true, "Обходы": true, "RU": true, "Каскад": true, "Резерв": true,
	"Быстрые": true, "AUTO": true, "ИИ прямые": true, "ИИ обходы": true, "ALL": true, "ИИ": true, "РФ": true,
	"Headscale": true, "Keycloak": true, "Игры": true, "Заблокированные сервисы": true, "Остальное": true,
	"Белые списки": true, "QUIC": true, "GLOBAL": true,
	// replaced by the groups above (NPM-33)
	"EU": true, "Без белых списков": true,
}

const (
	routingChainProvider = "CHAIN"
	routingAIProvider    = "AI"
	routingCheck         = "https://www.gstatic.com/generate_204"
	routingCheck2        = "https://cp.cloudflare.com/generate_204"
	routingMarker        = "HomeNet: маршрутизация (NPM-34). Группы ниже до «Игры» включительно\nсобирает HomeNet: правьте их в «VPN → Настройка → Маршрутизация»."
)

func routingPath() string { return filepath.Join(coreStateDir(), "routing.json") }

func loadRouting() (routingSettings, bool) {
	s := defaultRouting()
	body, err := os.ReadFile(routingPath())
	if err != nil {
		return s, false
	}
	if json.Unmarshal(body, &s) != nil {
		return defaultRouting(), false
	}
	return s, true
}

func saveRouting(s routingSettings) error {
	if err := os.MkdirAll(coreStateDir(), 0o755); err != nil {
		return err
	}
	body, _ := json.MarshalIndent(s, "", "  ")
	tmp := routingPath() + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, routingPath())
}

var countryCode = regexp.MustCompile(`^[A-Z]{2}$`)

func (s *routingSettings) normalize() error {
	clean := func(in []string, lower bool) []string {
		out := []string{}
		seen := map[string]bool{}
		for _, w := range in {
			w = strings.TrimSpace(w)
			if lower {
				w = strings.ToLower(w)
			}
			if w != "" && !seen[w] && len(w) <= 64 {
				seen[w] = true
				out = append(out, w)
			}
		}
		return out
	}
	s.Base = strings.TrimSpace(s.Base)
	s.Bypass = clean(s.Bypass, true)
	s.Junk = clean(s.Junk, true)
	if len(s.Bypass) == 0 {
		return errors.New("нужно хотя бы одно слово для обходов")
	}
	for _, list := range []*[]string{&s.EU, &s.AI, &s.Never} {
		*list = clean(*list, false)
		for i, c := range *list {
			(*list)[i] = strings.ToUpper(c)
			if !countryCode.MatchString((*list)[i]) {
				return fmt.Errorf("код страны %q: нужны две латинские буквы", c)
			}
		}
	}
	if len(s.AI) == 0 {
		return errors.New("для ИИ нужна хотя бы одна страна")
	}
	if s.FastMS < 200 || s.FastMS > 5000 {
		return errors.New("порог задержки: от 200 до 5000 мс")
	}
	for name, u := range map[string]string{"РФ": s.RUCheck, "Headscale": s.Headscale, "Keycloak": s.Keycloak} {
		p, err := url.Parse(u)
		if err != nil || (p.Scheme != "https" && p.Scheme != "http") || p.Host == "" {
			return fmt.Errorf("проверочный адрес «%s»: нужен http(s)-адрес", name)
		}
	}
	return nil
}

// wordsRE matches any of the words as a substring, case-insensitive; spaces
// inside a word match any whitespace.
func wordsRE(words []string) string {
	parts := make([]string, 0, len(words))
	for _, w := range words {
		parts = append(parts, strings.ReplaceAll(regexp.QuoteMeta(w), " ", `\s*`))
	}
	return "(?i)(" + strings.Join(parts, "|") + ")"
}

func flag(cc string) string {
	r := []rune{}
	for _, c := range cc {
		r = append(r, 0x1F1E6+c-'A')
	}
	return string(r)
}

func flagsRE(codes []string) string {
	parts := make([]string, 0, len(codes))
	for _, c := range codes {
		parts = append(parts, flag(c))
	}
	return "(" + strings.Join(parts, "|") + ")"
}

/* ---------- building ---------- */

type m = map[string]any

func fallback(name string, extra m) m {
	g := m{"name": name, "type": "fallback", "url": routingCheck, "interval": 300}
	for k, v := range extra {
		g[k] = v
	}
	return g
}

// routingGroups returns the generated groups, in order: base, automatic,
// then (after `between`, the preserved groups) the rule groups.
func routingGroups(s routingSettings, reserve []string, ruURL string, between []string, hasOLC, hasTS bool) (head, tail []m) {
	bypass, junk := wordsRE(s.Bypass), ""
	if len(s.Junk) > 0 {
		junk = wordsRE(s.Junk)
	}
	or := func(parts ...string) string {
		out := []string{}
		for _, p := range parts {
			if p != "" {
				out = append(out, p)
			}
		}
		return strings.Join(out, "|")
	}
	base := []any{s.Base}
	head = append(head,
		fallback("Прямые EU", m{"use": base, "filter": flagsRE(s.EU), "exclude-filter": or(bypass, junk)}),
		fallback("Прямые мир", m{"use": base, "exclude-filter": or(bypass, junk, flagsRE(s.Never), flagsRE(s.EU))}),
		fallback("Обходы", m{"use": base, "filter": bypass, "exclude-filter": junk}),
		fallback("RU", m{"use": base, "filter": flag("RU"), "exclude-filter": or(bypass, junk), "url": ruURL, "expected-status": "200"}),
	)
	if junk == "" {
		delete(head[2], "exclude-filter")
	}
	if s.Cascade {
		head = append(head, fallback("Каскад", m{"use": []any{routingChainProvider}, "interval": 600, "timeout": 8000, "lazy": true}))
	}
	if len(reserve) > 0 {
		head = append(head, m{"name": "Резерв", "type": "select", "use": toAny(reserve)})
	}
	last := []any{"Быстрые", "Обходы"}
	if s.Cascade {
		last = append(last, "Каскад")
	}
	head = append(head,
		fallback("Быстрые", m{"proxies": []any{"Прямые EU", "Прямые мир", "Обходы"}, "health-check-urls": []any{routingCheck2}, "timeout": s.FastMS, "lazy": false}),
		fallback("AUTO", m{"proxies": last, "health-check-urls": []any{routingCheck2}, "timeout": 5000, "lazy": false}),
		fallback("ИИ прямые", m{"use": []any{routingAIProvider}, "exclude-filter": bypass, "interval": 600}),
		fallback("ИИ обходы", m{"use": []any{routingAIProvider}, "filter": bypass, "interval": 600}),
	)
	all := []any{"AUTO", "Прямые EU", "Прямые мир", "Обходы", "RU"}
	if s.Cascade {
		all = append(all, "Каскад")
	}
	if len(reserve) > 0 {
		all = append(all, "Резерв")
	}
	head = append(head, m{"name": "ALL", "type": "select", "proxies": append(all, "DIRECT"), "use": base})

	ai := []any{"ИИ прямые", "ИИ обходы"}
	if s.Cascade {
		ai = append(ai, "Каскад")
	}
	extras := []any{}
	if hasOLC {
		extras = append(extras, "OLCRTC")
	}
	if hasTS {
		extras = append(extras, "Tailscale")
	}
	pick := func(first ...any) []any {
		out := append([]any{}, first...)
		return out
	}
	cascade := []any{}
	if s.Cascade {
		cascade = []any{"Каскад"}
	}
	blocked := pick("AUTO", "Прямые EU", "Прямые мир", "Обходы")
	blocked = append(append(append(blocked, cascade...), "ALL"), extras...)
	tail = append(tail,
		fallback("ИИ", m{"proxies": ai, "timeout": 5000}),
		fallback("РФ", m{"proxies": []any{"DIRECT", "RU", "AUTO"}, "url": s.RUCheck, "expected-status": "200-399", "timeout": 5000}),
		fallback("Headscale", m{"proxies": []any{"DIRECT", "RU", "AUTO"}, "url": s.Headscale, "expected-status": "200", "interval": 120, "timeout": 5000, "lazy": false}),
		fallback("Keycloak", m{"proxies": []any{"DIRECT", "RU", "AUTO"}, "url": s.Keycloak, "expected-status": "200-399", "interval": 120, "timeout": 5000, "lazy": false}),
		m{"name": "Игры", "type": "select", "proxies": []any{"DIRECT", "RU", "AUTO", "Прямые EU", "ALL", "REJECT"}},
		m{"name": "Заблокированные сервисы", "type": "select", "proxies": append(append([]any{}, blocked...), "DIRECT", "REJECT")},
		m{"name": "Остальное", "type": "select", "proxies": append(append([]any{"AUTO", "DIRECT", "Прямые EU", "Прямые мир", "Обходы", "ALL"}, extras...), "REJECT")},
		m{"name": "Белые списки", "type": "select", "proxies": []any{"DIRECT", "AUTO", "Обходы", "ALL", "REJECT"}},
		m{"name": "QUIC", "type": "select", "proxies": []any{"REJECT", "DIRECT", "AUTO"}},
		m{"name": "GLOBAL", "type": "select", "proxies": append(append([]any{}, blocked...), "DIRECT", "REJECT")},
	)
	_ = between
	return head, tail
}

func toAny(in []string) []any {
	out := make([]any, len(in))
	for i, v := range in {
		out[i] = v
	}
	return out
}

// Key order for generated mappings, so the YAML reads like a hand-written one.
var routingKeyOrder = []string{"name", "type", "proxies", "use", "filter", "exclude-filter", "url", "health-check-urls", "expected-status", "interval", "timeout", "lazy"}

func orderedNode(v any) *yaml.Node {
	switch t := v.(type) {
	case m:
		n := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		rank := func(k string) int {
			for i, o := range routingKeyOrder {
				if o == k {
					return i
				}
			}
			return len(routingKeyOrder)
		}
		sort.SliceStable(keys, func(i, j int) bool {
			ri, rj := rank(keys[i]), rank(keys[j])
			if ri != rj {
				return ri < rj
			}
			return keys[i] < keys[j]
		})
		for _, k := range keys {
			n.Content = append(n.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k}, orderedNode(t[k]))
		}
		return n
	case []any:
		n := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Style: yaml.FlowStyle}
		for _, x := range t {
			n.Content = append(n.Content, orderedNode(x))
		}
		return n
	default:
		var n yaml.Node
		_ = n.Encode(v)
		if n.Kind == yaml.ScalarNode && n.Tag == "!!str" && (strings.ContainsAny(n.Value, "|()?") || n.Value == "") {
			n.Style = yaml.SingleQuotedStyle
		}
		return &n
	}
}

func mapGet(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	return yamlGet(n, key)
}

func scalar(n *yaml.Node) string {
	if n == nil || n.Kind != yaml.ScalarNode {
		return ""
	}
	return n.Value
}

// providerNode builds a file provider that reads the base provider's cache,
// so only the base one updates the subscription.
func providerNode(base *yaml.Node, kind string, s routingSettings) (*yaml.Node, error) {
	path := scalar(mapGet(base, "path"))
	if path == "" {
		return nil, fmt.Errorf("у подписки %s нет path: копиям для ИИ и каскада нечего читать", s.Base)
	}
	bypass := wordsRE(s.Bypass)
	junk := ""
	if len(s.Junk) > 0 {
		junk = wordsRE(s.Junk)
	}
	p := m{"type": "file", "path": path, "interval": 3600, "filter": flagsRE(s.AI)}
	hc := m{"enable": true, "url": routingCheck, "expected-status": "204", "interval": 600}
	switch kind {
	case routingChainProvider:
		ex := bypass
		if junk != "" {
			ex += "|" + junk
		}
		p["exclude-filter"] = ex
		p["override"] = m{"additional-prefix": "⛓ ", "dialer-proxy": "Обходы"}
		hc["lazy"] = true
		hc["timeout"] = 8000
	case routingAIProvider:
		if junk != "" {
			p["exclude-filter"] = junk
		}
		p["override"] = m{"additional-prefix": "ИИ | "}
		hc["lazy"] = false
		hc["timeout"] = 5000
	}
	node := orderedNode(p)
	hcNode := orderedNode(hc)
	if kind == routingAIProvider && s.AIServiceOK {
		if ad := routingAIAdaptive(base, s); ad != nil {
			hcNode.Content = append(hcNode.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "adaptive"}, ad)
		}
	}
	node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "health-check"}, hcNode)
	// lists inside providers read better in block style
	for _, c := range node.Content {
		if c.Kind == yaml.SequenceNode {
			c.Style = 0
		}
	}
	return node, nil
}

// routingAIAdaptive reuses the base provider's network-mode probes and checks
// the exit country and the OpenAI API (NPM-33: the chatgpt.com page itself is
// challenged by Cloudflare when many nodes ask at once).
func routingAIAdaptive(base *yaml.Node, s routingSettings) *yaml.Node {
	ba := mapGet(mapGet(base, "health-check"), "adaptive")
	if ba == nil {
		return nil
	}
	never := append(append([]string{}, s.Never...), "SY", "CU", "VE", "AF")
	ad := orderedNode(m{"enable": true, "depends-on": s.Base, "confirmations": 2, "concurrency": 2, "failure-threshold": 3, "recovery-threshold": 2})
	for _, key := range []string{"network-key", "direct-allowed", "direct-global"} {
		if v := mapGet(ba, key); v != nil {
			c := *v
			ad.Content = append(ad.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &c)
		}
	}
	targets := []any{
		m{"url": "https://chatgpt.com/cdn-cgi/trace", "expected-status": "200", "content-type": "text/plain",
			"body-regex": `(?m)^loc=[A-Z]{2}$`, "body-not-regex": "(?m)^loc=(" + strings.Join(never, "|") + ")$"},
		m{"url": "https://api.openai.com/v1/models", "expected-status": "401", "content-type": "application/json",
			"body-not-regex": "(?i)unsupported_country"},
	}
	t := orderedNode(targets)
	t.Style = 0
	for _, it := range t.Content {
		it.Style = 0
	}
	ad.Content = append(ad.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "targets"}, t)
	return ad
}

var tailntRule = regexp.MustCompile(`(?i)^(DOMAIN|DOMAIN-SUFFIX),(headscale|keycloak)\.tailnt\.ru,`)

// buildRouting returns config.yaml with the routing block regenerated.
func buildRouting(original []byte, s routingSettings) ([]byte, error) {
	doc, root, err := yamlRoot(original)
	if err != nil {
		return nil, err
	}
	providers := yamlGet(root, "proxy-providers")
	if providers == nil || providers.Kind != yaml.MappingNode {
		return nil, errors.New("в config.yaml нет proxy-providers")
	}
	base := mapGet(providers, s.Base)
	if base == nil {
		return nil, fmt.Errorf("подписки %q нет в proxy-providers", s.Base)
	}

	// providers: AI always, CHAIN with the cascade
	setKey := func(parent *yaml.Node, key string, value *yaml.Node) {
		for i := 0; i+1 < len(parent.Content); i += 2 {
			if parent.Content[i].Value == key {
				if value == nil {
					parent.Content = append(parent.Content[:i], parent.Content[i+2:]...)
				} else {
					parent.Content[i+1] = value
				}
				return
			}
		}
		if value != nil {
			parent.Content = append(parent.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
		}
	}
	aiNode, err := providerNode(base, routingAIProvider, s)
	if err != nil {
		return nil, err
	}
	setKey(providers, routingAIProvider, aiNode)
	if s.Cascade {
		chain, err := providerNode(base, routingChainProvider, s)
		if err != nil {
			return nil, err
		}
		setKey(providers, routingChainProvider, chain)
	} else {
		setKey(providers, routingChainProvider, nil)
	}

	// groups: keep the ones HomeNet does not generate
	oldGroups := yamlGet(root, "proxy-groups")
	kept := []*yaml.Node{}
	keptNames := map[string]bool{}
	usedProviders := map[string]bool{}
	if oldGroups != nil && oldGroups.Kind == yaml.SequenceNode {
		for _, g := range oldGroups.Content {
			name := scalar(mapGet(g, "name"))
			if routingManaged[name] {
				continue
			}
			g.HeadComment = ""
			kept = append(kept, g)
			keptNames[name] = true
			if u := mapGet(g, "use"); u != nil {
				for _, x := range u.Content {
					usedProviders[x.Value] = true
				}
			}
		}
	}
	reserve := []string{}
	for i := 0; i+1 < len(providers.Content); i += 2 {
		name := providers.Content[i].Value
		if name == s.Base || name == routingAIProvider || name == routingChainProvider || usedProviders[name] {
			continue
		}
		reserve = append(reserve, name)
	}
	// RU nodes are checked by a RU address; keep the one already configured.
	ruURL := s.RUCheck
	if oldGroups != nil {
		for _, g := range oldGroups.Content {
			if scalar(mapGet(g, "name")) == "RU" {
				if u := scalar(mapGet(g, "url")); u != "" {
					ruURL = u
				}
			}
		}
	}
	head, tail := routingGroups(s, reserve, ruURL, nil, keptNames["OLCRTC"], keptNames["Tailscale"])
	seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	for _, g := range head {
		seq.Content = append(seq.Content, orderedNode(g))
	}
	seq.Content = append(seq.Content, kept...)
	for _, g := range tail {
		seq.Content = append(seq.Content, orderedNode(g))
	}
	seq.Content[0].HeadComment = routingMarker
	// proxies of groups in flow style, everything else block
	for _, g := range seq.Content {
		for i := 0; i+1 < len(g.Content); i += 2 {
			if g.Content[i+1].Kind == yaml.SequenceNode && len(g.Content[i+1].Content) > 8 {
				g.Content[i+1].Style = yaml.FlowStyle
			}
		}
	}
	yamlSet(root, "proxy-groups", seq)

	// rules: the two Tailnt rules right after the private-network one
	rules := yamlGet(root, "rules")
	if rules != nil && rules.Kind == yaml.SequenceNode {
		out := []*yaml.Node{}
		at := -1
		for _, r := range rules.Content {
			if tailntRule.MatchString(r.Value) {
				continue
			}
			out = append(out, r)
			if at < 0 && strings.HasPrefix(strings.ToUpper(r.Value), "GEOIP,PRIVATE,") {
				at = len(out)
			}
		}
		if at < 0 {
			at = 0
		}
		add := []*yaml.Node{
			{Kind: yaml.ScalarNode, Tag: "!!str", Value: "DOMAIN,headscale.tailnt.ru,Headscale", HeadComment: "Вход Tailnt для Tailscale: свои группы с проверкой (HomeNet)"},
			{Kind: yaml.ScalarNode, Tag: "!!str", Value: "DOMAIN,keycloak.tailnt.ru,Keycloak"},
		}
		rules.Content = append(append(append([]*yaml.Node{}, out[:at]...), add...), out[at:]...)
	}
	return encodeYAML(doc)
}

/* ---------- validator detail ---------- */

var (
	validatorURL    = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.-]*://[^\s"']+`)
	validatorSecret = regexp.MustCompile(`(?i)(password|uuid|private-key|token|secret|auth|key)[=:]\s*\S+`)
	validatorMsg    = regexp.MustCompile(`msg="((?:[^"\\]|\\.)*)"`)
)

// sanitizeValidator keeps the reason mihomo gives, without addresses or
// credentials that may appear in it.
func sanitizeValidator(out []byte) string {
	lines := strings.Split(string(out), "\n")
	reason := ""
	for _, l := range lines {
		if strings.Contains(l, "level=error") || strings.Contains(l, "level=fatal") || strings.Contains(strings.ToLower(l), "test failed") {
			if mm := validatorMsg.FindStringSubmatch(l); mm != nil {
				reason = mm[1]
			} else {
				reason = l
			}
		}
	}
	if reason == "" {
		for i := len(lines) - 1; i >= 0; i-- {
			if t := strings.TrimSpace(lines[i]); t != "" {
				reason = t
				break
			}
		}
	}
	reason = validatorURL.ReplaceAllString(reason, "<адрес>")
	reason = validatorSecret.ReplaceAllString(reason, "$1=***")
	if r := []rune(reason); len(r) > 400 {
		reason = string(r[:400]) + "…"
	}
	return reason
}

/* ---------- handlers ---------- */

func (a *app) handleRoutingGet(w http.ResponseWriter) {
	s, saved := loadRouting()
	res := response{"ok": true, "settings": s, "defaults": defaultRouting(), "saved": saved}
	if cs, err := coreSettings(); err == nil {
		if _, body, err := readActiveConfig(cs); err == nil {
			res["sha"] = configSHA(body)
			if _, root, err := yamlRoot(body); err == nil {
				names := []string{}
				if p := yamlGet(root, "proxy-providers"); p != nil {
					for i := 0; i+1 < len(p.Content); i += 2 {
						names = append(names, p.Content[i].Value)
					}
				}
				res["providers"] = names
				managed := false
				if g := yamlGet(root, "proxy-groups"); g != nil && len(g.Content) > 0 {
					managed = strings.Contains(g.Content[0].HeadComment, "HomeNet")
				}
				res["managed"] = managed
			}
		}
	}
	a.writeJSON(w, http.StatusOK, res)
}

func (a *app) handleRoutingWrite(w http.ResponseWriter, r *http.Request, apply bool) {
	var req struct {
		SHA      string          `json:"sha"`
		Settings routingSettings `json:"settings"`
	}
	if !a.decodeJSON(w, r, &req) {
		return
	}
	if err := req.Settings.normalize(); err != nil {
		a.writeJSON(w, http.StatusUnprocessableEntity, response{"ok": false, "error": err.Error()})
		return
	}
	coreConfigMu.Lock()
	defer coreConfigMu.Unlock()
	s, err := coreSettings()
	if err != nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": err.Error()})
		return
	}
	target, original, err := readActiveConfig(s)
	if err != nil {
		a.writeJSON(w, http.StatusNotFound, response{"ok": false, "error": err.Error()})
		return
	}
	if req.SHA != configSHA(original) {
		a.writeJSON(w, http.StatusConflict, response{"ok": false, "error": "config.yaml изменился с момента загрузки; обновите страницу и повторите", "sha": configSHA(original)})
		return
	}
	candidate, err := buildRouting(original, req.Settings)
	if err != nil {
		a.writeJSON(w, http.StatusUnprocessableEntity, response{"ok": false, "error": err.Error()})
		return
	}
	changes := diffConfig(original, candidate)
	masked, _, _ := maskConfig(candidate)
	if _, err := os.Stat(s.binary); err != nil {
		a.writeJSON(w, http.StatusFailedDependency, response{"ok": false, "changes": changes, "error": "бинарник mihomo не найден (" + s.binary + "): проверить конфиг нечем"})
		return
	}
	if !apply {
		staged, err := mihomoPrivateFile(filepath.Dir(target), ".homenet-staged-*.yaml", candidate)
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		defer os.Remove(staged)
		if detail := mihomoValidateDetail(s, staged); detail != "" {
			a.writeJSON(w, http.StatusOK, response{"ok": true, "valid": false, "changes": changes, "yaml": string(masked), "detail": detail, "message": "mihomo -t отклонил конфигурацию"})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "valid": true, "changes": changes, "yaml": string(masked), "message": "mihomo -t: конфигурация корректна"})
		return
	}
	if len(changes) == 0 {
		if err := saveRouting(req.Settings); err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "applied": false, "changes": changes, "message": "Конфиг уже соответствует настройкам; настройки сохранены"})
		return
	}
	backup, err := mihomoSwapConfig(s, target, original, candidate, "config", mihomoValidateCandidate, mihomoReload)
	if err != nil {
		a.writeJSON(w, http.StatusOK, response{"ok": false, "changes": changes, "error": err.Error()})
		return
	}
	if err := saveRouting(req.Settings); err != nil {
		a.writeJSON(w, http.StatusOK, response{"ok": true, "applied": true, "warning": "конфиг применён, но настройки не сохранились: " + err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true, "applied": true, "changes": changes, "backup": filepath.Base(backup), "sha": configSHA(candidate),
		"message": fmt.Sprintf("Маршрутизация применена: %d изменений; копия %s", len(changes), filepath.Base(backup))})
}
