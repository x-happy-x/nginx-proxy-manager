package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"time"
)

func main() {
	baseDir, err := resolveBaseDir()
	if err != nil {
		log.Fatal(err)
	}
	loadRuntimeEnv(baseDir)
	debug.SetMemoryLimit(int64(atoiDefault(getenv("MANAGER_MEMORY_MB", "64"), 64)) << 20)
	nginxConfRoot := getenv("NGINX_CONF_ROOT", "/etc/nginx")
	routePath := getenv("ROUTES_PATH", "/opt/etc/homenet/nginx/routes.v2.1.yml")
	a := &app{
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
		activeRoutesPath: routePath,
	}
	a.startTelemetry()
	a.startResources()
	a.startNetwork()
	a.startMihomoTraffic()

	a.startMaintenance()
	host, port := a.readUIBind()
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.handle)
	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", host, port),
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	log.Printf("manager listening on %s:%d", host, port)
	log.Fatal(server.ListenAndServe())
}
