package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type pcAction struct {
	Host    string `json:"host"`
	Target  string `json:"target"`
	Context string `json:"context,omitempty"`
	ID      string `json:"id,omitempty"`
	Name    string `json:"name,omitempty"`
	Action  string `json:"action"`
	Confirm string `json:"confirm,omitempty"`
}

type pcTask struct {
	ID         string `json:"id"`
	Host       string `json:"host"`
	Target     string `json:"target"`
	Context    string `json:"context,omitempty"`
	ResourceID string `json:"resource_id,omitempty"`
	Name       string `json:"name,omitempty"`
	Action     string `json:"action"`
	Status     string `json:"status"`
	Message    string `json:"message,omitempty"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
	created    time.Time
	config     pcHostConfig
}

var pcContainerID = regexp.MustCompile(`^[a-f0-9]{64}$`)

func pcIncludes(actions []string, action string) bool {
	for _, value := range actions {
		if value == action {
			return true
		}
	}
	return false
}

func (m *pcMonitor) validateActionLocked(a pcAction) (*pcHost, string, int, error) {
	fail := func(status int, msg string) (*pcHost, string, int, error) {
		return nil, "", status, fmt.Errorf("%s", msg)
	}
	if !pvhIDRe.MatchString(a.Host) {
		return fail(400, "Некорректный компьютер")
	}
	h := m.find(a.Host)
	if h == nil {
		return fail(404, "Компьютер не найден")
	}
	if !h.Online || h.Current == nil || h.Current.TS < time.Now().Unix()-120 || h.Current.TS > time.Now().Unix()+30 {
		return fail(409, "Нет свежих данных компьютера; восстановите связь с агентом")
	}
	s := h.Current
	name := ""
	found := false
	switch a.Target {
	case "wsl":
		if s.OS != "windows" || a.Context != "" || a.ID != "" || a.Name == "" || len(a.Name) > 256 || !pcIncludes([]string{"start", "terminate"}, a.Action) {
			return fail(400, "Некорректная команда WSL")
		}
		if !pcIncludes(s.Capabilities.WSLActions, a.Action) {
			return fail(403, "Управление WSL не разрешено для ключа агента")
		}
		for _, d := range s.WSL {
			if d.Name == a.Name {
				found = true
				name = d.Name
				if a.Action == "start" && d.State != "stopped" || a.Action == "terminate" && d.State != "running" {
					return fail(409, "Команда не соответствует текущему состоянию WSL")
				}
				break
			}
		}
	case "docker":
		if !pcContainerID.MatchString(a.ID) || a.Name != "" || !pcIncludes([]string{"start", "stop", "restart"}, a.Action) {
			return fail(400, "Некорректная команда Docker")
		}
		if !pcIncludes(s.Capabilities.DockerActions, a.Action) {
			return fail(403, "Управление Docker не разрешено для ключа агента")
		}
		for _, engine := range s.Docker {
			if engine.Context != a.Context {
				continue
			}
			if !engine.Available {
				return fail(409, "Docker в выбранном окружении недоступен")
			}
			for _, c := range engine.Containers {
				if c.ID != a.ID {
					continue
				}
				found = true
				name = c.Name
				if a.Action == "start" && c.State != "exited" && c.State != "created" || a.Action != "start" && c.State != "running" {
					return fail(409, "Команда не соответствует текущему состоянию контейнера")
				}
				break
			}
			break
		}
	default:
		return fail(400, "Неизвестная цель команды")
	}
	if !found {
		return fail(404, "Ресурс не найден в выбранном окружении компьютера")
	}
	if a.Action != "start" && a.Confirm != name {
		return fail(400, "Для подтверждения введите точное имя ресурса")
	}
	for _, task := range m.tasks {
		if task.Host != a.Host {
			continue
		}
		active := task.Status == "running" || (task.Status == "unknown" && time.Since(task.created) < 2*time.Minute)
		same := task.Target == a.Target && (a.Target == "wsl" && task.Name == name || a.Target == "docker" && task.Context == a.Context && task.ResourceID == a.ID)
		dependent := task.Target == "wsl" && a.Context == "wsl:"+task.Name || a.Target == "wsl" && task.Context == "wsl:"+name
		if active && (same || dependent) {
			return fail(409, "Для этого ресурса уже отправлена команда; сначала проверьте результат")
		}
	}
	return h, name, 0, nil
}

func (m *pcMonitor) submitAction(a pcAction) (pcTask, int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h, name, status, err := m.validateActionLocked(a)
	if err != nil {
		return pcTask{}, status, err
	}
	if len(m.tasks) >= 100 {
		for i, t := range m.tasks {
			if t.Status != "running" && time.Since(t.created) > 2*time.Minute {
				m.tasks = append(m.tasks[:i], m.tasks[i+1:]...)
				break
			}
		}
	}
	if len(m.tasks) >= 100 {
		return pcTask{}, 429, fmt.Errorf("Дождитесь завершения активных задач")
	}
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		return pcTask{}, 500, fmt.Errorf("Не удалось создать задачу")
	}
	now := time.Now()
	task := &pcTask{ID: hex.EncodeToString(id[:]), Host: a.Host, Target: a.Target, Context: a.Context, ResourceID: a.ID, Name: name, Action: a.Action, Status: "running", Message: "Команда отправляется агенту", CreatedAt: now.UTC().Format(time.RFC3339), UpdatedAt: now.UTC().Format(time.RFC3339), created: now, config: h.Config}
	m.tasks = append(m.tasks, task)
	if err := m.saveStateLocked(); err != nil {
		m.tasks = m.tasks[:len(m.tasks)-1]
		return pcTask{}, 503, fmt.Errorf("Команда не отправлена: %s", m.journal.storageError())
	}
	// Strip UI-only fields before sending a small structured command to the agent.
	payload := map[string]string{"target": a.Target, "action": a.Action}
	if a.Target == "wsl" {
		payload["name"] = a.Name
	} else {
		payload["context"], payload["id"] = a.Context, a.ID
	}
	b, _ := json.Marshal(payload)
	command := "control " + base64.RawURLEncoding.EncodeToString(b)
	managedGo(func() { m.runTask(task, command) })
	return *task, 0, nil
}

func (m *pcMonitor) runTask(task *pcTask, command string) {
	b, _, callErr := m.fetch(workerContext, task.config, command, false)
	var result struct {
		OK      bool   `json:"ok"`
		Unknown bool   `json:"unknown"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	decodeErr := json.Unmarshal(b, &result)
	m.mu.Lock()
	defer m.mu.Unlock()
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	switch {
	case decodeErr == nil && result.Unknown:
		task.Status, task.Message = "unknown", "Результат не подтверждён. Команда могла выполниться; проверьте состояние перед повтором."
	case decodeErr == nil && !result.OK && result.Error != "":
		task.Status, task.Message = "error", result.Error
	case callErr != nil || decodeErr != nil:
		task.Status, task.Message = "unknown", "Связь прервалась или ответ не распознан. Команда могла выполниться; проверьте состояние перед повтором."
	case !result.OK:
		task.Status, task.Message = "error", "Агент отклонил команду"
	default:
		task.Status, task.Message = "done", strings.TrimSpace(result.Message)
		if task.Message == "" {
			task.Message = "Команда выполнена; состояние обновится при следующем опросе"
		}
	}
	m.journal.result(task.Host, task.ID, task.Status, task.Message)
	m.saveStateLocked()
}

func (m *pcMonitor) taskList() []pcTask {
	m.mu.Lock()
	defer m.mu.Unlock()
	tasks := make([]pcTask, 0, len(m.tasks))
	for i := len(m.tasks) - 1; i >= 0; i-- {
		tasks = append(tasks, *m.tasks[i])
	}
	return tasks
}

func (a *app) handlePCActions(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/pc/tasks" && r.Method == http.MethodGet {
		tasks := pcm.taskList()
		pcm.mu.Lock()
		storage := pcm.journal.storageError()
		pcm.mu.Unlock()
		a.writeJSON(w, 200, response{"tasks": tasks, "storage_error": storage})
		return
	}
	if r.URL.Path != "/api/pc/actions" || r.Method != http.MethodPost {
		a.writeJSON(w, 405, response{"ok": false, "error": "method not allowed"})
		return
	}
	var action pcAction
	if err := decodePCJSON(w, r, &action); err != nil {
		a.writeJSON(w, 400, response{"ok": false, "error": "Некорректная команда"})
		return
	}
	task, status, err := pcm.submitAction(action)
	if err != nil {
		a.writeJSON(w, status, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, 202, response{"ok": true, "task": task})
}
