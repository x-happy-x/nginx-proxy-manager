package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeCert(t *testing.T, dir, host string, until time.Time) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: host}, NotBefore: until.Add(-90 * 24 * time.Hour), NotAfter: until}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, host+".crt"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
}

// NPM-67: certificates by expiry, the soonest first, and the attention they raise.
func TestHomeCertificatesWidget(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "selfsigned")
	_ = os.MkdirAll(dir, 0o700)
	now := time.Now()
	writeCert(t, dir, "ok.example", now.Add(60*24*time.Hour))
	writeCert(t, dir, "soon.example", now.Add(5*24*time.Hour))
	writeCert(t, dir, "old.example", now.Add(-2*24*time.Hour))
	a := &app{nginxConfRoot: root, activeRoutesPath: filepath.Join(root, "absent.yml")}
	w := a.widgetCertificates()
	items := w.Body.(map[string]any)["items"].([]widgetItem)
	if w.State != "bad" || len(items) != 3 || items[0].Text != "old.example" || items[0].State != "bad" || items[1].State != "warn" || items[2].State != "ok" {
		t.Fatalf("%+v", w)
	}
	att := a.proxyAttention()
	sev := map[string]string{}
	for _, it := range att {
		sev[it.ID] = it.Severity
	}
	if sev["cert-old.example"] != "critical" || sev["cert-soon.example"] != "warning" || sev["cert-ok.example"] != "" || sev["nginx-down"] != "critical" {
		t.Fatalf("%+v", att)
	}
}

func TestHomeNetworkWidgets(t *testing.T) {
	saved := netmon
	t.Cleanup(func() { netmon = saved })
	netmon = &netMonitor{targets: []netTarget{{ID: "dns", Name: "DNS", Category: "internet"}}}
	now := time.Now().Unix()
	for i := 0; i < 60; i++ {
		ok := i < 50 // the last ten minutes without internet
		netmon.history = append(netmon.history, netSample{T: now - int64(60-i)*60, API: true, LTE: "running", NC: map[string]pingLite{"dns": {OK: ok}}, MT: map[string]pingLite{"dns": {OK: ok}}})
	}
	a := &app{}
	w := a.widgetInternet()
	if w.State != "bad" || w.Body.(map[string]any)["label"] != "Нет интернета" {
		t.Fatalf("internet: %+v", w)
	}
	av := a.widgetAvailability()
	if av.State != "bad" && av.State != "warn" || !strings.Contains(av.Note, "%") {
		t.Fatalf("availability: %+v", av)
	}
	att := a.networkAttention()
	if len(att) != 1 || att[0].ID != "internet-down" || att[0].Since != stamp(now-10*60) {
		t.Fatalf("attention: %+v", att)
	}
	if plural(1, "домен", "домена", "доменов") != "домен" || plural(12, "домен", "домена", "доменов") != "доменов" || plural(23, "домен", "домена", "доменов") != "домена" {
		t.Fatal("plural")
	}
}

func TestHomeRequestsWidgetCounts(t *testing.T) {
	dir := t.TempDir()
	a := &app{routeAccessLog: filepath.Join(dir, "access.log")}
	store := a.ensureTelemetry()
	now := time.Now()
	agg := store.aggregate(now, 24*time.Hour, "", "")
	if _, ok := agg["total_requests"].(int64); !ok {
		t.Fatalf("total_requests is %T, the widget reads int64", agg["total_requests"])
	}
	if got := thousands(18240); got != "18 240" || thousands(999) != "999" || thousands(1234567) != "1 234 567" {
		t.Fatal(got)
	}
	if w := a.widgetRequests(); !strings.HasPrefix(w.Note, "0 запросов") {
		t.Fatal(w.Note)
	}
}
