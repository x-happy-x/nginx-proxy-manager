package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type dmsApp struct {
	Name            string    `json:"name,omitempty"`
	Version         string    `json:"version,omitempty"`
	Description     string    `json:"description,omitempty"`
	Icon            string    `json:"icon,omitempty"`
	App             string    `json:"app"`
	ManifestVersion string    `json:"manifest_version,omitempty"`
	ReleaseID       string    `json:"release_id,omitempty"`
	AppliedAt       time.Time `json:"applied_at,omitempty"`
	Status          string    `json:"status"`
	HealthcheckURL  string    `json:"healthcheck_url,omitempty"`
	ServiceInitName string    `json:"service_init_name,omitempty"`
	RouteApps       []string  `json:"route_apps,omitempty"`
	Hosts           []string  `json:"hosts,omitempty"`
	Artifacts       []string  `json:"artifacts,omitempty"`
	ReleaseCount    int       `json:"release_count"`
	Metadata        bool      `json:"metadata"`
}

func listDMSApps(root string) ([]dmsApp, error) {
	appsDir := filepath.Join(root, "apps")
	entries, err := os.ReadDir(appsDir)
	if os.IsNotExist(err) {
		return []dmsApp{}, nil
	}
	if err != nil {
		return nil, err
	}

	items := make([]dmsApp, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		appDir := filepath.Join(appsDir, entry.Name())
		item := dmsApp{App: entry.Name(), Status: "managed"}
		if body, readErr := os.ReadFile(filepath.Join(appDir, "meta", "current.json")); readErr == nil {
			if json.Unmarshal(body, &item) == nil {
				item.Metadata = true
			}
		}
		releases, readErr := os.ReadDir(filepath.Join(appDir, "releases"))
		if readErr == nil {
			item.ReleaseCount = countReleaseDirs(releases)
			if item.ReleaseID == "" {
				item.ReleaseID, item.AppliedAt = latestRelease(filepath.Join(appDir, "releases"), releases)
			}
		}
		if item.App == "" {
			item.App = entry.Name()
		}
		if item.Status == "" {
			item.Status = "managed"
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].App < items[j].App })
	return items, nil
}

func countReleaseDirs(entries []os.DirEntry) int {
	count := 0
	for _, entry := range entries {
		if entry.IsDir() {
			count++
		}
	}
	return count
}

func latestRelease(dir string, entries []os.DirEntry) (string, time.Time) {
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	if len(names) == 0 {
		return "", time.Time{}
	}
	info, err := os.Stat(filepath.Join(dir, names[0]))
	if err != nil {
		return names[0], time.Time{}
	}
	return names[0], info.ModTime().UTC()
}

func dmsServiceVersion(path string) string {
	output, err := exec.Command(path, "version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}
