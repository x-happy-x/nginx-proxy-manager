package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"os"
	"path/filepath"
)

// Accessed under operationMu by apply and maintenance.
var proxyDNSTransactionID string

type proxyDNSMaintenance struct {
	ID     string        `json:"id"`
	Status string        `json:"status"`
	Routes schema.Routes `json:"routes"`
}

func maintenanceTransactionPath() string {
	return filepath.Join(os.Getenv("HOMENET_PLATFORM_STATE"), "transactions", "proxy-dns-maintenance.json")
}
func recoverDNSMaintenance() error {
	if moduleKind != "proxy" {
		return nil
	}
	b, err := os.ReadFile(maintenanceTransactionPath())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var op proxyDNSMaintenance
	if err = json.Unmarshal(b, &op); err != nil {
		return err
	}
	if op.Status == "committed" || op.Status == "rolled_back" {
		return nil
	}
	if op.Status == "commit-decided" {
		if err = finishVPNDNS(op.ID, "commit"); err != nil {
			return err
		}
		op.Status = "committed"
	} else {
		if err = moduleRPC("vpn-dns/prepare", vpnDNSRequest{ID: op.ID, Routes: op.Routes}, nil); err != nil {
			return err
		}
		if err = finishVPNDNS(op.ID, "rollback"); err != nil {
			return err
		}
		op.Status = "rolled_back"
	}
	return integration.AtomicJSON(maintenanceTransactionPath(), op)
}

func newContractID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "dns-" + hex.EncodeToString(b), nil
}
func finishVPNDNS(id, action string) error {
	if id == "" {
		return nil
	}
	return moduleRPC("vpn-dns/"+action, vpnDNSRequest{ID: id}, nil)
}
func (a *app) syncVPNDNSContract(routes schema.Routes) (bool, string) {
	if proxyDNSTransactionID != "" {
		err := finishVPNDNS(proxyDNSTransactionID, "apply")
		if err != nil {
			return false, err.Error()
		}
		return true, "VPN DNS transaction applied"
	}
	if err := recoverDNSMaintenance(); err != nil {
		return false, err.Error()
	}
	if !moduleEnabled("vpn") {
		return true, "VPN integration is disabled; DNS capability unavailable"
	}
	id, err := newContractID()
	if err != nil {
		return false, err.Error()
	}
	op := proxyDNSMaintenance{ID: id, Status: "prepared", Routes: routes}
	if err = integration.AtomicJSON(maintenanceTransactionPath(), op); err != nil {
		return false, err.Error()
	}
	if err = moduleRPC("vpn-dns/prepare", vpnDNSRequest{ID: id, Routes: routes}, nil); err != nil {
		return false, err.Error()
	}
	if err = finishVPNDNS(id, "apply"); err != nil {
		rollback := recoverDNSMaintenance()
		return false, fmt.Sprintf("%v; rollback: %v", err, rollback)
	}
	op.Status = "commit-decided"
	if err = integration.AtomicJSON(maintenanceTransactionPath(), op); err != nil {
		return false, err.Error()
	}
	if err = recoverDNSMaintenance(); err != nil {
		return false, fmt.Sprintf("DNS applied; commit acknowledgement pending: %v", err)
	}
	return true, "VPN DNS transaction committed"
}
