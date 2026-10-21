package main

// Runtime journals contain observations and results only. Restoring one must
// never resubmit a command, nor make a cached host appear online.
import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type monitorEvent struct {
	ID        string `json:"id"`
	Host      string `json:"host"`
	Kind      string `json:"kind"`
	Severity  string `json:"severity"`
	Title     string `json:"title"`
	Message   string `json:"message"`
	CreatedAt string `json:"created_at"`
	ReadAt    string `json:"read_at,omitempty"`
	Key       string `json:"key,omitempty"`
}

type monitorJournal struct {
	Events      []monitorEvent  `json:"events"`
	Connections map[string]bool `json:"connections"`
	loadWarning string
	saveError   string
	lastSave    time.Time
}

func (j *monitorJournal) storageError() string {
	return strings.TrimSpace(strings.Join([]string{j.loadWarning, j.saveError}, " "))
}

func (j *monitorJournal) add(host, kind, severity, title, message, key string) {
	for _, e := range j.Events {
		if key != "" && e.Key == key {
			return
		}
	}
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		j.saveError = "Не удалось создать идентификатор события: " + err.Error()
		return
	}
	j.Events = append(j.Events, monitorEvent{ID: hex.EncodeToString(id[:]), Host: host, Kind: kind, Severity: severity, Title: title, Message: message, CreatedAt: time.Now().UTC().Format(time.RFC3339), Key: key})
	j.prune()
}

func (j *monitorJournal) prune() {
	cutoff := time.Now().Add(-24 * time.Hour)
	next := make([]monitorEvent, 0, len(j.Events))
	for _, e := range j.Events {
		ts, err := time.Parse(time.RFC3339, e.CreatedAt)
		if err == nil && !ts.Before(cutoff) {
			next = append(next, e)
		}
	}
	if len(next) > 200 {
		next = next[len(next)-200:]
	}
	j.Events = next
}

// A first failed probe is an outage; a first successful probe is normal setup.
func (j *monitorJournal) connection(id, name, identity string, online bool, message string) bool {
	if j.Connections == nil {
		j.Connections = map[string]bool{}
	}
	key := id + "|" + identity
	previous, known := j.Connections[key]
	j.Connections[key] = online
	if known && previous == online || !known && online {
		return false
	}
	if online {
		j.add(id, "connection_restored", "info", name+": связь восстановлена", "Агент снова отвечает", "")
	} else {
		j.add(id, "connection_lost", "error", name+": нет связи", message, "")
	}
	return true
}

func (j *monitorJournal) result(host, id, status, message string) {
	if status == "error" {
		j.add(host, "task_error", "error", "Ошибка операции", message, "task:"+id+":error")
	}
	if status == "unknown" {
		j.add(host, "task_unknown", "warning", "Результат операции не подтверждён", message, "task:"+id+":unknown")
	}
}

func (j *monitorJournal) document() response {
	j.prune()
	events := make([]monitorEvent, 0, len(j.Events))
	unread := 0
	for i := len(j.Events) - 1; i >= 0; i-- {
		e := j.Events[i]
		e.Key = ""
		events = append(events, e)
		if e.ReadAt == "" {
			unread++
		}
	}
	out := response{"events": events, "unread": unread}
	if s := j.storageError(); s != "" {
		out["storage_error"] = s
	}
	return out
}

func (j *monitorJournal) markRead(ids []string, all bool) {
	selected := map[string]bool{}
	for _, id := range ids {
		selected[id] = true
	}
	stamp := time.Now().UTC().Format(time.RFC3339)
	for i := range j.Events {
		if (all || selected[j.Events[i].ID]) && j.Events[i].ReadAt == "" {
			j.Events[i].ReadAt = stamp
		}
	}
}

// Temp file + fsync + rename preserves the previous complete document on error.
func saveMonitorState(dir string, value any) error {
	if dir == "" {
		return fmt.Errorf("не задан каталог состояния")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(b) > 16<<20 {
		return fmt.Errorf("размер состояния превысил 16 МБ")
	}
	f, err := os.CreateTemp(dir, ".runtime-state-*")
	if err != nil {
		return err
	}
	path := f.Name()
	defer os.Remove(path)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(b, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(path, filepath.Join(dir, "runtime-state.json")); err != nil {
		return err
	}
	// Persist the directory entry as well on the Linux worker. Windows does
	// not support syncing a directory through os.File.
	if runtime.GOOS != "windows" {
		folder, err := os.Open(dir)
		if err != nil {
			return err
		}
		err = folder.Sync()
		closeErr := folder.Close()
		if err != nil {
			return err
		}
		return closeErr
	}
	return nil
}

func readMonitorState(dir string, value any) error {
	f, err := os.Open(filepath.Join(dir, "runtime-state.json"))
	if err != nil {
		return err
	}
	defer f.Close()
	if info, statErr := f.Stat(); statErr != nil {
		return statErr
	} else if info.Size() > 16<<20 {
		return fmt.Errorf("размер состояния превысил 16 МБ")
	}
	d := json.NewDecoder(io.LimitReader(f, (16<<20)+1))
	if err = d.Decode(value); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("лишние данные или превышение размера состояния")
	}
	return nil
}

func stateLoadError(dir string, err error) string {
	if os.IsNotExist(err) {
		return ""
	}
	// Preserve damaged evidence instead of silently replacing it.
	path := filepath.Join(dir, "runtime-state.json")
	backup := path + ".corrupt-" + time.Now().UTC().Format("20060102T150405.000000000")
	note := "Сохранённое состояние не восстановлено: " + err.Error()
	if renameErr := os.Rename(path, backup); renameErr != nil {
		note += "; копия повреждённого файла не создана: " + renameErr.Error()
	}
	return note
}

func handleMonitorEvents(a *app, w http.ResponseWriter, r *http.Request, j *monitorJournal, save func() error) {
	if strings.HasSuffix(r.URL.Path, "/events") && r.Method == http.MethodGet {
		a.writeJSON(w, 200, j.document())
		return
	}
	if !strings.HasSuffix(r.URL.Path, "/events/read") || r.Method != http.MethodPost {
		a.writeJSON(w, 405, response{"ok": false, "error": "method not allowed"})
		return
	}
	var body struct {
		IDs []string `json:"ids"`
		All bool     `json:"all"`
	}
	if err := decodePCJSON(w, r, &body); err != nil || len(body.IDs) > 200 || (!body.All && len(body.IDs) == 0) {
		a.writeJSON(w, 400, response{"ok": false, "error": "Укажите события или all"})
		return
	}
	previous := append([]monitorEvent(nil), j.Events...)
	j.markRead(body.IDs, body.All)
	if err := save(); err != nil {
		j.Events = previous
		a.writeJSON(w, 500, response{"ok": false, "error": j.storageError()})
		return
	}
	a.writeJSON(w, 200, j.document())
}
