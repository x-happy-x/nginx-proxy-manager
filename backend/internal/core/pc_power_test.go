package core

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPCPowerCredentialCannotAuthorizeOtherManagement(t *testing.T) {
	s := testServer(t, "", 401)
	dir := filepath.Join(s.Config.StateDir, "credentials")
	os.MkdirAll(dir, 0700)
	token := strings.Repeat("p", 48)
	os.WriteFile(filepath.Join(dir, "pc-power.token"), []byte(token), 0600)
	for _, tc := range []struct {
		path, method, auth, origin string
		status                     int
	}{
		{"/api/pc/power/integration", "GET", "", "", 401},
		{"/api/pc/power/integration", "GET", "Bearer wrong", "", 401},
		{"/api/pc/power/integration", "GET", "Bearer " + token, "https://evil.invalid", 403},
		{"/api/pc/power/integration", "DELETE", "Bearer " + token, "", 405},
		{"/api/pc/actions", "POST", "Bearer " + token, "", 401},
		{"/api/pc/config", "GET", "Bearer " + token, "", 401},
		{"/api/pc/power/integration", "GET", "Bearer " + token, "", 404}, // no installed PC integration
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Authorization", tc.auth)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body)
		}
	}
}
