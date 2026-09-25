package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// MikroTik state read directly over the RouterOS API (it used to come from
// Netping's /api/router; the JSON shape is kept for the Resources page).

type rosSensor struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
	Unit  string  `json:"unit"`
}

type rosIface struct {
	Name    string  `json:"name"`
	Type    string  `json:"type"`
	Running bool    `json:"running"`
	RxBytes int64   `json:"rx_bytes"`
	TxBytes int64   `json:"tx_bytes"`
	RxBps   float64 `json:"rx_bps"`
	TxBps   float64 `json:"tx_bps"`
}

type rosSystem struct {
	Board         string      `json:"board"`
	Version       string      `json:"version"`
	Architecture  string      `json:"architecture"`
	UptimeSeconds int64       `json:"uptime_seconds"`
	CPULoad       int64       `json:"cpu_load"`
	CPUCount      int64       `json:"cpu_count"`
	CPUFrequency  int64       `json:"cpu_frequency_mhz"`
	MemoryTotal   int64       `json:"memory_total"`
	MemoryFree    int64       `json:"memory_free"`
	DiskTotal     int64       `json:"disk_total"`
	DiskFree      int64       `json:"disk_free"`
	Sensors       []rosSensor `json:"sensors"`
	Interfaces    []rosIface  `json:"interfaces"`
	DNSServers    []string    `json:"dns_servers"`
	WANAddress    string      `json:"wan_address,omitempty"`
}

type lteSignal struct {
	Status   string `json:"status"`
	Operator string `json:"operator"`
	Band     string `json:"band"`
	CellID   string `json:"cell_id"`
	RSSI     int    `json:"rssi"`
	RSRP     int    `json:"rsrp"`
	RSRQ     int    `json:"rsrq"`
	SINR     int    `json:"sinr"`
	CQI      int    `json:"cqi"`
	Quality  int    `json:"quality"`
	// Carriers in use: the primary plus any aggregated secondary ones.
	Carriers []lteCarrier `json:"carriers,omitempty"`
	TotalMHz float64      `json:"total_mhz,omitempty"`
}

// mikrotikView is what /api/resources exposes as "mikrotik".
type mikrotikView struct {
	Online      bool       `json:"online"`
	Error       string     `json:"error,omitempty"`
	Signal      *lteSignal `json:"signal,omitempty"`
	System      *rosSystem `json:"system,omitempty"`
	InternetOK  bool       `json:"internet_ok"`
	WhitelistOK bool       `json:"whitelist_ok"`
	SampleTime  time.Time  `json:"sample_time"`
}

func readROSSystem(conn *rosConn) (*rosSystem, error) {
	reply, err := conn.Run(8*time.Second, "/system/resource/print")
	if err != nil {
		return nil, err
	}
	sys := &rosSystem{Sensors: []rosSensor{}, Interfaces: []rosIface{}, DNSServers: []string{}}
	if len(reply.Rows) > 0 {
		m := reply.Rows[0]
		sys.Board, sys.Version, sys.Architecture = m["board-name"], m["version"], m["architecture-name"]
		sys.UptimeSeconds = int64(parseROSDuration(m["uptime"]))
		sys.CPULoad, sys.CPUCount, sys.CPUFrequency = rosInt(m["cpu-load"]), rosInt(m["cpu-count"]), rosInt(m["cpu-frequency"])
		sys.MemoryTotal, sys.MemoryFree = rosInt(m["total-memory"]), rosInt(m["free-memory"])
		sys.DiskTotal, sys.DiskFree = rosInt(m["total-hdd-space"]), rosInt(m["free-hdd-space"])
	}
	// Not every board has sensors; missing health is not an error.
	if reply, err := conn.Run(5*time.Second, "/system/health/print"); err == nil {
		sys.Sensors = parseROSHealth(reply.Rows)
	}
	if reply, err := conn.Run(5*time.Second, "/interface/print", "=stats=", "=.proplist=name,type,running,disabled,rx-byte,tx-byte"); err == nil {
		for _, m := range reply.Rows {
			if m["disabled"] == "true" {
				continue
			}
			sys.Interfaces = append(sys.Interfaces, rosIface{
				Name: m["name"], Type: m["type"], Running: m["running"] == "true",
				RxBytes: rosInt(m["rx-byte"]), TxBytes: rosInt(m["tx-byte"]),
			})
		}
	}
	if reply, err := conn.Run(5*time.Second, "/ip/dns/print"); err == nil && len(reply.Rows) > 0 {
		for _, key := range []string{"servers", "dynamic-servers"} {
			for _, s := range strings.Split(reply.Rows[0][key], ",") {
				if s = strings.TrimSpace(s); s != "" {
					sys.DNSServers = append(sys.DNSServers, s)
				}
			}
		}
	}
	return sys, nil
}

func readLTE(conn *rosConn, iface string) (*lteSignal, error) {
	reply, err := conn.Run(6*time.Second, "/interface/lte/monitor", "=numbers="+iface, "=once=")
	if err != nil {
		return nil, err
	}
	if len(reply.Rows) == 0 {
		return nil, nil
	}
	m := reply.Rows[0]
	band := m["primary-band"]
	if i := strings.Index(band, " "); i > 0 {
		band = band[:i]
	}
	s := &lteSignal{
		Status: m["status"], Operator: m["current-operator"], Band: band, CellID: m["current-cellid"],
		RSSI: int(rosInt(m["rssi"])), RSRP: int(rosInt(m["rsrp"])), RSRQ: int(rosInt(m["rsrq"])),
		SINR: int(rosInt(m["sinr"])), CQI: int(rosInt(m["cqi"])),
	}
	if s.Status == "" && s.RSRP != 0 {
		s.Status = "running"
	}
	s.Quality = lteQuality(s)
	s.Carriers = parseQCAINFO(atChat(conn, "AT+QCAINFO"))
	if len(s.Carriers) == 0 {
		width := 0.0
		if v := regexp.MustCompile(`@(\d+(?:\.\d+)?)Mhz`).FindStringSubmatch(m["primary-band"]); v != nil {
			width, _ = strconv.ParseFloat(v[1], 64)
		}
		s.Carriers = []lteCarrier{{Role: "pcc", Band: strings.Split(band, "@")[0], WidthMHz: width, Active: true, RSRP: s.RSRP, RSRQ: s.RSRQ, SINR: s.SINR}}
	}
	for _, c := range s.Carriers {
		if c.Active {
			s.TotalMHz += c.WidthMHz
		}
	}
	return s, nil
}

func lteQuality(s *lteSignal) int {
	clamp := func(v int) int {
		if v < 0 {
			return 0
		}
		if v > 100 {
			return 100
		}
		return v
	}
	rsrp := clamp((s.RSRP + 120) * 100 / 40)
	sinr := clamp((s.SINR + 5) * 100 / 25)
	rsrq := clamp((s.RSRQ + 20) * 100 / 17)
	return (rsrp*45 + sinr*35 + rsrq*20) / 100
}

// parseROSHealth understands both layouts: RouterOS 7 returns one row per
// sensor (name/value/type), RouterOS 6 one row with a key per sensor.
func parseROSHealth(rows []map[string]string) []rosSensor {
	sensors := []rosSensor{}
	unit := func(name, kind string) string {
		switch {
		case kind == "C" || strings.Contains(name, "temperature"):
			return "C"
		case kind == "V" || strings.Contains(name, "voltage"):
			return "V"
		case kind == "W" || strings.Contains(name, "power"):
			return "W"
		case kind == "A" || strings.Contains(name, "current"):
			return "A"
		case kind == "RPM" || strings.Contains(name, "fan"):
			return "RPM"
		}
		return kind
	}
	for _, row := range rows {
		if name, ok := row["name"]; ok && row["value"] != "" {
			if v, err := strconv.ParseFloat(row["value"], 64); err == nil {
				sensors = append(sensors, rosSensor{Name: name, Value: v, Unit: unit(name, row["type"])})
			}
			continue
		}
		for key, raw := range row {
			if strings.HasPrefix(key, ".") {
				continue
			}
			if v, err := strconv.ParseFloat(raw, 64); err == nil {
				sensors = append(sensors, rosSensor{Name: key, Value: v, Unit: unit(key, "")})
			}
		}
	}
	return sensors
}

// rosPing runs /ping on the MikroTik and summarises it.
func rosPing(conn *rosConn, address string, count int) pingResult {
	res := pingResult{Sent: count, Loss: 100}
	reply, err := conn.Run(time.Duration(count)*time.Second+6*time.Second, "/ping", "=address="+address, "=count="+strconv.Itoa(count), "=interval=200ms")
	if err != nil {
		res.Error = err.Error()
		return res
	}
	var times []float64
	for _, row := range reply.Rows {
		if row["time"] != "" {
			times = append(times, parseROSDuration(row["time"])*1000)
		}
		if msg := row["status"]; msg != "" && res.Error == "" {
			res.Error = msg
		}
	}
	res.fill(times)
	return res
}
