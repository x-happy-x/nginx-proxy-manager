package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"testing"
)

func TestParseProbeTarget(t *testing.T) {
	cases := []struct {
		in, host, path string
		port           int
		bad            bool
	}{
		{in: "YouTube.com", host: "youtube.com", port: 443, path: "/"},
		{in: "speed.cloudflare.com/__down?bytes=200000", host: "speed.cloudflare.com", port: 443, path: "/__down?bytes=200000"},
		{in: "https://example.org:8443/a/b", host: "example.org", port: 8443, path: "/a/b"},
		{in: "1.2.3.4", host: "1.2.3.4", port: 443, path: "/"},
		{in: "http://example.org", bad: true},
		{in: "localhost", bad: true},
		{in: "bad_host.com", bad: true},
		{in: "", bad: true},
	}
	for _, c := range cases {
		host, port, path, err := parseProbeTarget(c.in)
		if c.bad {
			if err == nil {
				t.Errorf("%q: want error", c.in)
			}
			continue
		}
		if err != nil || host != c.host || port != c.port || path != c.path {
			t.Errorf("%q: got %q %d %q %v", c.in, host, port, path, err)
		}
	}
}

func TestDNSRoundTrip(t *testing.T) {
	query := buildDNSQuery(0x1234, "ya.ru")
	// Answer: the question echoed plus two A records with name compression.
	resp := append([]byte{}, query...)
	resp[2], resp[3] = 0x81, 0x80
	binary.BigEndian.PutUint16(resp[6:], 2)
	for _, ip := range [][]byte{{77, 88, 44, 242}, {5, 255, 255, 242}} {
		resp = append(resp, 0xC0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4)
		resp = append(resp, ip...)
	}
	ips, rcode, err := parseDNSResponse(resp)
	if err != nil || rcode != 0 || len(ips) != 2 || ips[0] != "77.88.44.242" || ips[1] != "5.255.255.242" {
		t.Fatalf("got %v %d %v", ips, rcode, err)
	}
	resp[3] = 0x83 // NXDOMAIN
	binary.BigEndian.PutUint16(resp[6:], 0)
	if _, rcode, _ := parseDNSResponse(resp[:len(query)]); dnsRcodes[rcode] != "NXDOMAIN" {
		t.Fatalf("rcode %d", rcode)
	}
}

func TestBogusAnswer(t *testing.T) {
	if !bogusAnswer([]string{"10.10.34.36"}, false) {
		t.Error("private address must be bogus")
	}
	if bogusAnswer([]string{"198.18.0.5"}, true) {
		t.Error("mihomo fake-ip is expected for mihomo answers")
	}
	if bogusAnswer([]string{"142.250.74.14"}, false) {
		t.Error("public address is fine")
	}
}

func TestROSWordLengths(t *testing.T) {
	for _, n := range []int{0, 1, 0x7F, 0x80, 0x3FFF, 0x4000, 0x1FFFFF, 0x200000, 0xFFFFFFF, 0x10000000} {
		buf := appendROSLength(nil, n)
		c := &rosConn{r: bufio.NewReader(bytes.NewReader(buf))}
		got, err := c.readLength()
		if err != nil || got != n {
			t.Errorf("%#x: got %#x %v", n, got, err)
		}
	}
}

func TestParseROSDuration(t *testing.T) {
	cases := map[string]float64{"13h20m6s": 48006, "69ms818us": 0.069818, "1w2d": 9 * 86400, "00:01:02": 62, "5": 5}
	for in, want := range cases {
		if got := parseROSDuration(in); got < want-1e-6 || got > want+1e-6 {
			t.Errorf("%q: got %v want %v", in, got, want)
		}
	}
}

func TestFinishPathVerdicts(t *testing.T) {
	p := probePath{Steps: []probeStep{{ID: "dns", Status: "ok"}, {ID: "tcp", Status: "ok"}, {ID: "tls", Status: "fail", Cause: "sni"}}}
	finishPath(&p)
	if p.Verdict != "sni" || p.FailAt != "tls" {
		t.Errorf("sni: %+v", p)
	}
	p = probePath{Steps: []probeStep{{ID: "tcp", Status: "ok"}, {ID: "tls", Status: "ok"}, {ID: "http", Status: "fail", Detail: "заглушка блокировки: 302"}}}
	finishPath(&p)
	if p.Verdict != "stub" {
		t.Errorf("stub: %+v", p)
	}
	p = probePath{Steps: []probeStep{{ID: "tcp", Status: "ok"}, {ID: "bulk", Status: "warn"}}}
	finishPath(&p)
	if p.Verdict != "ok" {
		t.Errorf("warn only: %+v", p)
	}
}

func TestSummarizeHintsDirectClients(t *testing.T) {
	res := analysis{Clients: clientRoute{Via: "mihomo", Rule: "RuleSet (ru)", Chain: []string{"Белые списки", "DIRECT"}, Direct: true}, DNS: []dnsAnswer{{Verdict: "reference", IPs: []string{"1.1.1.1"}}}}
	summarize(&res, map[string]probePath{"direct": {Verdict: "sni"}, "mihomo": {Verdict: "ok"}})
	if res.Verdict != "partial" || len(res.Hints) == 0 {
		t.Errorf("clients sent into a block must be flagged: %+v", res)
	}
}

func TestHeaderContentLength(t *testing.T) {
	head := "HTTP/1.1 301 Moved\r\nContent-Length: 42\r\nLocation: https://warning.rt.ru/?id=1\r\n\r\n"
	if headerContentLength(head) != 42 {
		t.Error("content-length")
	}
	if _, loc := parseHTTPHead(head); !stubPattern.MatchString(loc) {
		t.Error("stub location must match")
	}
}
