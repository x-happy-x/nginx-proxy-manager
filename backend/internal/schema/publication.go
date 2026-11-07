package schema

import (
	"net"
	"strconv"
)

func VPSHTTPSPort(h Host) int {
	if h.Publication != nil {
		return NormalizePort(h.Publication.HTTPSPort, 443)
	}
	return 443
}
func VPSHTTPPort(h Host) int {
	if h.Publication != nil {
		return NormalizePort(h.Publication.HTTPPort, 80)
	}
	return 80
}
func HostAuthority(h Host, ep Endpoint) string {
	if _, _, err := net.SplitHostPort(h.Host); err == nil {
		return h.Host
	}
	protocol, port := ep.Listen.Protocol, NormalizePort(ep.Listen.Port, 0)
	if ep.Name == "vps" {
		protocol, port = "https", VPSHTTPSPort(h)
	}
	if port == 0 || protocol == "https" && port == 443 || protocol == "http" && port == 80 {
		return h.Host
	}
	return net.JoinHostPort(h.Host, strconv.Itoa(port))
}

// PublicationChannel is independent of a domain. A disabled channel retains
// its routes, ports and local listeners so re-enabling needs no reconstruction.
func PublicationChannel(h Host, ep Endpoint) string {
	if ep.Name == "web" {
		return ""
	}
	if ep.Name == "vps" && h.Publication != nil {
		return "vps:" + h.Publication.ServerID
	}
	profile := ep.Behavior.NDNSProfile
	if profile == "" {
		profile = "ndns_proxy"
	}
	return "keendns:" + profile
}

func PublicationEnabled(g Globals, h Host, ep Endpoint) bool {
	channel := PublicationChannel(h, ep)
	for _, disabled := range g.DisabledPublications {
		if channel != "" && disabled == channel {
			return false
		}
	}
	return true
}

func ActivePublicHost(g Globals, h Host) Host {
	out := h
	out.Endpoints = nil
	for _, ep := range h.Endpoints {
		if PublicationEnabled(g, h, ep) {
			out.Endpoints = append(out.Endpoints, ep)
		}
	}
	return out
}
