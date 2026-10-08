package core

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

type MigrationInput struct{ LegacyDir, StateDir, PackagesDir, StaticDir, Version, Arch string }
type MigrationPlan struct {
	Schema       int                     `json:"schema"`
	Config       Config                  `json:"config"`
	Sources      map[string]string       `json:"sources"`
	Integrations []integration.Installed `json:"integrations"`
	Catalog      PortalDocument          `json:"catalog"`
}

// PlanMigration reads the legacy installation without executing its shell file
// or changing services. Data paths remain in place so rollback uses current data.
func PlanMigration(in MigrationInput) (MigrationPlan, error) {
	plan := MigrationPlan{Schema: 1, Sources: map[string]string{}}
	for _, p := range []string{in.LegacyDir, in.StateDir, in.PackagesDir, in.StaticDir} {
		if !filepath.IsAbs(p) {
			return plan, fmt.Errorf("migration requires absolute paths")
		}
	}
	envPath := filepath.Join(in.LegacyDir, "config", "runtime.env")
	envBody, err := os.ReadFile(envPath)
	if err != nil {
		return plan, err
	}
	values := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(string(envBody)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
		}
	}
	if err = scanner.Err(); err != nil {
		return plan, err
	}
	value := func(key, fallback string) string {
		if values[key] != "" {
			return values[key]
		}
		return fallback
	}
	routesPath := value("ROUTES_PATH", filepath.Join(in.LegacyDir, "routes.yml"))
	routes, err := schema.LoadRoutes(routesPath)
	if err != nil {
		return plan, err
	}
	host := value("LITE_UI_HOST", routes.Globals.UI.Host)
	if host == "" {
		host = "0.0.0.0"
	}
	port := value("LITE_UI_PORT", strconv.Itoa(routes.Globals.UI.Port))
	if port == "0" {
		port = "8080"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return plan, fmt.Errorf("invalid legacy UI port")
	}
	config := Config{Listen: net.JoinHostPort(host, port), StateDir: in.StateDir, StaticDir: in.StaticDir, PackagesDir: in.PackagesDir, AccountURL: "http://127.0.0.1:63415", DMSURL: "http://127.0.0.1:63416", DMSTokenFile: "/opt/dms/token", WorkerEnv: envPath, WorkerAppDir: in.LegacyDir, ManageWorkers: true, AccessPath: value("HOMENET_ACCESS_PATH", "/opt/etc/homenet/access.json"), LauncherPath: filepath.Join(filepath.Dir(routesPath), "launcher.json")}
	config.WorkerDefaults = map[string]string{
		"ROUTES_PATH": routesPath, "APPLIED_ROUTES_PATH": value("APPLIED_ROUTES_PATH", filepath.Join(in.LegacyDir, ".runtime", "applied.yml")),
		"GEN_ROUTES_PATH": value("GEN_ROUTES_PATH", filepath.Join(value("HOME_NET_BIN_DIR", filepath.Join(in.LegacyDir, "bin", "linux-"+in.Arch)), "nginx")),
		"NGINX_CONF_ROOT": value("NGINX_CONF_ROOT", "/opt/etc/homenet/proxy"),
		"LOCAL_CA_CERT":   value("LOCAL_CA_CERT", "/opt/etc/nginx/local-ca/ca.crt"), "LOCAL_CA_KEY": value("LOCAL_CA_KEY", "/opt/etc/nginx/local-ca/ca.key"),
	}
	for _, p := range config.WorkerDefaults {
		if !filepath.IsAbs(p) || strings.ContainsAny(p, "$`") {
			return plan, fmt.Errorf("legacy path requires explicit resolution before migration")
		}
	}
	plan.Config = config
	plan.Catalog = PortalDocument{Apps: routes.Apps, Hosts: routes.Hosts}
	for _, p := range []string{envPath, routesPath, config.WorkerDefaults["APPLIED_ROUTES_PATH"], config.LauncherPath, config.AccessPath} {
		body, err := os.ReadFile(p)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return plan, err
		}
		sum := sha256.Sum256(body)
		plan.Sources[p] = hex.EncodeToString(sum[:])
	}
	candidates := integration.Lifecycle{PackagesDir: in.PackagesDir, Arch: in.Arch}
	for _, id := range []string{"proxy", "network", "vpn"} {
		m, err := candidates.Candidate(id, in.Version)
		if err != nil {
			return plan, err
		}
		plan.Integrations = append(plan.Integrations, integration.Installed{Manifest: m, Enabled: true, Connection: "unconfigured"})
	}
	return plan, nil
}

// PrepareMigration publishes a complete new state directory in one rename. It
// does not stop legacy writers or start Core; cutover is a separate guarded step.
func PrepareMigration(plan MigrationPlan) error {
	if plan.Schema != 1 || len(plan.Integrations) != 3 {
		return fmt.Errorf("invalid migration plan")
	}
	state := plan.Config.StateDir
	if !filepath.IsAbs(state) || filepath.Dir(state) == state {
		return fmt.Errorf("invalid migration destination")
	}
	if old, err := os.ReadFile(filepath.Join(state, "migration.json")); err == nil {
		var prior MigrationPlan
		if json.Unmarshal(old, &prior) != nil {
			return fmt.Errorf("invalid prior migration journal")
		}
		want, _ := json.Marshal(plan)
		got, _ := json.Marshal(prior)
		if string(want) != string(got) {
			return fmt.Errorf("migration inputs changed; preserve existing Core state and prepare a new destination")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if _, err := os.Lstat(state); err == nil {
		return fmt.Errorf("Core state already exists without a migration journal")
	} else if !os.IsNotExist(err) {
		return err
	}
	for p, hash := range plan.Sources {
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		actual := sha256.Sum256(b)
		if hex.EncodeToString(actual[:]) != hash {
			return fmt.Errorf("legacy source changed after planning: %s", p)
		}
	}
	if err := os.MkdirAll(filepath.Dir(state), 0700); err != nil {
		return err
	}
	temp, err := os.MkdirTemp(filepath.Dir(state), ".core-migration-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	for name, body := range map[string]any{"config.json": plan.Config, "portal.json": plan.Catalog, "migration.json": plan} {
		if err = integration.AtomicJSON(filepath.Join(temp, name), body); err != nil {
			return err
		}
	}
	registry, err := integration.Open(filepath.Join(temp, "registry.json"), plan.Integrations[0].Manifest.Arch)
	if err != nil {
		return err
	}
	if err = registry.Replace(plan.Integrations); err != nil {
		return err
	}
	// Preserve private snapshots for inspection. Normal rollback keeps the live
	// paths rather than overwriting newer ACL, launcher, certificate or history data.
	index := 0
	for p := range plan.Sources {
		body, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != plan.Sources[p] {
			return fmt.Errorf("source changed during backup: %s", p)
		}
		if err = os.MkdirAll(filepath.Join(temp, "backup"), 0700); err != nil {
			return err
		}
		if err = os.WriteFile(filepath.Join(temp, "backup", fmt.Sprintf("%d-%s", index, filepath.Base(p))), body, 0600); err != nil {
			return err
		}
		index++
	}
	return os.Rename(temp, state)
}
