package main

import (
	"net/http"
	"net/url"
	"sort"
	"time"
)

/*
 * One node for the side panel of «Серверы» (NPM-71): its share of passed
 * checks in both channel modes, its last probe, where it exits, the groups
 * that hold it and its place there, and the history HomeNet keeps.
 */

type nodeGroup struct {
	Name  string `json:"name"`
	Now   string `json:"now"`
	Place int    `json:"place"` // 1-based place in the group's list
	Of    int    `json:"of"`
	Leads bool   `json:"leads"` // the group sends traffic through it now
	Via   string `json:"via,omitempty"`
}

func (a *app) vpnNode(name, provider string) (response, int) {
	var body struct {
		Providers map[string]boardProvider `json:"providers"`
	}
	if err := mihomoGet("/providers/proxies", &body); err != nil {
		return response{"ok": false, "error": "нет связи с ядром mihomo: " + shortNetErr(err).Error()}, http.StatusServiceUnavailable
	}
	if provider == "" {
		for pname, p := range body.Providers {
			if p.VehicleType != "HTTP" && p.VehicleType != "File" {
				continue
			}
			for _, x := range p.Proxies {
				if x.Name == name {
					provider = pname
				}
			}
		}
	}
	p, ok := body.Providers[provider]
	if !ok {
		return response{"ok": false, "error": "узел не найден"}, http.StatusNotFound
	}
	out := response{"ok": true, "name": name, "provider": provider}
	modes := response{}
	if ad := p.Adaptive; ad != nil {
		for mode, list := range ad.Rankings {
			for _, s := range list {
				if s.Name == name {
					modes[mode] = response{"rate": round2(s.SuccessRate), "ms": int(s.Record.AvgMS), "checks": s.Record.Checks, "stable": s.Stable}
				}
			}
		}
		if r, has := ad.Results[name]; has {
			probes := []response{}
			for _, pr := range r.Probes {
				probes = append(probes, response{"host": probeHost(pr.URL), "ok": pr.OK, "ms": pr.MS, "fail": pr.Fail})
			}
			out["now"] = failOf(r)
			out["probes"] = probes
			out["country"] = r.Country
		}
		out["mode"] = ad.Mode
	} else {
		for _, x := range p.Proxies {
			if x.Name == name {
				out["now"] = map[bool]string{true: "ok", false: "fail"}[x.Alive]
			}
		}
	}
	out["modes"] = modes

	var px struct {
		Proxies map[string]proxySnapshot `json:"proxies"`
	}
	groups := []nodeGroup{}
	if mihomoGet("/proxies", &px) == nil {
		for gname, g := range px.Proxies {
			if !groupTypes[g.Type] || g.Hidden || gname == "GLOBAL" {
				continue
			}
			for i, member := range g.All {
				if member != name {
					continue
				}
				ng := nodeGroup{Name: gname, Now: g.Now, Place: i + 1, Of: len(g.All), Leads: g.Now == name}
				groups = append(groups, ng)
			}
		}
		// a group that leads through another group that leads through this node
		for i := range groups {
			for oname, og := range px.Proxies {
				if groupTypes[og.Type] && og.Now == groups[i].Name && groups[i].Leads && oname != "GLOBAL" && !og.Hidden {
					groups[i].Via = joinVia(groups[i].Via, oname)
				}
			}
		}
		sort.Slice(groups, func(i, j int) bool {
			if groups[i].Leads != groups[j].Leads {
				return groups[i].Leads
			}
			return groups[i].Name < groups[j].Name
		})
	}
	out["groups"] = groups
	if nodes != nil {
		h, has := nodes.detail(provider, name, time.Now())
		out["history"] = response{"checks": h.Checks, "week": h.Week, "base": h.Base, "recorded": has}
	}
	return out, http.StatusOK
}

func joinVia(list, name string) string {
	if list == "" {
		return name
	}
	return list + ", " + name
}

func (a *app) handleVPNNode(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "нужно имя узла"})
		return
	}
	out, code := a.vpnNode(name, r.URL.Query().Get("provider"))
	a.writeJSON(w, code, out)
}

// handleVPNNodeCheck: «Проверить сейчас» — one delay test through the node.
func (a *app) handleVPNNodeCheck(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "нужно имя узла"})
		return
	}
	var res struct {
		Delay int `json:"delay"`
	}
	path := "/proxies/" + url.PathEscape(name) + "/delay?timeout=5000&url=" + url.QueryEscape("https://www.gstatic.com/generate_204")
	if err := mihomoGet(path, &res); err != nil || res.Delay <= 0 {
		a.writeJSON(w, http.StatusOK, response{"ok": true, "passed": false, "error": "не ответил за 5 секунд"})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true, "passed": true, "ms": res.Delay})
}
