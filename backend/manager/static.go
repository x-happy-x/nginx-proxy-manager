package main

import (
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func (a *app) resolveStaticPath(relPath string) string {
	path := filepath.Join(a.staticDir, relPath)
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		return path
	}
	return ""
}

func (a *app) serveStatic(w http.ResponseWriter, relPath string) {
	relPath = strings.TrimLeft(relPath, "/")
	if strings.Contains(relPath, "..") || strings.HasPrefix(relPath, ".") {
		http.Error(w, "Bad path", http.StatusBadRequest)
		return
	}
	path := a.resolveStaticPath(relPath)
	if path == "" {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	body, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
