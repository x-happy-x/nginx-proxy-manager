package main

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPCPersistentSnapshotHistoryAndInterruptedTask(t *testing.T) {
	m := pcTestMonitor(t)
	now := time.Now()
	h := m.hosts[0]
	h.History = []pcSample{{T: now.Unix() - 90000}, {T: now.Unix() / 60 * 60, MemUsed: 42}}
	m.tasks = []*pcTask{{ID: "interrupted", Host: "office", Status: "running", CreatedAt: now.UTC().Format(time.RFC3339), created: now}}
	if err := m.saveHosts([]pcHostConfig{h.Config}); err != nil {
		t.Fatal(err)
	}
	if err := m.saveStateLocked(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PC_DIR", m.dir)
	loaded := newPCMonitor()
	if loaded.hosts[0].Online || loaded.hosts[0].Current == nil || len(loaded.hosts[0].History) != 1 || loaded.hosts[0].History[0].MemUsed != 42 {
		t.Fatalf("lost cached state: %+v", loaded.hosts[0])
	}
	if len(loaded.tasks) != 1 || loaded.tasks[0].Status != "unknown" || len(loaded.journal.Events) != 1 {
		t.Fatal("interrupted operation was not made unknown")
	}
	// Restarting again neither resubmits nor duplicates the unknown event.
	second := newPCMonitor()
	if len(second.journal.Events) != 1 || second.tasks[0].Status != "unknown" {
		t.Fatal("duplicate event on second restore")
	}
	cfg := h.Config
	cfg.Address = "192.168.99.77"
	if err := m.saveHosts([]pcHostConfig{cfg}); err != nil {
		t.Fatal(err)
	}
	changed := newPCMonitor()
	if changed.hosts[0].Current != nil || len(changed.hosts[0].History) != 0 {
		t.Fatal("old address resurrected cached resources")
	}
}

func TestPVEPersistentTasksAreNeverReplayed(t *testing.T) {
	m := pvhActionsMonitor(t)
	now := time.Now()
	if err := m.saveHosts([]pvhHostConfig{m.hosts[0].Config}); err != nil {
		t.Fatal(err)
	}
	m.tasks = []*pvhTask{{ID: "pending", Host: "s1", Status: "running", UPID: testPVHUPID, created: now, CreatedAt: now.UTC().Format(time.RFC3339)}, {ID: "accepted", Host: "s1", Status: "accepted", created: now, CreatedAt: now.UTC().Format(time.RFC3339)}}
	if err := m.saveStateLocked(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PVE_DIR", m.dir)
	restored := newPVHMonitor()
	restored.request = func(context.Context, pvhHostConfig, string) ([]byte, error) {
		t.Fatal("restored command was replayed or polled")
		return nil, nil
	}
	restored.pollTasks()
	if len(restored.tasks) != 2 || restored.tasks[0].Status != "unknown" || restored.tasks[1].Status != "unknown" || len(restored.journal.Events) != 2 {
		t.Fatal("missing interrupted results")
	}
}

func TestMonitorCorruptStatePreservedAndRecoverable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime-state.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"tasks":`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PC_DIR", dir)
	m := newPCMonitor()
	if m.journal.storageError() == "" {
		t.Fatal("corruption hidden")
	}
	copies, _ := filepath.Glob(path + ".corrupt-*")
	if len(copies) != 1 {
		t.Fatal("damaged document not preserved")
	}
	if err := m.saveStateLocked(); err != nil {
		t.Fatal(err)
	}
	var state pcRuntimeState
	if err := readMonitorState(dir, &state); err != nil || state.Version != 1 {
		t.Fatal("could not resume persistence", err)
	}
	if m.journal.storageError() == "" {
		t.Fatal("recovery warning should stay visible during this run")
	}
}

func TestPersistentEventsTransitionsDedupAndRead(t *testing.T) {
	m := pcTestMonitor(t)
	cfg := m.hosts[0].Config
	identity := pcConnectionIdentity(cfg)
	if m.journal.connection(cfg.ID, cfg.Name, identity, true, "") {
		t.Fatal("first success should not alert")
	}
	m.journal.connection(cfg.ID, cfg.Name, identity, false, "offline")
	m.journal.connection(cfg.ID, cfg.Name, identity, false, "still offline")
	m.journal.connection(cfg.ID, cfg.Name, identity, true, "")
	m.journal.result(cfg.ID, "t1", "error", "bad")
	m.journal.result(cfg.ID, "t1", "error", "bad")
	if len(m.journal.Events) != 3 {
		t.Fatal("duplicate transition or task event")
	}
	if err := m.saveHosts([]pcHostConfig{cfg}); err != nil {
		t.Fatal(err)
	}
	if err := m.saveStateLocked(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PC_DIR", m.dir)
	restored := newPCMonitor()
	if restored.journal.connection(cfg.ID, cfg.Name, identity, true, "") {
		t.Fatal("restart duplicated recovery")
	}
	previous := pcm
	pcm = restored
	t.Cleanup(func() { pcm = previous })
	a := &app{}
	id := restored.journal.Events[0].ID
	r := httptest.NewRequest("POST", "/api/pc/events/read", strings.NewReader(fmt.Sprintf(`{"ids":[%q]}`, id)))
	w := httptest.NewRecorder()
	a.handlePC(w, r)
	if w.Code != 200 || restored.journal.Events[0].ReadAt == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	loaded := newPCMonitor()
	if loaded.journal.Events[0].ReadAt == "" || loaded.journal.document()["unread"] != 2 {
		t.Fatal("read mark was not persisted")
	}
	r = httptest.NewRequest("POST", "/api/pc/events/read", strings.NewReader(`{"all":true}`))
	w = httptest.NewRecorder()
	a.handlePC(w, r)
	if w.Code != 200 || restored.journal.document()["unread"] != 0 {
		t.Fatal("read all failed")
	}
}

func TestMonitorStateLimitsAndAtomicFailure(t *testing.T) {
	m := pcTestMonitor(t)
	now := time.Now()
	for i := 0; i < 1600; i++ {
		m.hosts[0].History = append(m.hosts[0].History, pcSample{T: now.Unix() - int64(1600-i)})
	}
	for i := 0; i < 120; i++ {
		m.tasks = append(m.tasks, &pcTask{ID: fmt.Sprint(i), Status: "done", created: now, CreatedAt: now.UTC().Format(time.RFC3339)})
	}
	for i := 0; i < 220; i++ {
		m.journal.add("office", "task_error", "error", "Error", "message", fmt.Sprint(i))
	}
	if err := m.saveStateLocked(); err != nil {
		t.Fatal(err)
	}
	if len(m.hosts[0].History) != 1440 || len(m.tasks) != 100 || len(m.journal.Events) != 200 {
		t.Fatal("state is not bounded")
	}
	path := filepath.Join(m.dir, "runtime-state.json")
	before, _ := os.ReadFile(path)
	if err := saveMonitorState(m.dir, make(chan bool)); err == nil {
		t.Fatal("accepted unserializable document")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("failed save destroyed previous document")
	}
}

func TestPCStateWritesAreMinuteBoundedAndErrorsVisible(t *testing.T) {
	m := pcTestMonitor(t)
	m.request = func(context.Context, pcHostConfig, string, bool) ([]byte, string, error) {
		return pcFixture(t, time.Now().Unix()), "", nil
	}
	m.poll(m.hosts[0])
	first := m.journal.lastSave
	if first.IsZero() {
		t.Fatal("initial snapshot not persisted")
	}
	m.poll(m.hosts[0])
	if !m.journal.lastSave.Equal(first) {
		t.Fatal("same-minute poll rewrites state")
	}
	m.request = func(context.Context, pcHostConfig, string, bool) ([]byte, string, error) {
		return nil, "", errors.New("lost")
	}
	m.poll(m.hosts[0])
	if !m.journal.lastSave.After(first) {
		t.Fatal("outage not saved immediately")
	}
	// A file instead of a directory makes writes reliably fail on every OS.
	blocked := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocked, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	m.dir = blocked
	m.journal.lastSave = time.Time{}
	m.poll(m.hosts[0])
	if m.overview()["storage_error"] == "" || m.journal.document()["storage_error"] == nil {
		t.Fatal("write failure hidden from API")
	}
}

func TestPCActionIsNotSentWhenJournalCannotBeWritten(t *testing.T) {
	m := pcTestMonitor(t)
	blocked := filepath.Join(t.TempDir(), "file")
	os.WriteFile(blocked, []byte("x"), 0600)
	m.dir = blocked
	m.request = func(context.Context, pcHostConfig, string, bool) ([]byte, string, error) {
		t.Error("command sent without durable journal")
		return nil, "", nil
	}
	_, status, err := m.submitAction(pcAction{Host: "office", Target: "wsl", Name: "Debian", Action: "start"})
	if status != 503 || err == nil || len(m.tasks) != 0 {
		t.Fatal(status, err)
	}
}
