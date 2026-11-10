package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

type nodeFolder struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Nodes []string `json:"nodes"`
}
type nodeFoldersSnapshot struct {
	Revision string       `json:"revision"`
	Folders  []nodeFolder `json:"folders"`
}

var nodeFoldersMu sync.Mutex
var errNodeFoldersConflict = errors.New("Папки изменились в другой вкладке. Обновите список перед сохранением.")
var nodeFolderID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func validateNodeFolders(folders []nodeFolder) error {
	if len(folders) > 100 {
		return fmt.Errorf("не больше 100 папок")
	}
	ids, names := map[string]bool{}, map[string]bool{}
	total := 0
	for i := range folders {
		f := &folders[i]
		f.Name = strings.TrimSpace(f.Name)
		if !nodeFolderID.MatchString(f.ID) || ids[f.ID] {
			return fmt.Errorf("недопустимый или повторный ID папки")
		}
		ids[f.ID] = true
		name := strings.ToLower(f.Name)
		if name == "" || utf8.RuneCountInString(f.Name) > 80 || strings.IndexFunc(name, unicode.IsControl) >= 0 || names[name] {
			return fmt.Errorf("имя папки должно быть уникальным, от 1 до 80 символов")
		}
		names[name] = true
		if len(f.Nodes) > 2000 {
			return fmt.Errorf("не больше 2000 узлов в папке")
		}
		total += len(f.Nodes)
		seen := map[string]bool{}
		clean := []string{}
		for _, n := range f.Nodes {
			if n == "" || !utf8.ValidString(n) || len(n) > 1024 || strings.IndexFunc(n, unicode.IsControl) >= 0 {
				return fmt.Errorf("недопустимое имя узла")
			}
			if !seen[n] {
				clean = append(clean, n)
				seen[n] = true
			}
		}
		f.Nodes = clean
	}
	if total > 20000 {
		return fmt.Errorf("слишком много участников папок")
	}
	return nil
}
func readNodeFolders() (nodeFoldersSnapshot, error) {
	raw, err := os.ReadFile(filepath.Join(coreStateDir(), "node-folders.json"))
	if errors.Is(err, os.ErrNotExist) {
		raw = []byte("[]\n")
	} else if err != nil {
		return nodeFoldersSnapshot{}, err
	}
	folders := []nodeFolder{}
	if err = json.Unmarshal(raw, &folders); err != nil {
		return nodeFoldersSnapshot{}, fmt.Errorf("не удалось прочитать папки: %w", err)
	}
	if folders == nil {
		folders = []nodeFolder{}
	}
	if err = validateNodeFolders(folders); err != nil {
		return nodeFoldersSnapshot{}, err
	}
	return nodeFoldersSnapshot{Revision: configSHA(raw), Folders: folders}, nil
}
func writeNodeFolders(revision string, folders []nodeFolder) (nodeFoldersSnapshot, error) {
	nodeFoldersMu.Lock()
	defer nodeFoldersMu.Unlock()
	current, err := readNodeFolders()
	if err != nil {
		return current, err
	}
	if revision != current.Revision {
		return current, errNodeFoldersConflict
	}
	if err = validateNodeFolders(folders); err != nil {
		return current, err
	}
	if folders == nil {
		folders = []nodeFolder{}
	}
	raw, err := json.MarshalIndent(folders, "", "  ")
	if err != nil {
		return current, err
	}
	raw = append(raw, '\n')
	if err = os.MkdirAll(coreStateDir(), 0o750); err != nil {
		return current, err
	}
	f, err := os.CreateTemp(coreStateDir(), ".node-folders-*")
	if err != nil {
		return current, err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return current, err
	}
	if err = f.Close(); err != nil {
		return current, err
	}
	if err = os.Rename(f.Name(), filepath.Join(coreStateDir(), "node-folders.json")); err != nil {
		return current, err
	}
	return nodeFoldersSnapshot{Revision: configSHA(raw), Folders: folders}, nil
}
func (a *app) handleNodeFolders(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		nodeFoldersMu.Lock()
		snapshot, err := readNodeFolders()
		nodeFoldersMu.Unlock()
		if err != nil {
			a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, 200, snapshot)
		return
	}
	var req nodeFoldersSnapshot
	if !a.decodeJSON(w, r, &req) {
		return
	}
	snapshot, err := writeNodeFolders(req.Revision, req.Folders)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errNodeFoldersConflict) {
			status = http.StatusConflict
		}
		a.writeJSON(w, status, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, 200, snapshot)
}
