package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/golang/internal/envfile"
)

func loadRuntimeEnv(baseDir string) {
	path := getenv("CONFIG_ENV_PATH", filepath.Join(baseDir, "config", "runtime.env"))
	_ = envfile.Load(path)
}

func resolveBaseDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	baseDir := filepath.Dir(exe)
	if wd, err := os.Getwd(); err == nil && fileExists(filepath.Join(wd, "init.d")) {
		baseDir = wd
	} else if resolved, ok := findProjectRoot(baseDir); ok {
		baseDir = resolved
	}
	return baseDir, nil
}

func resolvePath(baseDir, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(baseDir, path)
}

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func findProjectRoot(start string) (string, bool) {
	dir := start
	for {
		if fileExists(filepath.Join(dir, "init.d")) {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}
