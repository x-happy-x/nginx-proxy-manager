package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
 * Exit countries (NPM-59): through every node ask where its traffic leaves
 * for the internet — country, city, IP, operator. The core's
 * /proxies/{name}/exit (MIHOMO-16) does the asking; HomeNet decides which
 * nodes and when: new ones as they appear, all of them at night, any on
 * request. Names lie («🇫🇲 ОБХОД»), so the UI shows the fact next to them.
 */

const (
	exitTimeout     = 8 * time.Second
	exitParallel    = 6
	exitKeepMissing = 14 * 24 * 3600
	exitNewBatch    = 80
)

type exitRecord struct {
	Provider string `json:"provider,omitempty"`
	CC       string `json:"cc,omitempty"`
	Country  string `json:"country,omitempty"`
	City     string `json:"city,omitempty"`
	IP       string `json:"ip,omitempty"`
	ISP      string `json:"isp,omitempty"`
	AS       string `json:"as,omitempty"`
	Source   string `json:"source,omitempty"`
	MS       int64  `json:"ms,omitempty"`
	T        int64  `json:"t"`
	OK       bool   `json:"ok"`
	Err      string `json:"err,omitempty"`
	// Seen: the last time the node was in the core, to forget removed ones.
	Seen int64 `json:"seen"`
}

type exitStore struct {
	Nodes    map[string]exitRecord `json:"nodes"`
	LastFull int64                 `json:"last_full"`
}

type exitState struct {
	mu      sync.Mutex
	path    string
	st      exitStore
	running bool
	done    int
	total   int
	reason  string
	started int64
}

var exits *exitState

// exitTarget is one node to ask: in a provider, or a top-level proxy.
type exitTarget struct {
	Provider string
	Name     string
}

func (t exitTarget) path() string {
	if t.Provider == "" {
		return "/proxies/" + url.PathEscape(t.Name) + "/exit"
	}
	return "/providers/proxies/" + url.PathEscape(t.Provider) + "/" + url.PathEscape(t.Name) + "/exit"
}

func exitsPath() string { return filepath.Join(coreStateDir(), "exits.json") }

func (a *app) startExits() {
	exits = &exitState{path: exitsPath(), st: exitStore{Nodes: map[string]exitRecord{}}}
	if body, err := os.ReadFile(exits.path); err == nil {
		_ = json.Unmarshal(body, &exits.st)
		if exits.st.Nodes == nil {
			exits.st.Nodes = map[string]exitRecord{}
		}
	}
	if os.Getenv("MAINTENANCE_DISABLED") == "1" || os.Getenv("MIHOMO_TRAFFIC_DISABLED") == "1" {
		return
	}
	managedGo(exits.loop)
}

func (e *exitState) saveLocked() {
	body, err := json.Marshal(e.st)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(e.path), 0o700)
	tmp := e.path + ".tmp"
	if os.WriteFile(tmp, body, 0o600) == nil {
		_ = os.Rename(tmp, e.path)
	}
}

// exitTargets lists every node the core has: provider nodes and top-level
// proxies that lead somewhere (no groups, DIRECT, REJECT or DNS).
func exitTargets() ([]exitTarget, error) {
	var provs struct {
		Providers map[string]struct {
			VehicleType string `json:"vehicleType"`
			Proxies     []struct {
				Name string `json:"name"`
				Type string `json:"type"`
			} `json:"proxies"`
		} `json:"providers"`
	}
	if err := mihomoDo(http.MethodGet, "/providers/proxies", nil, &provs, 20*time.Second); err != nil {
		return nil, err
	}
	var all struct {
		Proxies map[string]struct {
			Type string   `json:"type"`
			All  []string `json:"all"`
		} `json:"proxies"`
	}
	if err := mihomoDo(http.MethodGet, "/proxies", nil, &all, 20*time.Second); err != nil {
		return nil, err
	}
	var out []exitTarget
	seen := map[string]bool{}
	for prov, p := range provs.Providers {
		if p.VehicleType == "Compatible" {
			continue
		}
		for _, x := range p.Proxies {
			if exitSkipType(x.Type) || seen[x.Name] {
				continue
			}
			seen[x.Name] = true
			out = append(out, exitTarget{Provider: prov, Name: x.Name})
		}
	}
	for name, x := range all.Proxies {
		if len(x.All) > 0 || exitSkipType(x.Type) || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, exitTarget{Name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Provider+"\x00"+out[i].Name < out[j].Provider+"\x00"+out[j].Name })
	return out, nil
}

func exitSkipType(t string) bool {
	switch strings.ToLower(t) {
	case "direct", "reject", "rejectdrop", "dns", "pass", "compatible":
		return true
	}
	return false
}

func exitAsk(t exitTarget) exitRecord {
	var res struct {
		Country     string `json:"country"`
		CountryName string `json:"countryName"`
		City        string `json:"city"`
		IP          string `json:"ip"`
		ISP         string `json:"isp"`
		AS          string `json:"as"`
		Source      string `json:"source"`
		MS          int64  `json:"ms"`
	}
	q := "?timeout=" + strconv.Itoa(int(exitTimeout/time.Millisecond))
	now := time.Now().Unix()
	rec := exitRecord{Provider: t.Provider, T: now, Seen: now}
	if err := mihomoDo(http.MethodGet, t.path()+q, nil, &res, exitTimeout+5*time.Second); err != nil {
		rec.Err = shortErr(err)
		return rec
	}
	rec.OK = true
	rec.CC, rec.Country, rec.City, rec.IP, rec.ISP, rec.AS, rec.Source, rec.MS = strings.ToUpper(res.Country), res.CountryName, res.City, res.IP, res.ISP, res.AS, res.Source, res.MS
	return rec
}

// run asks the targets, several at a time. A failed answer keeps the last
// known country: the node may just be silent right now.
func (e *exitState) run(targets []exitTarget, reason string, full bool) bool {
	e.mu.Lock()
	if e.running {
		e.mu.Unlock()
		return false
	}
	e.running, e.done, e.total, e.reason, e.started = true, 0, len(targets), reason, time.Now().Unix()
	e.mu.Unlock()
	managedGo(func() {
		jobs := make(chan exitTarget)
		var wg sync.WaitGroup
		for i := 0; i < exitParallel; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for t := range jobs {
					rec := exitAsk(t)
					e.mu.Lock()
					if old, ok := e.st.Nodes[t.Name]; ok && !rec.OK && old.CC != "" {
						old.OK, old.Err, old.T, old.Seen, old.Provider = false, rec.Err, rec.T, rec.Seen, rec.Provider
						rec = old
					}
					e.st.Nodes[t.Name] = rec
					e.done++
					e.mu.Unlock()
				}
			}()
		}
		for _, t := range targets {
			jobs <- t
		}
		close(jobs)
		wg.Wait()
		e.mu.Lock()
		e.running = false
		if full {
			e.st.LastFull = time.Now().Unix()
		}
		e.saveLocked()
		e.mu.Unlock()
	})
	return true
}

// pending: nodes never asked, and the bookkeeping of which still exist.
func (e *exitState) pending(targets []exitTarget, now int64) []exitTarget {
	e.mu.Lock()
	defer e.mu.Unlock()
	present := map[string]bool{}
	var fresh []exitTarget
	for _, t := range targets {
		present[t.Name] = true
		rec, ok := e.st.Nodes[t.Name]
		if !ok {
			fresh = append(fresh, t)
			continue
		}
		rec.Seen, rec.Provider = now, t.Provider
		e.st.Nodes[t.Name] = rec
	}
	for name, rec := range e.st.Nodes {
		if !present[name] && now-rec.Seen > exitKeepMissing {
			delete(e.st.Nodes, name)
		}
	}
	if len(fresh) > exitNewBatch {
		fresh = fresh[:exitNewBatch]
	}
	return fresh
}

// loop: new nodes every 10 minutes, everything once a night (3–5 h local).
func (e *exitState) loop() {
	if !workerWait(2 * time.Minute) {
		return
	}
	for {
		if targets, err := exitTargets(); err == nil {
			now := time.Now()
			fresh := e.pending(targets, now.Unix())
			e.mu.Lock()
			lastFull := e.st.LastFull
			e.mu.Unlock()
			if h := now.Hour(); h >= 3 && h < 5 && now.Unix()-lastFull > 20*3600 {
				e.run(targets, "ночная проверка", true)
			} else if len(fresh) > 0 {
				e.run(fresh, "новые узлы", false)
			}
		}
		if !workerWait(10 * time.Minute) {
			return
		}
	}
}

func (e *exitState) snapshot() response {
	e.mu.Lock()
	defer e.mu.Unlock()
	nodes := make(map[string]exitRecord, len(e.st.Nodes))
	for k, v := range e.st.Nodes {
		nodes[k] = v
	}
	return response{
		"running": e.running, "done": e.done, "total": e.total, "reason": e.reason, "started": e.started,
		"last_full": e.st.LastFull, "nodes": nodes,
	}
}

func (a *app) handleExitsGet(w http.ResponseWriter) {
	if exits == nil {
		a.writeJSON(w, http.StatusOK, response{"ok": true, "nodes": map[string]exitRecord{}})
		return
	}
	snap := exits.snapshot()
	snap["ok"] = true
	a.writeJSON(w, http.StatusOK, snap)
}

// POST /api/core/exits/check {provider?, nodes?}: all nodes, one provider's, or the named ones.
func (a *app) handleExitsCheck(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string   `json:"provider"`
		Nodes    []string `json:"nodes"`
	}
	if !a.decodeJSON(w, r, &req) {
		return
	}
	if exits == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "проверка выключена"})
		return
	}
	targets, err := exitTargets()
	if err != nil {
		a.writeJSON(w, http.StatusBadGateway, response{"ok": false, "error": "ядро не ответило: " + shortErr(err)})
		return
	}
	want := map[string]bool{}
	for _, n := range req.Nodes {
		want[n] = true
	}
	var pick []exitTarget
	for _, t := range targets {
		if (req.Provider == "" || t.Provider == req.Provider) && (len(want) == 0 || want[t.Name]) {
			pick = append(pick, t)
		}
	}
	if len(pick) == 0 {
		a.writeJSON(w, http.StatusNotFound, response{"ok": false, "error": "таких узлов в ядре нет"})
		return
	}
	reason := "по кнопке"
	if !exits.run(pick, reason, req.Provider == "" && len(want) == 0) {
		a.writeJSON(w, http.StatusConflict, response{"ok": false, "error": "проверка уже идёт"})
		return
	}
	snap := exits.snapshot()
	snap["ok"] = true
	a.writeJSON(w, http.StatusAccepted, snap)
}
