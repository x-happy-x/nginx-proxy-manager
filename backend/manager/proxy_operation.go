package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

type operationDNSRecord struct{ Host, Address string }
type proxyOperation struct {
	ID             string               `json:"id"`
	Status         string               `json:"status"`
	DNSID          string               `json:"dns_id"`
	BeforeRoutes   schema.Routes        `json:"before_routes"`
	Routes         schema.Routes        `json:"routes"`
	BeforeProxies  map[string]ndnsProxy `json:"before_proxies"`
	DesiredProxies map[string]ndnsProxy `json:"desired_proxies"`
	ProxyNames     []string             `json:"proxy_names"`
	DNSAdded       []operationDNSRecord `json:"dns_added"`
	DNSRemoved     []operationDNSRecord `json:"dns_removed"`
}

func proxyOperationPath() string {
	return filepath.Join(os.Getenv("HOMENET_PLATFORM_STATE"), "transactions", "proxy-apply.json")
}
func saveProxyOperation(op proxyOperation) error {
	return integration.AtomicJSON(proxyOperationPath(), op)
}
func (a *app) beginProxyOperation(previous, routes schema.Routes, before map[string]ndnsProxy, adds []localDNSChange, cleanup managedCleanupPlan) (*proxyOperation, error) {
	if moduleKind != "proxy" {
		return nil, nil
	}
	id, err := newContractID()
	if err != nil {
		return nil, err
	}
	desired, _, err := managedRouteEntries(routes, a.nginxListenIPs)
	if err != nil {
		return nil, err
	}
	op := &proxyOperation{ID: id, Status: "prepared", BeforeRoutes: previous, Routes: routes, BeforeProxies: before, DesiredProxies: desired}
	if moduleEnabled("vpn") {
		op.DNSID = id
	}
	for name, next := range desired {
		if old, ok := before[name]; !ok || old != next {
			op.ProxyNames = append(op.ProxyNames, name)
		}
	}
	for _, p := range cleanup.proxies {
		op.ProxyNames = append(op.ProxyNames, p.Name)
	}
	for _, r := range adds {
		op.DNSAdded = append(op.DNSAdded, operationDNSRecord{r.host, r.address})
	}
	for _, r := range cleanup.dns {
		op.DNSRemoved = append(op.DNSRemoved, operationDNSRecord{r.host, r.address})
	}
	return op, saveProxyOperation(*op)
}
func (a *app) recoverProxyOperation() error {
	if moduleKind != "proxy" {
		return nil
	}
	if err := recoverDNSMaintenance(); err != nil {
		return err
	}
	b, err := os.ReadFile(proxyOperationPath())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var op proxyOperation
	if err = json.Unmarshal(b, &op); err != nil {
		return err
	}
	if op.Status == "committed" || op.Status == "rolled_back" {
		return nil
	}
	if op.Status == "commit-decided" {
		if err = schema.SaveRoutes(a.appliedRoutesPath(), op.Routes); err != nil {
			return err
		}
		if err = finishVPNDNS(op.DNSID, "commit"); err != nil {
			return err
		}
		if err = moduleRPC("portal", map[string]any{"apps": op.Routes.Apps, "hosts": op.Routes.Hosts}, nil); err != nil {
			return err
		}
		op.Status = "committed"
		return saveProxyOperation(op)
	}
	// The intention set was persisted before the first router write. Only states
	// matching either the before image or our intended result may be compensated.
	watched := map[string]bool{}
	for _, name := range op.ProxyNames {
		watched[name] = true
	}
	current, err := a.managedProxyState(watched)
	if err != nil {
		return err
	}
	for _, name := range op.ProxyNames {
		actual, present := current[name]
		old, existed := op.BeforeProxies[name]
		next, wanted := op.DesiredProxies[name]
		isOld := present == existed && (!present || actual == old)
		isNext := present == wanted && (!present || actual == next)
		if !isOld && !isNext {
			return fmt.Errorf("KeenDNS %s changed outside the transaction; manual recovery required", name)
		}
	}
	dns, err := a.readLocalDNSRecords()
	if err != nil {
		return err
	}
	for _, r := range append(append([]operationDNSRecord{}, op.DNSAdded...), op.DNSRemoved...) {
		for address := range dns[r.Host] {
			if address != r.Address {
				return fmt.Errorf("DNS %s changed externally; manual recovery required", r.Host)
			}
		}
	}
	rollback := filepath.Join(filepath.Dir(a.appliedRoutesPath()), "recovery.yml")
	if err = schema.SaveRoutes(rollback, op.BeforeRoutes); err != nil {
		return err
	}
	if _, err = runCommand(a.genRoutesPath, "--config", rollback); err != nil {
		return fmt.Errorf("nginx recovery failed: %w", err)
	}
	journal := managedRouterJournal{proxies: op.ProxyNames}
	for _, r := range op.DNSAdded {
		journal.dnsAdded = append(journal.dnsAdded, localDNSChange{r.Host, r.Address})
	}
	for _, r := range op.DNSRemoved {
		journal.dnsRemoved = append(journal.dnsRemoved, localDNSChange{r.Host, r.Address})
	}
	messages := a.rollbackManagedRouter(journal, op.BeforeProxies)
	for _, message := range messages {
		if strings.Contains(strings.ToUpper(message), "FAIL") || strings.Contains(strings.ToLower(message), "cannot") {
			return fmt.Errorf("router recovery: %s", strings.Join(messages, "; "))
		}
	}
	verified, err := a.managedProxyState(watched)
	if err != nil {
		return err
	}
	for _, name := range op.ProxyNames {
		actual, present := verified[name]
		old, existed := op.BeforeProxies[name]
		if present != existed || present && actual != old {
			return fmt.Errorf("KeenDNS rollback verification failed for %s", name)
		}
	}
	verifiedDNS, err := a.readLocalDNSRecords()
	if err != nil {
		return err
	}
	for _, r := range op.DNSAdded {
		if verifiedDNS[r.Host][r.Address] {
			return fmt.Errorf("DNS addition rollback failed for %s", r.Host)
		}
	}
	for _, r := range op.DNSRemoved {
		if !verifiedDNS[r.Host][r.Address] {
			return fmt.Errorf("DNS removal rollback failed for %s", r.Host)
		}
	}
	// A prepare acknowledgement may have been lost. Replaying prepare with the
	// original ID either recovers that record or creates a harmless before image.
	if op.DNSID != "" {
		if err = moduleRPC("vpn-dns/prepare", vpnDNSRequest{ID: op.DNSID, Routes: op.Routes}, nil); err != nil {
			return err
		}
		if err = finishVPNDNS(op.DNSID, "rollback"); err != nil {
			return err
		}
	}
	if err = schema.SaveRoutes(a.appliedRoutesPath(), op.BeforeRoutes); err != nil {
		return err
	}
	op.Status = "rolled_back"
	return saveProxyOperation(op)
}
