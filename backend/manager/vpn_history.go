package main

import (
	"net/http"
	"sort"
	"time"
)

// What the VPN tab draws besides traffic and modes (NPM-51): once a minute the
// delay of the node each group uses now, and every update of a subscription
// with the path the download took. The core only knows the present.

const (
	groupMinuteKeep = 24 * 60
	groupHourKeep   = 7 * 24
	provLogKeep     = 60
	groupsMax       = 40
)

type proxySnapshot struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Now     string   `json:"now"`
	All     []string `json:"all"`
	Alive   bool     `json:"alive"`
	Hidden  bool     `json:"hidden"`
	History []struct {
		Delay int `json:"delay"`
	} `json:"history"`
}

// latPoint: delays of the samples in the bucket (a failed check counts in Fail,
// not in the sum) and the node used last.
type latPoint struct {
	T    int64  `json:"t"`
	Sum  int64  `json:"sum"`
	N    int    `json:"n"`
	Fail int    `json:"fail"`
	Node string `json:"node,omitempty"`
}

type groupHistory struct {
	Minutes []latPoint `json:"minutes"`
	Hours   []latPoint `json:"hours"`
}

type provUpdate struct {
	T         int64  `json:"t"`
	UpdatedAt string `json:"updated_at"`
	Total     int    `json:"total"`
	Alive     int    `json:"alive"`
	Added     int    `json:"added"`
	Via       string `json:"via,omitempty"`
}

var groupTypes = map[string]bool{"Fallback": true, "URLTest": true, "Selector": true, "LoadBalance": true}

// leafOf follows the choice of a group down to a node: the node, the delay of
// its last check (0 — it failed, -1 — never checked) and whether it was found.
func leafOf(name string, px map[string]proxySnapshot, nodes map[string]proxySnapshot) (string, int) {
	cur, ok := px[name]
	for i := 0; ok && cur.Now != "" && i < 10; i++ {
		next := cur.Now
		if p, found := px[next]; found {
			cur = p
			continue
		}
		if p, found := nodes[next]; found {
			cur = p
			break
		}
		return next, -1
	}
	if !ok {
		return "", -1
	}
	if n := len(cur.History); n > 0 {
		return cur.Name, cur.History[n-1].Delay
	}
	return cur.Name, -1
}

func addLat(list []latPoint, start int64, node string, delay int, keep int) []latPoint {
	var cur *latPoint
	if n := len(list); n > 0 && list[n-1].T == start {
		cur = &list[n-1]
	} else {
		list = append(list, latPoint{T: start})
		if len(list) > keep {
			list = list[len(list)-keep:]
		}
		cur = &list[len(list)-1]
	}
	if delay > 0 {
		cur.Sum += int64(delay)
		cur.N++
	} else {
		cur.Fail++
	}
	cur.Node = node
	return list
}

func (t *trafficCollector) observeGroups(now time.Time, px map[string]proxySnapshot, providers map[string]providerSnapshot) {
	nodes := map[string]proxySnapshot{}
	for _, p := range providers {
		for _, x := range p.Proxies {
			nodes[x.Name] = x
		}
	}
	// Подписки: the group subscriptions download through (NPM-50)
	via, _ := leafOf(routingSubs, px, nodes)
	if _, ok := px[routingSubs]; !ok {
		via = ""
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	if t.st.Groups == nil {
		t.st.Groups = map[string]*groupHistory{}
	}
	minute := now.Truncate(time.Minute).Unix()
	hour := now.Truncate(time.Hour).Unix()
	names := make([]string, 0, len(px))
	for name, g := range px {
		if groupTypes[g.Type] && !g.Hidden && name != "GLOBAL" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) > groupsMax {
		names = names[:groupsMax]
	}
	for _, name := range names {
		node, delay := leafOf(name, px, nodes)
		if delay < 0 || node == "" {
			continue
		}
		h := t.st.Groups[name]
		if h == nil {
			h = &groupHistory{}
			t.st.Groups[name] = h
		}
		if n := len(h.Minutes); n > 0 && h.Minutes[n-1].T == minute {
			continue
		}
		h.Minutes = addLat(h.Minutes, minute, node, delay, groupMinuteKeep)
		h.Hours = addLat(h.Hours, hour, node, delay, groupHourKeep)
	}
	// groups gone from the config for a week are forgotten
	for name, h := range t.st.Groups {
		if n := len(h.Hours); n == 0 || h.Hours[n-1].T < hour-7*24*3600 {
			delete(t.st.Groups, name)
		}
	}

	if t.st.ProvLog == nil {
		t.st.ProvLog = map[string][]provUpdate{}
	}
	for name, p := range providers {
		if p.VehicleType != "HTTP" || p.UpdatedAt == "" {
			continue
		}
		log := t.st.ProvLog[name]
		prev := provUpdate{}
		if n := len(log); n > 0 {
			prev = log[n-1]
			if prev.UpdatedAt == p.UpdatedAt {
				continue
			}
		}
		// the adaptive check admits nodes; the core's own flag is stale there
		alive := 0
		if p.Adaptive != nil {
			alive = working(p.Adaptive)
		} else {
			for _, x := range p.Proxies {
				if x.Alive {
					alive++
				}
			}
		}
		at := now.Unix()
		if ts, err := time.Parse(time.RFC3339Nano, p.UpdatedAt); err == nil {
			at = ts.Unix()
		}
		u := provUpdate{T: at, UpdatedAt: p.UpdatedAt, Total: len(p.Proxies), Alive: alive}
		if prev.UpdatedAt != "" {
			u.Added = u.Total - prev.Total
			// the path is known only for an update seen as it happens
			if now.Unix()-at < 180 {
				u.Via = via
			}
		}
		log = append(log, u)
		if len(log) > provLogKeep {
			log = log[len(log)-provLogKeep:]
		}
		t.st.ProvLog[name] = log
	}
	t.dirty = true
}

type latRow struct {
	T    int64  `json:"t"`
	MS   int    `json:"ms"` // average of the successful checks, 0 when none
	Fail int    `json:"fail"`
	N    int    `json:"n"`
	Node string `json:"node,omitempty"`
}

func (t *trafficCollector) groupsReport(period string, now time.Time) map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	span := map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour}[period]
	if span == 0 {
		period, span = "24h", 24*time.Hour
	}
	resolution := 60
	if span > 24*time.Hour {
		resolution = 3600
	}
	from := now.Add(-span).Unix()
	groups := map[string][]latRow{}
	for name, h := range t.st.Groups {
		src := h.Minutes
		if resolution == 3600 {
			src = h.Hours
		}
		rows := []latRow{}
		for _, p := range src {
			if p.T < from {
				continue
			}
			ms := 0
			if p.N > 0 {
				ms = int(p.Sum / int64(p.N))
			}
			rows = append(rows, latRow{T: p.T, MS: ms, Fail: p.Fail, N: p.N + p.Fail, Node: p.Node})
		}
		if len(rows) > 0 {
			groups[name] = rows
		}
	}
	logs := map[string][]provUpdate{}
	for name, l := range t.st.ProvLog {
		out := make([]provUpdate, len(l))
		copy(out, l)
		logs[name] = out
	}
	return map[string]any{"period": period, "resolution": resolution, "groups": groups, "provider_log": logs}
}

func (a *app) handleCoreGroups(w http.ResponseWriter, r *http.Request) {
	if traffic == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "учёт на роутере не запущен"})
		return
	}
	rep := traffic.groupsReport(r.URL.Query().Get("period"), time.Now())
	rep["ok"] = true
	a.writeJSON(w, http.StatusOK, rep)
}
