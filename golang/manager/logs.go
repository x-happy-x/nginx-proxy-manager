package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
)

func readLogFile(path string, limit int, contains string) ([]string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("missing log: %s", path)
	}
	lines := []string{}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimRight(line, "\n")
		if line == "" {
			continue
		}
		if contains != "" && !strings.Contains(line, contains) {
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return lines, nil
}

func (a *app) handleRouteLogs(w http.ResponseWriter, r *http.Request, errorsOnly bool) {
	limit := atoiDefault(r.URL.Query().Get("limit"), 200)
	contains := r.URL.Query().Get("filter")
	statusMin := 0
	statusMax := 0
	if errorsOnly {
		statusMin = 400
	} else {
		switch r.URL.Query().Get("status_group") {
		case "4xx":
			statusMin = 400
			statusMax = 499
		case "5xx":
			statusMin = 500
			statusMax = 599
		}
	}
	items, err := readRouteLogs(a.routeAccessLog, limit, contains, statusMin, statusMax)
	if err != nil {
		a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true, "items": items})
}

func readRouteLogs(path string, limit int, contains string, statusMin, statusMax int) ([]map[string]any, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []map[string]any{}, nil
		}
		return nil, err
	}
	items := []map[string]any{}
	for _, line := range strings.Split(string(body), "\n") {
		if contains != "" && !strings.Contains(line, contains) {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			continue
		}
		status := atoiDefault(fmt.Sprint(obj["status"]), -1)
		if statusMin != 0 && status < statusMin {
			continue
		}
		if statusMax != 0 && status > statusMax {
			continue
		}
		items = append(items, obj)
	}
	if len(items) > limit {
		items = items[len(items)-limit:]
	}
	return items, nil
}
