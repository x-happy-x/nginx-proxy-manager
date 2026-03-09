package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/golang/internal/envfile"
	"github.com/amagomedsharipov/nginx-proxy-manager/golang/internal/schema"
)

type generator struct {
	confRoot       string
	nginxListenIPs string
	localCACert    string
	localCAKey     string
	leRoot         string
	sitesAvail     string
	sitesEnabled   string
	managedDir     string
	acmeWebroot    string
	selfDir        string
	mapsConf       string
	proxySnippet   string
	routeAccessLog string
}

func main() {
	var configPath string
	var dryRun bool
	flag.StringVar(&configPath, "config", "", "Path to routes v2.1 YAML")
	flag.BoolVar(&dryRun, "dry-run", false, "Do not test/reload nginx")
	flag.Parse()
	if configPath == "" {
		fmt.Fprintln(os.Stderr, "--config is required")
		os.Exit(1)
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "Run with sudo/root.")
		os.Exit(1)
	}

	wd, err := os.Getwd()
	if err == nil {
		loadRuntimeEnv(wd)
	}

	confRoot := getenv("NGINX_CONF_ROOT", "/etc/nginx")
	g := &generator{
		confRoot:       confRoot,
		nginxListenIPs: os.Getenv("NGINX_LISTEN_IPS"),
		localCACert:    getenv("LOCAL_CA_CERT", filepath.Join(confRoot, "local-ca", "ca.crt")),
		localCAKey:     getenv("LOCAL_CA_KEY", filepath.Join(confRoot, "local-ca", "ca.key")),
		leRoot:         getenv("LE_ROOT", "/etc/letsencrypt"),
		sitesAvail:     filepath.Join(confRoot, "sites-available"),
		sitesEnabled:   filepath.Join(confRoot, "sites-enabled"),
		managedDir:     filepath.Join(confRoot, "sites-available", "managed-homenet"),
		acmeWebroot:    "/var/www/_letsencrypt",
		selfDir:        filepath.Join(confRoot, "selfsigned"),
		mapsConf:       filepath.Join(confRoot, "conf.d", "homenet_maps.conf"),
		proxySnippet:   filepath.Join(confRoot, "snippets", "homenet_proxy_common.conf"),
		routeAccessLog: getenv("ROUTE_ACCESS_LOG", "/opt/var/log/nginx/route_access.log"),
	}

	routes, err := schema.LoadRoutes(configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if routes.SchemaVersion != "2.1" {
		fmt.Fprintln(os.Stderr, "schema_version must be 2.1")
		os.Exit(1)
	}

	listenIPs := routes.Globals.ListenIPs
	if len(listenIPs) == 0 {
		listenIPs = schema.ParseListenIPs(g.nginxListenIPs)
	}
	reserved := map[int]struct{}{
		schema.NormalizePort(routes.Globals.Ports.HTTP, 80):   {},
		schema.NormalizePort(routes.Globals.Ports.HTTPS, 443): {},
	}
	for _, port := range routes.Globals.Ports.HTTPExtra {
		if port = schema.NormalizePort(port, 0); port != 0 {
			reserved[port] = struct{}{}
		}
	}
	for _, port := range routes.Globals.Ports.HTTPSExtra {
		if port = schema.NormalizePort(port, 0); port != 0 {
			reserved[port] = struct{}{}
		}
	}

	allocateAutoRandomPorts(routes.Hosts, reserved)
	must(g.ensureCommonSnippets())
	must(g.cleanManaged())

	appIndex := map[string]schema.App{}
	for _, item := range routes.Apps {
		if item.ID != "" {
			appIndex[item.ID] = item
		}
	}
	certIndex := map[string]schema.Certificate{}
	for _, item := range routes.Certs {
		key := strings.TrimSpace(item.ID)
		if key == "" {
			key = strings.TrimSpace(item.Host)
		}
		if key != "" {
			certIndex[key] = item
		}
	}

	for _, hostCfg := range routes.Hosts {
		if hostCfg.Host == "" || hostCfg.AppID == "" {
			continue
		}
		app, ok := appIndex[hostCfg.AppID]
		if !ok {
			fmt.Fprintf(os.Stderr, "Unknown app_id %q for host %q\n", hostCfg.AppID, hostCfg.Host)
			os.Exit(1)
		}
		content, err := g.buildHostConf(hostCfg, app, schema.NormalizePort(routes.Globals.Ports.HTTP, 80), listenIPs, certIndex)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if content == "" {
			continue
		}
		path := filepath.Join(g.managedDir, hostCfg.Host+".conf")
		must(writeFile(path, "# managed by homenet-nginx-yaml\n"+content, 0o644))
		must(g.enableSite(path))
	}

	if !dryRun {
		must(g.nginxReload())
	} else {
		fmt.Println("Dry run complete. Config files generated, reload skipped.")
	}
}

func loadRuntimeEnv(baseDir string) {
	path := getenv("CONFIG_ENV_PATH", filepath.Join(baseDir, "config", "runtime.env"))
	_ = envfile.Load(path)
}

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func writeFile(path, content string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

func routeLogFormatName(name string) string {
	var b strings.Builder
	for _, ch := range name {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' {
			b.WriteRune(ch)
		} else {
			b.WriteByte('_')
		}
	}
	return "homenet_route_" + b.String()
}

func (g *generator) lePaths(host string) (string, string) {
	base := filepath.Join(g.leRoot, "live", host)
	return filepath.Join(base, "fullchain.pem"), filepath.Join(base, "privkey.pem")
}

func (g *generator) selfPaths(host string) (string, string) {
	return filepath.Join(g.selfDir, host+".crt"), filepath.Join(g.selfDir, host+".key")
}

func runCommand(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func (g *generator) ensureSelfSigned(host string) (string, string, error) {
	crt, key := g.selfPaths(host)
	if exists(crt) && exists(key) {
		return crt, key, nil
	}
	if err := os.MkdirAll(g.selfDir, 0o755); err != nil {
		return "", "", err
	}
	err := runCommand("openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", key, "-out", crt, "-days", "365", "-subj", "/CN="+host)
	return crt, key, err
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (g *generator) ensureLocalCASigned(host string) (string, string, error) {
	crt, key := g.selfPaths(host)
	if exists(crt) && exists(key) {
		return crt, key, nil
	}
	if !exists(g.localCACert) || !exists(g.localCAKey) {
		return g.ensureSelfSigned(host)
	}
	if err := os.MkdirAll(g.selfDir, 0o755); err != nil {
		return "", "", err
	}
	csr := filepath.Join(os.TempDir(), host+".csr")
	ext := filepath.Join(os.TempDir(), host+".ext")
	if err := os.WriteFile(ext, []byte("subjectAltName=DNS:"+host+"\n"), 0o644); err != nil {
		return "", "", err
	}
	if err := runCommand("openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN="+host); err != nil {
		return "", "", err
	}
	if err := runCommand("openssl", "x509", "-req", "-in", csr, "-CA", g.localCACert, "-CAkey", g.localCAKey, "-CAcreateserial", "-out", crt, "-days", "825", "-sha256", "-extfile", ext); err != nil {
		return "", "", err
	}
	return crt, key, nil
}

func (g *generator) resolveCertPaths(host string, hostCfg schema.Host, certIndex map[string]schema.Certificate) (string, string, string, error) {
	policy := strings.ToLower(strings.TrimSpace(hostCfg.TLS.CertPolicy))
	if policy == "" {
		policy = "auto_local_ca"
	}
	switch policy {
	case "off":
		return "", "", policy, nil
	case "self_signed":
		crt, key, err := g.ensureSelfSigned(host)
		return crt, key, policy, err
	case "auto_local_ca":
		crt, key, err := g.ensureLocalCASigned(host)
		return crt, key, policy, err
	case "auto_acme":
		full, priv := g.lePaths(host)
		if exists(full) && exists(priv) {
			return full, priv, policy, nil
		}
		crt, key, err := g.ensureLocalCASigned(host)
		return crt, key, "auto_local_ca", err
	case "custom_ref":
		ref := strings.TrimSpace(hostCfg.TLS.CertRef)
		item, ok := certIndex[ref]
		if !ok {
			item, ok = certIndex[host]
		}
		if ok && exists(item.CRTPath) && exists(item.KeyPath) {
			return item.CRTPath, item.KeyPath, policy, nil
		}
		return "", "", "", fmt.Errorf("custom_ref certificate not found for host %q", host)
	default:
		crt, key, err := g.ensureLocalCASigned(host)
		return crt, key, "auto_local_ca", err
	}
}

func (g *generator) ensureCommonSnippets() error {
	if !exists(g.mapsConf) {
		if err := writeFile(g.mapsConf, "map $http_upgrade $connection_upgrade {\n  default upgrade;\n  ''      close;\n}\n", 0o644); err != nil {
			return err
		}
	}
	if !exists(g.proxySnippet) {
		content := strings.Join([]string{
			"proxy_set_header Host $host;",
			"proxy_set_header X-Real-IP $remote_addr;",
			"proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
			"proxy_set_header X-Forwarded-Proto $scheme;",
			"proxy_http_version 1.1;",
			"proxy_read_timeout 3600;",
			"proxy_send_timeout 3600;",
			"proxy_buffering off;",
			"proxy_set_header Upgrade $http_upgrade;",
			"proxy_set_header Connection $connection_upgrade;",
			"",
		}, "\n")
		if err := writeFile(g.proxySnippet, content, 0o644); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(g.acmeWebroot, 0o755); err != nil {
		return err
	}
	return os.MkdirAll(g.selfDir, 0o755)
}

func (g *generator) cleanManaged() error {
	if entries, err := os.ReadDir(g.sitesEnabled); err == nil {
		for _, entry := range entries {
			path := filepath.Join(g.sitesEnabled, entry.Name())
			if target, err := os.Readlink(path); err == nil {
				if strings.Contains(target, "/managed-homenet/") || strings.Contains(target, "/managed-crubs-v2/") || strings.Contains(target, "/managed-crubs/") {
					_ = os.Remove(path)
				}
				continue
			}
			if entry.IsDir() {
				continue
			}
			body, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			head := string(body)
			if len(head) > 256 {
				head = head[:256]
			}
			if strings.Contains(head, "managed by crubs-nginx-yaml") || strings.Contains(head, "managed by homenet-nginx-yaml") {
				_ = os.Remove(path)
			}
		}
	}
	if err := os.MkdirAll(g.sitesAvail, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(g.sitesEnabled, 0o755); err != nil {
		return err
	}
	_ = os.RemoveAll(g.managedDir)
	for _, legacy := range []string{"managed-crubs-v2", "managed-crubs"} {
		_ = os.RemoveAll(filepath.Join(g.sitesAvail, legacy))
	}
	return os.MkdirAll(g.managedDir, 0o755)
}

func (g *generator) enableSite(confPath string) error {
	link := filepath.Join(g.sitesEnabled, filepath.Base(confPath))
	_ = os.Remove(link)
	return os.Symlink(confPath, link)
}

func proxyBlock(g *generator, app schema.App, hostCfg schema.Host) (string, error) {
	if strings.TrimSpace(app.Upstream.Address) == "" {
		return "", fmt.Errorf("upstream.address is required for app %q", app.ID)
	}
	scheme := strings.ToLower(strings.TrimSpace(app.Upstream.Scheme))
	if scheme != "https" {
		scheme = "http"
	}
	lines := []string{
		"location / {",
		fmt.Sprintf("    proxy_pass %s://%s:%d;", scheme, app.Upstream.Address, app.Upstream.Port),
		fmt.Sprintf("    include %s;", g.proxySnippet),
	}
	if scheme == "https" {
		if !hostCfg.VerifyUpstreamSSL {
			lines = append(lines, "    proxy_ssl_verify off;")
		}
		lines = append(lines, "    proxy_ssl_server_name on;")
	}
	lines = append(lines, "}")
	return strings.Join(lines, "\n"), nil
}

func wsProxyBlock(g *generator, app schema.App, hostCfg schema.Host) string {
	ws := hostCfg.WSProxy
	if !ws.Enabled {
		return ""
	}
	path := strings.TrimSpace(ws.Path)
	if path == "" {
		path = "/connections"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	scheme := strings.ToLower(strings.TrimSpace(app.Upstream.Scheme))
	if scheme != "https" {
		scheme = "http"
	}
	lines := []string{
		fmt.Sprintf("location ^~ %s {", path),
		fmt.Sprintf("    proxy_pass %s://%s:%d;", scheme, app.Upstream.Address, app.Upstream.Port),
		fmt.Sprintf("    include %s;", g.proxySnippet),
	}
	if scheme == "https" {
		if !hostCfg.VerifyUpstreamSSL {
			lines = append(lines, "    proxy_ssl_verify off;")
		}
		lines = append(lines, "    proxy_ssl_server_name on;")
	}
	lines = append(lines, "}")
	return strings.Join(lines, "\n")
}

func wsRewriteLines(app schema.App, hostCfg schema.Host) []string {
	ws := hostCfg.WSProxy
	if !ws.Enabled || !ws.RewriteToWSS || app.Upstream.Address == "" {
		return nil
	}
	rewriteFrom := strings.TrimSpace(ws.RewriteFrom)
	if rewriteFrom == "" {
		rewriteFrom = fmt.Sprintf("ws://%s:%d", app.Upstream.Address, app.Upstream.Port)
	}
	return []string{
		"    sub_filter_once off;",
		"    sub_filter_types text/html text/plain application/javascript text/javascript;",
		fmt.Sprintf("    sub_filter '%s' 'wss://$host';", rewriteFrom),
	}
}

func (g *generator) buildHostConf(hostCfg schema.Host, app schema.App, globalHTTPPort int, listenIPs []string, certIndex map[string]schema.Certificate) (string, error) {
	host := strings.TrimSpace(hostCfg.Host)
	if host == "" {
		return "", nil
	}
	var web *schema.Endpoint
	ndnsEndpoints := []schema.Endpoint{}
	for i := range hostCfg.Endpoints {
		ep := hostCfg.Endpoints[i]
		name := strings.ToLower(strings.TrimSpace(ep.Name))
		if name == "web" && web == nil {
			web = &ep
			continue
		}
		if name == "ndns" || strings.TrimSpace(ep.Behavior.NDNSProfile) != "" {
			ndnsEndpoints = append(ndnsEndpoints, ep)
		}
	}
	if web == nil {
		return "", nil
	}

	formatName := routeLogFormatName(host)
	formatDecl := fmt.Sprintf("log_format %s escape=json\n  '{\"time\":\"$time_iso8601\",\"remote\":\"$remote_addr\",\"host\":\"$host\",\"server_name\":\"$server_name\",\"server_addr\":\"$server_addr\",\"server_port\":\"$server_port\",\"scheme\":\"$scheme\",\"method\":\"$request_method\",\"uri\":\"$request_uri\",\"status\":\"$status\",\"bytes_sent\":\"$body_bytes_sent\",\"request_time\":\"$request_time\",\"upstream_addr\":\"$upstream_addr\",\"upstream_status\":\"$upstream_status\",\"upstream_connect_time\":\"$upstream_connect_time\",\"upstream_header_time\":\"$upstream_header_time\",\"upstream_response_time\":\"$upstream_response_time\",\"proxy_host\":\"$proxy_host\",\"http_referer\":\"$http_referer\",\"http_user_agent\":\"$http_user_agent\"}';", formatName)
	pb, err := proxyBlock(g, app, hostCfg)
	if err != nil {
		return "", err
	}
	wsb := wsProxyBlock(g, app, hostCfg)
	if rewrites := wsRewriteLines(app, hostCfg); len(rewrites) > 0 {
		pb = strings.Replace(pb, fmt.Sprintf("    include %s;", g.proxySnippet), fmt.Sprintf("    include %s;\n%s", g.proxySnippet, strings.Join(rewrites, "\n")), 1)
	}
	webProto := strings.ToLower(strings.TrimSpace(web.Listen.Protocol))
	if webProto == "" {
		webProto = "https"
	}
	webPort := schema.NormalizePort(web.Listen.Port, map[bool]int{true: 443, false: 80}[webProto == "https"])
	redirect := strings.ToLower(strings.TrimSpace(web.Behavior.Redirect))
	if redirect == "" {
		redirect = "off"
	}
	blocks := []string{formatDecl}
	if webProto == "https" {
		crt, key, _, err := g.resolveCertPaths(host, hostCfg, certIndex)
		if err != nil {
			return "", err
		}
		httpsBlock := fmt.Sprintf(`server {
  %s
  server_name %s;
  http2 on;
  access_log %s %s;
  ssl_certificate %s;
  ssl_certificate_key %s;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

  %s
  %s
}`, strings.Join(listenLines(webPort, listenIPs, " ssl"), "\n  "), host, g.routeAccessLog, formatName, crt, key, wsb, pb)
		blocks = append(blocks, httpsBlock)
		if redirect == "https" {
			target := ""
			if webPort != 443 {
				target = fmt.Sprintf(":%d", webPort)
			}
			blocks = append(blocks, fmt.Sprintf(`server {
  %s
  server_name %s;
  access_log %s %s;
  location ^~ /.well-known/acme-challenge/ {
    root %s;
    default_type "text/plain";
  }
  return 308 https://$host%s$request_uri;
}`, strings.Join(listenLines(globalHTTPPort, listenIPs, ""), "\n  "), host, g.routeAccessLog, formatName, g.acmeWebroot, target))
		} else if redirect == "http" {
			blocks = append(blocks, fmt.Sprintf(`server {
  %s
  server_name %s;
  access_log %s %s;
  %s
  %s
}`, strings.Join(listenLines(globalHTTPPort, listenIPs, ""), "\n  "), host, g.routeAccessLog, formatName, wsb, pb))
		}
	} else {
		blocks = append(blocks, fmt.Sprintf(`server {
  %s
  server_name %s;
  access_log %s %s;
  location ^~ /.well-known/acme-challenge/ {
    root %s;
    default_type "text/plain";
  }
  %s
  %s
}`, strings.Join(listenLines(webPort, listenIPs, ""), "\n  "), host, g.routeAccessLog, formatName, g.acmeWebroot, wsb, pb))
	}

	for idx, ep := range ndnsEndpoints {
		portAny := ep.Listen.Port
		if portStr, ok := portAny.(string); ok && portStr == "auto_random" {
			return "", fmt.Errorf("host %q endpoint %q still has auto_random; resolve it before generation", host, ep.Name)
		}
		port := schema.NormalizePort(portAny, 0)
		if port == 0 {
			continue
		}
		proto := strings.ToLower(strings.TrimSpace(ep.Listen.Protocol))
		if proto == "" {
			proto = "http"
		}
		format := routeLogFormatName(fmt.Sprintf("%s_ndns_%d", host, idx+1))
		blocks = append(blocks, fmt.Sprintf("log_format %s escape=json\n  '{\"time\":\"$time_iso8601\",\"remote\":\"$remote_addr\",\"host\":\"$host\",\"server_name\":\"$server_name\",\"server_addr\":\"$server_addr\",\"server_port\":\"$server_port\",\"scheme\":\"$scheme\",\"method\":\"$request_method\",\"uri\":\"$request_uri\",\"status\":\"$status\",\"bytes_sent\":\"$body_bytes_sent\",\"request_time\":\"$request_time\",\"upstream_addr\":\"$upstream_addr\",\"upstream_status\":\"$upstream_status\",\"upstream_connect_time\":\"$upstream_connect_time\",\"upstream_header_time\":\"$upstream_header_time\",\"upstream_response_time\":\"$upstream_response_time\",\"proxy_host\":\"$proxy_host\",\"http_referer\":\"$http_referer\",\"http_user_agent\":\"$http_user_agent\"}';", format))
		sslExtra := ""
		sslLines := ""
		if proto == "https" {
			crt, key, _, err := g.resolveCertPaths(host, hostCfg, certIndex)
			if err != nil {
				return "", err
			}
			sslExtra = " ssl"
			sslLines = fmt.Sprintf("\n  ssl_certificate %s;\n  ssl_certificate_key %s;", crt, key)
		}
		blocks = append(blocks, fmt.Sprintf(`server {
  %s
  server_name _;
  access_log %s %s;%s
  # ndns_profile: %s
  %s
  %s
}`, strings.Join(listenLines(port, listenIPs, sslExtra), "\n  "), g.routeAccessLog, format, sslLines, valueOr(ep.Behavior.NDNSProfile, "ndns_proxy"), wsb, pb))
	}
	return strings.Join(blocks, "\n\n") + "\n", nil
}

func valueOr(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
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

func allocateAutoRandomPorts(hosts []schema.Host, reserved map[int]struct{}) {
	used := map[int]struct{}{}
	for port := range reserved {
		used[port] = struct{}{}
	}
	for i := range hosts {
		for _, ep := range hosts[i].Endpoints {
			port := schema.NormalizePort(ep.Listen.Port, 0)
			if port != 0 {
				used[port] = struct{}{}
			}
		}
	}
	nextPort := 20000
	for i := range hosts {
		for j := range hosts[i].Endpoints {
			if port, ok := hosts[i].Endpoints[j].Listen.Port.(string); !ok || port != "auto_random" {
				continue
			}
			for {
				if nextPort > 59999 {
					fmt.Fprintln(os.Stderr, "No free port for auto_random in range 20000..59999")
					os.Exit(1)
				}
				if _, ok := used[nextPort]; !ok {
					break
				}
				nextPort++
			}
			hosts[i].Endpoints[j].Listen.Port = nextPort
			used[nextPort] = struct{}{}
			nextPort++
		}
	}
}

func (g *generator) nginxReload() error {
	testCmd := strings.Fields(getenv("NGINX_TEST_CMD", "nginx -t"))
	reloadCmd := strings.Fields(getenv("NGINX_RELOAD_CMD", "systemctl reload nginx"))
	if len(testCmd) == 0 || len(reloadCmd) == 0 {
		return fmt.Errorf("empty nginx command")
	}
	if err := runCommand(testCmd[0], testCmd[1:]...); err != nil {
		return err
	}
	return runCommand(reloadCmd[0], reloadCmd[1:]...)
}
