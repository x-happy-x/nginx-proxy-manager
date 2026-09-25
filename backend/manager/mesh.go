package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Keenetic Mesh Wi-Fi members as the controller sees them. They come from the
// firmware's local RCI JSON API (`show mws member`), so extenders added later
// appear without any setup.

type meshPort struct {
	Label string `json:"label"`
	Link  bool   `json:"link"`
	Speed int    `json:"speed,omitempty"`
}

type meshNode struct {
	CID          string     `json:"cid"`
	Name         string     `json:"name"`
	Model        string     `json:"model"`
	IP           string     `json:"ip"`
	Mode         string     `json:"mode"`
	Firmware     string     `json:"firmware"`
	FirmwareNext string     `json:"firmware_next,omitempty"`
	UpdateReady  bool       `json:"update_available"`
	Internet     bool       `json:"internet"`
	Clients      int        `json:"clients"`
	CPU          float64    `json:"cpu"`
	MemUsed      int64      `json:"mem_used"`
	MemTotal     int64      `json:"mem_total"`
	UptimeSec    int64      `json:"uptime_sec"`
	Uplink       string     `json:"uplink"`
	UplinkWiFi   bool       `json:"uplink_wifi"`
	RSSI         int        `json:"rssi,omitempty"`
	TxRate       int        `json:"txrate,omitempty"`
	Ports        []meshPort `json:"ports"`
}

type meshSample struct {
	T   int64   `json:"t"`
	CPU float64 `json:"cpu"`
	Mem int64   `json:"mem"`
}

// flexNum accepts numbers that the firmware sends either as JSON numbers or
// as strings ("uptime": "46646" next to "uptime": 44735).
type flexNum float64

func (f *flexNum) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil // unknown formats are not fatal for a dashboard
	}
	*f = flexNum(v)
	return nil
}

type flexBool bool

func (f *flexBool) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	*f = flexBool(s == "true" || s == "yes" || s == "up")
	return nil
}

type rciMember struct {
	CID       string   `json:"cid"`
	Model     string   `json:"model"`
	KnownHost string   `json:"known-host"`
	IP        string   `json:"ip"`
	Mode      string   `json:"mode"`
	FW        string   `json:"fw"`
	FWNext    string   `json:"fw-available"`
	FWUpdate  flexBool `json:"fw-update-available"`
	Internet  flexBool `json:"internet-available"`
	Clients   flexNum  `json:"associations"`
	Port      []struct {
		Label string  `json:"label"`
		Link  string  `json:"link"`
		Speed flexNum `json:"speed"`
	} `json:"port"`
	System struct {
		CPU    flexNum `json:"cpuload"`
		Memory string  `json:"memory"`
		Uptime flexNum `json:"uptime"`
	} `json:"system"`
	Backhaul struct {
		Uplink string  `json:"uplink"`
		TxRate flexNum `json:"txrate"`
		RSSI   flexNum `json:"rssi"`
	} `json:"backhaul"`
}

func meshNodesFromJSON(body []byte) ([]meshNode, error) {
	var members []rciMember
	if err := json.Unmarshal(body, &members); err != nil {
		return nil, fmt.Errorf("mws member: %w", err)
	}
	out := make([]meshNode, 0, len(members))
	for _, m := range members {
		node := meshNode{
			CID: m.CID, Name: m.KnownHost, Model: m.Model, IP: m.IP, Mode: m.Mode,
			Firmware: m.FW, FirmwareNext: m.FWNext, UpdateReady: bool(m.FWUpdate), Internet: bool(m.Internet),
			Clients: int(m.Clients), CPU: float64(m.System.CPU), UptimeSec: int64(m.System.Uptime),
			Uplink: m.Backhaul.Uplink, UplinkWiFi: strings.Contains(m.Backhaul.Uplink, "Wifi"),
			RSSI: int(m.Backhaul.RSSI), TxRate: int(m.Backhaul.TxRate), Ports: []meshPort{},
		}
		if node.Name == "" {
			node.Name = node.Model
		}
		if parts := strings.SplitN(m.System.Memory, "/", 2); len(parts) == 2 {
			used, _ := strconv.ParseInt(parts[0], 10, 64)
			total, _ := strconv.ParseInt(parts[1], 10, 64)
			node.MemUsed, node.MemTotal = used*1024, total*1024
		}
		for _, p := range m.Port {
			node.Ports = append(node.Ports, meshPort{Label: p.Label, Link: p.Link == "up", Speed: int(p.Speed)})
		}
		out = append(out, node)
	}
	return out, nil
}

// readMesh asks the controller's RCI, which answers on localhost only.
func readMesh(rciURL string) ([]meshNode, error) {
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(strings.TrimRight(rciURL, "/") + "/show/mws/member")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("RCI ответил %d", resp.StatusCode)
	}
	return meshNodesFromJSON(body)
}
