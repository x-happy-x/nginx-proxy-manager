package main

// The VPN worker owns Mihomo's config/controller. Proxy receives only the
// loopback SOCKS address and public node names through Core's private contract.
import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type publicVPNRequest struct {
	ID   string `json:"id"`
	Node string `json:"node,omitempty"`
}
type publicVPNStatus struct {
	OK         bool     `json:"ok"`
	Error      string   `json:"error,omitempty"`
	Group      string   `json:"group"`
	SOCKS      string   `json:"socks"`
	Selected   string   `json:"selected"`
	Candidates []string `json:"candidates"`
}
type publicVPNNode struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Now     string   `json:"now"`
	All     []string `json:"all"`
	Alive   bool     `json:"alive"`
	History []struct {
		Time  time.Time `json:"time"`
		Delay int       `json:"delay"`
	} `json:"history"`
}

func publicVPNGroup(id string) string  { return "HomeNet VPS " + id }
func publicVPNMarker(id string) string { return "HomeNet public VPN: " + id }

func publicVPNController(ctx context.Context, s mihomoSettings, method, path string, body any, out any) error {
	var input io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		input = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, s.controller+path, input)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if s.secret != "" {
		req.Header.Set("Authorization", "Bearer "+s.secret)
	}
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("Mihomo controller unavailable: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("Mihomo controller HTTP %d", res.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
	}
	return nil
}

func publicVPNConfig(original []byte, id string) ([]byte, int, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(original, &doc); err != nil {
		return nil, 0, err
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, 0, fmt.Errorf("Mihomo config must be a mapping")
	}
	root := doc.Content[0]
	groupName, listenerName := publicVPNGroup(id), "homenet-vps-"+id
	groups := mihomoYAMLField(root, "proxy-groups")
	if groups == nil {
		groups = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		yamlSet(root, "proxy-groups", groups)
	}
	if groups.Kind != yaml.SequenceNode {
		return nil, 0, fmt.Errorf("proxy-groups must be a list")
	}
	groupExists := false
	initial := ""
	for _, g := range groups.Content {
		name := scalar(mapGet(g, "name"))
		if name == "Обходы" {
			initial = name
		}
		if initial == "" && name == "AUTO" {
			initial = name
		}
		if name == groupName {
			if strings.TrimSpace(strings.TrimPrefix(g.HeadComment, "#")) != publicVPNMarker(id) || scalar(mapGet(g, "type")) != "select" {
				return nil, 0, fmt.Errorf("group %s is not owned by HomeNet", groupName)
			}
			groupExists = true
		}
	}
	listeners := mihomoYAMLField(root, "listeners")
	if listeners == nil {
		listeners = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		yamlSet(root, "listeners", listeners)
	}
	if listeners.Kind != yaml.SequenceNode {
		return nil, 0, fmt.Errorf("listeners must be a list")
	}
	port := 0
	used := map[int]bool{}
	for _, l := range listeners.Content {
		n, _ := strconv.Atoi(scalar(mapGet(l, "port")))
		used[n] = true
		if scalar(mapGet(l, "name")) == listenerName {
			if strings.TrimSpace(strings.TrimPrefix(l.HeadComment, "#")) != publicVPNMarker(id) || scalar(mapGet(l, "listen")) != "127.0.0.1" || scalar(mapGet(l, "proxy")) != groupName || scalar(mapGet(l, "type")) != "socks" || n < 33000 || n > 33999 {
				return nil, 0, fmt.Errorf("listener %s is not owned by HomeNet", listenerName)
			}
			port = n
		}
	}
	if port == 0 {
		h := fnv.New32a()
		_, _ = h.Write([]byte(id))
		start := int(h.Sum32() % 1000)
		for offset := 0; offset < 1000; offset++ {
			n := 33000 + (start+offset)%1000
			if used[n] {
				continue
			}
			ln, e := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(n)))
			if e != nil {
				continue
			}
			ln.Close()
			port = n
			break
		}
		if port == 0 {
			return nil, 0, fmt.Errorf("no free loopback SOCKS port")
		}
		l := orderedNode(m{"name": listenerName, "type": "socks", "listen": "127.0.0.1", "port": port, "proxy": groupName, "udp": false})
		l.HeadComment = publicVPNMarker(id)
		listeners.Content = append(listeners.Content, l)
	}
	if !groupExists {
		providers := []any{}
		if p := mihomoYAMLField(root, "proxy-providers"); p != nil && p.Kind == yaml.MappingNode {
			for i := 0; i < len(p.Content); i += 2 {
				providers = append(providers, p.Content[i].Value)
			}
		}
		members := []any{}
		if initial != "" {
			members = append(members, initial)
		}
		if raw := mihomoYAMLField(root, "proxies"); raw != nil {
			for _, p := range raw.Content {
				if name := scalar(mapGet(p, "name")); name != "" {
					members = append(members, name)
				}
			}
		}
		if len(members) == 0 && len(providers) == 0 {
			return nil, 0, fmt.Errorf("no VPN proxies configured")
		}
		group := orderedNode(m{"name": groupName, "type": "select", "proxies": members, "use": providers, "hidden": false})
		group.HeadComment = publicVPNMarker(id)
		groups.Content = append(groups.Content, group)
	}
	if groupExists && port != 0 {
		// YAML encode only when a listener/group was added; an ordinary status
		// check must never rewrite the config or reload existing VPN sessions.
		var prior yaml.Node
		_ = yaml.Unmarshal(original, &prior)
		oldListeners := mihomoYAMLField(prior.Content[0], "listeners")
		if oldListeners != nil {
			for _, l := range oldListeners.Content {
				if scalar(mapGet(l, "name")) == listenerName {
					return original, port, nil
				}
			}
		}
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return nil, 0, err
	}
	return buf.Bytes(), port, nil
}

func publicVPNCandidates(nodes map[string]publicVPNNode, members []string, now time.Time) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, name := range members {
		n, ok := nodes[name]
		if !ok || seen[name] || len(n.All) > 0 || name == "DIRECT" || name == "REJECT" || name == "REJECT-DROP" || strings.EqualFold(n.Type, "pass") {
			continue
		}
		switch strings.ToLower(n.Type) {
		case "direct", "reject", "rejectdrop", "compatible", "dns", "tailscale":
			continue
		}
		fresh := false
		for _, h := range n.History {
			if h.Delay > 0 && now.Sub(h.Time) >= 0 && now.Sub(h.Time) < 10*time.Minute {
				fresh = true
			}
		}
		if !n.Alive || !fresh {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	sort.Strings(out)
	// Reuse existing successful path choices first; never trigger healthchecks
	// of whole subscriptions just to sort the recovery candidates.
	ordered := []string{}
	available := map[string]bool{}
	for _, name := range out {
		available[name] = true
	}
	for _, start := range []string{"Обходы", "AUTO", "RU"} {
		name := start
		for depth := 0; depth < 8; depth++ {
			n, ok := nodes[name]
			if !ok {
				break
			}
			if n.Now == "" {
				break
			}
			name = n.Now
		}
		if available[name] {
			ordered = append(ordered, name)
			delete(available, name)
		}
	}
	for _, name := range out {
		if available[name] {
			ordered = append(ordered, name)
		}
	}
	return ordered
}

func (a *app) handlePublicVPN(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		a.writeJSON(w, 405, response{"error": "method not allowed"})
		return
	}
	var req publicVPNRequest
	if err := decodePCJSON(w, r, &req); err != nil || !pvhIDRe.MatchString(req.ID) || len(req.ID) > 16 {
		a.writeJSON(w, 400, response{"error": "invalid public server ID"})
		return
	}
	coreConfigMu.Lock()
	defer coreConfigMu.Unlock()
	if err := vpnDNSPending(""); err != nil {
		a.writeJSON(w, 409, response{"error": err.Error()})
		return
	}
	s, err := coreSettings()
	if err != nil {
		a.writeJSON(w, 503, response{"error": err.Error()})
		return
	}
	path, original, err := readActiveConfig(s)
	if err != nil {
		a.writeJSON(w, 503, response{"error": err.Error()})
		return
	}
	candidate, port, err := publicVPNConfig(original, req.ID)
	if err != nil {
		a.writeJSON(w, 409, response{"error": err.Error()})
		return
	}
	action := strings.TrimPrefix(r.URL.Path, "/internal/public-vpn/")
	if !bytes.Equal(original, candidate) {
		if action != "ensure" {
			a.writeJSON(w, 409, response{"error": "dedicated VPN group is not configured"})
			return
		}
		if _, err = mihomoSwapConfig(s, path, original, candidate, "public-vpn", mihomoValidateCandidate, mihomoReload); err != nil {
			a.writeJSON(w, 409, response{"error": err.Error()})
			return
		}
	}
	var proxies struct {
		Proxies map[string]publicVPNNode `json:"proxies"`
	}
	if err = publicVPNController(r.Context(), s, "GET", "/proxies", nil, &proxies); err != nil {
		a.writeJSON(w, 503, response{"error": err.Error()})
		return
	}
	var providers struct {
		Providers map[string]struct {
			Proxies []publicVPNNode `json:"proxies"`
		} `json:"providers"`
	}
	if err = publicVPNController(r.Context(), s, "GET", "/providers/proxies", nil, &providers); err != nil {
		a.writeJSON(w, 503, response{"error": err.Error()})
		return
	}
	for _, provider := range providers.Providers {
		for _, node := range provider.Proxies {
			if node.Name != "" {
				proxies.Proxies[node.Name] = node
			}
		}
	}
	group := publicVPNGroup(req.ID)
	g, exists := proxies.Proxies[group]
	if !exists {
		a.writeJSON(w, 503, response{"error": "dedicated VPN group not loaded"})
		return
	}
	candidates := publicVPNCandidates(proxies.Proxies, g.All, time.Now())
	if action == "select" {
		allowed := false
		for _, name := range candidates {
			allowed = allowed || req.Node == name
		}
		if !allowed {
			a.writeJSON(w, 409, response{"error": "VPN node has no fresh successful availability check"})
			return
		}
		if err = publicVPNController(r.Context(), s, "PUT", "/proxies/"+url.PathEscape(group), response{"name": req.Node}, nil); err != nil {
			a.writeJSON(w, 503, response{"error": err.Error()})
			return
		}
		g.Now = req.Node
	}
	a.writeJSON(w, 200, publicVPNStatus{OK: true, Group: group, SOCKS: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), Selected: g.Now, Candidates: candidates})
}
