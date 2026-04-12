package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func (a *app) ensureStubCert(certDir string) (string, string) {
	crt := filepath.Join(certDir, "stub.crt")
	key := filepath.Join(certDir, "stub.key")
	if fileExists(crt) && fileExists(key) {
		return crt, key
	}
	_ = os.MkdirAll(certDir, 0o755)
	_, _ = runCommand("openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", key, "-out", crt, "-days", "365", "-subj", "/CN=stub")
	return crt, key
}

func (a *app) applyStubConfig(payload map[string]any) (bool, string) {
	var routes schema.Routes
	body, _ := json.Marshal(payload)
	_ = json.Unmarshal(body, &routes)
	routes = schema.NormalizeRoutes(routes)
	if routes.Globals.Stub.Enabled == nil || !*routes.Globals.Stub.Enabled {
		return true, "stub disabled"
	}
	listenIPs := routes.Globals.ListenIPs
	if len(listenIPs) == 0 {
		listenIPs = schema.ParseListenIPs(a.nginxListenIPs)
	}
	httpPorts := append([]int{routes.Globals.Ports.HTTP}, routes.Globals.Ports.HTTPExtra...)
	httpsPorts := append([]int{routes.Globals.Ports.HTTPS}, routes.Globals.Ports.HTTPSExtra...)
	crt, key := a.ensureStubCert(filepath.Join(a.nginxConfRoot, "selfsigned"))
	listens80 := []string{}
	for _, port := range uniquePorts(httpPorts) {
		listens80 = append(listens80, listenLines(port, listenIPs, " default_server")...)
	}
	listens443 := []string{}
	for _, port := range uniquePorts(httpsPorts) {
		listens443 = append(listens443, listenLines(port, listenIPs, " ssl default_server")...)
	}
	content := fmt.Sprintf(`server {
%s
    server_name _;
    root %s;
    index index.html;
    access_log /opt/var/log/nginx/stub_access.log;
    error_log  /opt/var/log/nginx/stub_error.log;
    location / {
        try_files $uri $uri/ =404;
    }
}

server {
%s
    server_name _;
    ssl_certificate %s;
    ssl_certificate_key %s;
    root %s;
    index index.html;
    access_log /opt/var/log/nginx/stub_access.log;
    error_log  /opt/var/log/nginx/stub_error.log;
    location / {
        try_files $uri $uri/ =404;
    }
}
`, strings.Join(listens80, "\n"), routes.Globals.Stub.Root, strings.Join(listens443, "\n"), crt, key, routes.Globals.Stub.Root)
	confDir := filepath.Join(a.nginxConfRoot, "conf.d")
	if err := os.MkdirAll(confDir, 0o755); err != nil {
		return false, err.Error()
	}
	if err := os.WriteFile(filepath.Join(confDir, "stub.conf"), []byte(content), 0o644); err != nil {
		return false, err.Error()
	}
	return true, "stub applied"
}

func uniquePorts(values []int) []int {
	seen := map[int]struct{}{}
	out := []int{}
	for _, item := range values {
		port := schema.NormalizePort(item, 0)
		if port == 0 {
			continue
		}
		if _, ok := seen[port]; ok {
			continue
		}
		seen[port] = struct{}{}
		out = append(out, port)
	}
	return out
}

func listenLines(port int, listenIPs []string, extra string) []string {
	if len(listenIPs) == 0 {
		return []string{fmt.Sprintf("listen %d%s;", port, extra)}
	}
	out := make([]string, 0, len(listenIPs))
	for _, ip := range listenIPs {
		out = append(out, fmt.Sprintf("listen %s:%d%s;", ip, port, extra))
	}
	return out
}

func (a *app) saveStubContent(content string) (bool, string) {
	routes, err := schema.LoadRoutes(a.routesPath())
	if err != nil {
		return false, err.Error()
	}
	root := routes.Globals.Stub.Root
	if root == "" {
		root = "/opt/var/www/stub"
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return false, err.Error()
	}
	path := filepath.Join(root, "index.html")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return false, err.Error()
	}
	return true, "stub saved to " + path
}
