package main

import (
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
)

// Construct the existing management adapters without loading any optional config
// or starting collectors. Each worker chooses its own startup below this boundary.
func newManager() (*app, error) {
	baseDir, err := resolveBaseDir()
	if err != nil {
		return nil, err
	}
	loadRuntimeEnv(baseDir)
	debug.SetMemoryLimit(int64(atoiDefault(getenv("MANAGER_MEMORY_MB", "64"), 64)) << 20)
	nginxConfRoot := getenv("NGINX_CONF_ROOT", "/etc/nginx")
	defaultRoutesPath := "/opt/etc/homenet/nginx/routes.v2.1.yml"
	if moduleKind != "" {
		defaultRoutesPath = filepath.Join(baseDir, "routes.yml")
	}
	return &app{
		baseDir:          baseDir,
		staticDir:        resolvePath(baseDir, getenv("STATIC_ROOT", filepath.Join("frontend", "static"))),
		reactIndexRel:    getenv("REACT_INDEX_REL", filepath.Join("react", "index.html")),
		nginxConfRoot:    nginxConfRoot,
		nginxListenIPs:   os.Getenv("NGINX_LISTEN_IPS"),
		routeAccessLog:   getenv("ROUTE_ACCESS_LOG", "/opt/var/log/nginx/route_access.log"),
		localCACert:      getenv("LOCAL_CA_CERT", filepath.Join(nginxConfRoot, "local-ca", "ca.crt")),
		localCAKey:       getenv("LOCAL_CA_KEY", filepath.Join(nginxConfRoot, "local-ca", "ca.key")),
		ndmcBin:          getenv("NDMC_BIN", "ndmc"),
		ipHostDeleteMode: getenv("IP_HOST_DELETE_MODE", "no-host"),
		genRoutesPath:    getenv("GEN_ROUTES_PATH", filepath.Join(baseDir, "bin", runtime.GOOS+"-"+runtime.GOARCH, "nginx")),
		activeRoutesPath: getenv("ROUTES_PATH", defaultRoutesPath),
	}, nil
}
