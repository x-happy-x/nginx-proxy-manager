package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

/*
 * Torrents through nodes (NPM-60): where can one download — through each node
 * ask an HTTP tracker, a UDP tracker and the DHT (the core's /torrent,
 * MIHOMO-17). Only on request: it costs a few UDP exchanges per node.
 */

const torrentTimeout = 16 * time.Second

type torrentStep struct {
	OK     bool   `json:"ok"`
	MS     int64  `json:"ms,omitempty"`
	Target string `json:"target,omitempty"`
	Error  string `json:"error,omitempty"`
}

type torrentRecord struct {
	Provider string      `json:"provider,omitempty"`
	UDP      bool        `json:"udp"`
	HTTP     torrentStep `json:"http"`
	UDPT     torrentStep `json:"udpTracker"`
	DHT      torrentStep `json:"dht"`
	T        int64       `json:"t"`
	Err      string      `json:"err,omitempty"`
}

type torrentState struct {
	mu      sync.Mutex
	path    string
	nodes   map[string]torrentRecord
	running bool
	done    int
	total   int
}

var torrents *torrentState

func (a *app) startTorrents() {
	torrents = &torrentState{path: filepath.Join(coreStateDir(), "torrents.json"), nodes: map[string]torrentRecord{}}
	if body, err := os.ReadFile(torrents.path); err == nil {
		_ = json.Unmarshal(body, &torrents.nodes)
		if torrents.nodes == nil {
			torrents.nodes = map[string]torrentRecord{}
		}
	}
}

func torrentAsk(t exitTarget) torrentRecord {
	path := strings.TrimSuffix(t.path(), "/exit") + "/torrent?timeout=" + "15000"
	rec := torrentRecord{Provider: t.Provider, T: time.Now().Unix()}
	if err := mihomoDo(http.MethodGet, path, nil, &rec, torrentTimeout+5*time.Second); err != nil {
		rec.Err = shortErr(err)
	}
	rec.Provider, rec.T = t.Provider, time.Now().Unix()
	return rec
}

func (s *torrentState) run(targets []exitTarget) bool {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return false
	}
	s.running, s.done, s.total = true, 0, len(targets)
	s.mu.Unlock()
	go func() {
		jobs := make(chan exitTarget)
		var wg sync.WaitGroup
		for i := 0; i < exitParallel; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for t := range jobs {
					rec := torrentAsk(t)
					s.mu.Lock()
					s.nodes[t.Name] = rec
					s.done++
					s.mu.Unlock()
				}
			}()
		}
		for _, t := range targets {
			jobs <- t
		}
		close(jobs)
		wg.Wait()
		s.mu.Lock()
		s.running = false
		if body, err := json.Marshal(s.nodes); err == nil {
			_ = os.MkdirAll(filepath.Dir(s.path), 0o700)
			tmp := s.path + ".tmp"
			if os.WriteFile(tmp, body, 0o600) == nil {
				_ = os.Rename(tmp, s.path)
			}
		}
		s.mu.Unlock()
	}()
	return true
}

func (s *torrentState) snapshot() response {
	s.mu.Lock()
	defer s.mu.Unlock()
	nodes := make(map[string]torrentRecord, len(s.nodes))
	for k, v := range s.nodes {
		nodes[k] = v
	}
	return response{"ok": true, "running": s.running, "done": s.done, "total": s.total, "nodes": nodes}
}

func (a *app) handleTorrentsGet(w http.ResponseWriter) {
	if torrents == nil {
		a.writeJSON(w, http.StatusOK, response{"ok": true, "nodes": map[string]torrentRecord{}})
		return
	}
	a.writeJSON(w, http.StatusOK, torrents.snapshot())
}

// POST /api/core/torrents/check {provider?, nodes?}: DIRECT always comes along —
// it is what «напрямую» in the group means.
func (a *app) handleTorrentsCheck(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string   `json:"provider"`
		Nodes    []string `json:"nodes"`
	}
	if !a.decodeJSON(w, r, &req) {
		return
	}
	if torrents == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "проверка выключена"})
		return
	}
	all, err := exitTargets()
	if err != nil {
		a.writeJSON(w, http.StatusBadGateway, response{"ok": false, "error": "ядро не ответило: " + shortErr(err)})
		return
	}
	want := map[string]bool{}
	for _, n := range req.Nodes {
		want[n] = true
	}
	pick := []exitTarget{}
	if len(want) == 0 || want["DIRECT"] {
		pick = append(pick, exitTarget{Name: "DIRECT"})
	}
	for _, t := range all {
		if (req.Provider == "" || t.Provider == req.Provider) && (len(want) == 0 || want[t.Name]) {
			pick = append(pick, t)
		}
	}
	if !torrents.run(pick) {
		a.writeJSON(w, http.StatusConflict, response{"ok": false, "error": "проверка уже идёт"})
		return
	}
	a.writeJSON(w, http.StatusAccepted, torrents.snapshot())
}
