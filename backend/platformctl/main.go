// platformctl prepares an offline migration and recovers worker versions when
// the web console is unavailable. It never invokes the legacy service or engines.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/core"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: platformctl migrate|recover|apply")
	}
	switch os.Args[1] {
	case "ready-url", "verify-migration":
		fs := flag.NewFlagSet(os.Args[1], flag.ContinueOnError)
		file := fs.String("config", "/opt/etc/homenet/core/config.json", "Core configuration")
		if err := fs.Parse(os.Args[2:]); err != nil {
			return err
		}
		b, err := os.ReadFile(*file)
		if err != nil {
			return err
		}
		var cfg core.Config
		if err = json.Unmarshal(b, &cfg); err != nil {
			return err
		}
		if os.Args[1] == "ready-url" {
			host, port, err := net.SplitHostPort(cfg.Listen)
			if err != nil {
				return err
			}
			if host == "" || host == "0.0.0.0" || host == "::" {
				host = "127.0.0.1"
			}
			fmt.Println("http://" + net.JoinHostPort(host, port) + "/health/ready")
			return nil
		}
		b, err = os.ReadFile(filepath.Join(cfg.StateDir, "migration.json"))
		if err != nil {
			return err
		}
		var plan core.MigrationPlan
		if err = json.Unmarshal(b, &plan); err != nil {
			return err
		}
		return core.VerifyMigration(plan)
	case "migrate":
		fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
		legacy := fs.String("legacy", "/opt/etc/homenet/nginx", "existing application directory")
		state := fs.String("state", "/opt/etc/homenet/core", "new Core state directory")
		packages := fs.String("packages", "/opt/share/homenet/integrations", "staged integration packages")
		static := fs.String("static", "/opt/share/homenet/core/current/ui", "Core UI directory")
		version := fs.String("version", "1.0.0", "release-set version")
		dry := fs.Bool("dry-run", true, "inspect only; set false to prepare the new state")
		if err := fs.Parse(os.Args[2:]); err != nil {
			return err
		}
		plan, err := core.PlanMigration(core.MigrationInput{LegacyDir: *legacy, StateDir: *state, PackagesDir: *packages, StaticDir: *static, Version: *version, Arch: runtime.GOARCH})
		if err != nil {
			return err
		}
		if !*dry {
			if err = core.PrepareMigration(plan); err != nil {
				return err
			}
		}
		// Only path references/hashes and public catalog are printed, never source bytes.
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"dry_run": *dry, "listen": plan.Config.Listen, "state": plan.Config.StateDir, "source_count": len(plan.Sources), "integrations": len(plan.Integrations), "services_changed": false})
	case "recover":
		fs := flag.NewFlagSet("recover", flag.ContinueOnError)
		file := fs.String("config", "/opt/etc/homenet/core/config.json", "Core config; stop Core before offline recovery")
		if err := fs.Parse(os.Args[2:]); err != nil {
			return err
		}
		b, err := os.ReadFile(*file)
		if err != nil {
			return err
		}
		var cfg core.Config
		if err = json.Unmarshal(b, &cfg); err != nil {
			return err
		}
		unlock, err := integration.LockState(cfg.StateDir)
		if err != nil {
			return err
		}
		defer unlock()
		server, err := core.New(cfg, runtime.GOARCH)
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		return server.Lifecycle.Recover(ctx)
	case "apply":
		// Root on the router stands in for the console when the change cannot wait for a
		// signed-in administrator: the same plan → apply journal, under Core's lock.
		fs := flag.NewFlagSet("apply", flag.ContinueOnError)
		file := fs.String("config", "/opt/etc/homenet/core/config.json", "Core config; stop Core before offline changes")
		changes := fs.String("changes", "", `JSON list, e.g. [{"id":"pve","action":"install","version":"1.0.0"}]`)
		dry := fs.Bool("dry-run", true, "plan only; set false to apply the plan")
		if err := fs.Parse(os.Args[2:]); err != nil {
			return err
		}
		var list []integration.Change
		if err := json.Unmarshal([]byte(*changes), &list); err != nil {
			return fmt.Errorf("invalid -changes: %w", err)
		}
		b, err := os.ReadFile(*file)
		if err != nil {
			return err
		}
		var cfg core.Config
		if err = json.Unmarshal(b, &cfg); err != nil {
			return err
		}
		unlock, err := integration.LockState(cfg.StateDir)
		if err != nil {
			return err
		}
		defer unlock()
		server, err := core.New(cfg, runtime.GOARCH)
		if err != nil {
			return err
		}
		op, err := server.Lifecycle.Plan(list)
		if err != nil {
			return err
		}
		if !*dry {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			op, err = server.Lifecycle.Apply(ctx, op.ID)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"id": op.ID, "status": op.Status, "step": op.Step, "error": op.Error, "dry_run": *dry})
		return err
	default:
		return fmt.Errorf("unknown command")
	}
}
