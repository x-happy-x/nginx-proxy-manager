package main

// NPM-84: where applications run. The Proxmox worker answers which server and
// guest owns an address; the computer worker answers which container publishes
// a port. Core's portal joins both with the launcher's upstream addresses.
// Both answers come from memory, like the widget endpoints.

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
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
		node := response{"server": h.Config.ID, "server_name": h.Config.Name, "ip": h.Config.Address, "online": h.Online}
		if h.Parsed != nil && h.Online {
			n := h.Parsed.Node
			node["cpu"], node["mem_used"], node["mem_total"], node["temp"] = n.CPU, n.Mem.Used, n.Mem.Total, n.CPUTemp
		}
		nodes = append(nodes, node)
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
		host := response{"id": h.Config.ID, "name": h.Config.Name, "ip": h.Config.Address, "online": h.Online}
		if h.Current != nil && h.Online {
			c := h.Current
			host["cpu"], host["mem_used"], host["mem_total"], host["logs"] = c.CPU.Percent, c.Memory.Used, c.Memory.Total, c.Capabilities.DockerLogs
		}
		hosts = append(hosts, host)
		if h.Current == nil {
			continue
		}
		for _, d := range h.Current.Docker {
			for _, c := range d.Containers {
				containers = append(containers, response{"host": h.Config.ID, "host_name": h.Config.Name, "ip": h.Config.Address,
					"context": d.Context, "id": c.ID, "name": c.Name, "image": c.Image, "state": c.State, "status": c.Status,
					"ports": parseDockerPorts(c.Ports), "stale": !h.Online})
			}
		}
	}
	sort.SliceStable(containers, func(i, j int) bool { return containers[i]["name"].(string) < containers[j]["name"].(string) })
	return response{"hosts": hosts, "containers": containers}
}

var logsContext = regexp.MustCompile(`^(native|wsl:[A-Za-z0-9._-]{1,64})$`)

// serveLogs asks a computer's agent for the tail of one container's log. It is
// read-only but may show secrets an app prints, so it stays behind the admin gateway.
func (m *pcMonitor) serveLogs(a *app, w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tail, _ := strconv.Atoi(q.Get("tail"))
	if tail == 0 {
		tail = 300
	}
	m.mu.Lock()
	h := m.find(q.Get("host"))
	var cfg pcHostConfig
	if h != nil {
		cfg = h.Config
	}
	m.mu.Unlock()
	if h == nil {
		a.writeJSON(w, 404, response{"ok": false, "error": "Компьютер не найден"})
		return
	}
	if !pcContainerID.MatchString(q.Get("id")) || !logsContext.MatchString(q.Get("context")) || tail < 1 || tail > 2000 {
		a.writeJSON(w, 400, response{"ok": false, "error": "Некорректный запрос логов"})
		return
	}
	b, _ := json.Marshal(map[string]any{"context": q.Get("context"), "id": q.Get("id"), "tail": tail})
	out, _, err := m.fetch(r.Context(), cfg, "logs "+base64.RawURLEncoding.EncodeToString(b), false)
	var reply struct {
		OK        bool   `json:"ok"`
		Error     string `json:"error"`
		Text      string `json:"text"`
		Truncated bool   `json:"truncated"`
	}
	if json.Unmarshal(out, &reply) != nil {
		msg := "Агент не ответил"
		if err != nil {
			msg = err.Error()
		}
		a.writeJSON(w, 502, response{"ok": false, "error": msg})
		return
	}
	if !reply.OK {
		if strings.Contains(reply.Error, "unsupported request") || strings.Contains(reply.Error, "disabled") {
			reply.Error = "Агент на этом компьютере не отдаёт логи: обновите его и установите с --allow-docker-logs"
		}
		a.writeJSON(w, 200, response{"ok": false, "error": reply.Error})
		return
	}
	a.writeJSON(w, 200, response{"ok": true, "text": reply.Text, "truncated": reply.Truncated})
}
