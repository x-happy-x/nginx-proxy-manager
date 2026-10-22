package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/core"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

func main() {
	file := flag.String("config", "/opt/etc/homenet/core/config.json", "Core configuration")
	flag.Parse()
	config := core.Config{Listen: "127.0.0.1:18490", StateDir: "/opt/etc/homenet/core", StaticDir: "/opt/share/homenet/core/current/ui", PackagesDir: "/opt/share/homenet/integrations", AccountURL: "http://127.0.0.1:63415", DMSURL: "http://127.0.0.1:63416", DMSTokenFile: "/opt/dms/token"}
	config.ManageWorkers = true
	config.WorkerEnv = "/opt/etc/homenet/nginx/config/runtime.env"
	b, err := os.ReadFile(*file)
	if err != nil && !os.IsNotExist(err) {
		log.Fatal(err)
	}
	if err == nil {
		if err = json.Unmarshal(b, &config); err != nil {
			log.Fatal(err)
		}
	}
	if config.ManageWorkers {
		unlock, err := integration.LockState(config.StateDir)
		if err != nil {
			log.Fatal(err)
		}
		defer unlock()
	}
	handler, err := core.New(config, runtime.GOARCH)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: config.Listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if config.ManageWorkers {
		if err := handler.Lifecycle.Recover(ctx); err != nil {
			log.Printf("integration recovery requires attention: %v", err)
		} else if err = handler.Lifecycle.Reconcile(ctx); err != nil {
			log.Printf("integration startup: %v", err)
		}
		go func() {
			tick := time.NewTicker(15 * time.Second)
			defer tick.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					if err := handler.Lifecycle.Reconcile(ctx); err != nil {
						log.Printf("integration reconcile: %v", err)
					}
				}
			}
		}()
	}
	go handler.WatchApps(ctx)
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		_ = server.Shutdown(context.Background())
		handler.WaitOperations()
		if config.ManageWorkers {
			for {
				drain, finish := context.WithTimeout(context.Background(), 2*time.Minute)
				err := handler.Lifecycle.Shutdown(drain)
				finish()
				if err == nil {
					break
				}
				log.Printf("waiting for workers before releasing Core ownership: %v", err)
				time.Sleep(time.Second)
			}
		}
	}()
	log.Printf("HomeNet Core listening on %s", config.Listen)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	<-stopped
}
