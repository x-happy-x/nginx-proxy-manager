package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Network monitor (replaces Netping): every netEvery it reads the MikroTik
// (resources, LTE, pings over its direct LTE path), pings the same targets
// from the Netcraze itself and checks the internet through mihomo. Samples
// are kept for a day and saved to NETWORK_STATE_DIR.

const (
	netEvery   = 10 * time.Second
	netHistory = 8640 // 24 h
)

type netTarget struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Address  string `json:"address"`
	Category string `json:"category"` // internet (IP) | domain (needs DNS)
}

var defaultNetTargets = []netTarget{
	{ID: "google-dns", Name: "Google DNS", Address: "8.8.8.8", Category: "internet"},
	{ID: "yandex-dns", Name: "Yandex DNS", Address: "77.88.8.8", Category: "internet"},
	{ID: "google", Name: "google.com", Address: "google.com", Category: "domain"},
	{ID: "yandex", Name: "yandex.ru", Address: "yandex.ru", Category: "domain"},
}

type pingResult struct {
	Sent     int     `json:"sent"`
	Received int     `json:"received"`
	Loss     float64 `json:"loss"`
	AvgMS    float64 `json:"avg_ms"`
	MinMS    float64 `json:"min_ms"`
	MaxMS    float64 `json:"max_ms"`
	OK       bool    `json:"ok"`
	Error    string  `json:"error,omitempty"`
}

func (r *pingResult) fill(times []float64) {
	r.Received = len(times)
	if r.Sent > 0 {
		r.Loss = math.Round(float64(r.Sent-r.Received)/float64(r.Sent)*1000) / 10
	}
	r.OK = r.Received > 0
	if len(times) == 0 {
		return
	}
	r.MinMS, r.MaxMS = times[0], times[0]
	sum := 0.0
	for _, v := range times {
		sum += v
		r.MinMS = math.Min(r.MinMS, v)
		r.MaxMS = math.Max(r.MaxMS, v)
	}
	r.AvgMS = round2(sum / float64(len(times)))
	if r.OK {
		r.Error = ""
	}
}

// pingLite is the per-sample record kept in history.
type pingLite struct {
	OK   bool    `json:"ok"`
	MS   float64 `json:"ms,omitempty"`
	Loss float64 `json:"loss,omitempty"`
}

type netSample struct {
	T     int64               `json:"t"`
	API   bool                `json:"api"` // MikroTik API answered
	LTE   string              `json:"lte,omitempty"`
	RSRP  int                 `json:"rsrp,omitempty"`
	RSRQ  int                 `json:"rsrq,omitempty"`
	SINR  int                 `json:"sinr,omitempty"`
	Q     int                 `json:"q,omitempty"`
	MT    map[string]pingLite `json:"mt"`
	NC    map[string]pingLite `json:"nc"`
	Proxy pingLite            `json:"proxy"`
	LTERx float64             `json:"lte_rx"`
	LTETx float64             `json:"lte_tx"`
	WANRx float64             `json:"wan_rx"`
	WANTx float64             `json:"wan_tx"`
}

type netCheck struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Group string `json:"group"` // summary | mikrotik | netcraze
	test  func(netSample) (ok, valid bool)
}

type netMonitor struct {
	mu       sync.Mutex
	creds    string
	targets  []netTarget
	history  []netSample
	latest   map[string]any // detailed latest pings for the UI
	view     mikrotikView
	stateDir string
	savedAt  time.Time

	prevIface map[string]rosIface
	prevAt    time.Time
}

var netmon = &netMonitor{}

func (a *app) startNetwork() {
	if runtime.GOOS != "linux" {
		return
	}
	netmon.creds = getenv("MIKROTIK_CREDENTIALS_FILE", "/opt/etc/homenet/secrets/mikrotik.env")
	netmon.stateDir = getenv("NETWORK_STATE_DIR", "/opt/etc/homenet/network")
	netmon.targets = defaultNetTargets
	netmon.view = mikrotikView{Error: "данные MikroTik ещё не получены"}
	netmon.load()
	every(netEvery, netmon.poll)
	startScanner()
}

func (m *netMonitor) checks() []netCheck {
	checks := []netCheck{
		{ID: "api", Name: "MikroTik API", Group: "summary", test: func(s netSample) (bool, bool) { return s.API, true }},
		{ID: "lte", Name: "LTE", Group: "summary", test: func(s netSample) (bool, bool) { return s.LTE == "running", s.API }},
		{ID: "mt-internet", Name: "Интернет · MikroTik", Group: "summary", test: func(s netSample) (bool, bool) { return anyPing(s.MT, m.targets, "internet"), s.API }},
		{ID: "mt-domain", Name: "Домены · MikroTik", Group: "summary", test: func(s netSample) (bool, bool) { return allPing(s.MT, m.targets, "domain"), s.API }},
		{ID: "nc-internet", Name: "Интернет · Netcraze", Group: "summary", test: func(s netSample) (bool, bool) { return anyPing(s.NC, m.targets, "internet"), true }},
		{ID: "nc-domain", Name: "Домены · Netcraze", Group: "summary", test: func(s netSample) (bool, bool) { return allPing(s.NC, m.targets, "domain"), true }},
		{ID: "proxy", Name: "Интернет через mihomo", Group: "summary", test: func(s netSample) (bool, bool) { return s.Proxy.OK, true }},
	}
	for _, t := range m.targets {
		id := t.ID
		checks = append(checks,
			netCheck{ID: "mt:" + id, Name: t.Name + " · MikroTik", Group: "mikrotik", test: func(s netSample) (bool, bool) { return s.MT[id].OK, s.API }},
			netCheck{ID: "nc:" + id, Name: t.Name + " · Netcraze", Group: "netcraze", test: func(s netSample) (bool, bool) { return s.NC[id].OK, true }},
		)
	}
	return checks
}

func anyPing(pings map[string]pingLite, targets []netTarget, category string) bool {
	for _, t := range targets {
		if t.Category == category && pings[t.ID].OK {
			return true
		}
	}
	return false
}

func allPing(pings map[string]pingLite, targets []netTarget, category string) bool {
	found := false
	for _, t := range targets {
		if t.Category != category {
			continue
		}
		found = true
		if !pings[t.ID].OK {
			return false
		}
	}
	return found
}

func (m *netMonitor) poll() {
	now := time.Now()
	sample := netSample{T: now.Unix(), MT: map[string]pingLite{}, NC: map[string]pingLite{}}
	details := map[string]any{}
	var wg sync.WaitGroup
	var mu sync.Mutex

	// Netcraze: ICMP is not redirected by XKeen, so this is the direct path.
	ncDetail := map[string]pingResult{}
	for _, t := range m.targets {
		wg.Add(1)
		go func(t netTarget) {
			defer wg.Done()
			res := localPing(t.Address, 3)
			mu.Lock()
			ncDetail[t.ID] = res
			sample.NC[t.ID] = pingLite{OK: res.OK, MS: res.AvgMS, Loss: res.Loss}
			mu.Unlock()
		}(t)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		started := time.Now()
		ok, err := proxyReachable("www.gstatic.com", 80, 8*time.Second)
		mu.Lock()
		sample.Proxy = pingLite{OK: ok}
		if ok {
			sample.Proxy.MS = round2(float64(time.Since(started).Microseconds()) / 1000)
		}
		details["proxy_error"] = errString(err)
		mu.Unlock()
	}()

	view := mikrotikView{SampleTime: now.UTC()}
	mtDetail := map[string]pingResult{}
	if creds, err := readROSCredentials(m.creds); err != nil {
		view.Error = err.Error()
	} else if conn, err := dialROS(creds, 4*time.Second); err != nil {
		view.Error = "MikroTik недоступен: " + err.Error()
	} else {
		view.Online, sample.API = true, true
		if sys, err := readROSSystem(conn); err != nil {
			view.Error = err.Error()
		} else {
			m.applyRates(sys, now)
			view.System = sys
			for _, i := range sys.Interfaces {
				if i.Type == "lte" {
					sample.LTERx += i.RxBps
					sample.LTETx += i.TxBps
				}
			}
		}
		if sig, err := readLTE(conn, getenv("MIKROTIK_LTE_INTERFACE", "lte1")); err == nil && sig != nil {
			view.Signal = sig
			sample.LTE, sample.RSRP, sample.RSRQ, sample.SINR, sample.Q = sig.Status, sig.RSRP, sig.RSRQ, sig.SINR, sig.Quality
		}
		for _, t := range m.targets {
			res := rosPing(conn, t.Address, 3)
			mtDetail[t.ID] = res
			sample.MT[t.ID] = pingLite{OK: res.OK, MS: res.AvgMS, Loss: res.Loss}
		}
		conn.Close()
	}
	wg.Wait()
	view.InternetOK = anyPing(sample.MT, m.targets, "internet")
	view.WhitelistOK = allPing(sample.MT, m.targets, "domain")
	details["mikrotik"], details["netcraze"] = mtDetail, ncDetail

	resources.mu.Lock()
	if iface, ok := resources.snapshot.wan(); ok {
		sample.WANRx, sample.WANTx = iface.RxBps, iface.TxBps
	}
	resources.mu.Unlock()

	m.mu.Lock()
	m.view, m.latest = view, details
	m.history = appendRing(m.history, sample, netHistory)
	save := time.Since(m.savedAt) > 5*time.Minute
	m.mu.Unlock()

	resources.setMikrotik(view, sample)
	if save {
		m.save()
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (m *netMonitor) applyRates(sys *rosSystem, now time.Time) {
	elapsed := now.Sub(m.prevAt).Seconds()
	next := map[string]rosIface{}
	for i := range sys.Interfaces {
		item := &sys.Interfaces[i]
		if prev, ok := m.prevIface[item.Name]; ok && elapsed > 0 && elapsed < 600 {
			if d := item.RxBytes - prev.RxBytes; d >= 0 {
				item.RxBps = round2(float64(d) * 8 / elapsed)
			}
			if d := item.TxBytes - prev.TxBytes; d >= 0 {
				item.TxBps = round2(float64(d) * 8 / elapsed)
			}
		}
		next[item.Name] = *item
	}
	m.prevIface, m.prevAt = next, now
}

var (
	pingLossRe = regexp.MustCompile(`(\d+(?:\.\d+)?)% packet loss`)
	pingTimeRe = regexp.MustCompile(`time=([\d.]+) ms`)
)

func localPing(address string, count int) pingResult {
	res := pingResult{Sent: count, Loss: 100}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(count)*time.Second+5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ping", "-c", strconv.Itoa(count), "-W", "2", address).CombinedOutput()
	text := string(out)
	var times []float64
	for _, m := range pingTimeRe.FindAllStringSubmatch(text, -1) {
		v, _ := strconv.ParseFloat(m[1], 64)
		times = append(times, v)
	}
	res.fill(times)
	if !res.OK {
		res.Error = strings.TrimSpace(lastLine(text))
		if res.Error == "" && err != nil {
			res.Error = err.Error()
		}
	} else if m := pingLossRe.FindStringSubmatch(text); len(m) == 2 {
		res.Loss, _ = strconv.ParseFloat(m[1], 64)
	}
	return res
}

func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	return lines[len(lines)-1]
}

// ---------- persistence ----------

func (m *netMonitor) historyFile() string { return filepath.Join(m.stateDir, "history.json.gz") }

func (m *netMonitor) save() {
	m.mu.Lock()
	list := append([]netSample(nil), m.history...)
	m.savedAt = time.Now()
	m.mu.Unlock()
	if err := os.MkdirAll(m.stateDir, 0755); err != nil {
		return
	}
	tmp := m.historyFile() + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return
	}
	zw := gzip.NewWriter(f)
	err = json.NewEncoder(zw).Encode(list)
	if cerr := zw.Close(); err == nil {
		err = cerr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		_ = os.Rename(tmp, m.historyFile())
	}
}

func (m *netMonitor) load() {
	f, err := os.Open(m.historyFile())
	if err != nil {
		return
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return
	}
	var list []netSample
	if json.NewDecoder(zr).Decode(&list) != nil {
		return
	}
	cutoff := time.Now().Add(-24 * time.Hour).Unix()
	for _, s := range list {
		if s.T >= cutoff {
			m.history = append(m.history, s)
		}
	}
	m.savedAt = time.Now()
}

// ---------- series, availability, incidents ----------

type netIncident struct {
	Check    string `json:"check"`
	Name     string `json:"name"`
	Start    int64  `json:"start"`
	End      int64  `json:"end"` // 0 while ongoing
	Duration int64  `json:"duration_sec"`
}

type netAvailability struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Group      string  `json:"group"`
	OK         bool    `json:"ok"`
	Valid      bool    `json:"valid"`
	Uptime     float64 `json:"uptime"` // % of valid samples
	LastChange int64   `json:"last_change"`
	Buckets    []int8  `json:"buckets"` // per bucket: -1 no data, 0 all failed .. 100 all ok
}

type netBucket struct {
	T     int64               `json:"t"`
	RSRP  *float64            `json:"rsrp"`
	SINR  *float64            `json:"sinr"`
	LTERx float64             `json:"lte_rx"`
	LTETx float64             `json:"lte_tx"`
	WANRx float64             `json:"wan_rx"`
	WANTx float64             `json:"wan_tx"`
	Proxy *float64            `json:"proxy_ms"`
	MT    map[string]*float64 `json:"mt"` // target -> avg latency of successful pings
	NC    map[string]*float64 `json:"nc"`
	Loss  map[string]float64  `json:"loss"` // "mt:id"/"nc:id" -> avg loss %
}

func avgPtr(sum float64, n int) *float64 {
	if n == 0 {
		return nil
	}
	v := round2(sum / float64(n))
	return &v
}

func (a *app) handleNetwork(w http.ResponseWriter, r *http.Request) {
	minutes, _ := strconv.Atoi(r.URL.Query().Get("minutes"))
	if minutes <= 0 || minutes > 1440 {
		minutes = 60
	}
	points, _ := strconv.Atoi(r.URL.Query().Get("points"))
	if points <= 0 || points > 720 {
		points = 180
	}
	netmon.mu.Lock()
	cutoff := time.Now().Add(-time.Duration(minutes) * time.Minute).Unix()
	var list []netSample
	for _, s := range netmon.history {
		if s.T >= cutoff {
			list = append(list, s)
		}
	}
	view, latest, targets := netmon.view, netmon.latest, netmon.targets
	checks := netmon.checks()
	netmon.mu.Unlock()

	span := int64(minutes*60) / int64(points)
	if span < int64(netEvery/time.Second) {
		span = int64(netEvery / time.Second)
	}
	start := time.Now().Unix() - int64(minutes*60)
	nb := int((time.Now().Unix()-start)/span) + 1
	buckets := make([]netBucket, 0, nb)
	type acc struct {
		rsrp, sinr, proxy, lteRx, lteTx, wanRx, wanTx float64
		nSig, nProxy, n                               int
		mt, nc                                        map[string][2]float64
		loss                                          map[string][2]float64
	}
	accs := make([]acc, nb)
	for i := range accs {
		accs[i] = acc{mt: map[string][2]float64{}, nc: map[string][2]float64{}, loss: map[string][2]float64{}}
	}
	for _, s := range list {
		i := int((s.T - start) / span)
		if i < 0 || i >= nb {
			continue
		}
		b := &accs[i]
		b.n++
		b.lteRx += s.LTERx
		b.lteTx += s.LTETx
		b.wanRx += s.WANRx
		b.wanTx += s.WANTx
		if s.API && s.RSRP != 0 {
			b.rsrp += float64(s.RSRP)
			b.sinr += float64(s.SINR)
			b.nSig++
		}
		if s.Proxy.OK {
			b.proxy += s.Proxy.MS
			b.nProxy++
		}
		for id, p := range s.MT {
			if p.OK {
				v := b.mt[id]
				b.mt[id] = [2]float64{v[0] + p.MS, v[1] + 1}
			}
			l := b.loss["mt:"+id]
			b.loss["mt:"+id] = [2]float64{l[0] + p.Loss, l[1] + 1}
		}
		for id, p := range s.NC {
			if p.OK {
				v := b.nc[id]
				b.nc[id] = [2]float64{v[0] + p.MS, v[1] + 1}
			}
			l := b.loss["nc:"+id]
			b.loss["nc:"+id] = [2]float64{l[0] + p.Loss, l[1] + 1}
		}
	}
	for i, b := range accs {
		out := netBucket{T: start + int64(i)*span, MT: map[string]*float64{}, NC: map[string]*float64{}, Loss: map[string]float64{}}
		if b.n > 0 {
			out.RSRP, out.SINR = avgPtr(b.rsrp, b.nSig), avgPtr(b.sinr, b.nSig)
			out.Proxy = avgPtr(b.proxy, b.nProxy)
			out.LTERx, out.LTETx = round2(b.lteRx/float64(b.n)), round2(b.lteTx/float64(b.n))
			out.WANRx, out.WANTx = round2(b.wanRx/float64(b.n)), round2(b.wanTx/float64(b.n))
		}
		for _, t := range targets {
			if v, ok := b.mt[t.ID]; ok {
				out.MT[t.ID] = avgPtr(v[0], int(v[1]))
			} else {
				out.MT[t.ID] = nil
			}
			if v, ok := b.nc[t.ID]; ok {
				out.NC[t.ID] = avgPtr(v[0], int(v[1]))
			} else {
				out.NC[t.ID] = nil
			}
		}
		for key, v := range b.loss {
			out.Loss[key] = round2(v[0] / v[1])
		}
		buckets = append(buckets, out)
	}

	avail := make([]netAvailability, 0, len(checks))
	incidents := []netIncident{}
	for _, c := range checks {
		item := netAvailability{ID: c.ID, Name: c.Name, Group: c.Group, Buckets: make([]int8, nb)}
		okN, validN := make([]int, nb), make([]int, nb)
		total, good := 0, 0
		var run *netIncident
		var prevOK *bool
		for _, s := range list {
			ok, valid := c.test(s)
			if !valid {
				continue
			}
			total++
			if ok {
				good++
			}
			if i := int((s.T - start) / span); i >= 0 && i < nb {
				validN[i]++
				if ok {
					okN[i]++
				}
			}
			if prevOK != nil && *prevOK != ok {
				item.LastChange = s.T
			}
			v := ok
			prevOK = &v
			item.OK, item.Valid = ok, true
			if !ok && run == nil {
				run = &netIncident{Check: c.ID, Name: c.Name, Start: s.T}
			}
			if ok && run != nil {
				run.End, run.Duration = s.T, s.T-run.Start
				incidents = append(incidents, *run)
				run = nil
			}
		}
		if run != nil {
			run.Duration = time.Now().Unix() - run.Start
			incidents = append(incidents, *run)
		}
		if total > 0 {
			item.Uptime = round2(float64(good) * 100 / float64(total))
		}
		for i := range item.Buckets {
			if validN[i] == 0 {
				item.Buckets[i] = -1
			} else {
				item.Buckets[i] = int8(okN[i] * 100 / validN[i])
			}
		}
		avail = append(avail, item)
	}
	sort.Slice(incidents, func(i, j int) bool { return incidents[i].Start > incidents[j].Start })
	if len(incidents) > 100 {
		incidents = incidents[:100]
	}

	var current *netSample
	if len(list) > 0 {
		current = &list[len(list)-1]
	}
	resources.mu.Lock()
	ifaces := resources.snapshot.Interfaces
	resources.mu.Unlock()

	a.writeJSON(w, http.StatusOK, response{
		"ok":           true,
		"interval_sec": int(netEvery / time.Second),
		"bucket_sec":   span,
		"targets":      targets,
		"current":      current,
		"details":      latest,
		"mikrotik":     view,
		"keenetic":     map[string]any{"interfaces": ifaces},
		"series":       buckets,
		"availability": avail,
		"incidents":    incidents,
	})
}

func (s systemSnapshot) wan() (netIface, bool) {
	for _, i := range s.Interfaces {
		if i.WAN {
			return i, true
		}
	}
	return netIface{}, false
}
