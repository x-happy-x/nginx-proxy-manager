package publictls

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testPair(t *testing.T, host string, expires time.Time) ([]byte, []byte) {
	t.Helper()
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: host}, DNSNames: []string{host}, NotBefore: time.Now().Add(-time.Hour), NotAfter: expires, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalPKCS8PrivateKey(key)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}

func TestAtomicRenewalRejectsWrongExpiredAndMismatchedPairs(t *testing.T) {
	root, host := t.TempDir(), "app.cdn6.ru"
	now := time.Now()
	cert, key := testPair(t, host, now.Add(24*time.Hour))
	if changed, err := Save(root, "cdn6", host, cert, key, now); err != nil || !changed {
		t.Fatalf("save %v %v", changed, err)
	}
	before, _, err := Paths(root, "cdn6", host, now)
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := Save(root, "cdn6", host, cert, key, now); err != nil || changed {
		t.Fatal("unchanged certificate must not reload")
	}
	wrong, wrongKey := testPair(t, "other.example", now.Add(time.Hour))
	expired, expiredKey := testPair(t, host, now.Add(-time.Minute))
	for _, pair := range [][2][]byte{{wrong, wrongKey}, {expired, expiredKey}, {cert, wrongKey}} {
		if _, err := Save(root, "cdn6", host, pair[0], pair[1], now); err == nil {
			t.Fatal("invalid certificate accepted")
		}
		current, _, _ := Paths(root, "cdn6", host, now)
		if current != before {
			t.Fatal("invalid renewal replaced working pair")
		}
	}
	next, nextKey := testPair(t, host, now.Add(48*time.Hour))
	if _, err := Save(root, "cdn6", host, next, nextKey, now); err != nil {
		t.Fatal(err)
	}
	current, _, err := Paths(root, "cdn6", host, now)
	if err != nil || current == before {
		t.Fatal("renewal not activated")
	}
	if _, err := os.Stat(before); err != nil {
		t.Fatal("old nginx workers lost their certificate")
	}
	if _, _, err := Paths(root, "another", host, now); err == nil {
		t.Fatal("another VPS adopted certificate")
	}
	if err := os.WriteFile(filepath.Join(dir(root, "cdn6", host), "current"), []byte("../../secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Paths(root, "cdn6", host, now); err == nil {
		t.Fatal("unsafe manifest accepted")
	}
}
