package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestUnavailablePagesCoverLocalAndPublicEntrances(t *testing.T) {
	g := newGenerator("/opt/etc/homenet/proxy")
	g.preview = true
	r := testRoutes()
	r.Apps[0].Name = `Sub <script>alert(1)</script>`
	files, err := g.render(r)
	if err != nil {
		t.Fatal(err)
	}
	conf := files[filepath.Join(g.sitesEnabled, "sub.crubs.crazedns.ru.conf")]
	for _, want := range []string{
		"error_page 502 /__homenet/unavailable-502.html;",
		"error_page 504 /__homenet/unavailable-504.html;",
		`alias "/opt/etc/homenet/proxy/errors/sub.crubs.crazedns.ru.local.502.html";`,
		`alias "/opt/etc/homenet/proxy/errors/sub.crubs.crazedns.ru.public.504.html";`,
		"internal;",
	} {
		if !strings.Contains(conf, want) {
			t.Errorf("config missing %q", want)
		}
	}
	if strings.Contains(conf, "proxy_intercept_errors") {
		t.Fatal("application error responses must pass through unchanged")
	}

	local := files[filepath.Join(g.errorsDir, "sub.crubs.crazedns.ru.local.502.html")]
	public := files[filepath.Join(g.errorsDir, "sub.crubs.crazedns.ru.public.502.html")]
	timeout := files[filepath.Join(g.errorsDir, "sub.crubs.crazedns.ru.local.504.html")]
	if local == "" || public == "" || timeout == "" {
		t.Fatal("error pages not rendered")
	}
	if !strings.HasPrefix(local, managedHTMLHeader) {
		t.Fatal("error page is not marked as managed")
	}
	if !strings.Contains(local, "http://192.168.99.20:4192") || !strings.Contains(local, "Что проверить") {
		t.Fatal("local page lacks diagnostics")
	}
	if strings.Contains(public, "192.168.99.20") || strings.Contains(public, "Что проверить") {
		t.Fatal("public page exposes internal details")
	}
	if !strings.Contains(timeout, "не ответил вовремя") || !strings.Contains(timeout, "Ошибка 504") {
		t.Fatal("timeout page does not explain 504")
	}
	if strings.Contains(local, "<script>alert") || !strings.Contains(local, "&lt;script&gt;") {
		t.Fatal("application name not escaped")
	}
}

func TestUnavailablePagesAreTransactionalAndStaleOnesRemoved(t *testing.T) {
	g := testGenerator(t)
	stale := filepath.Join(g.errorsDir, "gone.local.local.502.html")
	if err := writeFile(stale, managedHTMLHeader+"old", 0o644); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(g.errorsDir, "custom.html")
	if err := writeFile(foreign, "<p>mine</p>", 0o644); err != nil {
		t.Fatal(err)
	}
	g.command = func(string, ...string) error { return nil }
	if err := g.apply(testRoutes()); err != nil {
		t.Fatal(err)
	}
	page := filepath.Join(g.errorsDir, "sub.crubs.crazedns.ru.local.502.html")
	if !exists(page) {
		t.Fatal("error page not installed")
	}
	if exists(stale) {
		t.Fatal("stale managed error page retained")
	}
	if fileBody(t, foreign) != "<p>mine</p>" {
		t.Fatal("foreign file changed")
	}
	conf := fileBody(t, filepath.Join(g.sitesEnabled, "sub.crubs.crazedns.ru.conf"))
	if !strings.Contains(conf, quote(page)) || strings.Contains(conf, "npm-nginx-stage-") {
		t.Fatal("live config does not reference the live error page")
	}
}
