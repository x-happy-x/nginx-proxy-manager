package core

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLMSEgressCredentialIsReadOnlyAndScoped(t *testing.T) {
	s := testServer(t, "", 401)
	dir := filepath.Join(s.Config.StateDir, "credentials")
	os.MkdirAll(dir, 0700)
	token := strings.Repeat("l", 48)
	os.WriteFile(filepath.Join(dir, "lms-egress.token"), []byte(token), 0600)
	for _, tc := range []struct {
		path, method, auth, origin string
		status                     int
	}{
		{"/api/lms/egress?node=homeapps", "GET", "", "", 401},
		{"/api/lms/egress?node=homeapps", "GET", "Bearer wrong", "", 401},
		{"/api/lms/egress?node=homeapps", "GET", "Bearer " + token, "https://evil.invalid", 403},
		{"/api/lms/egress?node=homeapps", "POST", "Bearer " + token, "", 405},
		{"/api/lms/egress?node=../secret", "GET", "Bearer " + token, "", 400},
		{"/api/lms/egress?node=home&node=other", "GET", "Bearer " + token, "", 400},
		{"/api/mihomo/configs", "PUT", "Bearer " + token, "", 401},
		{"/api/lms/egress?node=homeapps&host=example.test", "GET", "Bearer " + token, "", 404},
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
