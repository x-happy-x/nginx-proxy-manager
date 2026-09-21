package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func rotationWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o640); err != nil {
		t.Fatal(err)
	}
}
func rotationRead(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
func TestLogRotationBoundedBackupsAndSingleReopen(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "route.log")
	rotationWrite(t, path, "current content")
	for i := 1; i <= 4; i++ {
		rotationWrite(t, path+"."+strconv.Itoa(i), strconv.Itoa(i))
	}
	foreign := filepath.Join(root, "unrelated.log")
	rotationWrite(t, foreign, "untouched")
	calls := 0
	if err := rotateLogFiles([]string{path, path}, 5, func() error { calls++; return nil }); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || rotationRead(t, path) != "" || rotationRead(t, path+".1") != "current content" || rotationRead(t, path+".4") != "3" || rotationRead(t, foreign) != "untouched" {
		t.Fatal("incorrect rotation")
	}
	if _, err := os.Stat(path + ".5"); !os.IsNotExist(err) {
		t.Fatal("backup count exceeded")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 6 {
		t.Fatalf("temporary files leaked: %v", entries)
	}
}
func TestLogRotationBelowLimitDoesNotSignal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	rotationWrite(t, path, "12345")
	if err := rotateLogFiles([]string{path}, 5, func() error { t.Fatal("reopen below threshold"); return nil }); err != nil {
		t.Fatal(err)
	}
	if rotationRead(t, path) != "12345" {
		t.Fatal("small log changed")
	}
}
func TestLogRotationReopenFailureRollsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "route.log")
	rotationWrite(t, path, "current data")
	for i := 1; i <= 4; i++ {
		rotationWrite(t, path+"."+strconv.Itoa(i), strconv.Itoa(i))
	}
	if err := rotateLogFiles([]string{path}, 1, func() error { return errors.New("signal rejected") }); err == nil {
		t.Fatal("missing error")
	}
	if rotationRead(t, path) != "current data" {
		t.Fatal("active log not restored")
	}
	for i := 1; i <= 4; i++ {
		if rotationRead(t, path+"."+strconv.Itoa(i)) != strconv.Itoa(i) {
			t.Fatal("backup lost", i)
		}
	}
}
func TestLogRotationNeverClobbersNewWritesOnFailedReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "route.log")
	rotationWrite(t, path, "old data")
	if err := rotateLogFiles([]string{path}, 1, func() error { rotationWrite(t, path, "new data"); return errors.New("uncertain signal result") }); err == nil {
		t.Fatal("missing rollback limitation")
	}
	if rotationRead(t, path) != "new data" || rotationRead(t, path+".1") != "old data" {
		t.Fatal("log data lost")
	}
}
func TestLogRotationRejectsUnsafePathsBeforeMutation(t *testing.T) {
	root := t.TempDir()
	valid := filepath.Join(root, "valid.log")
	rotationWrite(t, valid, "preserved")
	if err := rotateLogFiles([]string{valid, valid + ".1"}, 1, func() error { return nil }); err == nil {
		t.Fatal("overlapping explicit paths accepted")
	}
	for _, unsafe := range []string{"relative.log", root} {
		if err := rotateLogFiles([]string{valid, unsafe}, 1, func() error { t.Fatal("unsafe signal"); return nil }); err == nil {
			t.Fatal("unsafe path accepted", unsafe)
		}
		if rotationRead(t, valid) != "preserved" {
			t.Fatal("earlier log mutated before validation")
		}
	}
	link := filepath.Join(root, "symlink.log")
	if err := os.Symlink(valid, link); err != nil {
		t.Skip("symlinks unavailable", err)
	}
	if err := rotateLogFiles([]string{link}, 1, func() error { return nil }); err == nil {
		t.Fatal("symlink source accepted")
	}
	if err := os.Symlink(valid, valid+".1"); err != nil {
		t.Fatal(err)
	}
	if err := rotateLogFiles([]string{valid}, 1, func() error { return nil }); err == nil {
		t.Fatal("symlink backup accepted")
	}
	if rotationRead(t, valid) != "preserved" {
		t.Fatal("symlink target modified")
	}
}
