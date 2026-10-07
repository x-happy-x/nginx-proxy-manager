package core

import "strings"

// Kept at the gateway while existing first-party pages migrate to host.api.
// Ownership is fixed by Core, never selected by a request header from the browser.
func legacyOwner(path string) string {
	if path == "/api/network" || path == "/api/resources" || strings.HasPrefix(path, "/api/network/") {
		return "network"
	}
	if strings.HasPrefix(path, "/api/core/") || strings.HasPrefix(path, "/api/mihomo/") {
		return "vpn"
	}
	for _, prefix := range []string{"/api/routes", "/api/nginx", "/api/ca", "/api/cert", "/api/dns", "/api/ip-hosts", "/api/ndns", "/api/apply", "/api/stub"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return "proxy"
		}
	}
	return ""
}
