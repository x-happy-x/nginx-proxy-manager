package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const lmsListenerMarker = "HomeNet LMS egress"

// Only this administrative operation changes dedicated LMS listeners. The scoped
// service API is read-only and cannot provision or alter shared proxy groups.
type lmsProvisionRequest struct {
	Nodes  map[string]string `json:"nodes"`
	Listen string            `json:"listen"`
	Routes []struct {
		ID    string `json:"id"`
		Label string `json:"label"`
		Proxy string `json:"proxy"`
	} `json:"routes"`
}

func lmsListenerConfig(original []byte, registry lmsEgressRegistry) ([]byte, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(original, &doc); err != nil {
		return nil, fmt.Errorf("invalid Mihomo config")
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("Mihomo config must be a mapping")
	}
	root := doc.Content[0]
	listeners := mihomoYAMLField(root, "listeners")
	if listeners == nil {
		listeners = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		yamlSet(root, "listeners", listeners)
	}
	if listeners.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("listeners must be a list")
	}
	kept := []*yaml.Node{}
	ports := map[int]bool{}
	for _, listener := range listeners.Content {
		name := scalar(mapGet(listener, "name"))
		owned := strings.TrimSpace(strings.TrimPrefix(listener.HeadComment, "#")) == lmsListenerMarker
		if strings.HasPrefix(name, "homenet-lms-") && !owned {
			return nil, fmt.Errorf("LMS listener name collision")
		}
		if owned {
			continue
		}
		port, _ := strconv.Atoi(scalar(mapGet(listener, "port")))
		ports[port] = true
		kept = append(kept, listener)
	}
	for _, route := range registry.Routes {
		if ports[route.Port] {
			return nil, fmt.Errorf("LMS listener port collision")
		}
		ports[route.Port] = true
		listener := orderedNode(m{"name": "homenet-lms-" + route.ID, "type": "http", "listen": route.Listen, "port": route.Port, "proxy": route.Proxy,
			"users": []any{m{"username": route.Username, "password": route.Password}}})
		listener.HeadComment = lmsListenerMarker
		kept = append(kept, listener)
	}
	listeners.Content = kept
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&doc); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (a *app) provisionLMSEgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		a.writeJSON(w, 405, response{"error": "method not allowed"})
		return
	}
	var req lmsProvisionRequest
	if err := decodePCJSON(w, r, &req); err != nil || len(req.Routes) == 0 || len(req.Routes) > 24 || len(req.Nodes) == 0 || len(req.Nodes) > 32 {
		a.writeJSON(w, 400, response{"error": "invalid LMS routes"})
		return
	}
	ip := net.ParseIP(req.Listen)
	if ip == nil || !ip.IsPrivate() {
		a.writeJSON(w, 400, response{"error": "LMS listener must bind a private LAN IP"})
		return
	}
	for id, source := range req.Nodes {
		sourceIP := net.ParseIP(source)
		if !lmsRouteID.MatchString(id) || sourceIP == nil || !sourceIP.IsPrivate() {
			a.writeJSON(w, 400, response{"error": "invalid private LMS node"})
			return
		}
	}
	coreConfigMu.Lock()
	defer coreConfigMu.Unlock()
	if err := vpnDNSPending(""); err != nil {
		a.writeJSON(w, 409, response{"error": "network configuration transaction pending"})
		return
	}
	settings, err := coreSettings()
	if err != nil {
		a.writeJSON(w, 503, response{"error": "Mihomo unavailable"})
		return
	}
	var proxies struct {
		Proxies map[string]publicVPNNode `json:"proxies"`
	}
	if err = publicVPNController(r.Context(), settings, "GET", "/proxies", nil, &proxies); err != nil {
		a.writeJSON(w, 503, response{"error": "Proxy catalog unavailable"})
		return
	}
	previous, _ := lmsRegistry()
	prior := map[string]lmsEgressRoute{}
	used := map[int]bool{}
	for _, route := range previous.Routes {
		prior[route.ID] = route
		used[route.Port] = true
	}
	registry := lmsEgressRegistry{Nodes: req.Nodes, Routes: []lmsEgressRoute{}}
	seen := map[string]bool{}
	for _, route := range req.Routes {
		if !lmsRouteID.MatchString(route.ID) || seen[route.ID] || route.Label == "" || len(route.Label) > 160 {
			a.writeJSON(w, 400, response{"error": "invalid or duplicate route"})
			return
		}
		if _, ok := proxies.Proxies[route.Proxy]; !ok || route.Proxy == "REJECT" || route.Proxy == "REJECT-DROP" {
			a.writeJSON(w, 400, response{"error": "unknown or rejecting outbound"})
			return
		}
		seen[route.ID] = true
		item, exists := prior[route.ID]
		if !exists {
			port := 34000
			for used[port] && port < 35000 {
				port++
			}
			if port >= 35000 {
				a.writeJSON(w, 409, response{"error": "no free LMS ports"})
				return
			}
			used[port] = true
			secret := make([]byte, 32)
			if _, err = rand.Read(secret); err != nil {
				a.writeJSON(w, 500, response{"error": "credential generation failed"})
				return
			}
			item = lmsEgressRoute{ID: route.ID, Port: port, Username: "lms-" + route.ID, Password: base64.RawURLEncoding.EncodeToString(secret)}
		}
		item.Listen = req.Listen
		item.Label = route.Label
		item.Proxy = route.Proxy
		registry.Routes = append(registry.Routes, item)
	}
	active, original, err := readActiveConfig(settings)
	if err != nil {
		a.writeJSON(w, 503, response{"error": "Mihomo config unavailable"})
		return
	}
	candidate, err := lmsListenerConfig(original, registry)
	if err != nil {
		a.writeJSON(w, 409, response{"error": err.Error()})
		return
	}
	dir := coreStateDir()
	if err = os.MkdirAll(dir, 0700); err != nil {
		a.writeJSON(w, 500, response{"error": "registry unavailable"})
		return
	}
	tmp, err := os.CreateTemp(dir, ".lms-egress-*")
	if err != nil {
		a.writeJSON(w, 500, response{"error": "registry unavailable"})
		return
	}
	defer os.Remove(tmp.Name())
	tmp.Chmod(0600)
	err = json.NewEncoder(tmp).Encode(registry)
	if err == nil {
		err = tmp.Sync()
	}
	tmp.Close()
	if err != nil {
		a.writeJSON(w, 500, response{"error": "registry write failed"})
		return
	}
	if !bytes.Equal(original, candidate) {
		if _, err = mihomoSwapConfig(settings, active, original, candidate, "lms-egress", mihomoValidateCandidate, mihomoReload); err != nil {
			a.writeJSON(w, 409, response{"error": "Dedicated listeners validation/reload failed; original configuration preserved"})
			return
		}
	}
	if err = os.Rename(tmp.Name(), filepath.Join(dir, "lms-egress.json")); err != nil {
		_, _ = mihomoSwapConfig(settings, active, candidate, original, "lms-egress-rollback", mihomoValidateCandidate, mihomoReload)
		a.writeJSON(w, 500, response{"error": "Registry commit failed; configuration rollback requested"})
		return
	}
	a.writeJSON(w, 200, response{"ok": true, "routes": len(registry.Routes), "scope": "dedicated-download-listeners"})
}
