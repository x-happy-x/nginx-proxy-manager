package schema

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type Routes struct {
	SchemaVersion string        `yaml:"schema_version" json:"schema_version"`
	Globals       Globals       `yaml:"globals" json:"globals"`
	Apps          []App         `yaml:"apps" json:"apps"`
	Hosts         []Host        `yaml:"hosts" json:"hosts"`
	Certs         []Certificate `yaml:"certs" json:"certs"`
}

type Globals struct {
	AccessGateway bool     `yaml:"access_gateway,omitempty" json:"access_gateway,omitempty"`
	SSLMode       string   `yaml:"ssl_mode" json:"ssl_mode"`
	ListenIPs     []string `yaml:"listen_ips" json:"listen_ips"`
	Ports         Ports    `yaml:"ports" json:"ports"`
	UI            UIBind   `yaml:"ui" json:"ui"`
	Stub          Stub     `yaml:"stub" json:"stub"`
	ACME          ACME     `yaml:"acme" json:"acme"`
}

type Ports struct {
	HTTP       int   `yaml:"http" json:"http"`
	HTTPS      int   `yaml:"https" json:"https"`
	HTTPExtra  []int `yaml:"http_extra" json:"http_extra"`
	HTTPSExtra []int `yaml:"https_extra" json:"https_extra"`
}

type UIBind struct {
	Host string `yaml:"host" json:"host"`
	Port int    `yaml:"port" json:"port"`
}

type Stub struct {
	Enabled *bool  `yaml:"enabled" json:"enabled"`
	Root    string `yaml:"root" json:"root"`
}

type ACME struct {
	Email string `yaml:"email" json:"email"`
}

type App struct {
	ID       string      `yaml:"id" json:"id"`
	Name     string      `yaml:"name" json:"name"`
	Upstream UpstreamApp `yaml:"upstream" json:"upstream"`
	WSProxy  WSProxy     `yaml:"ws_proxy" json:"ws_proxy"`
}

type UpstreamApp struct {
	Address string `yaml:"address" json:"address"`
	Port    int    `yaml:"port" json:"port"`
	Scheme  string `yaml:"scheme" json:"scheme"`
}

type WSProxy struct {
	Enabled      bool   `yaml:"enabled" json:"enabled"`
	Path         string `yaml:"path" json:"path"`
	RewriteToWSS bool   `yaml:"rewrite_to_wss" json:"rewrite_to_wss"`
	RewriteFrom  string `yaml:"rewrite_from" json:"rewrite_from"`
}

type Host struct {
	AccessApp         string     `yaml:"access_app,omitempty" json:"access_app,omitempty"`
	AccessPassthrough []string   `yaml:"access_passthrough,omitempty" json:"access_passthrough,omitempty"`
	Host              string     `yaml:"host" json:"host"`
	Kind              string     `yaml:"kind" json:"kind"`
	AppID             string     `yaml:"app_id" json:"app_id"`
	VerifyUpstreamSSL bool       `yaml:"verify_upstream_ssl" json:"verify_upstream_ssl"`
	WSProxy           WSProxy    `yaml:"ws_proxy" json:"ws_proxy"`
	DNS               DNSConfig  `yaml:"dns" json:"dns"`
	TLS               TLSConfig  `yaml:"tls" json:"tls"`
	Endpoints         []Endpoint `yaml:"endpoints" json:"endpoints"`
}

type DNSConfig struct {
	Publish       []string `yaml:"publish" json:"publish"`
	LocalRecordIP string   `yaml:"local_record_ip" json:"local_record_ip"`
}

type TLSConfig struct {
	CertPolicy string   `yaml:"cert_policy" json:"cert_policy"`
	CertRef    string   `yaml:"cert_ref" json:"cert_ref"`
	SAN        []string `yaml:"san" json:"san"`
}

type Endpoint struct {
	Name     string           `yaml:"name" json:"name"`
	Listen   EndpointListen   `yaml:"listen" json:"listen"`
	Behavior EndpointBehavior `yaml:"behavior" json:"behavior"`
}

type EndpointListen struct {
	Protocol string `yaml:"protocol" json:"protocol"`
	Port     any    `yaml:"port" json:"port"`
}

type EndpointBehavior struct {
	Redirect          string `yaml:"redirect" json:"redirect"`
	NDNSProfile       string `yaml:"ndns_profile" json:"ndns_profile"`
	NDNSName          string `yaml:"ndns_name" json:"ndns_name"`
	NDNSDomain        string `yaml:"ndns_domain" json:"ndns_domain"`
	NDNSSecurityLevel string `yaml:"ndns_security_level" json:"ndns_security_level"`
	NDNSSSLRedirect   *bool  `yaml:"ndns_ssl_redirect" json:"ndns_ssl_redirect"`
	NDNSTargetIP      string `yaml:"ndns_target_ip" json:"ndns_target_ip"`
}

type Certificate struct {
	ID      string `yaml:"id" json:"id"`
	Host    string `yaml:"host" json:"host"`
	CRTPath string `yaml:"crt_path" json:"crt_path"`
	KeyPath string `yaml:"key_path" json:"key_path"`
}

func NormalizePort(value any, fallback int) int {
	switch v := value.(type) {
	case int:
		if v >= 1 && v <= 65535 {
			return v
		}
	case int64:
		if v >= 1 && v <= 65535 {
			return int(v)
		}
	case float64:
		if iv := int(v); float64(iv) == v && iv >= 1 && iv <= 65535 {
			return iv
		}
	case string:
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 65535 {
			return n
		}
	}
	return fallback
}

func NormalizePortList(values []int) []int {
	out := make([]int, 0, len(values))
	seen := map[int]struct{}{}
	for _, value := range values {
		port := NormalizePort(value, 0)
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

func ParseListenIPs(value any) []string {
	switch v := value.(type) {
	case []string:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if item != "" {
				out = append(out, item)
			}
		}
		return out
	case string:
		if v == "" {
			return nil
		}
		out := []string{}
		for _, item := range splitAndTrim(v) {
			if item != "" {
				out = append(out, item)
			}
		}
		return out
	default:
		return nil
	}
}

func splitAndTrim(v string) []string {
	part := ""
	out := []string{}
	for _, r := range v {
		if r == ',' {
			if part != "" {
				out = append(out, part)
			}
			part = ""
			continue
		}
		if r != ' ' && r != '\t' && r != '\n' && r != '\r' {
			part += string(r)
		}
	}
	if part != "" {
		out = append(out, part)
	}
	return out
}

func DefaultRoutes() Routes {
	enabled := true
	port := 8080
	if raw := os.Getenv("LITE_UI_PORT"); raw != "" {
		port = NormalizePort(raw, 8080)
	}
	host := os.Getenv("LITE_UI_HOST")
	if host == "" {
		host = "0.0.0.0"
	}
	return Routes{
		SchemaVersion: "2.1",
		Globals: Globals{
			SSLMode:   "local-ca",
			ListenIPs: []string{},
			Ports: Ports{
				HTTP:       80,
				HTTPS:      443,
				HTTPExtra:  []int{},
				HTTPSExtra: []int{},
			},
			UI: UIBind{
				Host: host,
				Port: port,
			},
			Stub: Stub{
				Enabled: &enabled,
				Root:    "/opt/var/www/stub",
			},
			ACME: ACME{},
		},
		Apps:  []App{},
		Hosts: []Host{},
		Certs: []Certificate{},
	}
}

func NormalizeRoutes(in Routes) Routes {
	out := DefaultRoutes()
	out.SchemaVersion = "2.1"
	if in.Globals.SSLMode != "" {
		out.Globals.SSLMode = in.Globals.SSLMode
	}
	if len(in.Globals.ListenIPs) > 0 {
		out.Globals.ListenIPs = cleanStrings(in.Globals.ListenIPs)
	}
	out.Globals.Ports.HTTP = NormalizePort(in.Globals.Ports.HTTP, 80)
	out.Globals.Ports.HTTPS = NormalizePort(in.Globals.Ports.HTTPS, 443)
	out.Globals.Ports.HTTPExtra = NormalizePortList(in.Globals.Ports.HTTPExtra)
	out.Globals.Ports.HTTPSExtra = NormalizePortList(in.Globals.Ports.HTTPSExtra)
	if in.Globals.UI.Host != "" {
		out.Globals.UI.Host = in.Globals.UI.Host
	}
	out.Globals.UI.Port = NormalizePort(in.Globals.UI.Port, out.Globals.UI.Port)
	if in.Globals.Stub.Enabled != nil {
		value := *in.Globals.Stub.Enabled
		out.Globals.Stub.Enabled = &value
	}
	if in.Globals.Stub.Root != "" {
		out.Globals.Stub.Root = in.Globals.Stub.Root
	}
	out.Globals.ACME.Email = in.Globals.ACME.Email
	out.Apps = append([]App{}, in.Apps...)
	out.Hosts = append([]Host{}, in.Hosts...)
	out.Certs = append([]Certificate{}, in.Certs...)
	for i := range out.Apps {
		if out.Apps[i].Upstream.Port == 0 {
			out.Apps[i].Upstream.Port = 80
		}
		if out.Apps[i].Upstream.Scheme == "" {
			out.Apps[i].Upstream.Scheme = "http"
		}
	}
	for i := range out.Hosts {
		out.Hosts[i].Endpoints = append([]Endpoint{}, in.Hosts[i].Endpoints...)
		out.Hosts[i].DNS.Publish = append([]string{}, in.Hosts[i].DNS.Publish...)
		out.Hosts[i].TLS.SAN = append([]string{}, in.Hosts[i].TLS.SAN...)
		if out.Hosts[i].DNS.LocalRecordIP == "" {
			out.Hosts[i].DNS.LocalRecordIP = "auto"
		}
		if out.Hosts[i].TLS.CertPolicy == "" {
			out.Hosts[i].TLS.CertPolicy = "auto_local_ca"
		}
		if out.Hosts[i].TLS.CertRef == "" {
			out.Hosts[i].TLS.CertRef = "auto"
		}
		if out.Hosts[i].TLS.SAN == nil {
			out.Hosts[i].TLS.SAN = []string{}
		}
		for j := range out.Hosts[i].Endpoints {
			ep := &out.Hosts[i].Endpoints[j]
			if ep.Listen.Protocol == "" {
				ep.Listen.Protocol = "http"
				if ep.Name == "web" {
					ep.Listen.Protocol = "https"
				}
			}
			if ep.Name == "web" && ep.Behavior.Redirect == "" {
				ep.Behavior.Redirect = "off"
				if ep.Listen.Protocol == "https" {
					ep.Behavior.Redirect = "https"
				}
			}
			if ep.Behavior.NDNSDomain == "" {
				ep.Behavior.NDNSDomain = "ndns"
			}
			if ep.Behavior.NDNSSecurityLevel == "" {
				ep.Behavior.NDNSSecurityLevel = "public"
			}
			if ep.Behavior.NDNSSSLRedirect == nil {
				value := true
				ep.Behavior.NDNSSSLRedirect = &value
			}
			if ep.Behavior.NDNSTargetIP == "" {
				ep.Behavior.NDNSTargetIP = "auto"
			}
		}
	}
	return out
}

func cleanStrings(items []string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

func LoadRoutes(path string) (Routes, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return DefaultRoutes(), nil
		}
		return Routes{}, err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return Routes{}, err
	}
	var routes Routes
	if err := yaml.Unmarshal(body, &routes); err != nil {
		return Routes{}, err
	}
	if routes.SchemaVersion != "2.1" {
		return Routes{}, ErrSchemaVersion
	}
	if err := ValidateRoutes(routes); err != nil {
		return Routes{}, err
	}
	return NormalizeRoutes(routes), nil
}

func SaveRoutes(path string, routes Routes) error {
	if err := ValidateRoutes(routes); err != nil {
		return err
	}
	payload := NormalizeRoutes(routes)
	body, err := renderRoutesYAML(payload)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".routes-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(body); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func renderRoutesYAML(routes Routes) ([]byte, error) {
	sections := []struct {
		comment string
		key     string
		value   any
	}{
		{
			comment: "Schema version for the routes file format.",
			key:     "schema_version",
			value:   routes.SchemaVersion,
		},
		{
			comment: "Global nginx and UI settings shared by all apps and hosts.",
			key:     "globals",
			value:   routes.Globals,
		},
		{
			comment: "Backend apps that define upstream targets and websocket options.",
			key:     "apps",
			value:   routes.Apps,
		},
		{
			comment: "Public or private hosts mapped to apps, TLS, DNS and endpoint behavior.",
			key:     "hosts",
			value:   routes.Hosts,
		},
		{
			comment: "Optional custom certificate bindings for specific hosts.",
			key:     "certs",
			value:   routes.Certs,
		},
	}

	var out bytes.Buffer
	for i, section := range sections {
		if i > 0 {
			out.WriteByte('\n')
		}
		out.WriteString("# ")
		out.WriteString(section.comment)
		out.WriteByte('\n')

		block, err := yaml.Marshal(map[string]any{section.key: section.value})
		if err != nil {
			return nil, fmt.Errorf("marshal %s: %w", section.key, err)
		}
		out.WriteString(strings.TrimRight(string(block), "\n"))
		out.WriteByte('\n')
	}

	return out.Bytes(), nil
}
