package launcher

import (
	"path/filepath"
	"testing"
)

// NPM-83: the repository link survives a save and must be an http(s) address.
func TestSaveKeepsRepo(t *testing.T) {
	store := Store{Path: filepath.Join(t.TempDir(), "launcher.json")}
	cfg := Config{
		Devices: []Device{{ID: "s3", Name: "Сервер S3", Kind: "server"}},
		Links:   []Link{{ID: "p3d", Title: "P3D", URL: "https://p3d.example/", Device: "s3", Repo: "https://git.example/services/p3d"}},
		Apps:    map[string]AppOverride{"bigfam": {Repo: "https://git.example/services/bigfam"}},
	}
	if err := store.Save(cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Links[0].Repo != cfg.Links[0].Repo || loaded.Apps["bigfam"].Repo != cfg.Apps["bigfam"].Repo {
		t.Fatalf("repo lost: %+v", loaded)
	}

	cfg.Apps["bigfam"] = AppOverride{Repo: "javascript:alert(1)"}
	if err := store.Save(cfg); err == nil {
		t.Fatal("non-http repo accepted")
	}
}
