package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Topology for the network diagram: what is connected to what, and which
// stages a LAN request passes (DNS redirect, XKeen ipsets, mihomo groups,
// MikroTik, LTE operator). Assembled from the Keenetic RCI, iptables/ipset,
// the mihomo controller and the monitors' latest state.

type topoHost struct {
	Name   string `json:"name"`
	IP     string `json:"ip"`
	Link   string `json:"link"` // wifi | ethernet
	Mesh   bool   `json:"mesh,omitempty"`
	Bypass bool   `json:"bypass,omitempty"` // MAC in xkeen_deny_mac: never proxied
}

type topoSegment struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	IP          string     `json:"ip"`
	CIDR        string     `json:"cidr"`
	Active      int        `json:"active"`
	Hosts       []topoHost `json:"hosts"`
	DNSToMihomo bool       `json:"dns_to_mihomo"`
}

type topoGroup struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Now  string `json:"now"`
	Size int    `json:"size"`
}

func rciGet(path string, out any) error {
	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Get(strings.TrimRight(resources.rciURL, "/") + path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

func ipsetCount(name string) int {
	out, err := exec.Command("ipset", "list", "-t", name).Output()
	if err != nil {
		return -1
	}
	if m := regexp.MustCompile(`Number of entries: (\d+)`).FindSubmatch(out); m != nil {
		n, _ := strconv.Atoi(string(m[1]))
		return n
	}
	return 0
}

func ipsetMembers(name string) map[string]bool {
	out, _ := exec.Command("ipset", "list", name).Output()
	members := map[string]bool{}
	inMembers := false
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "Members:") {
			inMembers = true
			continue
		}
		if inMembers && strings.TrimSpace(line) != "" {
			members[strings.ToLower(strings.Fields(line)[0])] = true
		}
	}
	return members
}

// dnsRedirects lists bridges whose DNS (to the router) is redirected to mihomo.
func dnsRedirects() map[string]bool {
	out, _ := exec.Command("iptables", "-t", "nat", "-S", "PREROUTING").Output()
	res := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "--dport 53") || !strings.Contains(line, "REDIRECT") {
			continue
		}
		if m := regexp.MustCompile(`-i (\S+)`).FindStringSubmatch(line); m != nil {
			res[m[1]] = true
		}
	}
	return res
}

func maskBits(mask string) int {
	ip := net.ParseIP(mask).To4()
	if ip == nil {
		return 24
	}
	ones, _ := net.IPv4Mask(ip[0], ip[1], ip[2], ip[3]).Size()
	return ones
}

func (a *app) handleTopology(w http.ResponseWriter) {
	out := response{"ok": true}

	var version struct {
		Model string `json:"model"`
		Title string `json:"title"`
	}
	_ = rciGet("/show/version", &version)
	var ifaces map[string]struct {
		ID          string `json:"id"`
		Type        string `json:"type"`
		Description string `json:"description"`
		Address     string `json:"address"`
		Mask        string `json:"mask"`
		Link        string `json:"link"`
		State       string `json:"state"`
	}
	_ = rciGet("/show/interface", &ifaces)
	var hotspot struct {
		Host []struct {
			MAC       string `json:"mac"`
			IP        string `json:"ip"`
			Hostname  string `json:"hostname"`
			Name      string `json:"name"`
			Active    bool   `json:"active"`
			Backhaul  bool   `json:"mws-backhaul"`
			SSID      string `json:"ssid"`
			Interface struct {
				ID string `json:"id"`
			} `json:"interface"`
		} `json:"host"`
	}
	_ = rciGet("/show/ip/hotspot", &hotspot)

	denyMAC := ipsetMembers("xkeen_deny_mac")
	redirects := dnsRedirects()
	// Keenetic "BridgeN" is Linux "brN".
	linuxName := func(id string) string { return "br" + strings.TrimPrefix(id, "Bridge") }

	segments := []topoSegment{}
	wan := map[string]string{}
	for id, i := range ifaces {
		switch {
		case i.Type == "Bridge" && i.Address != "":
			segments = append(segments, topoSegment{
				ID: id, Name: firstNonEmpty(i.Description, id), IP: i.Address,
				CIDR: i.Address + "/" + strconv.Itoa(maskBits(i.Mask)), Hosts: []topoHost{},
				DNSToMihomo: redirects[linuxName(id)],
			})
		case i.ID == "GigabitEthernet1" || (strings.Contains(strings.ToLower(i.Description), "подключение") && i.Address != ""):
			wan = map[string]string{"id": id, "name": i.Description, "ip": i.Address, "link": i.Link}
		}
	}
	sort.Slice(segments, func(x, y int) bool { return segments[x].ID < segments[y].ID })
	meshIPs := map[string]bool{}
	resources.mu.Lock()
	mesh := append([]meshNode(nil), resources.mesh...)
	pve := resources.pveState
	hasPVE := resources.pve != nil
	resources.mu.Unlock()
	for _, n := range mesh {
		meshIPs[n.IP] = true
	}
	for _, h := range hotspot.Host {
		if !h.Active {
			continue
		}
		for i := range segments {
			if segments[i].ID != h.Interface.ID {
				continue
			}
			link := "ethernet"
			if h.SSID != "" {
				link = "wifi"
			}
			segments[i].Active++
			segments[i].Hosts = append(segments[i].Hosts, topoHost{
				Name: firstNonEmpty(h.Name, h.Hostname, h.MAC), IP: h.IP, Link: link,
				Mesh: h.Backhaul || meshIPs[h.IP], Bypass: denyMAC[strings.ToLower(h.MAC)],
			})
		}
	}
	for i := range segments {
		sort.Slice(segments[i].Hosts, func(x, y int) bool {
			a, b := net.ParseIP(segments[i].Hosts[x].IP).To4(), net.ParseIP(segments[i].Hosts[y].IP).To4()
			if a == nil || b == nil {
				return segments[i].Hosts[x].Name < segments[i].Hosts[y].Name
			}
			return string(a) < string(b)
		})
	}

	routes := []map[string]string{}
	if raw, err := exec.Command("ip", "-4", "route", "show").Output(); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			f := strings.Fields(line)
			if len(f) >= 3 && f[1] == "via" && f[0] != "default" {
				routes = append(routes, map[string]string{"dst": f[0], "via": f[2]})
			}
		}
	}
	out["keenetic"] = response{"model": version.Model, "firmware": version.Title, "wan": wan, "segments": segments, "routes": routes}
	out["mesh"] = mesh

	out["xkeen"] = response{
		"deny_mac":     len(denyMAC),
		"geo_exclude":  ipsetCount("geo_exclude"),
		"user_exclude": ipsetCount("user_exclude"),
		"ext_exclude":  ipsetCount("ext_exclude"),
	}

	mihomo := response{}
	var ver struct {
		Version string `json:"version"`
	}
	if err := mihomoGet("/version", &ver); err != nil {
		mihomo["error"] = err.Error()
	} else {
		mihomo["version"] = ver.Version
		var cfg struct {
			Mode string `json:"mode"`
		}
		_ = mihomoGet("/configs", &cfg)
		mihomo["mode"] = cfg.Mode
		var proxies struct {
			Proxies map[string]struct {
				Type string   `json:"type"`
				Now  string   `json:"now"`
				All  []string `json:"all"`
			} `json:"proxies"`
		}
		groups := []topoGroup{}
		if mihomoGet("/proxies", &proxies) == nil {
			for name, p := range proxies.Proxies {
				if p.All == nil || name == "GLOBAL" {
					continue
				}
				groups = append(groups, topoGroup{Name: name, Type: p.Type, Now: p.Now, Size: len(p.All)})
			}
		}
		sort.Slice(groups, func(i, j int) bool { return groups[i].Name < groups[j].Name })
		mihomo["groups"] = groups
		mihomo["nameservers"] = mihomoNameservers()
	}
	out["mihomo"] = mihomo

	netmon.mu.Lock()
	view := netmon.view
	netmon.mu.Unlock()
	out["mikrotik"] = view

	if hasPVE {
		host := ""
		if u, err := url.Parse(os.Getenv("PROXMOX_URL")); err == nil {
			host = u.Hostname()
		}
		running := 0
		for _, g := range pve.Guests {
			if g.Status == "running" {
				running++
			}
		}
		nodes := []string{}
		for _, n := range pve.Nodes {
			nodes = append(nodes, n.Node)
		}
		out["proxmox"] = response{"ip": host, "nodes": nodes, "guests_running": running, "guests": len(pve.Guests)}
	}
	a.writeJSON(w, http.StatusOK, out)
}

// mihomoNameservers reads dns.nameserver from the config (plain list items).
func mihomoNameservers() []string {
	raw, err := os.ReadFile(getenv("MIHOMO_CONFIG", "/opt/etc/mihomo/config.yaml"))
	if err != nil {
		return nil
	}
	var list []string
	inDNS, inNS := false, false
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "dns:"):
			inDNS = true
		case inDNS && line != "" && !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "#"):
			return list
		case inDNS && strings.HasPrefix(trimmed, "nameserver:"):
			inNS = true
		case inNS && strings.HasPrefix(trimmed, "- "):
			list = append(list, strings.Trim(strings.TrimPrefix(trimmed, "- "), `'"`))
		case inNS && trimmed != "":
			inNS = false
		}
	}
	return list
}
