package main

import (
	"fmt"
	"time"
)

type pcRuntimeHost struct {
	Config  pcHostConfig `json:"config"`
	Current *pcSnapshot  `json:"current"`
	History []pcSample   `json:"history"`
	Checked time.Time    `json:"checked"`
	LastOK  time.Time    `json:"last_ok"`
}
type pcRuntimeState struct {
	Version int             `json:"version"`
	Hosts   []pcRuntimeHost `json:"hosts"`
	Tasks   []*pcTask       `json:"tasks"`
	Journal monitorJournal  `json:"journal"`
}
type pvhRuntimeState struct {
	Version int            `json:"version"`
	Tasks   []*pvhTask     `json:"tasks"`
	Journal monitorJournal `json:"journal"`
}

func (m *pcMonitor) restoreState() {
	var state pcRuntimeState
	err := readMonitorState(m.dir, &state)
	if err == nil && state.Version != 1 {
		err = fmt.Errorf("неизвестная версия состояния")
	}
	if err != nil {
		m.journal.loadWarning = stateLoadError(m.dir, err)
		return
	}
	m.journal = state.Journal
	m.journal.prune()
	for _, saved := range state.Hosts {
		h := m.find(saved.Config.ID)
		if h == nil || h.Config.Address != saved.Config.Address || h.Config.Port != saved.Config.Port || h.Config.User != saved.Config.User {
			continue
		}
		h.Current = saved.Current
		h.History = saved.History
		h.Checked = saved.Checked
		h.LastOK = saved.LastOK
		h.Online = false
		h.Error = "Ожидается проверка связи после запуска"
	}
	m.tasks = state.Tasks
	changed := false
	for _, t := range m.tasks {
		if t == nil {
			continue
		}
		t.created, _ = time.Parse(time.RFC3339, t.CreatedAt)
		if t.Status == "running" {
			t.Status = "unknown"
			t.Message = "Приложение перезапущено до подтверждения результата. Команда повторно не отправляется; проверьте состояние ресурса."
			t.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			m.journal.result(t.Host, t.ID, t.Status, t.Message)
			changed = true
		}
	}
	m.pruneStateLocked()
	if changed {
		m.saveStateLocked()
	}
}

func (m *pcMonitor) pruneStateLocked() {
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, h := range m.hosts {
		next := make([]pcSample, 0, len(h.History))
		for _, p := range h.History {
			if p.T >= cutoff.Unix() && p.T <= time.Now().Add(time.Minute).Unix() {
				next = append(next, p)
			}
		}
		if len(next) > 1440 {
			next = next[len(next)-1440:]
		}
		h.History = next
	}
	tasks := make([]*pcTask, 0, len(m.tasks))
	for _, t := range m.tasks {
		if t != nil && (t.Status == "running" || !t.created.Before(cutoff)) {
			tasks = append(tasks, t)
		}
	}
	if len(tasks) > 100 {
		tasks = tasks[len(tasks)-100:]
	}
	m.tasks = tasks
	m.journal.prune()
	// Discard state for removed or changed addresses, preventing unbounded churn.
	allowed := map[string]bool{}
	for _, h := range m.hosts {
		allowed[pcConnectionKey(h.Config)] = true
	}
	for key := range m.journal.Connections {
		if !allowed[key] {
			delete(m.journal.Connections, key)
		}
	}
}

func pcConnectionIdentity(c pcHostConfig) string {
	return fmt.Sprintf("%s:%d:%s", c.Address, c.Port, c.User)
}
func pcConnectionKey(c pcHostConfig) string { return c.ID + "|" + pcConnectionIdentity(c) }
func pvhConnectionIdentity(c pvhHostConfig) string {
	return fmt.Sprintf("%s:%d:%s", c.Address, c.Port, c.User)
}

func (m *pcMonitor) saveStateLocked() error {
	m.pruneStateLocked()
	state := pcRuntimeState{Version: 1, Tasks: m.tasks, Journal: m.journal, Hosts: []pcRuntimeHost{}}
	for _, h := range m.hosts {
		state.Hosts = append(state.Hosts, pcRuntimeHost{h.Config, h.Current, h.History, h.Checked, h.LastOK})
	}
	err := saveMonitorState(m.dir, state)
	if err != nil {
		m.journal.saveError = "История и события не сохраняются: " + err.Error()
	} else {
		m.journal.saveError = ""
		m.journal.lastSave = time.Now()
	}
	return err
}

func (m *pvhMonitor) restoreState() {
	var state pvhRuntimeState
	err := readMonitorState(m.dir, &state)
	if err == nil && state.Version != 1 {
		err = fmt.Errorf("неизвестная версия состояния")
	}
	if err != nil {
		m.journal.loadWarning = stateLoadError(m.dir, err)
		return
	}
	m.journal = state.Journal
	m.journal.prune()
	m.tasks = state.Tasks
	changed := false
	for _, t := range m.tasks {
		if t == nil {
			continue
		}
		t.created, _ = time.Parse(time.RFC3339, t.CreatedAt)
		if t.Status == "running" || t.Status == "accepted" {
			t.Status = "unknown"
			t.Message = "Приложение перезапущено до подтверждения результата. Команда повторно не отправляется; проверьте состояние ресурса."
			t.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			m.journal.result(t.Host, t.ID, t.Status, t.Message)
			changed = true
		}
	}
	m.pruneStateLocked()
	if changed {
		m.saveStateLocked()
	}
}

func (m *pvhMonitor) pruneStateLocked() {
	cutoff := time.Now().Add(-24 * time.Hour)
	tasks := make([]*pvhTask, 0, len(m.tasks))
	for _, t := range m.tasks {
		if t != nil && (t.Status == "running" || !t.created.Before(cutoff)) {
			tasks = append(tasks, t)
		}
	}
	if len(tasks) > 100 {
		tasks = tasks[len(tasks)-100:]
	}
	m.tasks = tasks
	m.journal.prune()
	allowed := map[string]bool{}
	for _, h := range m.hosts {
		allowed[h.Config.ID+"|"+pvhConnectionIdentity(h.Config)] = true
	}
	for key := range m.journal.Connections {
		if !allowed[key] {
			delete(m.journal.Connections, key)
		}
	}
}

func (m *pvhMonitor) saveStateLocked() error {
	m.pruneStateLocked()
	err := saveMonitorState(m.dir, pvhRuntimeState{Version: 1, Tasks: m.tasks, Journal: m.journal})
	if err != nil {
		m.journal.saveError = "Журнал и события не сохраняются: " + err.Error()
	} else {
		m.journal.saveError = ""
		m.journal.lastSave = time.Now()
	}
	return err
}
