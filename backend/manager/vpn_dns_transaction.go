package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

type vpnDNSRequest struct {
	ID     string        `json:"id"`
	Routes schema.Routes `json:"routes"`
}
type vpnDNSTransaction struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	RequestHash string `json:"request_hash"`
	Mode        string `json:"mode"`
	Target      string `json:"target"`
	FileMode    uint32 `json:"file_mode"`
	Before      []byte `json:"before"`
	Candidate   []byte `json:"candidate"`
}

func vpnTransactionPath(id string) string {
	return filepath.Join(os.Getenv("HOMENET_PLATFORM_STATE"), "transactions", "vpn-dns-"+id+".json")
}
func vpnDNSPending(except string) error {
	state := os.Getenv("HOMENET_PLATFORM_STATE")
	if state == "" {
		return nil
	}
	entries, err := os.ReadDir(filepath.Join(state, "transactions"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "vpn-dns-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(state, "transactions", entry.Name()))
		if err != nil {
			return err
		}
		var tx vpnDNSTransaction
		if err = json.Unmarshal(b, &tx); err != nil {
			return err
		}
		if tx.ID != except && tx.Status != "committed" && tx.Status != "rolled_back" {
			return fmt.Errorf("Proxy DNS transaction %s is pending", tx.ID)
		}
	}
	return nil
}
func saveDNSTransaction(tx vpnDNSTransaction) error {
	return integration.AtomicJSON(vpnTransactionPath(tx.ID), tx)
}
func readDNSTransaction(id string) (vpnDNSTransaction, error) {
	var tx vpnDNSTransaction
	b, err := os.ReadFile(vpnTransactionPath(id))
	if err != nil {
		return tx, err
	}
	err = json.Unmarshal(b, &tx)
	return tx, err
}

func (a *app) prepareDNSTransaction(req vpnDNSRequest) (vpnDNSTransaction, error) {
	raw, _ := json.Marshal(req.Routes)
	hash := configSHA(raw)
	if old, err := readDNSTransaction(req.ID); err == nil {
		if old.RequestHash != hash {
			return old, fmt.Errorf("transaction ID reused with different routes")
		}
		return old, nil
	} else if !os.IsNotExist(err) {
		return old, err
	}
	tx := vpnDNSTransaction{ID: req.ID, Status: "prepared", RequestHash: hash}
	if err := vpnDNSPending(req.ID); err != nil {
		return tx, err
	}
	s, enabled, err := mihomoEnvironment()
	if err != nil {
		return tx, err
	}
	if !enabled {
		return tx, saveDNSTransaction(tx)
	}
	tx.Mode = s.mode
	target := s.config
	if s.mode == "system-hosts" {
		target = s.hostsPath
	}
	tx.Target, err = filepath.EvalSymlinks(target)
	if err != nil {
		return tx, err
	}
	info, err := os.Stat(tx.Target)
	if err != nil {
		return tx, err
	}
	if !info.Mode().IsRegular() {
		return tx, fmt.Errorf("DNS target is not regular")
	}
	tx.FileMode = uint32(info.Mode().Perm())
	tx.Before, err = os.ReadFile(tx.Target)
	if err != nil {
		return tx, err
	}
	if s.mode == "system-hosts" {
		tx.Candidate, _, err = a.mihomoSystemHostsCandidate(s, req.Routes)
	} else {
		tx.Candidate, _, _, err = a.mihomoHostsCandidate(tx.Before, req.Routes)
	}
	if err != nil {
		return tx, err
	}
	if s.mode == "config-reload" {
		staged, err := mihomoPrivateFile(filepath.Dir(tx.Target), ".vpn-dns-check-*", tx.Candidate)
		if err != nil {
			return tx, err
		}
		defer os.Remove(staged)
		if err = mihomoValidateCandidate(s, staged); err != nil {
			return tx, err
		}
	}
	return tx, saveDNSTransaction(tx)
}

func replaceDNSBytes(tx vpnDNSTransaction, body []byte) error {
	temp, err := mihomoPrivateFile(filepath.Dir(tx.Target), ".vpn-dns-*", body)
	if err != nil {
		return err
	}
	defer os.Remove(temp)
	if err = os.Chmod(temp, os.FileMode(tx.FileMode)); err != nil {
		return err
	}
	if err = os.Rename(temp, tx.Target); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(tx.Target))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func (a *app) transitionDNSTransaction(id, action string) (vpnDNSTransaction, error) {
	tx, err := readDNSTransaction(id)
	if err != nil {
		return tx, err
	}
	if action == "commit" {
		if tx.Status == "committed" {
			return tx, nil
		}
		if tx.Status != "applied" {
			return tx, fmt.Errorf("transaction has not been applied")
		}
		tx.Status = "committed"
		return tx, saveDNSTransaction(tx)
	}
	if action == "apply" && tx.Status == "applied" || action == "rollback" && tx.Status == "rolled_back" {
		return tx, nil
	}
	if tx.Status == "committed" || tx.Status == "rolled_back" {
		return tx, fmt.Errorf("transaction is already finished")
	}
	if action != "apply" && action != "rollback" {
		return tx, fmt.Errorf("invalid transaction action")
	}
	if tx.Target != "" {
		s, enabled, err := mihomoEnvironment()
		if err != nil || !enabled || s.mode != tx.Mode {
			return tx, fmt.Errorf("VPN DNS settings changed during transaction")
		}
		configured := s.config
		if s.mode == "system-hosts" {
			configured = s.hostsPath
		}
		resolved, err := filepath.EvalSymlinks(configured)
		if err != nil || resolved != tx.Target {
			return tx, fmt.Errorf("VPN DNS target changed")
		}
		current, err := os.ReadFile(tx.Target)
		if err != nil {
			return tx, err
		}
		if !bytes.Equal(current, tx.Before) && !bytes.Equal(current, tx.Candidate) {
			return tx, fmt.Errorf("DNS resource changed externally; recovery must preserve external edits")
		}
		tx.Status = action + "ing"
		if err = saveDNSTransaction(tx); err != nil {
			return tx, err
		}
		wanted := tx.Candidate
		if action == "rollback" {
			wanted = tx.Before
		}
		if !bytes.Equal(current, wanted) {
			if err = replaceDNSBytes(tx, wanted); err != nil {
				return tx, err
			}
		}
		if s.mode == "config-reload" {
			if s.secret == "" {
				_, _, s.secret, _ = a.mihomoHostsCandidate(wanted, schema.Routes{})
			}
			if err = mihomoReload(s); err != nil {
				return tx, err
			}
		}
	}
	tx.Status = "applied"
	if action == "rollback" {
		tx.Status = "rolled_back"
	}
	return tx, saveDNSTransaction(tx)
}

func (a *app) handleVPNDNSTransaction(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
		return
	}
	var req vpnDNSRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&req); err != nil {
		http.Error(w, "Invalid transaction", 400)
		return
	}
	action := strings.TrimPrefix(r.URL.Path, "/internal/vpn-dns/")
	mihomoSyncMu.Lock()
	defer mihomoSyncMu.Unlock()
	coreConfigMu.Lock()
	defer coreConfigMu.Unlock()
	if action == "preview" {
		plan, err := a.previewMihomoDNS(req.Routes)
		if err != nil {
			http.Error(w, err.Error(), 409)
		} else {
			a.writeJSON(w, 200, plan)
		}
		return
	}
	if !integration.ValidID(req.ID) {
		http.Error(w, "Invalid operation ID", 400)
		return
	}
	var tx vpnDNSTransaction
	var err error
	if action == "prepare" {
		tx, err = a.prepareDNSTransaction(req)
	} else {
		tx, err = a.transitionDNSTransaction(req.ID, action)
	}
	if err != nil {
		http.Error(w, err.Error(), 409)
		return
	}
	// Original configuration may contain credentials: never send snapshots over RPC.
	a.writeJSON(w, 200, response{"id": tx.ID, "status": tx.Status})
}
