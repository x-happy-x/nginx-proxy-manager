package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListDMSAppsReadsMetadataAndFallsBackToReleases(t *testing.T) {
	root := t.TempDir()
	metaDir := filepath.Join(root, "apps", "homenet", "meta")
	releaseDir := filepath.Join(root, "apps", "homenet", "releases", "20260604-120000")
	legacyRelease := filepath.Join(root, "apps", "netping", "releases", "20260603-090000")
	for _, dir := range []string{metaDir, releaseDir, legacyRelease} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	body := `{"app":"homenet","manifest_version":"1","release_id":"20260604-120000","status":"applied","hosts":["homenet.local"]}`
	if err := os.WriteFile(filepath.Join(metaDir, "current.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	items, err := listDMSApps(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("got %d apps, want 2", len(items))
	}
	if !items[0].Metadata || items[0].ReleaseID != "20260604-120000" || items[0].ReleaseCount != 1 {
		t.Fatalf("unexpected metadata app: %+v", items[0])
	}
	if items[1].Metadata || items[1].ReleaseID != "20260603-090000" || items[1].ReleaseCount != 1 {
		t.Fatalf("unexpected fallback app: %+v", items[1])
	}
}
