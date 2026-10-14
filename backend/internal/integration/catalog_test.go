package integration

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

// The first-party catalog is what build-modules.mjs turns into manifests: every
// module built from it must pass the same checks Core runs at install.
func TestFirstPartyCatalogManifests(t *testing.T) {
	b, err := os.ReadFile("../../../integrations/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var items []struct {
		ID, Name, Description string
		Port                  int
		Pages, Paths, Data    []string
		Widgets               []Widget
		Summary               *Summary
	}
	if err := json.Unmarshal(b, &items); err != nil {
		t.Fatal(err)
	}
	for _, it := range items {
		ui := 1
		if it.Widgets != nil {
			ui = 2
		}
		pages := []Page{}
		for _, id := range it.Pages {
			p := Page{ID: id, Title: id}
			if id == "subs" {
				p.Aliases = []string{"tailscale", "olcrtc"}
			}
			pages = append(pages, p)
		}
		m := Manifest{Schema: 1, ID: it.ID, Name: it.Name, Version: "1.0.0", Arch: "arm64", CoreAPI: 1, UIAPI: ui, DataSchema: 1, DataDirectories: it.Data, Package: "homenet-" + it.ID,
			UI:      UI{Entry: "entry.js", CSS: []string{"style.css"}, Pages: pages, Widgets: it.Widgets, Summary: it.Summary},
			Backend: Backend{Endpoint: "http://127.0.0.1:" + strconv.Itoa(it.Port), Health: "/health", Paths: it.Paths, Service: "S90homenet-" + it.ID}}
		if err := m.Validate("arm64"); err != nil {
			t.Errorf("%s: %v", it.ID, err)
		}
	}
}
