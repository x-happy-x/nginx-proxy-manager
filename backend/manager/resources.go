package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Router resource monitor: the manager runs on the router itself, so it reads
// /proc directly. Every sampleEvery it records system totals and per-app
// usage (processes rolled up into named groups) into a one-hour ring; the
// upstream MikroTik is read from Netping's /api/router.

const (
	sampleEvery   = 5 * time.Second
	historyLength = 720 // one hour
	clockTicks    = 100 // USER_HZ on Linux/arm64
)

type appUsage struct {
	CPU float64 `json:"cpu"` // % of the whole machine (all cores)
	RSS int64   `json:"rss"` // bytes
}

type resourceSample struct {
	T        int64               `json:"t"`
	CPU      float64             `json:"cpu"`
	MemUsed  int64               `json:"mem"`
	SwapUsed int64               `json:"swap"`
	Temp     float64             `json:"temp"`
	RxBps    float64             `json:"rx"`
	TxBps    float64             `json:"tx"`
	Conns    int                 `json:"conns"`
	Apps     map[string]appUsage `json:"apps"`
}

type mikrotikSample struct {
	T     int64   `json:"t"`
	CPU   float64 `json:"cpu"`
	Mem   int64   `json:"mem"`
	RxBps float64 `json:"rx"`
	TxBps float64 `json:"tx"`
	RSRP  float64 `json:"rsrp"`
	SINR  float64 `json:"sinr"`
}

type procInfo struct {
	pid, ppid int
	comm      string
	cmdline   string
	ticks     uint64
	rss       int64
	group     string
}

type appGroup struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Kind  string   `json:"kind"` // app | system
	CPU   float64  `json:"cpu"`
	RSS   int64    `json:"rss"`
	Procs int      `json:"procs"`
	PIDs  []int    `json:"pids"`
	Ports []int    `json:"ports"`
	Exe   string   `json:"exe,omitempty"`
	Top   []string `json:"top,omitempty"`
}

type topProcess struct {
	PID   int     `json:"pid"`
	Name  string  `json:"name"`
	Group string  `json:"group"`
	CPU   float64 `json:"cpu"`
	RSS   int64   `json:"rss"`
}

type thermalZone struct {
	Name string  `json:"name"`
	Temp float64 `json:"temp"`
}

type diskUsage struct {
	Path  string `json:"path"`
	Total int64  `json:"total"`
	Free  int64  `json:"free"`
}

type netIface struct {
	Name    string  `json:"name"`
	RxBytes int64   `json:"rx_bytes"`
	TxBytes int64   `json:"tx_bytes"`
	RxBps   float64 `json:"rx_bps"`
	TxBps   float64 `json:"tx_bps"`
	WAN     bool    `json:"wan,omitempty"`
}

type systemSnapshot struct {
	Time       time.Time     `json:"time"`
	Hostname   string        `json:"hostname"`
	Cores      int           `json:"cores"`
	UptimeSec  int64         `json:"uptime_sec"`
	Load       [3]float64    `json:"load"`
	CPU        float64       `json:"cpu"`
	MemTotal   int64         `json:"mem_total"`
	MemUsed    int64         `json:"mem_used"`
	MemCache   int64         `json:"mem_cache"`
	SwapTotal  int64         `json:"swap_total"`
	SwapUsed   int64         `json:"swap_used"`
	Temps      []thermalZone `json:"temps"`
	TempMax    float64       `json:"temp_max"`
	Disks      []diskUsage   `json:"disks"`
	Conns      int           `json:"conns"`
	ConnsMax   int           `json:"conns_max"`
	Interfaces []netIface    `json:"interfaces"`
	Apps       []appGroup    `json:"apps"`
	Top        []topProcess  `json:"top"`
	Processes  int           `json:"processes"`
}

type resourceMonitor struct {
	mu        sync.Mutex
	history   []resourceSample
	mtHistory []mikrotikSample
	snapshot  systemSnapshot

	prevTicks  map[int]uint64
	prevTotal  uint64
	prevIdle   uint64
	prevAt     time.Time
	prevNet    map[string]netIface
	ports      map[int][]int // pid -> listening ports
	portsAt    time.Time
	mikrotik   json.RawMessage
	mikrotikAt time.Time
	netpingURL string

	rciURL      string
	mesh        []meshNode
	meshErr     string
	meshHistory map[string][]meshSample

	pve        *pveClient
	pveState   pveState
	pveHistory []pveSample
}

var resources = &resourceMonitor{}

func (a *app) startResources() {
	if runtime.GOOS != "linux" {
		return
	}
	resources.netpingURL = strings.TrimRight(getenv("NETPING_URL", "http://127.0.0.1:18081"), "/")
	resources.rciURL = getenv("RCI_URL", "http://127.0.0.1:79/rci")
	if url := strings.TrimSpace(os.Getenv("PROXMOX_URL")); url != "" {
		resources.pve = newPVEClient(url, getenv("PROXMOX_TOKEN_FILE", "/opt/etc/homenet/secrets/proxmox.token"), os.Getenv("PROXMOX_FINGERPRINT"))
	}
	go func() {
		for {
			resources.sample()
			time.Sleep(sampleEvery)
		}
	}()
	// Remote sources each get their own loop, so a slow one does not stall
	// the local sampler or the others.
	every(2*sampleEvery, resources.pollMikrotik)
	every(2*sampleEvery, resources.pollMesh)
	if resources.pve != nil {
		every(2*sampleEvery, resources.pollProxmox)
	}
}

func every(interval time.Duration, fn func()) {
	go func() {
		for {
			fn()
			time.Sleep(interval)
		}
	}()
}

func (m *resourceMonitor) pollMesh() {
	nodes, err := readMesh(m.rciURL)
	now := time.Now().Unix()
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		m.meshErr = err.Error()
		return
	}
	m.mesh, m.meshErr = nodes, ""
	if m.meshHistory == nil {
		m.meshHistory = map[string][]meshSample{}
	}
	seen := map[string]bool{}
	for _, n := range nodes {
		key := n.CID
		if key == "" {
			key = n.IP
		}
		seen[key] = true
		m.meshHistory[key] = appendRing(m.meshHistory[key], meshSample{T: now, CPU: n.CPU, Mem: n.MemUsed}, historyLength/2)
	}
	for key := range m.meshHistory {
		if !seen[key] {
			delete(m.meshHistory, key)
		}
	}
}

func (m *resourceMonitor) pollProxmox() {
	state := m.pve.poll()
	sample := pveSample{T: time.Now().Unix(), Nodes: map[string]pveUse{}, Guests: map[string]float64{}}
	for _, n := range state.Nodes {
		sample.Nodes[n.Node] = pveUse{CPU: n.CPU, Mem: n.MemUsed}
	}
	for _, g := range state.Guests {
		if g.Status == "running" {
			sample.Guests[g.ID] = g.CPU
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pveState = state
	if state.Error == "" {
		m.pveHistory = appendRing(m.pveHistory, sample, historyLength/2)
	}
}

// ---- process groups ----

type groupRule struct {
	id, name, kind string
	match          func(p *procInfo) bool
}

func cmdHas(parts ...string) func(p *procInfo) bool {
	return func(p *procInfo) bool {
		for _, part := range parts {
			if strings.Contains(p.cmdline, part) {
				return true
			}
		}
		return false
	}
}

func commIs(names ...string) func(p *procInfo) bool {
	return func(p *procInfo) bool {
		for _, name := range names {
			if p.comm == name {
				return true
			}
		}
		return false
	}
}

// Ordered: the first match wins. Children that do not match anything
// specific (nginx workers, shell wrappers) inherit their parent's group.
var groupRules = []groupRule{
	{"mihomo", "Mihomo (XKeen)", "app", commIs("mihomo")},
	{"xray", "Xray (XKeen)", "app", commIs("xray")},
	{"xkeen-ui", "XKeen UI", "app", cmdHas("/opt/etc/xkeen-ui/")},
	{"xkeen-net", "xkeen-net", "app", func(p *procInfo) bool {
		return p.comm == "xkeen-net" || strings.Contains(p.cmdline, "/opt/bin/xkeen-net")
	}},
	{"homenet", "HomeNet", "app", cmdHas("/opt/etc/homenet/")},
	{"netping", "Netping", "app", cmdHas("/opt/netping/")},
	{"sms", "SMS-шлюз", "app", cmdHas("/opt/sms-gateway/")},
	{"routerd", "routerd (LMS)", "app", cmdHas("/opt/routerd/")},
	{"lms", "LMS", "app", cmdHas("/opt/lms", "lms-client", "lms-node")},
	{"dms", "DMS", "app", cmdHas("/opt/dms/", "dms-service")},
	{"dns", "DNS-over-HTTPS/TLS", "system", commIs("https_dns_proxy", "stubby", "dnsmasq")},
	{"webui", "Веб-интерфейс Keenetic", "system", cmdHas("/usr/sbin/nginx -e")},
	{"ndm", "Ядро прошивки (ndm)", "system", commIs("ndm", "ndmc", "ndhcpc", "ndnproxy")},
	{"wifi", "Wi-Fi", "system", commIs("wind", "hostapd", "wpa_supplicant")},
	{"smb", "Файлы (SMB/FTP)", "system", commIs("tsmb-server", "smbd", "nmbd", "vsftpd", "tsmb")},
	{"ssh", "SSH", "system", commIs("dropbear", "sshd")},
}

var groupNames = func() map[string]groupRule {
	out := map[string]groupRule{}
	for _, rule := range groupRules {
		out[rule.id] = rule
	}
	out["kernel"] = groupRule{id: "kernel", name: "Ядро Linux", kind: "system"}
	out["firmware"] = groupRule{id: "firmware", name: "Прочие службы прошивки", kind: "system"}
	return out
}()

var nonWord = regexp.MustCompile(`[^a-z0-9_.-]+`)

func classify(p *procInfo) (string, string, string) {
	if p.cmdline == "" {
		return "kernel", "", ""
	}
	for _, rule := range groupRules {
		if rule.match(p) {
			return rule.id, "", ""
		}
	}
	// Other Entware software gets a group of its own named after the binary.
	fields := strings.Fields(p.cmdline)
	if len(fields) > 0 && strings.HasPrefix(fields[0], "/opt/") {
		exe := fields[0]
		base := filepath.Base(exe)
		if (base == "python3" || base == "python" || base == "node" || base == "sh") && len(fields) > 1 {
			base = filepath.Base(fields[1])
		}
		id := "opt-" + nonWord.ReplaceAllString(strings.ToLower(base), "-")
		return id, base, exe
	}
	return "firmware", "", ""
}

// ---- /proc readers ----

func readFileString(path string) string {
	body, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(body)
}

func readProcs() map[int]*procInfo {
	out := map[int]*procInfo{}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	page := int64(os.Getpagesize())
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		dir := "/proc/" + entry.Name()
		stat := readFileString(dir + "/stat")
		open := strings.IndexByte(stat, '(')
		close := strings.LastIndexByte(stat, ')')
		if open < 0 || close < open {
			continue
		}
		fields := strings.Fields(stat[close+1:])
		if len(fields) < 22 {
			continue
		}
		p := &procInfo{pid: pid, comm: stat[open+1 : close]}
		p.ppid, _ = strconv.Atoi(fields[1])
		utime, _ := strconv.ParseUint(fields[11], 10, 64)
		stime, _ := strconv.ParseUint(fields[12], 10, 64)
		p.ticks = utime + stime
		if rssPages, err := strconv.ParseInt(fields[21], 10, 64); err == nil {
			p.rss = rssPages * page
		}
		p.cmdline = strings.TrimSpace(strings.ReplaceAll(readFileString(dir+"/cmdline"), "\x00", " "))
		out[pid] = p
	}
	return out
}

func assignGroups(procs map[int]*procInfo) map[string]groupRule {
	extra := map[string]groupRule{}
	generic := map[int]bool{}
	for _, p := range procs {
		id, name, exe := classify(p)
		p.group = id
		if name != "" {
			extra[id] = groupRule{id: id, name: name, kind: "app"}
		}
		_ = exe
		if id == "firmware" {
			generic[p.pid] = true
		}
	}
	// Workers and wrappers inherit the parent's group (a few passes cover
	// nested children).
	for pass := 0; pass < 4; pass++ {
		changed := false
		for pid := range generic {
			p := procs[pid]
			parent, ok := procs[p.ppid]
			if !ok || parent.group == "firmware" || parent.group == "kernel" || p.ppid <= 1 {
				continue
			}
			p.group = parent.group
			delete(generic, pid)
			changed = true
		}
		if !changed {
			break
		}
	}
	return extra
}

func cpuTotals() (total, idle uint64, cores int) {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, 0
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)[1:]
			for i, field := range fields {
				n, _ := strconv.ParseUint(field, 10, 64)
				total += n
				if i == 3 || i == 4 {
					idle += n
				}
			}
		} else if strings.HasPrefix(line, "cpu") {
			cores++
		}
	}
	return
}

func readMeminfo() map[string]int64 {
	out := map[string]int64{}
	for _, line := range strings.Split(readFileString("/proc/meminfo"), "\n") {
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			n, _ := strconv.ParseInt(parts[1], 10, 64)
			out[strings.TrimSuffix(parts[0], ":")] = n * 1024
		}
	}
	return out
}

func readThermal() []thermalZone {
	zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*")
	sort.Strings(zones)
	out := []thermalZone{}
	for _, zone := range zones {
		raw := strings.TrimSpace(readFileString(zone + "/temp"))
		milli, err := strconv.ParseFloat(raw, 64)
		if err != nil || milli <= 0 {
			continue
		}
		name := strings.TrimSpace(readFileString(zone + "/type"))
		if name == "" {
			name = filepath.Base(zone)
		}
		out = append(out, thermalZone{Name: name, Temp: milli / 1000})
	}
	return out
}

func readNetDev() map[string]netIface {
	out := map[string]netIface{}
	for _, line := range strings.Split(readFileString("/proc/net/dev"), "\n") {
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		name := strings.TrimSpace(line[:colon])
		fields := strings.Fields(line[colon+1:])
		if len(fields) < 9 || name == "lo" {
			continue
		}
		rx, _ := strconv.ParseInt(fields[0], 10, 64)
		tx, _ := strconv.ParseInt(fields[8], 10, 64)
		out[name] = netIface{Name: name, RxBytes: rx, TxBytes: tx}
	}
	return out
}

// wanInterface returns the interface of the default route.
func wanInterface() string {
	for _, line := range strings.Split(readFileString("/proc/net/route"), "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) > 2 && fields[1] == "00000000" && fields[7] == "00000000" {
			return fields[0]
		}
	}
	return ""
}

func readInt(path string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(readFileString(path)))
	return n
}

// listeningPorts maps pid -> TCP ports it listens on, via socket inodes.
func listeningPorts() map[int][]int {
	inodePort := map[string]int{}
	for _, file := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		for _, line := range strings.Split(readFileString(file), "\n")[1:] {
			fields := strings.Fields(line)
			if len(fields) < 10 || fields[3] != "0A" {
				continue
			}
			local := fields[1]
			colon := strings.LastIndexByte(local, ':')
			port, err := strconv.ParseInt(local[colon+1:], 16, 32)
			if err != nil {
				continue
			}
			inodePort[fields[9]] = int(port)
		}
	}
	out := map[int][]int{}
	entries, _ := os.ReadDir("/proc")
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		fds, err := os.ReadDir("/proc/" + entry.Name() + "/fd")
		if err != nil {
			continue
		}
		seen := map[int]bool{}
		for _, fd := range fds {
			link, err := os.Readlink("/proc/" + entry.Name() + "/fd/" + fd.Name())
			if err != nil || !strings.HasPrefix(link, "socket:[") {
				continue
			}
			if port, ok := inodePort[strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")]; ok && !seen[port] {
				seen[port] = true
				out[pid] = append(out[pid], port)
			}
		}
	}
	return out
}

// ---- sampling ----

func (m *resourceMonitor) sample() {
	now := time.Now()
	procs := readProcs()
	extra := assignGroups(procs)
	total, idle, cores := cpuTotals()
	if cores == 0 {
		cores = 1
	}
	mem := readMeminfo()
	netNow := readNetDev()
	wan := wanInterface()

	m.mu.Lock()
	defer m.mu.Unlock()

	elapsed := now.Sub(m.prevAt).Seconds()
	cpu := 0.0
	if m.prevTotal > 0 && total > m.prevTotal {
		busy := float64((total - m.prevTotal) - (idle - m.prevIdle))
		cpu = busy / float64(total-m.prevTotal) * 100
	}
	ticks := map[int]uint64{}
	groups := map[string]*appGroup{}
	procCPU := map[int]float64{}
	for pid, p := range procs {
		ticks[pid] = p.ticks
		usage := 0.0
		if prev, ok := m.prevTicks[pid]; ok && elapsed > 0 && p.ticks >= prev {
			usage = float64(p.ticks-prev) / (elapsed * clockTicks * float64(cores)) * 100
		}
		procCPU[pid] = usage
		rule, ok := groupNames[p.group]
		if !ok {
			rule = extra[p.group]
		}
		g := groups[p.group]
		if g == nil {
			g = &appGroup{ID: p.group, Name: rule.name, Kind: rule.kind, PIDs: []int{}, Ports: []int{}}
			groups[p.group] = g
		}
		g.CPU += usage
		g.RSS += p.rss
		g.Procs++
		g.PIDs = append(g.PIDs, pid)
	}

	if time.Since(m.portsAt) > 30*time.Second {
		m.ports = listeningPorts()
		m.portsAt = now
	}
	for pid, ports := range m.ports {
		if p, ok := procs[pid]; ok {
			g := groups[p.group]
			g.Ports = appendUnique(g.Ports, ports...)
		}
	}

	apps := make([]appGroup, 0, len(groups))
	usage := map[string]appUsage{}
	for _, g := range groups {
		sort.Ints(g.PIDs)
		sort.Ints(g.Ports)
		apps = append(apps, *g)
		usage[g.ID] = appUsage{CPU: round2(g.CPU), RSS: g.RSS}
	}
	sort.Slice(apps, func(i, j int) bool {
		if apps[i].RSS != apps[j].RSS {
			return apps[i].RSS > apps[j].RSS
		}
		return apps[i].ID < apps[j].ID
	})

	top := make([]topProcess, 0, len(procs))
	for pid, p := range procs {
		name := p.comm
		if fields := strings.Fields(p.cmdline); len(fields) > 0 {
			name = filepath.Base(fields[0])
			if (name == "python3" || name == "python") && len(fields) > 1 {
				name = filepath.Base(fields[1])
			}
		}
		top = append(top, topProcess{PID: pid, Name: name, Group: p.group, CPU: round2(procCPU[pid]), RSS: p.rss})
	}
	sort.Slice(top, func(i, j int) bool {
		if top[i].CPU != top[j].CPU {
			return top[i].CPU > top[j].CPU
		}
		return top[i].RSS > top[j].RSS
	})
	if len(top) > 15 {
		top = top[:15]
	}

	ifaces := []netIface{}
	var wanRx, wanTx float64
	for name, cur := range netNow {
		if prev, ok := m.prevNet[name]; ok && elapsed > 0 {
			if d := cur.RxBytes - prev.RxBytes; d >= 0 {
				cur.RxBps = float64(d) * 8 / elapsed
			}
			if d := cur.TxBytes - prev.TxBytes; d >= 0 {
				cur.TxBps = float64(d) * 8 / elapsed
			}
		}
		cur.WAN = name == wan
		if cur.WAN {
			wanRx, wanTx = cur.RxBps, cur.TxBps
		}
		if cur.RxBytes+cur.TxBytes > 0 {
			ifaces = append(ifaces, cur)
		}
	}
	sort.Slice(ifaces, func(i, j int) bool {
		if ifaces[i].WAN != ifaces[j].WAN {
			return ifaces[i].WAN
		}
		return ifaces[i].RxBps+ifaces[i].TxBps > ifaces[j].RxBps+ifaces[j].TxBps
	})

	temps := readThermal()
	tempMax := 0.0
	for _, z := range temps {
		if z.Temp > tempMax {
			tempMax = z.Temp
		}
	}
	disks := []diskUsage{}
	for _, path := range []string{"/opt", "/tmp"} {
		if d, ok := readDisk(path); ok {
			disks = append(disks, d)
		}
	}
	load := [3]float64{}
	for i, field := range strings.Fields(readFileString("/proc/loadavg")) {
		if i < 3 {
			load[i], _ = strconv.ParseFloat(field, 64)
		}
	}
	uptime, _ := strconv.ParseFloat(strings.Fields(readFileString("/proc/uptime") + " 0")[0], 64)
	hostname, _ := os.Hostname()
	memTotal := mem["MemTotal"]
	memUsed := memTotal - mem["MemAvailable"]
	swapUsed := mem["SwapTotal"] - mem["SwapFree"]
	conns := readInt("/proc/sys/net/netfilter/nf_conntrack_count")

	m.snapshot = systemSnapshot{
		Time: now.UTC(), Hostname: hostname, Cores: cores, UptimeSec: int64(uptime), Load: load, CPU: round2(cpu),
		MemTotal: memTotal, MemUsed: memUsed, MemCache: mem["Cached"] + mem["Buffers"],
		SwapTotal: mem["SwapTotal"], SwapUsed: swapUsed,
		Temps: temps, TempMax: tempMax, Disks: disks,
		Conns: conns, ConnsMax: readInt("/proc/sys/net/netfilter/nf_conntrack_max"),
		Interfaces: ifaces, Apps: apps, Top: top, Processes: len(procs),
	}
	if m.prevTotal > 0 {
		m.history = appendRing(m.history, resourceSample{
			T: now.Unix(), CPU: round2(cpu), MemUsed: memUsed, SwapUsed: swapUsed, Temp: tempMax,
			RxBps: wanRx, TxBps: wanTx, Conns: conns, Apps: usage,
		}, historyLength)
	}
	m.prevTicks, m.prevTotal, m.prevIdle, m.prevAt, m.prevNet = ticks, total, idle, now, netNow
}

func appendRing[T any](list []T, item T, limit int) []T {
	list = append(list, item)
	if len(list) > limit {
		list = append(list[:0:0], list[len(list)-limit:]...)
	}
	return list
}

func appendUnique(list []int, values ...int) []int {
	for _, v := range values {
		found := false
		for _, have := range list {
			if have == v {
				found = true
				break
			}
		}
		if !found {
			list = append(list, v)
		}
	}
	return list
}

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}

// pollMikrotik keeps Netping's MikroTik view and a history for charts.
func (m *resourceMonitor) pollMikrotik() {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(m.netpingURL + "/api/router")
	var body []byte
	if err == nil {
		body, err = io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
	}
	if err != nil {
		body, _ = json.Marshal(map[string]string{"error": "Netping недоступен: " + err.Error()})
	}
	var parsed struct {
		Signal struct {
			RSRP float64 `json:"rsrp"`
			SINR float64 `json:"sinr"`
		} `json:"signal"`
		System *struct {
			CPULoad     float64 `json:"cpu_load"`
			MemoryTotal int64   `json:"memory_total"`
			MemoryFree  int64   `json:"memory_free"`
			Interfaces  []struct {
				Type  string  `json:"type"`
				RxBps float64 `json:"rx_bps"`
				TxBps float64 `json:"tx_bps"`
			} `json:"interfaces"`
		} `json:"system"`
	}
	_ = json.Unmarshal(body, &parsed)

	m.mu.Lock()
	defer m.mu.Unlock()
	m.mikrotik, m.mikrotikAt = body, time.Now()
	if parsed.System == nil {
		return
	}
	sample := mikrotikSample{T: time.Now().Unix(), CPU: parsed.System.CPULoad, Mem: parsed.System.MemoryTotal - parsed.System.MemoryFree, RSRP: parsed.Signal.RSRP, SINR: parsed.Signal.SINR}
	// The LTE side is the MikroTik's uplink; fall back to all traffic.
	for _, iface := range parsed.System.Interfaces {
		if iface.Type == "lte" {
			sample.RxBps += iface.RxBps
			sample.TxBps += iface.TxBps
		}
	}
	m.mtHistory = appendRing(m.mtHistory, sample, historyLength/2)
}

func (a *app) handleResources(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "linux" {
		a.writeJSON(w, http.StatusOK, response{"ok": false, "error": "мониторинг ресурсов работает только на роутере (Linux)"})
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	resources.mu.Lock()
	snapshot := resources.snapshot
	history := make([]resourceSample, 0, len(resources.history))
	for _, s := range resources.history {
		if s.T > since {
			history = append(history, s)
		}
	}
	mtHistory := make([]mikrotikSample, 0, len(resources.mtHistory))
	for _, s := range resources.mtHistory {
		if s.T > since {
			mtHistory = append(mtHistory, s)
		}
	}
	mikrotik := resources.mikrotik
	meshNodes, meshErr := resources.mesh, resources.meshErr
	meshHistory := map[string][]meshSample{}
	for key, list := range resources.meshHistory {
		for _, s := range list {
			if s.T > since {
				meshHistory[key] = append(meshHistory[key], s)
			}
		}
	}
	var proxmox any
	pveHistory := []pveSample{}
	if resources.pve != nil {
		proxmox = resources.pveState
		for _, s := range resources.pveHistory {
			if s.T > since {
				pveHistory = append(pveHistory, s)
			}
		}
	}
	resources.mu.Unlock()
	if meshNodes == nil {
		meshNodes = []meshNode{}
	}
	if len(mikrotik) == 0 {
		mikrotik = json.RawMessage(`{"error":"данные MikroTik ещё не получены"}`)
	}
	a.writeJSON(w, http.StatusOK, response{
		"ok":               true,
		"now":              snapshot,
		"history":          history,
		"mikrotik":         mikrotik,
		"mikrotik_history": mtHistory,
		"mesh":             map[string]any{"nodes": meshNodes, "error": meshErr},
		"mesh_history":     meshHistory,
		"proxmox":          proxmox,
		"proxmox_history":  pveHistory,
		"interval_sec":     int(sampleEvery / time.Second),
	})
}
