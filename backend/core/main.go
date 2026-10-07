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
)

func main() {
	file := flag.String("config", "/opt/etc/homenet/core/config.json", "Core configuration")
	flag.Parse()
	config := core.Config{Listen: "127.0.0.1:18490", StateDir: "/opt/etc/homenet/core", StaticDir: "/opt/share/homenet/core", PackagesDir: "/opt/share/homenet/integrations", AccountURL: "http://127.0.0.1:63415", DMSURL: "http://127.0.0.1:63416", DMSTokenFile: "/opt/dms/token"}
	b, err := os.ReadFile(*file)
	if err != nil && !os.IsNotExist(err) {
		log.Fatal(err)
	}
	if err == nil {
		if err = json.Unmarshal(b, &config); err != nil {
			log.Fatal(err)
		}
	}
	handler, err := core.New(config, runtime.GOARCH)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: config.Listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		deadline, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_ = server.Shutdown(deadline)
	}()
	log.Printf("HomeNet Core listening on %s", config.Listen)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
