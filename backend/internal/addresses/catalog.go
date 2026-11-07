// Package addresses builds the exact browser authorities owned by applied routes.
package addresses

import (
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

type Host struct {
	Origin     string `json:"origin"`
	Service    string `json:"service"`
	Resource   string `json:"resource"`
	Group      string `json:"group"`
	GatewayApp string `json:"gateway_app,omitempty"`
}
type Catalog struct {
	Schema int    `json:"schema"`
	Hosts  []Host `json:"hosts"`
}

var aliases = map[string]string{"cloud": "homecloud", "sublab": "sub_mirror", "sub-lab": "sub_mirror", "lms-client": "lms_node", "task-tracker": "task_tracker", "service-docs": "documents"}
var prefixes = map[string]string{"ha": "home_assistant", "cloud": "homecloud", "sub": "sub_mirror", "lms": "lms_node", "task": "task_tracker", "docs": "documents", "agents": "canvagents", "git": "forgejo", "vektor": "vektor"}

func Group(host string) string {
	if net.ParseIP(host) != nil || !strings.Contains(host, ".") {
		return "lan"
	}
	if i := strings.IndexByte(host, '.'); i >= 0 {
		return host[i+1:]
	}
	return "lan"
}
func Build(r schema.Routes) Catalog {
	c := Catalog{Schema: 1, Hosts: []Host{}}
	keys := map[string]string{}
	resolved := map[string]bool{}
	known := map[string]bool{"account": true, "homenet": true, "home_assistant": true, "proxmox": true, "bigfam": true, "homecloud": true, "kadr": true, "torrserver": true, "lms_node": true, "p3d": true, "sub_mirror": true, "task_tracker": true, "documents": true, "canvagents": true, "forgejo": true, "vektor": true}
	for _, a := range r.Apps {
		key := a.ID
		if v := aliases[key]; v != "" {
			key = v
		}
		keys[a.ID] = key
		if a.AccountKey != "" {
			keys[a.ID] = a.AccountKey
			resolved[a.ID] = true
		} else {
			resolved[a.ID] = known[key]
		}
	}
	for _, h := range r.Hosts {
		if !resolved[h.AppID] {
			if k := prefixes[strings.Split(h.Host, ".")[0]]; k != "" {
				keys[h.AppID] = k
				resolved[h.AppID] = true
			}
		}
	}
	seen := map[string]bool{}
	add := func(raw, resource, app string) {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return
		}
		if seen[raw] {
			return
		}
		seen[raw] = true
		c.Hosts = append(c.Hosts, Host{Origin: raw, Resource: resource, Service: keys[resource], Group: Group(u.Hostname()), GatewayApp: app})
	}
	for _, h := range r.Hosts {
		for _, ep := range h.Endpoints {
			proto, authority := ep.Listen.Protocol, schema.HostAuthority(h, ep)
			if ep.Name == "vps" {
				proto = "https"
			} else if ep.Name != "web" {
				proto = "https"
				if ep.Behavior.NDNSSSLRedirect != nil && !*ep.Behavior.NDNSSSLRedirect {
					proto = "http"
				}
				authority = h.Host
			}
			if proto == "" {
				proto = "http"
			}
			add(proto+"://"+authority, h.AppID, h.AccessApp)
		}
	}
	for _, a := range r.Apps {
		proto := a.Upstream.Scheme
		if proto == "" {
			proto = "http"
		}
		u := url.URL{Scheme: proto, Host: net.JoinHostPort(a.Upstream.Address, strconv.Itoa(schema.NormalizePort(a.Upstream.Port, 80)))}
		if a.Upstream.Port == 80 && proto == "http" || a.Upstream.Port == 443 && proto == "https" {
			u.Host = a.Upstream.Address
		}
		add(u.String(), a.ID, "")
	}
	sort.Slice(c.Hosts, func(i, j int) bool { return c.Hosts[i].Origin < c.Hosts[j].Origin })
	return c
}
func (c Catalog) AccountFor(origin string) string {
	group := ""
	for _, h := range c.Hosts {
		if h.Origin == origin {
			group = h.Group
			break
		}
	}
	if group == "" {
		return ""
	}
	for _, h := range c.Hosts {
		if h.Service == "account" && h.Group == group {
			return h.Origin
		}
	}
	return ""
}
