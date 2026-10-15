package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

/*
 * History of each node's checks (NPM-71). The fork reports only a node's last
 * probe and a running total, so HomeNet keeps, for every node of an adaptive
 * subscription: its last 48 checks (time, outcome, delay) and a week by hour
 * as 168 letters — enough for the «Серверы» tiles and the side panel. About
 * 700 nodes fit in a few hundred kilobytes, gzip-compressed on disk.
 */

const (
	nodeChecksKeep = 48
	nodeWeekHours  = 7 * 24
	nodeForget     = 7 * 24 * 3600 // a node not checked for a week is dropped
)

// Outcome letters: o — opened both sites; s — silent; t — TLS failed; r —
// reset; h — a foreign answer; b — a foreign page; f — failed otherwise.
type nodeCheck struct {
	T  int64  `json:"t"`
	C  string `json:"c"`
	MS int64  `json:"ms,omitempty"`
}

// Week: one letter an hour, oldest first, the last one is hour Base (unix/3600):
// "." no check, "g" every check passed, "r" none did, "y" some did.
type nodeHist struct {
	Checks []nodeCheck `json:"k"`
	Week   string      `json:"w"`
	Base   int64       `json:"b"`
}

type nodeHistory struct {
	mu      sync.Mutex
	path    string
	P       map[string]map[string]*nodeHist `json:"p"`
	dirty   bool
	savedAt time.Time
}

var nodes *nodeHistory

func nodeHistoryPath() string { return filepath.Join(coreStateDir(), "node-history.json.gz") }

func newNodeHistory(path string) *nodeHistory {
	h := &nodeHistory{path: path, P: map[string]map[string]*nodeHist{}}
	f, err := os.Open(path)
	if err != nil {
		return h
	}
	defer f.Close()
	if zr, err := gzip.NewReader(f); err == nil {
		var saved nodeHistory
		if json.NewDecoder(zr).Decode(&saved) == nil && saved.P != nil {
			h.P = saved.P
		}
	}
	return h
}

func checkCode(r adaptiveResult) (string, int64) {
	var ms int64
	for _, p := range r.Probes {
		if p.OK && (ms == 0 || p.MS < ms) {
			ms = p.MS
		}
	}
	if r.OK {
		return "o", ms
	}
	for _, p := range r.Probes {
		if !p.OK {
			switch p.Fail {
			case "silent":
				return "s", 0
			case "tls":
				return "t", 0
			case "reset":
				return "r", 0
			case "http":
				return "h", 0
			case "body":
				return "b", 0
			}
		}
	}
	return "f", 0
}

func emptyWeek() string { return strings.Repeat(".", nodeWeekHours) }

// shift moves the week so its last letter is hour; older hours fall off.
func (n *nodeHist) shift(hour int64) {
	if len(n.Week) != nodeWeekHours {
		n.Week, n.Base = emptyWeek(), hour
		return
	}
	if hour <= n.Base {
		return
	}
	d := hour - n.Base
	if d >= nodeWeekHours {
		n.Week = emptyWeek()
	} else {
		n.Week = n.Week[d:] + strings.Repeat(".", int(d))
	}
	n.Base = hour
}

func (n *nodeHist) mark(hour int64, ok bool) {
	n.shift(hour)
	i := nodeWeekHours - 1 - int(n.Base-hour)
	if i < 0 {
		return
	}
	cur, next := n.Week[i], byte('r')
	switch {
	case cur == '.' && ok:
		next = 'g'
	case cur == '.':
		next = 'r'
	case (cur == 'g' && ok) || (cur == 'r' && !ok):
		next = cur
	default:
		next = 'y'
	}
	n.Week = n.Week[:i] + string(next) + n.Week[i+1:]
}

// observe records every node whose last probe is newer than its last record.
func (h *nodeHistory) observe(now time.Time, providers map[string]providerSnapshot) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for name, p := range providers {
		if p.Adaptive == nil || len(p.Adaptive.Results) == 0 {
			continue
		}
		prov := h.P[name]
		if prov == nil {
			prov = map[string]*nodeHist{}
			h.P[name] = prov
		}
		for node, r := range p.Adaptive.Results {
			if r.Skipped != "" || r.At.IsZero() {
				continue
			}
			n := prov[node]
			if n == nil {
				n = &nodeHist{}
				prov[node] = n
			}
			t := r.At.Unix()
			if k := len(n.Checks); k > 0 && n.Checks[k-1].T >= t {
				continue
			}
			code, ms := checkCode(r)
			n.Checks = append(n.Checks, nodeCheck{T: t, C: code, MS: ms})
			if len(n.Checks) > nodeChecksKeep {
				n.Checks = n.Checks[len(n.Checks)-nodeChecksKeep:]
			}
			n.mark(t/3600, code == "o")
			h.dirty = true
		}
		for node, n := range prov {
			if k := len(n.Checks); k == 0 || now.Unix()-n.Checks[k-1].T > nodeForget {
				delete(prov, node)
				h.dirty = true
			}
		}
	}
}

// strip: the node's last n outcome letters, oldest first.
func (h *nodeHistory) strip(provider, node string, n int) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	x := h.P[provider][node]
	if x == nil {
		return ""
	}
	c := x.Checks
	if len(c) > n {
		c = c[len(c)-n:]
	}
	var b strings.Builder
	for _, k := range c {
		b.WriteString(k.C)
	}
	return b.String()
}

// detail: a copy of the node's history, the week moved up to now.
func (h *nodeHistory) detail(provider, node string, now time.Time) (nodeHist, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	x := h.P[provider][node]
	if x == nil {
		return nodeHist{Week: emptyWeek(), Base: now.Unix() / 3600}, false
	}
	cp := nodeHist{Checks: append([]nodeCheck(nil), x.Checks...), Week: x.Week, Base: x.Base}
	cp.shift(now.Unix() / 3600)
	return cp, true
}

// save writes at most every five minutes, or at once when forced.
func (h *nodeHistory) save(force bool) {
	h.mu.Lock()
	if !h.dirty || (!force && time.Since(h.savedAt) < 5*time.Minute) {
		h.mu.Unlock()
		return
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	err := json.NewEncoder(zw).Encode(h)
	_ = zw.Close()
	h.dirty, h.savedAt = false, time.Now()
	h.mu.Unlock()
	if err != nil {
		return
	}
	tmp := h.path + ".tmp"
	if os.WriteFile(tmp, buf.Bytes(), 0o600) == nil {
		_ = os.Rename(tmp, h.path)
	}
}
