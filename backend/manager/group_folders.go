package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

type groupFolder struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Groups []string `json:"groups"`
}
type groupFoldersSnapshot struct {
	Revision string        `json:"revision"`
	Folders  []groupFolder `json:"folders"`
}

var groupFoldersMu sync.Mutex
var errGroupFoldersConflict = errors.New("Папки изменились в другой вкладке. Обновите список перед сохранением.")

func validateGroupFolders(folders []groupFolder) error {
	nodes := make([]nodeFolder, len(folders))
	for i, f := range folders {
		nodes[i] = nodeFolder{ID: f.ID, Name: f.Name, Nodes: f.Groups}
	}
	if err := validateNodeFolders(nodes); err != nil {
		return err
	}
	assigned := map[string]string{}
	for i, f := range nodes {
		for _, g := range f.Nodes {
			if previous, ok := assigned[g]; ok {
				return fmt.Errorf("группа %s уже в папке %s", g, previous)
			}
			assigned[g] = f.Name
		}
		folders[i].Name = f.Name
		folders[i].Groups = f.Nodes
	}
	return nil
}
func readGroupFolders() (groupFoldersSnapshot, error) {
	raw, err := os.ReadFile(filepath.Join(coreStateDir(), "group-folders.json"))
	if errors.Is(err, os.ErrNotExist) {
		raw = []byte("[]\n")
	} else if err != nil {
		return groupFoldersSnapshot{}, err
	}
	folders := []groupFolder{}
	if err = json.Unmarshal(raw, &folders); err != nil {
		return groupFoldersSnapshot{}, fmt.Errorf("не удалось прочитать папки: %w", err)
	}
	if folders == nil {
		folders = []groupFolder{}
	}
	if err = validateGroupFolders(folders); err != nil {
		return groupFoldersSnapshot{}, err
	}
	return groupFoldersSnapshot{Revision: configSHA(raw), Folders: folders}, nil
}
func writeGroupFolders(revision string, folders []groupFolder) (groupFoldersSnapshot, error) {
	groupFoldersMu.Lock()
	defer groupFoldersMu.Unlock()
	current, err := readGroupFolders()
	if err != nil {
		return current, err
	}
	if revision != current.Revision {
		return current, errGroupFoldersConflict
	}
	if err = validateGroupFolders(folders); err != nil {
		return current, err
	}
	if folders == nil {
		folders = []groupFolder{}
	}
	raw, err := json.MarshalIndent(folders, "", "  ")
	if err != nil {
		return current, err
	}
	raw = append(raw, '\n')
	if err = os.MkdirAll(coreStateDir(), 0o750); err != nil {
		return current, err
	}
	f, err := os.CreateTemp(coreStateDir(), ".group-folders-*")
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
	if err = os.Rename(f.Name(), filepath.Join(coreStateDir(), "group-folders.json")); err != nil {
		return current, err
	}
	return groupFoldersSnapshot{Revision: configSHA(raw), Folders: folders}, nil
}
func (a *app) handleGroupFolders(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		groupFoldersMu.Lock()
		snapshot, err := readGroupFolders()
		groupFoldersMu.Unlock()
		if err != nil {
			a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, 200, snapshot)
		return
	}
	var req groupFoldersSnapshot
	if !a.decodeJSON(w, r, &req) {
		return
	}
	snapshot, err := writeGroupFolders(req.Revision, req.Folders)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errGroupFoldersConflict) {
			status = http.StatusConflict
		}
		a.writeJSON(w, status, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, 200, snapshot)
}
