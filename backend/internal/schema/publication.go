package schema

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
