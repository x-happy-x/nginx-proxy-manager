package main

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Proxmox VE hosts read over the API with a read-only token (PVEAuditor).
// The token lives outside the deployable runtime.env (PROXMOX_TOKEN_FILE);
// the self-signed certificate is accepted only if its SHA-256 matches
// PROXMOX_FINGERPRINT, so no blind InsecureSkipVerify.

type pveNode struct {
	Node       string     `json:"node"`
	Online     bool       `json:"online"`
	CPU        float64    `json:"cpu"` // % of all cores
	Cores      int        `json:"cores"`
	CPUModel   string     `json:"cpu_model,omitempty"`
	MemUsed    int64      `json:"mem_used"`
	MemTotal   int64      `json:"mem_total"`
	SwapUsed   int64      `json:"swap_used"`
	SwapTotal  int64      `json:"swap_total"`
	RootUsed   int64      `json:"root_used"`
	RootTotal  int64      `json:"root_total"`
	Load       [3]float64 `json:"load"`
	UptimeSec  int64      `json:"uptime_sec"`
	PVEVersion string     `json:"pve_version,omitempty"`
	Kernel     string     `json:"kernel,omitempty"`
}

type pveGuest struct {
	ID        string  `json:"id"`
	VMID      int     `json:"vmid"`
	Name      string  `json:"name"`
	Type      string  `json:"type"` // qemu | lxc
	Node      string  `json:"node"`
	Status    string  `json:"status"`
	Template  bool    `json:"template,omitempty"`
	CPU       float64 `json:"cpu"` // % of the guest's own vCPUs
	Cores     int     `json:"cores"`
	MemUsed   int64   `json:"mem_used"`
	MemTotal  int64   `json:"mem_total"`
	DiskUsed  int64   `json:"disk_used"`
	DiskTotal int64   `json:"disk_total"`
	NetInBps  float64 `json:"net_in_bps"`
	NetOutBps float64 `json:"net_out_bps"`
	UptimeSec int64   `json:"uptime_sec"`
}

type pveStorage struct {
	Name   string `json:"name"`
	Node   string `json:"node"`
	Type   string `json:"type"`
	Used   int64  `json:"used"`
	Total  int64  `json:"total"`
	Active bool   `json:"active"`
}

type pveState struct {
	Error   string       `json:"error,omitempty"`
	URL     string       `json:"url,omitempty"`
	Nodes   []pveNode    `json:"nodes"`
	Guests  []pveGuest   `json:"guests"`
	Storage []pveStorage `json:"storage"`
}

type pveSample struct {
	T      int64              `json:"t"`
	Nodes  map[string]pveUse  `json:"nodes"`
	Guests map[string]float64 `json:"guests"` // guest id -> CPU %
}

type pveUse struct {
	CPU float64 `json:"cpu"`
	Mem int64   `json:"mem"`
}

type pveClient struct {
	url         string
	tokenFile   string
	fingerprint string
	http        *http.Client

	mu      sync.Mutex
	prevNet map[string][2]int64
	prevAt  time.Time
}

func normalizeFingerprint(value string) string {
	return strings.ToLower(strings.NewReplacer(":", "", " ", "").Replace(strings.TrimSpace(value)))
}

func newPVEClient(url, tokenFile, fingerprint string) *pveClient {
	want := normalizeFingerprint(fingerprint)
	verify := func(raw [][]byte, _ [][]*x509.Certificate) error {
		if want == "" {
			return errors.New("не задан PROXMOX_FINGERPRINT — сертификат нечем проверить")
		}
		if len(raw) == 0 {
			return errors.New("сервер не прислал сертификат")
		}
		sum := sha256.Sum256(raw[0])
		if hex.EncodeToString(sum[:]) != want {
			return errors.New("отпечаток сертификата Proxmox не совпадает с PROXMOX_FINGERPRINT")
		}
		return nil
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			// Chain verification is replaced by pinning the host's own
			// self-signed certificate in VerifyPeerCertificate.
			InsecureSkipVerify:    true, //nolint:gosec
			VerifyPeerCertificate: verify,
		},
	}
	return &pveClient{
		url:         strings.TrimRight(url, "/"),
		tokenFile:   tokenFile,
		fingerprint: want,
		http:        &http.Client{Timeout: 8 * time.Second, Transport: transport},
	}
}

func (c *pveClient) get(path string, out any) error {
	token, err := os.ReadFile(c.tokenFile)
	if err != nil {
		return fmt.Errorf("нет токена Proxmox (%s): %w", c.tokenFile, err)
	}
	req, err := http.NewRequest(http.MethodGet, c.url+"/api2/json"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", strings.TrimSpace(string(token)))
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Proxmox ответил %d на %s", resp.StatusCode, path)
	}
	return json.Unmarshal(body, out)
}

// poll reads the cluster view and every online node's status.
func (c *pveClient) poll() pveState {
	state := pveState{URL: c.url, Nodes: []pveNode{}, Guests: []pveGuest{}, Storage: []pveStorage{}}
	var resources struct {
		Data []struct {
			ID       string  `json:"id"`
			Type     string  `json:"type"`
			Node     string  `json:"node"`
			Status   string  `json:"status"`
			Name     string  `json:"name"`
			Storage  string  `json:"storage"`
			Plugin   string  `json:"plugintype"`
			VMID     int     `json:"vmid"`
			Template flexNum `json:"template"`
			CPU      float64 `json:"cpu"`
			MaxCPU   float64 `json:"maxcpu"`
			Mem      int64   `json:"mem"`
			MaxMem   int64   `json:"maxmem"`
			Disk     int64   `json:"disk"`
			MaxDisk  int64   `json:"maxdisk"`
			NetIn    int64   `json:"netin"`
			NetOut   int64   `json:"netout"`
			Uptime   int64   `json:"uptime"`
		} `json:"data"`
	}
	if err := c.get("/cluster/resources", &resources); err != nil {
		state.Error = err.Error()
		return state
	}
	now := time.Now()
	c.mu.Lock()
	elapsed := now.Sub(c.prevAt).Seconds()
	prev := c.prevNet
	next := map[string][2]int64{}
	c.mu.Unlock()

	for _, r := range resources.Data {
		switch r.Type {
		case "node":
			state.Nodes = append(state.Nodes, pveNode{
				Node: r.Node, Online: r.Status == "online", CPU: round2(r.CPU * 100), Cores: int(r.MaxCPU),
				MemUsed: r.Mem, MemTotal: r.MaxMem, RootUsed: r.Disk, RootTotal: r.MaxDisk, UptimeSec: r.Uptime,
			})
		case "qemu", "lxc":
			g := pveGuest{
				ID: r.ID, VMID: r.VMID, Name: r.Name, Type: r.Type, Node: r.Node, Status: r.Status, Template: r.Template > 0,
				CPU: round2(r.CPU * 100), Cores: int(r.MaxCPU), MemUsed: r.Mem, MemTotal: r.MaxMem,
				DiskUsed: r.Disk, DiskTotal: r.MaxDisk, UptimeSec: r.Uptime,
			}
			if p, ok := prev[r.ID]; ok && elapsed > 0 && elapsed < 600 {
				if d := r.NetIn - p[0]; d >= 0 {
					g.NetInBps = float64(d) * 8 / elapsed
				}
				if d := r.NetOut - p[1]; d >= 0 {
					g.NetOutBps = float64(d) * 8 / elapsed
				}
			}
			next[r.ID] = [2]int64{r.NetIn, r.NetOut}
			if g.Status != "running" {
				g.MemUsed = 0
			}
			state.Guests = append(state.Guests, g)
		case "storage":
			state.Storage = append(state.Storage, pveStorage{Name: r.Storage, Node: r.Node, Type: r.Plugin, Used: r.Disk, Total: r.MaxDisk, Active: r.Status == "available"})
		}
	}
	c.mu.Lock()
	c.prevNet, c.prevAt = next, now
	c.mu.Unlock()

	for i := range state.Nodes {
		node := &state.Nodes[i]
		if !node.Online {
			continue
		}
		var status struct {
			Data struct {
				LoadAvg []string `json:"loadavg"`
				Memory  struct {
					Total int64 `json:"total"`
					Used  int64 `json:"used"`
				} `json:"memory"`
				Swap struct {
					Total int64 `json:"total"`
					Used  int64 `json:"used"`
				} `json:"swap"`
				RootFS struct {
					Total int64 `json:"total"`
					Used  int64 `json:"used"`
				} `json:"rootfs"`
				CPUInfo struct {
					Model string `json:"model"`
					CPUs  int    `json:"cpus"`
				} `json:"cpuinfo"`
				PVEVersion string `json:"pveversion"`
				Kernel     string `json:"kversion"`
				Uptime     int64  `json:"uptime"`
			} `json:"data"`
		}
		if err := c.get("/nodes/"+node.Node+"/status", &status); err != nil {
			continue
		}
		d := status.Data
		for j, l := range d.LoadAvg {
			if j < 3 {
				node.Load[j], _ = strconv.ParseFloat(l, 64)
			}
		}
		node.MemUsed, node.MemTotal = d.Memory.Used, d.Memory.Total
		node.SwapUsed, node.SwapTotal = d.Swap.Used, d.Swap.Total
		node.RootUsed, node.RootTotal = d.RootFS.Used, d.RootFS.Total
		node.CPUModel, node.PVEVersion = d.CPUInfo.Model, d.PVEVersion
		if d.CPUInfo.CPUs > 0 {
			node.Cores = d.CPUInfo.CPUs
		}
		// "Linux 6.17.9-1-pve #1 SMP ..." -> "6.17.9-1-pve"
		if fields := strings.Fields(d.Kernel); len(fields) > 1 {
			node.Kernel = fields[1]
		}
		node.UptimeSec = d.Uptime
	}
	sort.Slice(state.Guests, func(i, j int) bool {
		a, b := state.Guests[i], state.Guests[j]
		if (a.Status == "running") != (b.Status == "running") {
			return a.Status == "running"
		}
		if a.Template != b.Template {
			return !a.Template
		}
		return a.VMID < b.VMID
	})
	return state
}
