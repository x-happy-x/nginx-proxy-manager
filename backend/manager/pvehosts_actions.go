package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Capabilities come from the SSH forced command, whose installation explicitly
// enables each group of operations. Older agents remain read-only.
type pvhCapabilities struct {
	Control      bool     `json:"control"`
	GuestActions []string `json:"guest_actions"`
	NodeActions  []string `json:"node_actions"`
}

type pvhAction struct {
	Host    string `json:"host"`
	Target  string `json:"target"`
	Type    string `json:"type,omitempty"`
	VMID    int    `json:"vmid,omitempty"`
	Action  string `json:"action"`
	Confirm string `json:"confirm,omitempty"`
}

type pvhTask struct {
	ID        string `json:"id"`
	Host      string `json:"host"`
	Target    string `json:"target"`
	Type      string `json:"type,omitempty"`
	VMID      int    `json:"vmid,omitempty"`
	Action    string `json:"action"`
	Status    string `json:"status"`
	UPID      string `json:"upid,omitempty"`
	Message   string `json:"message,omitempty"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	created   time.Time
	config    pvhHostConfig
}

func containsPVHAction(actions []string, action string) bool {
	for _, allowed := range actions {
		if allowed == action {
			return true
		}
	}
	return false
}

func (a *app) handlePVEActions(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/pve/tasks" && r.Method == http.MethodGet {
		tasks := pvh.taskList()
		pvh.mu.Lock()
		storage := pvh.journal.storageError()
		pvh.mu.Unlock()
		a.writeJSON(w, 200, response{"tasks": tasks, "storage_error": storage})
		return
	}
	if r.URL.Path != "/api/pve/actions" || r.Method != http.MethodPost {
		a.writeJSON(w, 405, response{"ok": false, "error": "method not allowed"})
		return
	}
	var action pvhAction
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&action); err != nil {
		a.writeJSON(w, 400, response{"ok": false, "error": "Некорректная команда"})
		return
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		a.writeJSON(w, 400, response{"ok": false, "error": "Ожидается одна команда"})
		return
	}
	task, status, err := pvh.executeAction(r.Context(), action)
	if err != nil {
		a.writeJSON(w, status, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusAccepted, response{"ok": true, "task": task})
}

// validateActionLocked performs cached checks for a useful immediate response.
// The agent repeats authoritative state and membership checks before execution.
func (m *pvhMonitor) validateActionLocked(a pvhAction) (*pvhHost, int, error) {
	fail := func(code int, msg string) (*pvhHost, int, error) { return nil, code, fmt.Errorf("%s", msg) }
	if !pvhIDRe.MatchString(a.Host) {
		return fail(400, "Некорректный сервер")
	}
	h := m.find(a.Host)
	if h == nil {
		return fail(404, "Сервер не найден")
	}
	if !h.Online || h.Parsed == nil || h.Parsed.TS < time.Now().Unix()-90 || h.Parsed.TS > time.Now().Unix()+30 {
		return fail(409, "Нет свежих данных сервера; дождитесь восстановления связи")
	}
	if !h.Capabilities.Control {
		return fail(403, "Агент работает только для наблюдения; разрешите управление при его установке")
	}
	if a.Target == "node" {
		if a.Type != "" || a.VMID != 0 || (a.Action != "reboot" && a.Action != "shutdown") {
			return fail(400, "Некорректная команда сервера")
		}
		if !containsPVHAction(h.Capabilities.NodeActions, a.Action) {
			return fail(403, "Управление питанием этого сервера не разрешено")
		}
		if a.Confirm != h.Config.ID {
			return fail(400, "Для подтверждения введите идентификатор сервера")
		}
	} else if a.Target == "guest" {
		if (a.Type != "qemu" && a.Type != "lxc") || a.VMID < 100 || a.VMID > 999999999 || !containsPVHAction([]string{"start", "shutdown", "reboot", "stop"}, a.Action) {
			return fail(400, "Некорректная команда машины")
		}
		if !containsPVHAction(h.Capabilities.GuestActions, a.Action) {
			return fail(403, "Эта команда машины не разрешена агентом")
		}
		if a.Action != "start" && a.Confirm != strconv.Itoa(a.VMID) {
			return fail(400, "Для подтверждения введите номер машины")
		}
		found := false
		for _, g := range h.Parsed.Guests {
			if g.VMID != a.VMID || g.Type != a.Type {
				continue
			}
			found = true
			if g.Template {
				return fail(409, "Шаблоном нельзя управлять как запущенной машиной")
			}
			if g.Lock != "" {
				return fail(409, "Машина заблокирована операцией Proxmox: "+g.Lock)
			}
			if a.Action == "start" && g.Status != "stopped" || a.Action != "start" && g.Status != "running" {
				return fail(409, "Команда не соответствует текущему состоянию машины; обновите данные")
			}
			break
		}
		if !found {
			return fail(404, "Машина этого типа не найдена на выбранном сервере")
		}
	} else {
		return fail(400, "Неизвестная цель команды")
	}
	for _, task := range m.tasks {
		if task.Host != a.Host {
			continue
		}
		active := task.Status == "running" || ((task.Status == "accepted" || task.Status == "unknown") && time.Since(task.created) < 2*time.Minute)
		if active && (a.Target == "node" || task.Target == "node" || task.Type == a.Type && task.VMID == a.VMID) {
			return fail(409, "Для этой цели уже отправлена команда; сначала проверьте её результат")
		}
	}
	return h, 0, nil
}

func (m *pvhMonitor) executeAction(ctx context.Context, a pvhAction) (pvhTask, int, error) {
	m.mu.Lock()
	h, status, err := m.validateActionLocked(a)
	if err != nil {
		m.mu.Unlock()
		return pvhTask{}, status, err
	}
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		m.mu.Unlock()
		return pvhTask{}, 500, fmt.Errorf("Не удалось создать задачу")
	}
	now := time.Now()
	task := &pvhTask{ID: hex.EncodeToString(id[:]), Host: a.Host, Target: a.Target, Type: a.Type, VMID: a.VMID, Action: a.Action,
		Status: "running", CreatedAt: now.UTC().Format(time.RFC3339), UpdatedAt: now.UTC().Format(time.RFC3339), created: now, config: h.Config}
	m.pruneTasksLocked()
	if len(m.tasks) >= 100 {
		m.mu.Unlock()
		return pvhTask{}, 429, fmt.Errorf("Слишком много активных задач; дождитесь их завершения")
	}
	m.tasks = append(m.tasks, task)
	if err := m.saveStateLocked(); err != nil {
		m.tasks = m.tasks[:len(m.tasks)-1]
		message := m.journal.storageError()
		m.mu.Unlock()
		return pvhTask{}, 503, fmt.Errorf("Команда не отправлена: %s", message)
	}
	m.mu.Unlock()
	command := "control node " + a.Action
	if a.Target == "guest" {
		command = fmt.Sprintf("control guest %s %d %s", a.Type, a.VMID, a.Action)
	}
	b, callErr := m.fetch(ctx, task.config, command)
	var result struct {
		OK      bool   `json:"ok"`
		UPID    string `json:"upid"`
		Message string `json:"message"`
		Error   string `json:"error"`
		Unknown bool   `json:"unknown"`
	}
	decodeErr := json.Unmarshal(b, &result)
	m.mu.Lock()
	defer m.mu.Unlock()
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	switch {
	case decodeErr == nil && result.Unknown:
		task.Status, task.Message = "unknown", "Результат команды не подтверждён. Она могла выполниться; проверьте состояние перед повтором."
	case decodeErr == nil && !result.OK && result.Error != "":
		task.Status, task.Message = "error", result.Error
	case callErr != nil || decodeErr != nil:
		task.Status, task.Message = "unknown", "Связь прервалась или ответ не распознан. Команда могла выполниться; проверьте состояние перед повтором."
	case !result.OK:
		task.Status, task.Message = "error", strings.TrimSpace(result.Error)
		if task.Message == "" {
			task.Message = "Агент отклонил команду"
		}
	case result.UPID != "" && validPVHUPID(result.UPID):
		task.UPID, task.Message = result.UPID, "Команда выполняется в Proxmox"
	case result.UPID != "" || a.Target == "guest":
		task.Status, task.Message = "unknown", "Агент принял команду без корректного номера задачи; проверьте состояние машины"
	default:
		task.Status, task.Message = "accepted", "Сервер принял команду. Выполнение ещё не подтверждено; связь может пропасть."
	}
	m.journal.result(task.Host, task.ID, task.Status, task.Message)
	m.saveStateLocked()
	return *task, 0, nil
}

func validPVHUPID(upid string) bool {
	if !strings.HasPrefix(upid, "UPID:") || len(upid) > 512 || !strings.HasSuffix(upid, ":") {
		return false
	}
	for _, c := range upid {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune(":._-@!+", c)) {
			return false
		}
	}
	return strings.Count(upid, ":") == 8
}

func (m *pvhMonitor) pruneTasksLocked() {
	if len(m.tasks) < 100 {
		return
	}
	for i, t := range m.tasks {
		if t.Status != "running" && time.Since(t.created) > 2*time.Minute {
			m.tasks = append(m.tasks[:i], m.tasks[i+1:]...)
			return
		}
	}
}

func (m *pvhMonitor) taskList() []pvhTask {
	m.mu.Lock()
	defer m.mu.Unlock()
	tasks := make([]pvhTask, 0, len(m.tasks))
	for i := len(m.tasks) - 1; i >= 0; i-- {
		tasks = append(tasks, *m.tasks[i])
	}
	return tasks
}

// Only task identifiers returned by this agent for a submitted action are polled.
// Browsers cannot supply arbitrary Proxmox paths, commands or task identifiers.
func (m *pvhMonitor) pollTasks() {
	m.mu.Lock()
	active := []pvhTask{}
	for _, task := range m.tasks {
		if task.Status == "running" && task.UPID != "" {
			active = append(active, *task)
		}
	}
	m.mu.Unlock()
	for _, task := range active {
		b, err := m.fetch(workerContext, task.config, "task "+task.UPID)
		var state struct {
			OK         bool   `json:"ok"`
			Status     string `json:"status"`
			ExitStatus string `json:"exitstatus"`
			Error      string `json:"error"`
		}
		decodeErr := json.Unmarshal(b, &state)
		m.mu.Lock()
		for _, current := range m.tasks {
			if current.ID != task.ID || current.Status != "running" {
				continue
			}
			current.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			switch {
			case err != nil || decodeErr != nil || !state.OK:
				current.Message = "Результат пока недоступен; команда повторно не отправляется"
				if time.Since(current.created) > 15*time.Minute {
					current.Status = "unknown"
				}
			case state.Status == "stopped" && state.ExitStatus == "OK":
				current.Status, current.Message = "done", "Задача Proxmox завершена"
			case state.Status == "stopped" && state.ExitStatus != "":
				current.Status, current.Message = "error", state.ExitStatus
			case state.Status != "running":
				current.Status, current.Message = "unknown", "Proxmox не подтвердил результат задачи"
			default:
				current.Message = "Команда выполняется в Proxmox"
			}
			if current.Status != "running" {
				m.journal.result(current.Host, current.ID, current.Status, current.Message)
				m.saveStateLocked()
			}
			break
		}
		m.mu.Unlock()
	}
}
