package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/addresses"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

// The credential already used by the access gateway authenticates this one-way
// update. No worker/Core credential or DNS-provider secret leaves LAN.
func (a *app) syncAddressCatalog() error {
	var cfg struct {
		AccountAPI string `json:"account_api"`
		Secret     string `json:"secret"`
	}
	b, err := os.ReadFile(getenv("GATEWAY_CONFIG", "/opt/etc/homenet/gateway.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = json.Unmarshal(b, &cfg); err != nil {
		return err
	}
	if cfg.AccountAPI == "" || len(cfg.Secret) < 32 {
		return nil
	}
	routes, err := schema.LoadRoutes(a.appliedRoutesPath())
	if err != nil {
		return err
	}
	body, err := json.Marshal(addresses.Build(routes))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:])
	marker := filepath.Join(filepath.Dir(a.appliedRoutesPath()), "address-catalog.sha256")
	old, _ := os.ReadFile(marker)
	info, _ := os.Stat(marker)
	if string(old) == hash && info != nil && time.Since(info.ModTime()) < time.Minute {
		return nil
	}
	req, err := http.NewRequest("POST", cfg.AccountAPI+"/api/gateway/catalog", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gateway-Token", cfg.Secret)
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("Account catalog is unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("Account catalog sync: HTTP %d", res.StatusCode)
	}
	return os.WriteFile(marker, []byte(hash), 0600)
}
