package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadNodesMeta(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "providers"), 0o755); err != nil {
		t.Fatal(err)
	}
	sub := `proxies:
  - name: "ОБХОД №1-1"
    type: vless
    server: 31.177.111.108
    port: 443
    uuid: secret-uuid
    servername: www.vk.com
  - name: "ОБХОД №1-2"
    type: vless
    server: 31.177.111.108
    port: 443
    uuid: secret-uuid
    sni: yandex.ru
  - name: broken
    type: vless
`
	if err := os.WriteFile(filepath.Join(dir, "providers", "router.yaml"), []byte(sub), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := `proxies:
  - name: own
    type: trojan
    server: own.example.org
    port: 8443
    password: secret-pass
proxy-providers:
  ROUTER:
    type: http
    path: ./providers/router.yaml
  AI:
    type: file
    path: ./providers/router.yaml
    override:
      additional-prefix: "ИИ | "
  OUTSIDE:
    type: file
    path: ../../etc/passwd
`
	nodes, err := readNodesMeta(filepath.Join(dir, "config.yaml"), []byte(cfg))
	if err != nil {
		t.Fatal(err)
	}
	if n := nodes["ОБХОД №1-1"]; n.Server != "31.177.111.108" || n.SNI != "www.vk.com" || n.Port != 443 || n.Provider != "ROUTER" {
		t.Errorf("1-1 = %+v", n)
	}
	if n := nodes["ОБХОД №1-2"]; n.SNI != "yandex.ru" {
		t.Errorf("1-2 = %+v", n)
	}
	if n := nodes["ИИ | ОБХОД №1-1"]; n.Provider != "AI" {
		t.Errorf("prefixed = %+v", n)
	}
	if n := nodes["own"]; n.Server != "own.example.org" || n.Provider != "" {
		t.Errorf("own = %+v", n)
	}
	if _, ok := nodes["broken"]; ok {
		t.Error("node without a server listed")
	}
	if len(nodes) != 5 {
		t.Errorf("%d nodes: %v", len(nodes), nodes)
	}
	for name, n := range nodes {
		if strings.Contains(name+n.Server+n.SNI, "secret") {
			t.Errorf("secret leaked in %s", name)
		}
	}
}
