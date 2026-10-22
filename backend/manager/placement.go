package main

// NPM-84: where applications run. The Proxmox worker answers which server and
// guest owns an address; the computer worker answers which container publishes
// a port. Core's portal joins both with the launcher's upstream addresses.
// Both answers come from memory, like the widget endpoints.

import (
	"bufio"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// readARP maps MAC → IPv4 from the router's neighbour table: a fallback for
// guests without a guest agent, which only report their MAC addresses.
func readARP() map[string]string {
	f, err := os.Open(getenv("PLACEMENT_ARP", "/proc/net/arp"))
	if err != nil {
		return nil
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		// IP address, HW type, Flags, HW address, Mask, Device; flags 0x0 is an incomplete entry
		if len(fields) < 4 || net.ParseIP(fields[0]) == nil || fields[2] == "0x0" {
			continue
		}
		out[strings.ToLower(fields[3])] = fields[0]
	}
	return out
}

func (m *pvhMonitor) placement(arp map[string]string) response {
	m.mu.Lock()
	defer m.mu.Unlock()
	nodes, machines := []response{}, []response{}
	for _, h := range m.hosts {
		nodes = append(nodes, response{"server": h.Config.ID, "server_name": h.Config.Name, "ip": h.Config.Address, "online": h.Online})
		if h.Parsed == nil {
			continue
		}
		for _, g := range h.Parsed.Guests {
			if g.Template {
				continue
			}
			ips := append([]string{}, g.IPs...)
			if len(ips) == 0 {
				for _, mac := range g.MACs {
					if ip := arp[strings.ToLower(mac)]; ip != "" {
						ips = append(ips, ip)
					}
				}
			}
			machines = append(machines, response{"server": h.Config.ID, "server_name": h.Config.Name, "vmid": g.VMID, "name": g.Name,
				"type": g.Type, "status": g.Status, "ips": ips, "stale": !h.Online})
		}
	}
	return response{"nodes": nodes, "machines": machines}
}

type publishedPort struct {
	IP     string `json:"ip"` // "" when published on every address
	Port   int    `json:"port"`
	Target string `json:"target"`
}

var dockerPortRE = regexp.MustCompile(`^(?:\[?([0-9a-fA-F:.]*)\]?:)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?/(tcp|udp)$`)

// parseDockerPorts reads `docker ps` Ports text: "0.0.0.0:4161->4161/tcp, [::]:4161->4161/tcp, 80/tcp".
// Unpublished ports are skipped; the IPv4 and IPv6 forms of one port are reported once.
func parseDockerPorts(text string) []publishedPort {
	seen := map[string]bool{}
	out := []publishedPort{}
	for _, part := range strings.Split(text, ",") {
		mt := dockerPortRE.FindStringSubmatch(strings.TrimSpace(part))
		if mt == nil || mt[6] != "tcp" {
			continue
		}
		ip := mt[1]
		if ip == "0.0.0.0" || ip == "::" {
			ip = ""
		}
		from, _ := strconv.Atoi(mt[2])
		to := from
		if mt[3] != "" {
			to, _ = strconv.Atoi(mt[3])
		}
		target, _ := strconv.Atoi(mt[4])
		for port := from; port <= to && port-from < 64; port++ {
			key := ip + ":" + strconv.Itoa(port)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, publishedPort{IP: ip, Port: port, Target: strconv.Itoa(target+port-from) + "/tcp"})
		}
	}
	return out
}

func (m *pcMonitor) placement() response {
	m.mu.Lock()
	defer m.mu.Unlock()
	hosts, containers := []response{}, []response{}
	for _, h := range m.hosts {
		hosts = append(hosts, response{"id": h.Config.ID, "name": h.Config.Name, "ip": h.Config.Address, "online": h.Online})
		if h.Current == nil {
			continue
		}
		for _, d := range h.Current.Docker {
			for _, c := range d.Containers {
				containers = append(containers, response{"host": h.Config.ID, "host_name": h.Config.Name, "ip": h.Config.Address,
					"context": d.Context, "id": shortID(c.ID), "name": c.Name, "image": c.Image, "state": c.State, "status": c.Status,
					"ports": parseDockerPorts(c.Ports), "stale": !h.Online})
			}
		}
	}
	sort.SliceStable(containers, func(i, j int) bool { return containers[i]["name"].(string) < containers[j]["name"].(string) })
	return response{"hosts": hosts, "containers": containers}
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}
