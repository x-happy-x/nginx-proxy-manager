package main

import (
	"math"
	"net/http"
	"sort"
	"time"
)

// History of the fork's adaptive checks (NPM-29): once a minute, for every
// provider with adaptive health, the confirmed network mode and how many of
// its nodes are admitted. The core only reports the present, so the router
// keeps the past: minutes for 24 hours, hours for 30 days.

type healthPoint struct {
	T int64 `json:"t"`
	// Minutes spent in each confirmed mode within the bucket.
	Normal    int `json:"normal"`
	Whitelist int `json:"whitelist"`
	Offline   int `json:"offline"`
	Unknown   int `json:"unknown"`
	// Admitted nodes: the last sample for a minute, the average for an hour.
	Working int `json:"working"`
	Total   int `json:"total"`
	// Stable nodes in the normal and whitelist rankings at the end of the bucket.
	StableNormal    int `json:"stable_normal"`
	StableWhitelist int `json:"stable_whitelist"`
	samples         int
	workingSum      int
}

type providerHealth struct {
	Minutes []healthPoint `json:"minutes"`
	Hours   []healthPoint `json:"hours"`
	// Per node: how many recent minutes the core counted it working (NPM-68).
	Nodes map[string]*nodeShare `json:"nodes,omitempty"`
}

// nodeShare counts minutes with a decay of shareDecay per minute (half-life
// about 11.5 hours), so an old outage fades and a day's behaviour dominates.
type nodeShare struct {
	OK   float64 `json:"o"`
	N    float64 `json:"n"`
	Seen int64   `json:"t"`
}

const (
	shareDecay   = 0.999
	shareForget  = 24 * 60 * 60 // a node gone from the report for a day is dropped
	shareMinimum = 30           // minutes observed before a node's share means anything
)

func round2f(v float64) float64 { return math.Round(v*100) / 100 }

// observeNodes adds one minute: every node the report has an answer for.
func (h *providerHealth) observeNodes(minute int64, a *adaptiveSnapshot) {
	if h.Nodes == nil {
		h.Nodes = map[string]*nodeShare{}
	}
	for name, r := range a.Results {
		if r.Skipped != "" {
			continue
		}
		ok := r.OK
		if r.Available != nil {
			ok = *r.Available
		}
		n := h.Nodes[name]
		if n == nil {
			n = &nodeShare{}
			h.Nodes[name] = n
		}
		n.OK, n.N = n.OK*shareDecay, n.N*shareDecay
		n.N++
		if ok {
			n.OK++
		}
		n.OK, n.N, n.Seen = round2f(n.OK), round2f(n.N), minute
	}
	for name, n := range h.Nodes {
		if minute-n.Seen > shareForget {
			delete(h.Nodes, name)
		}
	}
}

type adaptiveSnapshot struct {
	Mode     string `json:"mode"`
	Rankings map[string][]struct {
		Stable bool `json:"stable"`
	} `json:"rankings"`
	Results map[string]adaptiveResult `json:"results"`
	DependsOn string `json:"dependsOn"`
}

// adaptiveResult: a node's last probe as the fork reports it; At and the
// probes let HomeNet keep each node's history of checks (NPM-71).
type adaptiveResult struct {
	OK        bool            `json:"ok"`
	Available *bool           `json:"available"`
	Skipped   string          `json:"skipped"`
	At        time.Time       `json:"at"`
	Probes    []adaptiveProbe `json:"probes"`
}

type adaptiveProbe struct {
	OK   bool   `json:"ok"`
	MS   int64  `json:"ms"`
	Fail string `json:"fail"`
}

type providerSnapshot struct {
	Proxies     []proxySnapshot   `json:"proxies"`
	Adaptive    *adaptiveSnapshot `json:"adaptive"`
	VehicleType string            `json:"vehicleType"`
	UpdatedAt   string            `json:"updatedAt"`
}

// working counts nodes the fork admits now: `available` when the core reports
// thresholds (MIHOMO-5+), otherwise the last probe; skipped nodes do not count.
func working(a *adaptiveSnapshot) int {
	n := 0
	for _, r := range a.Results {
		if r.Skipped != "" {
			continue
		}
		if r.Available != nil {
			if *r.Available {
				n++
			}
		} else if r.OK {
			n++
		}
	}
	return n
}

func stableCount(a *adaptiveSnapshot, mode string) int {
	n := 0
	for _, r := range a.Rankings[mode] {
		if r.Stable {
			n++
		}
	}
	return n
}

// aliveSnapshot stands in for the adaptive report of a provider without one
// (a cascade subscription): its nodes alive by the core's own health check,
// the mode unknown (NPM-51).
func aliveSnapshot(p providerSnapshot) *adaptiveSnapshot {
	ok := true
	a := &adaptiveSnapshot{Results: map[string]adaptiveResult{}}
	for _, x := range p.Proxies {
		if x.Alive {
			a.Results[x.Name] = adaptiveResult{OK: true, Available: &ok}
		}
	}
	return a
}

func addHealth(list []healthPoint, start int64, p providerSnapshot, keep int) []healthPoint {
	a := p.Adaptive
	var cur *healthPoint
	if n := len(list); n > 0 && list[n-1].T == start {
		cur = &list[n-1]
	} else {
		list = append(list, healthPoint{T: start})
		if len(list) > keep {
			list = list[len(list)-keep:]
		}
		cur = &list[len(list)-1]
	}
	switch a.Mode {
	case "normal":
		cur.Normal++
	case "whitelist":
		cur.Whitelist++
	case "offline":
		cur.Offline++
	default:
		cur.Unknown++
	}
	w := working(a)
	cur.samples++
	cur.workingSum += w
	cur.Working = (cur.workingSum + cur.samples/2) / cur.samples
	cur.Total = len(p.Proxies)
	cur.StableNormal = stableCount(a, "normal")
	cur.StableWhitelist = stableCount(a, "whitelist")
	return list
}

func (t *trafficCollector) observeHealth(now time.Time, providers map[string]providerSnapshot) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.st.Health == nil {
		t.st.Health = map[string]*providerHealth{}
	}
	minute := now.Truncate(time.Minute).Unix()
	hour := now.Truncate(time.Hour).Unix()
	for name, p := range providers {
		if p.Adaptive == nil {
			// subscriptions only: Compatible providers are the groups' own lists
			if p.VehicleType != "HTTP" && p.VehicleType != "File" {
				continue
			}
			p.Adaptive = aliveSnapshot(p)
		}
		h := t.st.Health[name]
		if h == nil {
			h = &providerHealth{}
			t.st.Health[name] = h
		}
		// One sample per minute: a repeat within the same minute replaces nothing.
		if n := len(h.Minutes); n > 0 && h.Minutes[n-1].T == minute {
			continue
		}
		h.Minutes = addHealth(h.Minutes, minute, p, minuteKeep)
		h.observeNodes(minute, p.Adaptive)
		h.Hours = addHealth(h.Hours, hour, p, hourKeep)
	}
	t.dirty = true
}

func (t *trafficCollector) healthReport(provider, period string, now time.Time) map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	span := map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}[period]
	if span == 0 {
		period, span = "24h", 24*time.Hour
	}
	names := []string{}
	for name := range t.st.Health {
		names = append(names, name)
	}
	sort.Strings(names)
	h := t.st.Health[provider]
	if h == nil && len(names) > 0 {
		// No provider asked: the main subscription, the one with most nodes
		// among those still reported — a subscription removed from the core
		// keeps its history but must not stand for the present.
		best := -1
		fresh := now.Add(-10 * time.Minute).Unix()
		for _, name := range names {
			c := t.st.Health[name]
			if n := len(c.Minutes); n > 0 && c.Minutes[n-1].T >= fresh && c.Minutes[n-1].Total > best {
				best, provider = c.Minutes[n-1].Total, name
			}
		}
		if best < 0 {
			for _, name := range names {
				c := t.st.Health[name]
				if n := len(c.Minutes); n > 0 && c.Minutes[n-1].Total > best {
					best, provider = c.Minutes[n-1].Total, name
				}
			}
		}
		if best < 0 {
			provider = names[0]
		}
		h = t.st.Health[provider]
	}
	series := []healthPoint{}
	resolution := 60
	if span > 24*time.Hour {
		resolution = 3600
	}
	from := now.Add(-span).Unix()
	pick := func(ph *providerHealth) {
		src := ph.Minutes
		if resolution == 3600 {
			src = ph.Hours
		}
		for _, p := range src {
			if p.T >= from-int64(resolution) {
				series = append(series, p)
			}
		}
	}
	if h != nil {
		pick(h)
	}
	// the modes are the channel's, whatever subscription the counts are of
	uplink := false
	if len(series) == 0 && t.st.Uplink != nil {
		pick(t.st.Uplink)
		uplink = len(series) > 0
	} else {
		uplink = t.overlayUplink(series, resolution == 3600)
	}
	return map[string]any{"provider": provider, "providers": names, "period": period, "resolution": resolution, "series": series, "uplink": uplink}
}

func (a *app) handleCoreHealth(w http.ResponseWriter, r *http.Request) {
	if traffic == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "учёт на роутере не запущен"})
		return
	}
	rep := traffic.healthReport(r.URL.Query().Get("provider"), r.URL.Query().Get("period"), time.Now())
	rep["channel"] = channelNow(nil)
	rep["ok"] = true
	a.writeJSON(w, http.StatusOK, rep)
}

// reliability: nodes of the main subscription by their share of working minutes.
func (t *trafficCollector) reliability(now time.Time) (provider string, shares []float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	best := -1
	fresh := now.Add(-10 * time.Minute).Unix()
	for name, h := range t.st.Health {
		if n := len(h.Minutes); n > 0 && h.Minutes[n-1].T >= fresh && len(h.Nodes) > best {
			best, provider = len(h.Nodes), name
		}
	}
	if best < 0 {
		return "", nil
	}
	for _, n := range t.st.Health[provider].Nodes {
		if n.N >= shareMinimum {
			shares = append(shares, n.OK/n.N)
		}
	}
	sort.Float64s(shares)
	return provider, shares
}
