package main

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestGroupFoldersRoundTripAndConflict(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MIHOMO_STATE_DIR", dir)
	before, err := readGroupFolders()
	if err != nil || len(before.Folders) != 0 {
		t.Fatal(before, err)
	}
	folders := []groupFolder{{ID: "my-folder", Name: " Игры ", Groups: []string{"Казахстан · VLESS", "исчезнувший узел", "Казахстан · VLESS"}}}
	after, err := writeGroupFolders(before.Revision, folders)
	if err != nil {
		t.Fatal(err)
	}
	read, err := readGroupFolders()
	if err != nil || read.Revision != after.Revision || read.Folders[0].Name != "Игры" || len(read.Folders[0].Groups) != 2 {
		t.Fatal(read, err)
	}
	if _, err = writeGroupFolders(before.Revision, nil); !errors.Is(err, errGroupFoldersConflict) {
		t.Fatal("stale write accepted", err)
	}
	read, _ = readGroupFolders()
	if len(read.Folders) != 1 {
		t.Fatal("stale write lost folders")
	}
	if _, err = writeGroupFolders(read.Revision, []groupFolder{{ID: "other", Name: "Игры"}, {ID: "duplicate", Name: "игры"}}); err == nil {
		t.Fatal("duplicate names accepted")
	}
	if _, err = writeGroupFolders(read.Revision, []groupFolder{{ID: "../escape", Name: "bad"}}); err == nil {
		t.Fatal("bad id accepted")
	}
	if _, err = writeGroupFolders(read.Revision, nil); err != nil {
		t.Fatal(err)
	}
	read, _ = readGroupFolders()
	if read.Folders == nil || len(read.Folders) != 0 {
		t.Fatal(read)
	}
}
func TestGroupFoldersCorruptionIsNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MIHOMO_STATE_DIR", dir)
	path := filepath.Join(dir, "group-folders.json")
	os.WriteFile(path, []byte("broken"), 0o600)
	if _, err := writeGroupFolders("", nil); err == nil {
		t.Fatal("corrupt data overwritten")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "broken" {
		t.Fatal(string(raw))
	}
}

func TestGroupFoldersConcurrentWritersUseCAS(t *testing.T) {
	t.Setenv("MIHOMO_STATE_DIR", t.TempDir())
	initial, err := readGroupFolders()
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, id := range []string{"first", "second"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			<-start
			_, err := writeGroupFolders(initial.Revision, []groupFolder{{ID: id, Name: id, Groups: []string{"node"}}})
			results <- err
		}(id)
	}
	close(start)
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, errGroupFoldersConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal(successes, conflicts)
	}
	read, err := readGroupFolders()
	if err != nil || len(read.Folders) != 1 {
		t.Fatal(read, err)
	}
}
