package core

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/access"
)

func TestDMSCatalogWithoutProxyPreservesACLAndOfflineSnapshot(t *testing.T) {
	s := testServer(t, "admin", 204)
	s.Config.DMSTokenFile = filepath.Join(s.Config.StateDir, "dms-token")
	os.WriteFile(s.Config.DMSTokenFile, []byte("private-test-token"), 0600)
	dms := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-test-token" || r.URL.Path != "/v1/apps" {
			w.WriteHeader(401)
			return
		}
		w.Write([]byte(`{"items":[{"portal_apps":[{"id":"demo","name":"Demo","upstream":{"address":"127.0.0.1","port":9000,"scheme":"http"}}]}]}`))
	}))
	s.Config.DMSURL = dms.URL
	doc, _, _, err := s.portalDocument(Identity{Login: "admin", Admin: true}, access.Config{})
	if err != nil || len(doc.Apps) != 1 {
		t.Fatalf("DMS application missing without Proxy: %+v %v", doc, err)
	}
	dms.Close()
	doc, _, _, err = s.portalDocument(Identity{Login: "admin", Admin: true}, access.Config{})
	if err != nil || len(doc.Apps) != 1 {
		t.Fatalf("DMS outage lost cached catalog: %+v %v", doc, err)
	}
	doc, _, _, err = s.portalDocument(Identity{Login: "guest"}, access.Config{})
	if err != nil || len(doc.Apps) != 0 {
		t.Fatal("DMS catalog bypassed application ACL")
	}
}
