package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func (a *app) saveLocalCA(certPEM, keyPEM string) (bool, string) {
	if err := os.MkdirAll(filepath.Dir(a.localCACert), 0o755); err != nil {
		return false, err.Error()
	}
	if err := os.WriteFile(a.localCACert, []byte(certPEM), 0o644); err != nil {
		return false, err.Error()
	}
	if err := os.WriteFile(a.localCAKey, []byte(keyPEM), 0o600); err != nil {
		return false, err.Error()
	}
	return true, "local CA saved"
}

func (a *app) hasLocalCA() bool {
	return fileExists(a.localCACert) && fileExists(a.localCAKey)
}

func sanEntry(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "DNS:") || strings.HasPrefix(value, "IP:") {
		return value
	}
	isIP := true
	for _, ch := range value {
		if (ch < '0' || ch > '9') && ch != '.' {
			isIP = false
			break
		}
	}
	if isIP {
		return "IP:" + value
	}
	return "DNS:" + value
}

func (a *app) ensureLocalCASigned(host string, sans []string, force bool) (bool, string) {
	certDir := filepath.Join(a.nginxConfRoot, "selfsigned")
	crt := filepath.Join(certDir, host+".crt")
	key := filepath.Join(certDir, host+".key")
	if fileExists(crt) && fileExists(key) && !force {
		return true, "exists"
	}
	if force {
		_ = os.Remove(crt)
		_ = os.Remove(key)
	}
	if !a.hasLocalCA() {
		return false, "local CA not found"
	}
	if err := os.MkdirAll(certDir, 0o755); err != nil {
		return false, err.Error()
	}
	csr := filepath.Join(os.TempDir(), host+".csr")
	ext := filepath.Join(os.TempDir(), host+".ext")
	altNames := []string{sanEntry(host)}
	for _, item := range sans {
		if ent := sanEntry(item); ent != "" {
			altNames = append(altNames, ent)
		}
	}
	sort.Strings(altNames)
	altNames = uniqueStrings(altNames)
	if err := os.WriteFile(ext, []byte("subjectAltName="+strings.Join(altNames, ",")+"\n"), 0o644); err != nil {
		return false, err.Error()
	}
	_, _ = runCommand("openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN="+host)
	_, _ = runCommand("openssl", "x509", "-req", "-in", csr, "-CA", a.localCACert, "-CAkey", a.localCAKey, "-CAcreateserial", "-out", crt, "-days", "825", "-sha256", "-extfile", ext)
	return true, "issued"
}

func (a *app) issueLocalCAForRoutes(force bool) (bool, string) {
	routes, err := schema.LoadRoutes(a.routesPath())
	if err != nil {
		return false, err.Error()
	}
	errorsOut := []string{}
	for _, item := range routes.Hosts {
		if strings.TrimSpace(item.Host) == "" {
			continue
		}
		ok, msg := a.ensureLocalCASigned(item.Host, item.TLS.SAN, force)
		if !ok {
			errorsOut = append(errorsOut, item.Host+": "+msg)
		}
	}
	if len(errorsOut) > 0 {
		return false, strings.Join(errorsOut, "\n")
	}
	return true, "issued"
}

func (a *app) generateLocalCA(subject map[string]string) (bool, string) {
	if err := os.MkdirAll(filepath.Dir(a.localCACert), 0o755); err != nil {
		return false, err.Error()
	}
	subj := fmt.Sprintf("/C=%s/ST=%s/L=%s/O=%s/CN=%s", subject["C"], subject["ST"], subject["L"], subject["O"], valueOr(subject["CN"], "Local CA"))
	_, _ = runCommand("openssl", "req", "-x509", "-new", "-nodes", "-keyout", a.localCAKey, "-out", a.localCACert, "-sha256", "-days", "3650", "-subj", subj)
	return true, "local CA generated"
}

func (a *app) sendPEM(w http.ResponseWriter, path, filename string) {
	body, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (a *app) listLocalCerts() []response {
	certDir := filepath.Join(a.nginxConfRoot, "selfsigned")
	entries, err := os.ReadDir(certDir)
	if err != nil {
		return []response{}
	}
	items := []response{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".crt") {
			continue
		}
		host := strings.TrimSuffix(entry.Name(), ".crt")
		items = append(items, response{
			"host":    host,
			"has_key": fileExists(filepath.Join(certDir, host+".key")),
			"path":    filepath.Join(certDir, entry.Name()),
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["host"].(string) < items[j]["host"].(string) })
	return items
}

func (a *app) deleteLocalCert(host string) bool {
	certDir := filepath.Join(a.nginxConfRoot, "selfsigned")
	removed := false
	for _, path := range []string{filepath.Join(certDir, host+".crt"), filepath.Join(certDir, host+".key")} {
		if fileExists(path) {
			_ = os.Remove(path)
			removed = true
		}
	}
	return removed
}

func (a *app) testCertificate(host string, port int) (bool, string) {
	cmd := exec.Command("sh", "-c", fmt.Sprintf("echo | openssl s_client -connect %s:%d -servername %s 2>/dev/null | openssl x509 -noout -issuer -subject -text", host, port, host))
	out, err := cmd.CombinedOutput()
	return err == nil, string(out)
}
