package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func (a *app) appliedRoutesPath() string {
	return getenv("APPLIED_ROUTES_PATH", filepath.Join(a.baseDir, ".runtime", "applied.yml"))
}

func (a *app) preflightRouter(routes schema.Routes) error {
	if err := schema.ValidateRoutes(routes); err != nil {
		return err
	}
	if _, err := a.previewMihomoDNS(routes); err != nil {
		return err
	}
	if ok, out := a.previewLocalDNS(routes); !ok {
		return fmt.Errorf("%s", out)
	}
	ips := routes.Globals.ListenIPs
	if len(ips) == 0 {
		ips = schema.ParseListenIPs(a.nginxListenIPs)
	}
	suffix := ""
	for _, host := range routes.Hosts {
		item := hostNDNSPayload(host, ips)
		if item == nil {
			continue
		}
		proxy, err := proxyFromPayload(item)
		if err != nil {
			return err
		}
		if proxy.Domain == "ndns" {
			if suffix == "" {
				suffix = a.ndnsDomainSuffixGet()
			}
			if suffix == "" || !strings.EqualFold(host.Host, proxy.Name+"."+suffix) {
				return fmt.Errorf("%s: KeenDNS hostname must equal %s.%s", host.Host, proxy.Name, suffix)
			}
		}
		if !contains(ips, proxy.Upstream.Target) {
			return fmt.Errorf("%s: public target must be one of the proxy listener IPs", host.Host)
		}
	}
	if err := a.checkNewListeners(routes); err != nil {
		return err
	}
	return nil
}

func (a *app) checkNewListeners(routes schema.Routes) error {
	known := map[string]bool{}
	for _, listener := range a.nginxStatus().ParsedListeners {
		known[net.JoinHostPort(listener.IP, strconv.Itoa(listener.Port))] = true
	}
	ports := map[int]bool{routes.Globals.Ports.HTTP: true, routes.Globals.Ports.HTTPS: true}
	for _, p := range append(routes.Globals.Ports.HTTPExtra, routes.Globals.Ports.HTTPSExtra...) {
		ports[p] = true
	}
	for _, host := range routes.Hosts {
		for _, ep := range host.Endpoints {
			if p := schema.NormalizePort(ep.Listen.Port, 0); p > 0 {
				ports[p] = true
			}
		}
	}
	ips := routes.Globals.ListenIPs
	if len(ips) == 0 {
		ips = schema.ParseListenIPs(a.nginxListenIPs)
	}
	for _, ip := range ips {
		for port := range ports {
			if port == 0 {
				continue
			}
			address := net.JoinHostPort(ip, strconv.Itoa(port))
			if known[address] {
				continue
			}
			listener, err := net.Listen("tcp", address)
			if err != nil {
				return fmt.Errorf("listener %s is unavailable: %w", address, err)
			}
			listener.Close()
		}
	}
	return nil
}

func (a *app) applyManagedRoutes() (bool, string) {
	routes, err := schema.LoadRoutes(a.routesPath())
	if err != nil {
		return false, err.Error()
	}
	if err = schema.ResolveAutoPorts(&routes); err != nil {
		return false, err.Error()
	}
	previous := schema.DefaultRoutes()
	previous.Globals = routes.Globals
	ownership, err := a.readAppliedOwnership()
	if err != nil {
		return false, err.Error()
	}
	if ownership != nil {
		previous = *ownership
	}
	cleanup, err := a.planManagedCleanup(ownership, routes)
	if err != nil {
		return false, "Managed ownership preflight: " + err.Error()
	}
	if err = a.preflightRouter(routes); err != nil {
		return false, "Preflight: " + err.Error()
	}
	rollbackPath := filepath.Join(filepath.Dir(a.appliedRoutesPath()), "rollback.yml")
	if err := schema.SaveRoutes(rollbackPath, previous); err != nil {
		return false, err.Error()
	}
	dnsAdds, err := a.planLocalDNS(routes)
	if err != nil {
		return false, err.Error()
	}
	proxies, err := a.currentProxies()
	if err != nil {
		return false, err.Error()
	}
	before, err := proxyState(proxies)
	if err != nil {
		return false, err.Error()
	}
	journal := managedRouterJournal{}
	mihomoAttempted := false
	rollback := func(cause string) (bool, string) {
		messages := []string{cause}
		if out, err := runCommand(a.genRoutesPath, "--config", rollbackPath); err != nil {
			messages = append(messages, "NGINX ROLLBACK FAILED: "+out)
		} else {
			messages = append(messages, "Previous proxy listeners restored")
		}
		messages = append(messages, a.rollbackManagedRouter(journal, before)...)
		if mihomoAttempted {
			if ok, msg := a.syncMihomoDNS(previous); !ok {
				messages = append(messages, "SYSTEM HOSTS ROLLBACK FAILED: "+msg)
			}
		}
		return false, strings.Join(messages, "\n")
	}
	ok, out := a.applyRoutes()
	if !ok {
		return false, out
	}
	outputs := []string{out}
	if err := a.addManagedDNS(dnsAdds, &journal); err != nil {
		return rollback(err.Error())
	}
	outputs = append(outputs, fmt.Sprintf("local DNS: %d records added", len(journal.dnsAdded)))
	mihomoAttempted = true
	if ok, msg := a.syncMihomoDNS(routes); !ok {
		return rollback(msg)
	} else {
		outputs = append(outputs, msg)
	}
	if err := a.syncManagedProxies(routes, before, &journal); err != nil {
		return rollback(err.Error())
	}
	if err := a.applyManagedCleanup(cleanup, &journal); err != nil {
		return rollback(err.Error())
	}
	outputs = append(outputs, fmt.Sprintf("managed router records: %d public entries removed, %d exact DNS records removed", len(cleanup.proxies), len(cleanup.dns)))
	if err := schema.SaveRoutes(a.appliedRoutesPath(), routes); err != nil {
		return rollback("Cannot save applied snapshot: " + err.Error())
	}
	_ = os.WriteFile(filepath.Join(filepath.Dir(a.appliedRoutesPath()), "keenetic.sha256"), []byte(keeneticCertificateFingerprint()), 0600)
	return true, strings.Join(outputs, "\n")
}

var certificateMaps = regexp.MustCompile(`(?s)map\s+\$host\s+\$ndm_(?:cert|key)_\d+\s*\{.*?\n\s*\}`)

func keeneticCertificateFingerprint() string {
	body, err := os.ReadFile(getenv("KEENETIC_NGINX_CONF", "/tmp/nginx/nginx.conf"))
	if err != nil {
		return ""
	}
	maps := certificateMaps.FindAll(body, -1)
	if len(maps) == 0 {
		return ""
	}
	h := sha256.New()
	for _, value := range maps {
		h.Write(value)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (a *app) startMaintenance() {
	if os.Getenv("MAINTENANCE_DISABLED") == "1" {
		return
	}
	go func() {
		client := &http.Client{Timeout: 3 * time.Second}
		fingerprintPath := filepath.Join(filepath.Dir(a.appliedRoutesPath()), "keenetic.sha256")
		fingerprint, _ := os.ReadFile(fingerprintPath)
		lastCertificate := string(fingerprint)
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		iterations := 0
		for {
			// Apply only the last successfully generated routes, never an un-applied UI draft.
			res, err := client.Get("http://127.0.0.1:63413/health")
			healthy := err == nil && res.StatusCode == 200
			if res != nil {
				res.Body.Close()
			}
			if healthy {
				a.operationMu.Lock()
				if _, err := os.Stat(a.appliedRoutesPath()); err == nil {
					if routes, err := schema.LoadRoutes(a.appliedRoutesPath()); err == nil {
						if ok, msg := a.syncMihomoDNS(routes); !ok {
							log.Printf("system hosts maintenance: %s", msg)
						}
						if iterations%10 == 0 {
							current := keeneticCertificateFingerprint()
							if current != "" && current != lastCertificate {
								out, err := runCommand(a.genRoutesPath, "--config", a.appliedRoutesPath())
								if err != nil {
									log.Printf("KeenDNS certificate refresh failed: %s", out)
								} else {
									lastCertificate = current
									_ = os.WriteFile(fingerprintPath, []byte(current), 0600)
									log.Print("KeenDNS certificates refreshed for dedicated proxy")
								}
							}
						}
					}
				}
				if err := a.rotateProxyLogs(); err != nil {
					log.Printf("proxy log rotation: %v", err)
				}
				a.operationMu.Unlock()
			}
			iterations++
			<-tick.C
		}
	}()
}
