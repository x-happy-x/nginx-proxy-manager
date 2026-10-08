package main

import "os"

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
	}
	return "unavailable"
}
