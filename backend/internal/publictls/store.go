// Package publictls stores certificate/key pairs obtained through pinned SSH.
// Immutable versions and one atomic manifest prevent a partially replaced pair.
package publictls

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var versionRE = regexp.MustCompile(`^[a-f0-9]{64}$`)

func Validate(host string, cert, key []byte, now time.Time) error {
	pair, err := tls.X509KeyPair(cert, key)
	if err != nil {
		return fmt.Errorf("invalid certificate/key pair for %s", host)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return err
	}
	if err = leaf.VerifyHostname(host); err != nil {
		return err
	}
	if now.Before(leaf.NotBefore) || !leaf.NotAfter.After(now.Add(5*time.Minute)) {
		return fmt.Errorf("certificate for %s is expired or not yet valid", host)
	}
	return nil
}

func dir(root, server, host string) string { return filepath.Join(root, "public-certs", server, host) }

func Paths(root, server, host string, now time.Time) (string, string, error) {
	d := dir(root, server, host)
	b, err := os.ReadFile(filepath.Join(d, "current"))
	if err != nil {
		return "", "", fmt.Errorf("%s: local VPS certificate is not synchronized", host)
	}
	v := string(b)
	if !versionRE.MatchString(v) {
		return "", "", fmt.Errorf("invalid certificate manifest")
	}
	crt, key := filepath.Join(d, v+".crt"), filepath.Join(d, v+".key")
	c, err := os.ReadFile(crt)
	if err != nil {
		return "", "", err
	}
	k, err := os.ReadFile(key)
	if err != nil {
		return "", "", err
	}
	if err = Validate(host, c, k, now); err != nil {
		return "", "", err
	}
	return crt, key, nil
}

func Save(root, server, host string, cert, key []byte, now time.Time) (bool, error) {
	if err := Validate(host, cert, key, now); err != nil {
		return false, err
	}
	d := dir(root, server, host)
	if err := os.MkdirAll(d, 0700); err != nil {
		return false, err
	}
	h := sha256.New()
	h.Write(cert)
	h.Write(key)
	v := hex.EncodeToString(h.Sum(nil))
	previous, _ := os.ReadFile(filepath.Join(d, "current"))
	if string(previous) == v {
		_, _, err := Paths(root, server, host, now)
		if err == nil {
			return false, nil
		}
	}
	for name, body := range map[string][]byte{v + ".crt": cert, v + ".key": key} {
		if err := os.WriteFile(filepath.Join(d, name), body, 0600); err != nil {
			return false, err
		}
	}
	f, err := os.CreateTemp(d, ".current-")
	if err != nil {
		return false, err
	}
	defer os.Remove(f.Name())
	if _, err = f.WriteString(v); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return false, err
	}
	if err = os.Rename(f.Name(), filepath.Join(d, "current")); err != nil {
		return false, err
	}
	return true, nil
}
