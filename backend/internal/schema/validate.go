package schema

import (
	"fmt"
	"net"
	"regexp"
	"strings"
)

var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var pathPattern = regexp.MustCompile(`^/[A-Za-z0-9_./:@%+~-]*$`)

// ValidHostname accepts literal DNS names, never nginx wildcards or directives.
func ValidHostname(value string) bool {
	if len(value) == 0 || len(value) > 253 || strings.TrimSpace(value) != value {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-') {
				return false
			}
		}
	}
	return true
}

func validIP(value string) bool { return net.ParseIP(value) != nil }
func oneOf(value string, allowed ...string) bool {
	for _, item := range allowed {
		if value == item {
			return true
		}
	}
	return false
}
func validPath(value string) bool {
	return pathPattern.MatchString(value) && !strings.Contains(value, "..")
}

// ValidateRoutes is shared by the API and generator. Validate before normalizing:
// defaults must not silently turn an invalid supplied port into a working route.
func ValidateRoutes(r Routes) error {
	if r.SchemaVersion != "2.1" {
		return ErrSchemaVersion
	}
	for _, ip := range r.Globals.ListenIPs {
		if !validIP(ip) {
			return fmt.Errorf("invalid listener IP %q", ip)
		}
	}
	for name, port := range map[string]int{"http": r.Globals.Ports.HTTP, "https": r.Globals.Ports.HTTPS, "ui": r.Globals.UI.Port} {
		if port != 0 && NormalizePort(port, 0) == 0 {
			return fmt.Errorf("invalid %s port %d", name, port)
		}
	}
	for _, port := range append(append([]int{}, r.Globals.Ports.HTTPExtra...), r.Globals.Ports.HTTPSExtra...) {
		if NormalizePort(port, 0) == 0 {
			return fmt.Errorf("invalid extra port %d", port)
		}
	}
	if r.Globals.UI.Host != "" && !validIP(r.Globals.UI.Host) && !ValidHostname(r.Globals.UI.Host) {
		return fmt.Errorf("invalid UI host")
	}
	if r.Globals.Stub.Root != "" && !validPath(r.Globals.Stub.Root) {
		return fmt.Errorf("invalid stub root")
	}
	apps := map[string]bool{}
	for _, app := range r.Apps {
		if !identifierPattern.MatchString(app.ID) || apps[app.ID] {
			return fmt.Errorf("invalid or duplicate app id %q", app.ID)
		}
		apps[app.ID] = true
		if !validIP(app.Upstream.Address) && !ValidHostname(app.Upstream.Address) {
			return fmt.Errorf("app %q: invalid upstream address", app.ID)
		}
		if app.Upstream.Port != 0 && NormalizePort(app.Upstream.Port, 0) == 0 {
			return fmt.Errorf("app %q: invalid upstream port", app.ID)
		}
		if !oneOf(app.Upstream.Scheme, "", "http", "https") {
			return fmt.Errorf("app %q: upstream scheme must be http or https", app.ID)
		}
		if app.WSProxy.Path != "" && !validPath(app.WSProxy.Path) {
			return fmt.Errorf("app %q: invalid websocket path", app.ID)
		}
	}
	certs := map[string]bool{}
	for _, cert := range r.Certs {
		id := cert.ID
		if id == "" {
			id = cert.Host
		}
		if !identifierPattern.MatchString(id) || certs[id] {
			return fmt.Errorf("invalid or duplicate certificate id %q", id)
		}
		certs[id] = true
		if !validPath(cert.CRTPath) || !validPath(cert.KeyPath) {
			return fmt.Errorf("certificate %q: unsafe certificate path", id)
		}
	}
	localPorts := map[int]string{}
	addLocal := func(port int, protocol string) error {
		if old, ok := localPorts[port]; ok && old != protocol {
			return fmt.Errorf("port %d mixes HTTP and HTTPS", port)
		}
		localPorts[port] = protocol
		return nil
	}
	if err := addLocal(NormalizePort(r.Globals.Ports.HTTP, 80), "http"); err != nil {
		return err
	}
	if err := addLocal(NormalizePort(r.Globals.Ports.HTTPS, 443), "https"); err != nil {
		return err
	}
	for _, port := range r.Globals.Ports.HTTPExtra {
		if err := addLocal(port, "http"); err != nil {
			return err
		}
	}
	for _, port := range r.Globals.Ports.HTTPSExtra {
		if err := addLocal(port, "https"); err != nil {
			return err
		}
	}
	publicPorts := map[int]string{}
	hosts := map[string]bool{}
	ndnsNames := map[string]bool{}
	for _, host := range r.Hosts {
		for _, path := range host.AccessPassthrough {
			if !validPath(path) || path == "/" || strings.HasPrefix(path, "/_gate") {
				return fmt.Errorf("host %q: invalid access_passthrough", host.Host)
			}
		}
		if host.AccessApp != "" && !identifierPattern.MatchString(host.AccessApp) {
			return fmt.Errorf("host %q: invalid access_app", host.Host)
		}
		name := strings.ToLower(host.Host)
		if !ValidHostname(host.Host) || hosts[name] {
			return fmt.Errorf("invalid or duplicate hostname %q", host.Host)
		}
		hosts[name] = true
		if !apps[host.AppID] {
			return fmt.Errorf("host %q: unknown app_id %q", host.Host, host.AppID)
		}
		if !oneOf(host.Kind, "", "public", "private", "local") {
			return fmt.Errorf("host %q: invalid kind", host.Host)
		}
		if host.WSProxy.Path != "" && !validPath(host.WSProxy.Path) {
			return fmt.Errorf("host %q: invalid websocket path", host.Host)
		}
		if host.DNS.LocalRecordIP != "" && host.DNS.LocalRecordIP != "auto" && !validIP(host.DNS.LocalRecordIP) {
			return fmt.Errorf("host %q: invalid local DNS IP", host.Host)
		}
		for _, publish := range host.DNS.Publish {
			if !oneOf(publish, "local", "public", "ndns") {
				return fmt.Errorf("host %q: invalid DNS publication %q", host.Host, publish)
			}
		}
		if !oneOf(host.TLS.CertPolicy, "", "off", "self_signed", "auto_local_ca", "auto_acme", "custom_ref", "keenetic") {
			return fmt.Errorf("host %q: invalid certificate policy", host.Host)
		}
		for _, san := range host.TLS.SAN {
			if !ValidHostname(san) {
				return fmt.Errorf("host %q: invalid certificate SAN", host.Host)
			}
		}
		webCount := 0
		publicCount := 0
		endpointNames := map[string]bool{}
		for _, ep := range host.Endpoints {
			if !identifierPattern.MatchString(ep.Name) || endpointNames[ep.Name] {
				return fmt.Errorf("host %q: invalid endpoint name", host.Host)
			}
			endpointNames[ep.Name] = true
			if ep.Name != "web" && ep.Name != "ndns" && ep.Behavior.NDNSProfile == "" {
				return fmt.Errorf("host %q: unsupported endpoint %q", host.Host, ep.Name)
			}
			if !oneOf(ep.Listen.Protocol, "", "http", "https") {
				return fmt.Errorf("host %q: invalid endpoint protocol", host.Host)
			}
			proto := ep.Listen.Protocol
			if proto == "" {
				if ep.Name == "web" {
					proto = "https"
				} else {
					proto = "http"
				}
			}
			if proto == "https" && host.TLS.CertPolicy == "off" {
				return fmt.Errorf("host %q: HTTPS endpoint requires a certificate policy", host.Host)
			}
			if !oneOf(ep.Behavior.Redirect, "", "off", "http", "https") {
				return fmt.Errorf("host %q: invalid redirect", host.Host)
			}
			port := NormalizePort(ep.Listen.Port, 0)
			if ep.Name == "web" {
				if ep.Behavior.NDNSProfile != "" {
					return fmt.Errorf("host %q: web endpoint cannot also be a public/NDNS endpoint", host.Host)
				}
				webCount++
				if webCount > 1 {
					return fmt.Errorf("host %q: multiple web endpoints", host.Host)
				}
				if ep.Listen.Port == nil {
					port = 80
					if proto == "https" {
						port = 443
					}
				}
				if port == 0 {
					return fmt.Errorf("host %q: invalid web port", host.Host)
				}
				if err := addLocal(port, proto); err != nil {
					return err
				}
				continue
			}
			publicCount++
			if publicCount > 1 {
				return fmt.Errorf("host %q: only one public/NDNS endpoint is supported", host.Host)
			}
			if port == 0 && ep.Listen.Port != "auto_random" {
				return fmt.Errorf("host %q: public endpoint requires a port or auto_random", host.Host)
			}
			if port != 0 {
				if prior, ok := publicPorts[port]; ok {
					return fmt.Errorf("public listener port %d is shared by %q and %q", port, prior, host.Host)
				}
				publicPorts[port] = host.Host
			}
			b := ep.Behavior
			if b.NDNSProfile != "" && !identifierPattern.MatchString(b.NDNSProfile) {
				return fmt.Errorf("host %q: invalid NDNS profile", host.Host)
			}
			if b.NDNSName != "" && !ValidHostname(b.NDNSName) {
				return fmt.Errorf("host %q: invalid NDNS name", host.Host)
			}
			ndnsName := b.NDNSName
			if ndnsName == "" {
				ndnsName = strings.Split(host.Host, ".")[0]
			}
			if ndnsNames[ndnsName] {
				return fmt.Errorf("duplicate NDNS name %q", ndnsName)
			}
			ndnsNames[ndnsName] = true
			if b.NDNSDomain != "" && !ValidHostname(b.NDNSDomain) {
				return fmt.Errorf("host %q: invalid NDNS domain", host.Host)
			}
			if !oneOf(b.NDNSSecurityLevel, "", "public", "private", "protected") {
				return fmt.Errorf("host %q: invalid NDNS security level", host.Host)
			}
			if b.NDNSTargetIP != "" && b.NDNSTargetIP != "auto" && !validIP(b.NDNSTargetIP) {
				return fmt.Errorf("host %q: invalid NDNS target IP", host.Host)
			}
		}
		if len(host.Endpoints) == 0 {
			return fmt.Errorf("host %q: at least one endpoint is required", host.Host)
		}
	}
	for port, host := range publicPorts {
		if _, ok := localPorts[port]; ok {
			return fmt.Errorf("host %q: public port %d overlaps a local listener", host, port)
		}
	}
	return nil
}

// ResolveAutoPorts assigns ports before saving so nginx and KeenDNS use identical
// values. Existing assignments are preserved; callers persist the result.
func ResolveAutoPorts(routes *Routes) error {
	if err := ValidateRoutes(*routes); err != nil {
		return err
	}
	used := map[int]bool{NormalizePort(routes.Globals.Ports.HTTP, 80): true, NormalizePort(routes.Globals.Ports.HTTPS, 443): true, routes.Globals.UI.Port: true}
	for _, port := range append(append([]int{}, routes.Globals.Ports.HTTPExtra...), routes.Globals.Ports.HTTPSExtra...) {
		used[port] = true
	}
	for _, host := range routes.Hosts {
		for _, ep := range host.Endpoints {
			used[NormalizePort(ep.Listen.Port, 0)] = true
		}
	}
	next := 20000
	for i := range routes.Hosts {
		for j := range routes.Hosts[i].Endpoints {
			ep := &routes.Hosts[i].Endpoints[j]
			if ep.Listen.Port != "auto_random" {
				continue
			}
			for next <= 59999 && used[next] {
				next++
			}
			if next > 59999 {
				return fmt.Errorf("no free public listener port in 20000..59999")
			}
			ep.Listen.Port = next
			used[next] = true
			next++
		}
	}
	return nil
}
