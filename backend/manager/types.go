package main

import "sync"

type app struct {
	baseDir          string
	staticDir        string
	reactIndexRel    string
	nginxConfRoot    string
	nginxListenIPs   string
	routeAccessLog   string
	localCACert      string
	localCAKey       string
	ndmcBin          string
	ndmcRunner       func(string) (bool, string)
	ipHostDeleteMode string
	genRoutesPath    string
	activeRoutesPath string
	mu               sync.RWMutex
	operationMu      sync.Mutex
	telemetryMu      sync.Mutex
	telemetry        *telemetryStore
}

type response map[string]any

type ndnsConfig struct {
	HTTP struct {
		Port    *int `json:"port"`
		SSLPort *int `json:"sslPort"`
	} `json:"http"`
	Proxies      []ndnsProxy `json:"proxies"`
	DomainSuffix string      `json:"domainSuffix,omitempty"`
}

type ndnsProxy struct {
	Name     string `json:"name"`
	Upstream struct {
		Proto  string `json:"proto"`
		Target string `json:"target"`
		Port   string `json:"port"`
	} `json:"upstream"`
	Domain        string `json:"domain"`
	SSLRedirect   bool   `json:"sslRedirect"`
	SecurityLevel string `json:"securityLevel"`
}

type nginxStatus struct {
	Running         bool             `json:"running"`
	PID             string           `json:"pid"`
	PIDs            []string         `json:"pids"`
	Version         string           `json:"version"`
	ConfigFiles     []string         `json:"config_files"`
	Listeners       []string         `json:"listeners"`
	ParsedListeners []parsedListener `json:"parsed_listeners"`
	RSSKB           int64            `json:"rss_kb"`
}

type parsedListener struct {
	IP     string   `json:"ip"`
	Port   int      `json:"port"`
	Scheme string   `json:"scheme"`
	Flags  []string `json:"flags"`
	Source string   `json:"source"`
}

type configItem struct {
	ID       string           `json:"id"`
	Title    string           `json:"title"`
	Path     string           `json:"path"`
	Type     string           `json:"type"`
	Editable bool             `json:"editable"`
	Exists   bool             `json:"exists"`
	Size     int64            `json:"size"`
	MTime    int64            `json:"mtime"`
	Listens  []parsedListener `json:"listens"`
}
