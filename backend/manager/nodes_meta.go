package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

/*
 * VPN → «Узлы» по серверам (NPM-48). mihomo's API does not say where a node
 * connects; the subscription files do. Only the address, port, protocol and
 * the TLS name (SNI) leave the router — never ids, keys or passwords.
 */

type nodeMeta struct {
	Provider string `json:"provider"`
	Type     string `json:"type"`
	Server   string `json:"server"`
	Port     int    `json:"port,omitempty"`
	SNI      string `json:"sni,omitempty"`
	Network  string `json:"network,omitempty"`
}

// nodeEntry reads one proxy mapping; prefix is the provider's
// override.additional-prefix, so names match the ones mihomo shows.
func nodeEntry(n *yaml.Node, provider, prefix string) (string, nodeMeta, bool) {
	if n == nil || n.Kind != yaml.MappingNode {
		return "", nodeMeta{}, false
	}
	name := scalar(mapGet(n, "name"))
	server := scalar(mapGet(n, "server"))
	if name == "" || server == "" {
		return "", nodeMeta{}, false
	}
	m := nodeMeta{Provider: provider, Type: scalar(mapGet(n, "type")), Server: server, Network: scalar(mapGet(n, "network"))}
	m.Port, _ = strconv.Atoi(scalar(mapGet(n, "port")))
	for _, key := range []string{"servername", "sni"} {
		if v := scalar(mapGet(n, key)); v != "" {
			m.SNI = v
			break
		}
	}
	return prefix + name, m, true
}

func readNodesMeta(configPath string, body []byte) (map[string]nodeMeta, error) {
	_, root, err := yamlRoot(body)
	if err != nil {
		return nil, err
	}
	out := map[string]nodeMeta{}
	if list := yamlGet(root, "proxies"); list != nil && list.Kind == yaml.SequenceNode {
		for _, p := range list.Content {
			if name, m, ok := nodeEntry(p, "", ""); ok {
				out[name] = m
			}
		}
	}
	providers := yamlGet(root, "proxy-providers")
	if providers == nil || providers.Kind != yaml.MappingNode {
		return out, nil
	}
	dir := filepath.Dir(configPath)
	for i := 0; i+1 < len(providers.Content); i += 2 {
		name, p := providers.Content[i].Value, providers.Content[i+1]
		path := scalar(mapGet(p, "path"))
		if path == "" {
			continue
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(dir, path)
		}
		// a provider file stays inside mihomo's directory
		if rel, err := filepath.Rel(dir, path); err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var doc yaml.Node
		if yaml.Unmarshal(raw, &doc) != nil || len(doc.Content) == 0 {
			continue
		}
		prefix := scalar(mapGet(mapGet(p, "override"), "additional-prefix"))
		list := mapGet(doc.Content[0], "proxies")
		if list == nil || list.Kind != yaml.SequenceNode {
			continue
		}
		for _, px := range list.Content {
			if n, m, ok := nodeEntry(px, name, prefix); ok {
				out[n] = m
			}
		}
	}
	return out, nil
}

func (a *app) handleNodesMeta(w http.ResponseWriter) {
	s, err := coreSettings()
	if err != nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": err.Error()})
		return
	}
	target, body, err := readActiveConfig(s)
	if err != nil {
		a.writeJSON(w, http.StatusNotFound, response{"ok": false, "error": err.Error()})
		return
	}
	nodes, err := readNodesMeta(target, body)
	if err != nil {
		a.writeJSON(w, http.StatusUnprocessableEntity, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true, "nodes": nodes})
}
