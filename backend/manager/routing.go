package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

/*
 * Routing (NPM-34): HomeNet owns the proxy groups of config.yaml and builds
 * them from a few settings — which nodes are bypass ones (limited traffic),
 * the delay ceiling for direct ones, the countries for AI services, the check
 * addresses and the cascade. Rules and other sections stay the user's; only
 * the rules of the checked addresses are kept in place. Groups HomeNet does not know
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
	Cascade     bool     `json:"cascade"`
	AIServiceOK bool     `json:"ai_service_check"`
	// Addresses that must always open (a tailnet's control server, its
	// sign-in): each gets its own group DIRECT → RU → AUTO with a check of
	// its own and a rule for its domain (NPM-41). Kept in routing.json on the
	// router, never in the code.
	Access []accessCheck `json:"access"`
	// Add the adaptive check (network mode, real GET through each node) to
	// the base provider when it has none — a config that came with the
	// original XKeen (NPM-42). An existing block is never changed.
	BaseAdaptive bool `json:"base_adaptive"`
	// Telegram gets its own group, bypass servers first: they survive the
	// whitelist mode of the uplink (NPM-44).
	Telegram bool `json:"telegram"`
	// Devices that ask a public resolver (1.1.1.1, 8.8.8.8, Yandex) get the
	// answer from mihomo's own DNS instead of a trip through a node: a dead
	// node no longer takes the whole internet of such a device (NPM-46).
	DNSIntercept bool `json:"dns_intercept"`
	// Passive check of the fork (MIHOMO-8) on the groups of nodes: a node
	// through which connections get no answer sits out, a sign-in group takes
	// only nodes that passed its own check. Off — the core behaves as before.
	PassiveCheck bool `json:"passive_check"`
	// Torrents get a group of their own, switched by hand — direct, through
	// bypass nodes or any node of the base subscription (NPM-60). Public
	// trackers and the usual BitTorrent ports go there; TorrentDevices send
	// everything but the web there too.
	Torrents       bool     `json:"torrents"`
	TorrentDevices []string `json:"torrent_devices"`
	// set by the handler, not saved: the core takes exit-countries (fork 7+)
	coreExitCountries bool
}

type accessCheck struct {
	Name string `json:"name"`
	Host string `json:"host"`
	URL  string `json:"url"`
}

var euCountries = strings.Fields("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE EU GB CH NO IS")

func defaultRouting() routingSettings {
	return routingSettings{
		Base:         "ROUTER",
		Bypass:       []string{"обход", "white", "белые списки", "белый список", "whitelist", "4g", "lte", "мобильн", "mobile"},
		Junk:         []string{"[free]", "только tg"},
		FastMS:       800,
		EU:           append([]string{}, euCountries...),
		AI:           append(append([]string{}, euCountries...), strings.Fields("US CA JP KR SG AU KZ")...),
		Never:        strings.Fields("RU BY HK CN MO IR KP"),
		RUCheck:      "https://habr.com/ru/feed/",
		Access:       []accessCheck{},
		BaseAdaptive: true,
		Telegram:     true,
		DNSIntercept: true,
		PassiveCheck: true,
		Cascade:      true,
		AIServiceOK:  true,
	}
}

// Group names HomeNet generates; any other group in config.yaml is kept.
var routingManaged = map[string]bool{
	"Прямые EU": true, "Прямые мир": true, "Обходы": true, "RU": true, "Каскад": true, "Резерв": true,
	"Быстрые": true, "AUTO": true, "ИИ прямые": true, "ИИ обходы": true, "ALL": true, "ИИ": true, "РФ": true,
	"Игры": true, "Заблокированные сервисы": true, "Остальное": true,
	"Белые списки": true, "QUIC": true, "GLOBAL": true, "Telegram": true, "Подписки": true, routingTorrents: true,
	// replaced by the groups above (NPM-33)
	"EU": true, "Без белых списков": true,
}

const (
	routingChainProvider = "CHAIN"
	routingAIProvider    = "AI"
	routingCheck         = "https://www.gstatic.com/generate_204"
	routingCheck2        = "https://cp.cloudflare.com/generate_204"
	routingTelegramCheck = "https://api.telegram.org/"
	routingSubs          = "Подписки"
	// the whitelist-mode probe: a Yandex address the whitelist keeps (NPM-52)
	routingYandex204 = "api.browser.yandex.ru/generate_204"
	routingDNS       = "HomeNet DNS"
	routingTorrents  = "Торренты"
	// BitTorrent's usual ports: 6881-6999 of the classic clients, 51413 of Transmission
	routingTorrentPorts = "6881-6999/51413"
	routingMarker       = "HomeNet: маршрутизация (NPM-34). Группы ниже до «Игры» включительно\nсобирает HomeNet: правьте их в «VPN → Настройка → Маршрутизация»."
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
	if s.Base == "" {
		return errors.New("выберите основную подписку")
	}
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
	if !httpURL(s.RUCheck) {
		return errors.New("проверочный адрес «РФ»: нужен http(s)-адрес")
	}
	if s.Access == nil {
		s.Access = []accessCheck{}
	}
	devs := []string{}
	for _, d := range s.TorrentDevices {
		d = strings.TrimSpace(d)
		ip := net.ParseIP(d)
		if ip == nil || ip.To4() == nil || !ip.IsPrivate() {
			return fmt.Errorf("устройство для торрентов %q: нужен IPv4-адрес домашней сети", d)
		}
		if !slices.Contains(devs, ip.String()) {
			devs = append(devs, ip.String())
		}
	}
	s.TorrentDevices = devs
	seen := map[string]bool{}
	for i := range s.Access {
		a := &s.Access[i]
		a.Name, a.Host, a.URL = strings.TrimSpace(a.Name), strings.ToLower(strings.TrimSpace(a.Host)), strings.TrimSpace(a.URL)
		switch {
		case a.Name == "" || len([]rune(a.Name)) > 40 || strings.ContainsAny(a.Name, ",'\"\n"):
			return fmt.Errorf("проверяемый адрес %d: нужно короткое имя без запятых и кавычек", i+1)
		case routingManaged[a.Name] || seen[a.Name]:
			return fmt.Errorf("имя «%s» уже занято другой группой", a.Name)
		case !hostRE.MatchString(a.Host):
			return fmt.Errorf("«%s»: домен вида login.example.org", a.Name)
		case !httpURL(a.URL):
			return fmt.Errorf("«%s»: адрес проверки — http(s)-адрес", a.Name)
		}
		seen[a.Name] = true
	}
	return nil
}

var hostRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)

func httpURL(u string) bool {
	p, err := url.Parse(u)
	return err == nil && (p.Scheme == "https" || p.Scheme == "http") && p.Host != ""
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

// Timing (NPM-44). A check of a group tests every member, so groups over a
// whole subscription are checked rarely; the switch away from a dead node comes
// from max-failed-times: two failed connections trigger a check at once. Small
// groups of groups are cheap to check and are checked often.
func leafGroup(name string, timeout int, extra m) m {
	g := fallback(name, m{"interval": 600, "timeout": timeout, "max-failed-times": 2, "lazy": false})
	for k, v := range extra {
		g[k] = v
	}
	return g
}

func pathGroup(name string, proxies []any, extra m) m {
	g := fallback(name, m{"proxies": proxies, "interval": 120, "timeout": 5000, "max-failed-times": 2, "lazy": false})
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
	// Direct servers count only while they answer within FastMS; bypass ones
	// are slower by nature (600-1000 ms in the whitelist mode).
	head = append(head,
		leafGroup("Прямые EU", s.FastMS, m{"use": base, "filter": flagsRE(s.EU), "exclude-filter": or(bypass, junk)}),
		leafGroup("Прямые мир", s.FastMS, m{"use": base, "exclude-filter": or(bypass, junk, flagsRE(s.Never), flagsRE(s.EU))}),
		leafGroup("Обходы", 4000, m{"use": base, "filter": bypass, "exclude-filter": junk}),
		leafGroup("RU", 3000, m{"use": base, "filter": flag("RU"), "exclude-filter": or(bypass, junk), "url": ruURL, "expected-status": "200-399"}),
	)
	if junk == "" {
		delete(head[2], "exclude-filter")
	}
	cascade := []any{}
	if s.Cascade {
		cascade = []any{"Каскад"}
		head = append(head, leafGroup("Каскад", 8000, m{"use": []any{routingChainProvider}, "lazy": true}))
	}
	if len(reserve) > 0 {
		head = append(head, m{"name": "Резерв", "type": "select", "use": toAny(reserve)})
	}
	// AUTO takes the leaf groups directly: one level less to go stale (NPM-44).
	// It checks through the node each leaf picked, so a leaf without a fast
	// direct server drops out when that node does not answer.
	head = append(head,
		pathGroup("AUTO", append([]any{"Прямые EU", "Прямые мир", "Обходы"}, cascade...), m{"health-check-urls": []any{routingCheck2}}),
	)
	if s.aiByCountry() {
		// the base subscription's own nodes, by the exit country its adaptive
		// check saw: no copy of the provider, no second check (MIHOMO-8)
		countries := []any{}
		for _, c := range s.AI {
			if c != "EU" {
				countries = append(countries, c)
			}
		}
		direct := leafGroup("ИИ прямые", 5000, m{"use": base, "exclude-filter": or(bypass, junk), "exit-countries": countries})
		viaBypass := leafGroup("ИИ обходы", 5000, m{"use": base, "filter": bypass, "exit-countries": countries})
		if junk != "" {
			viaBypass["exclude-filter"] = junk
		}
		head = append(head, direct, viaBypass)
	} else {
		head = append(head,
			leafGroup("ИИ прямые", 5000, m{"use": []any{routingAIProvider}, "exclude-filter": bypass}),
			leafGroup("ИИ обходы", 5000, m{"use": []any{routingAIProvider}, "filter": bypass}),
		)
	}
	extras := []any{}
	if hasOLC {
		extras = append(extras, "OLCRTC")
	}
	if hasTS {
		extras = append(extras, "Tailscale")
	}
	all := []any{"AUTO", "Прямые EU", "Прямые мир", "Обходы", "RU"}
	if s.Cascade {
		all = append(all, "Каскад")
	}
	if len(reserve) > 0 {
		all = append(all, "Резерв")
	}
	// OLCRTC and Tailscale in ALL too: groups that go through ALL follow it (NPM-61)
	head = append(head, m{"name": "ALL", "type": "select", "proxies": append(append(all, extras...), "DIRECT"), "use": base})

	ai := append([]any{"ИИ прямые", "ИИ обходы"}, cascade...)
	pick := func(first ...any) []any {
		out := append([]any{}, first...)
		return out
	}
	blocked := pick("AUTO", "Прямые EU", "Прямые мир", "Обходы")
	blocked = append(append(append(blocked, cascade...), "ALL"), extras...)
	tail = append(tail,
		pathGroup("ИИ", ai, nil),
		// bypass servers exit in Russian clouds: RU sites outside the whitelist
		// open through them without a trip abroad
		pathGroup("РФ", []any{"DIRECT", "RU", "Обходы", "AUTO"}, m{"url": s.RUCheck, "expected-status": "200-399"}),
		// direct while the uplink is open; the gstatic check fails in the
		// whitelist mode, and direct UDP is closed there anyway
		pathGroup("Игры", []any{"DIRECT", "Обходы", "AUTO"}, nil),
	)
	if s.Torrents {
		// chosen by hand: direct first, any node of the base subscription below
		tail = append(tail, m{"name": routingTorrents, "type": "select", "proxies": append(append(append([]any{"DIRECT", "Обходы", "AUTO"}, cascade...), "ALL"), extras...), "use": base})
	}
	if s.Telegram {
		tail = append(tail, pathGroup("Telegram", append(append([]any{"Обходы"}, cascade...), "Прямые EU"), m{"url": routingTelegramCheck, "expected-status": "200-399"}))
	}
	tail = append(tail,
		m{"name": "Заблокированные сервисы", "type": "select", "proxies": append(append([]any{}, blocked...), "DIRECT", "REJECT")},
		m{"name": "Остальное", "type": "select", "proxies": append(append([]any{"AUTO", "DIRECT", "Прямые EU", "Прямые мир", "Обходы", "ALL"}, extras...), "REJECT")},
		m{"name": "Белые списки", "type": "select", "proxies": []any{"DIRECT", "AUTO", "Обходы", "ALL", "REJECT"}},
		m{"name": "QUIC", "type": "select", "proxies": []any{"REJECT", "DIRECT", "AUTO"}},
		m{"name": "GLOBAL", "type": "select", "proxies": append(append([]any{}, blocked...), "DIRECT", "REJECT")},
	)
	// Subscriptions download through their own path: direct, then bypass, so
	// an update never waits on the nodes it is meant to replace (NPM-44).
	tail = append(tail, pathGroup(routingSubs, append([]any{"DIRECT", "Обходы"}, cascade...), m{"interval": 600}))
	// Addresses that must always open: direct, then every bypass node, then
	// every cascade node, each checked by the address itself. A bypass node
	// that reaches gstatic may not reach the address (on 06.10 one of ten
	// reached the tailnet's servers), so the «Обходы» group's pick is no
	// answer here (NPM-44). RU servers and AUTO share the entry points of the
	// foreign ones and fall with them.
	accessUse, accessFilter := []any{s.Base}, bypass
	if s.Cascade {
		accessUse, accessFilter = append(accessUse, routingChainProvider), bypass+"|⛓"
	}
	for _, a := range s.Access {
		g := pathGroup(a.Name, []any{"DIRECT"}, m{"use": accessUse, "filter": accessFilter, "url": a.URL, "expected-status": "200-399", "interval": 300})
		if junk != "" {
			g["exclude-filter"] = junk
		}
		tail = append(tail, g)
	}
	// passive check on the groups whose members are nodes, never on groups
	// of groups: those would sit out a whole group for one node
	if s.PassiveCheck {
		nodeGroups := map[string]bool{"Прямые EU": true, "Прямые мир": true, "Обходы": true, "RU": true, "Каскад": true, "ИИ прямые": true, "ИИ обходы": true}
		for _, a := range s.Access {
			nodeGroups[a.Name] = true
		}
		for _, list := range [][]m{head, tail} {
			for _, g := range list {
				if name, _ := g["name"].(string); nodeGroups[name] {
					g["passive-check"] = true
				}
			}
		}
	}
	_ = between
	return head, tail
}

// aiByCountry: AI groups pick by exit country instead of a provider copy
// when the core can and the service check is on (buildRouting also needs the
// base subscription's adaptive check, the source of the country).
func (s routingSettings) aiByCountry() bool { return s.coreExitCountries && s.AIServiceOK }

// forkAtLeast: the core is the x-happy-x fork of at least this release.
func forkAtLeast(version string, n int) bool {
	i := strings.Index(version, "-fork.")
	if i < 0 {
		return false
	}
	rest := version[i+len("-fork."):]
	j := 0
	for j < len(rest) && rest[j] >= '0' && rest[j] <= '9' {
		j++
	}
	v, err := strconv.Atoi(rest[:j])
	return err == nil && v >= n
}

func toAny(in []string) []any {
	out := make([]any, len(in))
	for i, v := range in {
		out[i] = v
	}
	return out
}

// Key order for generated mappings, so the YAML reads like a hand-written one.
var routingKeyOrder = []string{"name", "type", "proxies", "use", "filter", "exclude-filter", "exit-countries", "url", "health-check-urls", "expected-status", "interval", "timeout", "max-failed-times", "passive-check", "lazy"}

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
	hc := m{"enable": true, "url": routingCheck, "expected-status": "204", "interval": routingProviderInterval}
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
		// With the service check the exit country is checked for real
		// (cdn-cgi/trace), so nodes without a country flag — bypass ones
		// marked 🇫🇲 — are candidates too; only the flags of unsupported
		// countries are dropped up front (NPM-39). Without the check the
		// flags are all there is.
		ex := flagsRE(s.Never)
		if junk != "" {
			ex = junk + "|" + ex
		}
		if s.AIServiceOK && mapGet(mapGet(base, "health-check"), "adaptive") != nil {
			delete(p, "filter")
		}
		p["exclude-filter"] = ex
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
	// the exit country must be one of the chosen ones ("EU" is a flag, not a country code)
	allowed := []string{}
	for _, c := range s.AI {
		if c != "EU" {
			allowed = append(allowed, c)
		}
	}
	ad := orderedNode(m{"enable": true, "depends-on": s.Base, "confirmations": 2, "concurrency": 2, "failure-threshold": 3, "recovery-threshold": 2})
	for _, key := range []string{"network-key", "direct-allowed", "direct-global"} {
		if v := mapGet(ba, key); v != nil {
			c := *v
			ad.Content = append(ad.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &c)
		}
	}
	targets := []any{
		m{"url": "https://chatgpt.com/cdn-cgi/trace", "expected-status": "200", "content-type": "text/plain",
			"body-regex": "(?m)^loc=(" + strings.Join(allowed, "|") + ")$"},
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

// The adaptive check this router's subscription uses: the network mode by
// direct probes, then a real GET through every node (MIHOMO-2..6).
const defaultAdaptiveYAML = `enable: true
network-key: uplink
confirmations: 2
concurrency: 4
direct-allowed:
  - url: https://api.browser.yandex.ru/generate_204
    expected-status: "204"
  - url: https://ya.ru
    expected-status: 200-399
direct-global:
  - url: https://www.gstatic.com/generate_204
    expected-status: "204"
  - url: https://cp.cloudflare.com/generate_204
    expected-status: "204"
targets:
  - url: https://www.google.com/
    expected-status: "200"
    min-bytes: 1024
  - url: https://www.cloudflare.com/cdn-cgi/trace
    expected-status: "200"
    min-bytes: 64
`

// ensureAdaptive adds health-check.adaptive to a provider without one and the
// health-check fields it needs; whatever is there already stays.
func ensureAdaptive(provider *yaml.Node) {
	if provider == nil || provider.Kind != yaml.MappingNode {
		return
	}
	hc := mapGet(provider, "health-check")
	if hc == nil || hc.Kind != yaml.MappingNode {
		hc = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		yamlSet(provider, "health-check", hc)
	}
	if mapGet(hc, "adaptive") != nil {
		return
	}
	for _, kv := range [][2]string{{"enable", "true"}, {"url", routingCheck}, {"expected-status", "204"}, {"interval", "300"}, {"timeout", "5000"}, {"lazy", "false"}} {
		if mapGet(hc, kv[0]) == nil {
			var v yaml.Node
			_ = yaml.Unmarshal([]byte(kv[1]), &v)
			node := v.Content[0]
			if kv[0] == "expected-status" {
				node = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: kv[1], Style: yaml.DoubleQuotedStyle}
			}
			yamlSet(hc, kv[0], node)
		}
	}
	// the check must run: a disabled one would leave the groups without data
	yamlSet(hc, "enable", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
	var ad yaml.Node
	_ = yaml.Unmarshal([]byte(defaultAdaptiveYAML), &ad)
	yamlSet(hc, "adaptive", ad.Content[0])
}

// A full check of a subscription took over 5 minutes with its 300 s interval:
// the nodes were checked without a pause, and the bypass servers dropped
// connections while it ran (NPM-44). Groups react to failures on their own.
const routingProviderInterval = 900

// tuneProviders makes the subscriptions download through the «Подписки» group
// and checks the base one no more often than routingProviderInterval. A proxy
// or a longer interval the user set stays.
func tuneProviders(providers *yaml.Node, base string) {
	for i := 0; i+1 < len(providers.Content); i += 2 {
		name, p := providers.Content[i].Value, providers.Content[i+1]
		if p.Kind != yaml.MappingNode || name == routingAIProvider || name == routingChainProvider {
			continue
		}
		if scalar(mapGet(p, "type")) == "http" && mapGet(p, "proxy") == nil {
			yamlSet(p, "proxy", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: routingSubs})
		}
		if name != base {
			continue
		}
		yandexWhitelistProbe(mapGet(mapGet(p, "health-check"), "adaptive"))
		if hc := mapGet(p, "health-check"); hc != nil && hc.Kind == yaml.MappingNode {
			var iv int
			if n := mapGet(hc, "interval"); n == nil || n.Decode(&iv) != nil || iv < routingProviderInterval {
				yamlSet(hc, "interval", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprint(routingProviderInterval)})
			}
		}
	}
}

// yandexWhitelistProbe puts Yandex's generate_204 first among the probes that
// tell the whitelist mode (NPM-52): one request, no redirect, no page; ya.ru
// and whatever else is there stay as fallbacks (any one answering is enough).
func yandexWhitelistProbe(adaptive *yaml.Node) {
	if adaptive == nil || adaptive.Kind != yaml.MappingNode {
		return
	}
	list := mapGet(adaptive, "direct-allowed")
	if list == nil || list.Kind != yaml.SequenceNode {
		return
	}
	for _, it := range list.Content {
		if strings.Contains(scalar(mapGet(it, "url")), routingYandex204) {
			return
		}
	}
	probe := orderedNode(m{"url": "https://" + routingYandex204, "expected-status": "204"})
	list.Content = append([]*yaml.Node{probe}, list.Content...)
}

// buildRouting returns config.yaml with the routing block regenerated.
func buildRouting(original []byte, s routingSettings) ([]byte, error) {
	doc, root, err := yamlRoot(original)
	if err != nil {
		return nil, err
	}
	accessNames := map[string]bool{}
	for _, x := range s.Access {
		accessNames[x.Name] = true
	}
	providers := yamlGet(root, "proxy-providers")
	if providers == nil || providers.Kind != yaml.MappingNode {
		return nil, errors.New("в config.yaml нет proxy-providers")
	}
	base := mapGet(providers, s.Base)
	if base == nil {
		return nil, fmt.Errorf("подписки %q нет в proxy-providers: выберите основную подписку во вкладке «Маршрутизация»", s.Base)
	}
	if s.BaseAdaptive {
		ensureAdaptive(base)
	}
	tuneProviders(providers, s.Base)

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
	// the country comes from the base subscription's adaptive trace
	if mapGet(mapGet(base, "health-check"), "adaptive") == nil {
		s.coreExitCountries = false
	}
	if s.aiByCountry() {
		setKey(providers, routingAIProvider, nil)
	} else {
		aiNode, err := providerNode(base, routingAIProvider, s)
		if err != nil {
			return nil, err
		}
		setKey(providers, routingAIProvider, aiNode)
	}
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
			if routingManaged[name] || accessNames[name] {
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

	// the dns outbound: added with the interception, removed without it
	proxies := yamlGet(root, "proxies")
	if proxies == nil || proxies.Kind != yaml.SequenceNode {
		proxies = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		if s.DNSIntercept {
			yamlSet(root, "proxies", proxies)
		}
	}
	keptProxies := []*yaml.Node{}
	for _, px := range proxies.Content {
		if scalar(mapGet(px, "name")) != routingDNS {
			keptProxies = append(keptProxies, px)
		}
	}
	if s.DNSIntercept {
		keptProxies = append([]*yaml.Node{orderedNode(m{"name": routingDNS, "type": "dns"})}, keptProxies...)
	}
	proxies.Content = keptProxies

	// rules: one per checked address, right after the private-network one,
	// then Telegram's own
	hosts := map[string]bool{}
	for _, a := range s.Access {
		hosts[a.Host] = true
	}
	rules := yamlGet(root, "rules")
	if rules != nil && rules.Kind == yaml.SequenceNode {
		out := []*yaml.Node{}
		at := -1
		for _, r := range rules.Content {
			if parts := strings.Split(r.Value, ","); len(parts) >= 3 && (strings.EqualFold(parts[0], "DOMAIN") || strings.EqualFold(parts[0], "DOMAIN-SUFFIX")) && hosts[strings.ToLower(strings.TrimSpace(parts[1]))] {
				continue
			}
			if parts := strings.Split(r.Value, ","); len(parts) >= 3 && strings.TrimSpace(parts[2]) == "Telegram" && strings.EqualFold(strings.TrimSpace(parts[1]), "telegram") {
				continue
			}
			if parts := strings.Split(r.Value, ","); len(parts) >= 3 && strings.TrimSpace(parts[2]) == routingDNS {
				continue
			}
			if strings.HasSuffix(strings.TrimSpace(r.Value), ","+routingTorrents) {
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
		add := []*yaml.Node{}
		// after the private-network rule, so a home DNS server keeps its queries
		if s.DNSIntercept {
			n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "DST-PORT,53," + routingDNS}
			n.HeadComment = "DNS устройств к публичным серверам отвечает DNS mihomo (HomeNet, «Маршрутизация»)"
			add = append(add, n)
		}
		for i, a := range s.Access {
			n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "DOMAIN," + a.Host + "," + a.Name}
			if i == 0 {
				n.HeadComment = "Проверяемые адреса: свои группы с проверкой (HomeNet, «Маршрутизация»)"
			}
			add = append(add, n)
		}
		if s.Torrents {
			for i, v := range torrentRules(s.TorrentDevices) {
				n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v}
				if i == 0 {
					n.HeadComment = "Торренты: своя группа, переключается вручную (HomeNet, «Маршрутизация»)"
				}
				add = append(add, n)
			}
		}
		if s.Telegram {
			n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "GEOSITE,telegram,Telegram"}
			n.HeadComment = "Telegram: своя группа, сначала обходы (HomeNet, «Маршрутизация»)"
			add = append(add, n, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "GEOIP,telegram,Telegram,no-resolve"})
		}
		rules.Content = append(append(append([]*yaml.Node{}, out[:at]...), add...), out[at:]...)
	}
	return encodeYAML(doc)
}

// torrentRules: public trackers, the usual ports, then each download device
// with everything but the web (its browser keeps its own routes).
func torrentRules(devices []string) []string {
	out := []string{"GEOSITE,category-public-tracker," + routingTorrents, "DST-PORT," + routingTorrentPorts + "," + routingTorrents}
	for _, d := range devices {
		out = append(out, "AND,((SRC-IP-CIDR,"+d+"/32),(NOT,((DST-PORT,80/443)))),"+routingTorrents)
	}
	return out
}

/* ---------- validator detail ---------- */

var (
	validatorURL    = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.-]*://[^\s"']+`)
	validatorSecret = regexp.MustCompile(`(?i)(password|uuid|private-key|token|secret|auth|key)[=:]\s*\S+`)
	validatorMsg    = regexp.MustCompile(`msg="((?:[^"\\]|\\.)*)"`)
	validatorPath   = regexp.MustCompile(`(?:[A-Za-z]:\\|/)[^\s"']*\.ya?ml`)
)

// sanitizeValidator keeps the reason mihomo gives, without addresses or
// credentials that may appear in it.
func sanitizeValidator(out []byte) string {
	lines := strings.Split(string(out), "\n")
	reason := ""
	// the first error is the cause; "test failed" only closes the run
	for _, l := range lines {
		if strings.Contains(l, "level=error") || strings.Contains(l, "level=fatal") {
			if mm := validatorMsg.FindStringSubmatch(l); mm != nil {
				reason = mm[1]
			} else {
				reason = l
			}
			break
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
	reason = validatorPath.ReplaceAllString(reason, "config.yaml")
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
				info := []map[string]any{}
				if p := yamlGet(root, "proxy-providers"); p != nil {
					for i := 0; i+1 < len(p.Content); i += 2 {
						name, node := p.Content[i].Value, p.Content[i+1]
						names = append(names, name)
						info = append(info, map[string]any{
							"name":     name,
							"type":     scalar(mapGet(node, "type")),
							"adaptive": mapGet(mapGet(node, "health-check"), "adaptive") != nil,
							"homenet":  name == routingAIProvider || name == routingChainProvider,
							// a service check that depends on another provider is no base
							"service": scalar(mapGet(mapGet(mapGet(node, "health-check"), "adaptive"), "depends-on")) != "",
						})
					}
				}
				res["providers"] = names
				res["provider_info"] = info
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
	// AI by exit country needs fork 7 (MIHOMO-8); an older core keeps the copy
	req.Settings.coreExitCountries = forkAtLeast(readCoreStatus().Version, 7)
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
