package main

import (
	"os"
	"time"
)

func (a *app) moduleConnection() string {
	switch moduleKind {
	case "proxy":
		if _, err := os.Stat(a.routesPath()); os.IsNotExist(err) {
			return "unconfigured"
		}
		if a.nginxStatus().Running {
			return "connected"
		}
		return "unavailable"
	case "vpn":
		status := readCoreStatus()
		if !status.ConfigExists {
			return "unconfigured"
		}
		if status.ControllerOK {
			return "connected"
		}
		return "unavailable"
	case "network":
		netmon.mu.Lock()
		defer netmon.mu.Unlock()
		if len(netmon.history) == 0 {
			return "unconfigured"
		}
		return "connected"
	case "pve":
		if pvh == nil {
			return "unconfigured"
		}
		pvh.mu.Lock()
		defer pvh.mu.Unlock()
		if pvh.loadErr != "" {
			return "unavailable"
		}
		if len(pvh.hosts) == 0 {
			return "unconfigured"
		}
		for _, h := range pvh.hosts {
			if h.Online && h.Parsed != nil && time.Now().Unix()-h.Parsed.TS < 90 {
				return "connected"
			}
		}
		return "unavailable"
	}
	return "unavailable"
}
