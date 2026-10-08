package main

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func TestDMSImportEditsOnlyValidatedProxyDraft(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "routes.yml")
	initial := schema.DefaultRoutes()
	if err := schema.SaveRoutes(file, initial); err != nil {
		t.Fatal(err)
	}
	a := &app{baseDir: dir, activeRoutesPath: file}
	w := httptest.NewRecorder()
	a.importDMSRoutes(w, httptest.NewRequest("POST", "/api/routes/import", strings.NewReader(`{"apps":[{"id":"demo","name":"Demo","upstream":{"address":"127.0.0.1","port":9000,"scheme":"http"}}]}`)))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	updated, err := schema.LoadRoutes(file)
	if err != nil || len(updated.Apps) != len(initial.Apps)+1 {
		t.Fatalf("missing imported app: %+v %v", updated, err)
	}
	backups, _ := filepath.Glob(filepath.Join(dir, "backups", "*.yml"))
	if len(backups) != 1 {
		t.Fatal("draft import did not preserve previous file")
	}
	w = httptest.NewRecorder()
	a.importDMSRoutes(w, httptest.NewRequest("POST", "/api/routes/import", strings.NewReader(`{"apps":[{"id":"","name":"Invalid"}]}`)))
	if w.Code == 200 {
		t.Fatal("invalid import accepted")
	}
	after, _ := schema.LoadRoutes(file)
	if len(after.Apps) != len(updated.Apps) {
		t.Fatal("invalid import replaced working draft")
	}
}
