package main

import (
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func gatewayLocations(host string, externalHTTPS bool) string {
	proto := "$scheme"
	if externalHTTPS {
		proto = "https"
	}
	headers := fmt.Sprintf(`    proxy_set_header X-Gate-Host %s;
    proxy_set_header X-Gate-Proto %s;
    proxy_set_header X-Gate-IP $remote_addr;
    proxy_set_header X-Gate-URI $request_uri;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Origin $http_origin;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Host %s;
    proxy_connect_timeout 2s;
    proxy_read_timeout 12s;
`, host, proto, host)
	return "location = /_gate/check {\n    internal;\n    proxy_pass http://127.0.0.1:63415;\n    proxy_pass_request_body off;\n    proxy_set_header Content-Length \"\";\n" + headers + "}\nlocation ^~ /_gate/ {\n    proxy_pass http://127.0.0.1:63415;\n    client_max_body_size 4k;\n" + headers + "}\n"
}

// gatewayHostsFile lists every protected authority for the access gateway, so a
// host added in the UI is known to the gateway without editing gateway.json.
// It carries no secret; gateway.json entries still take precedence.
func gatewayHostsFile(routes schema.Routes, ips []string) (string, error) {
	type policy struct {
		App      string `json:"app"`
		Resource string `json:"resource,omitempty"`
	}
	out := struct {
		Managed string            `json:"managed"`
		Hosts   map[string]policy `json:"hosts"`
	}{Managed: strings.TrimSpace(strings.TrimPrefix(managedHeader, "#")), Hosts: map[string]policy{}}
	for _, host := range routes.Hosts {
		if host.AccessApp == "" {
			continue
		}
		p := policy{App: host.AccessApp, Resource: host.AppID}
		out.Hosts[host.Host] = p
		if host.AccessIPPort > 0 {
			for _, ip := range ips {
				out.Hosts[net.JoinHostPort(ip, strconv.Itoa(host.AccessIPPort))] = p
			}
		}
	}
	body, err := json.MarshalIndent(out, "", "  ")
	return string(body) + "\n", err
}
