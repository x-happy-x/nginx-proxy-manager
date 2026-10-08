package main

import (
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/launcher"
	"net/http"
	"path/filepath"
)

type launcherDevice = launcher.Device
type launcherLink = launcher.Link
type launcherAppOverride = launcher.AppOverride
type launcherConfig = launcher.Config
type launcherProbe = launcher.Probe

var launcherTarget = launcher.Target
var validLauncherURL = launcher.ValidURL

func (a *app) launcherPath() string {
	return filepath.Join(filepath.Dir(a.routesPath()), "launcher.json")
}
func (a *app) loadLauncher() (*launcherConfig, error) {
	return (launcher.Store{Path: a.launcherPath()}).Load()
}
func (a *app) saveLauncher(c launcherConfig) error {
	return (launcher.Store{Path: a.launcherPath()}).Save(c)
}
func (a *app) handleLauncherGet(w http.ResponseWriter) {
	(launcher.Store{Path: a.launcherPath()}).Get(w)
}
func (a *app) handleLauncherSave(w http.ResponseWriter, r *http.Request) {
	(launcher.Store{Path: a.launcherPath()}).Post(w, r)
}
func (a *app) handleLauncherStatus(w http.ResponseWriter, r *http.Request) {
	(launcher.Store{Path: a.launcherPath()}).Status(w, r)
}
