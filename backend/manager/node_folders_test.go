package main

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestNodeFoldersRoundTripAndConflict(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MIHOMO_STATE_DIR", dir)
	before, err := readNodeFolders()
	if err != nil || len(before.Folders) != 0 {
		t.Fatal(before, err)
	}
	folders := []nodeFolder{{ID: "my-folder", Name: " Игры ", Nodes: []string{"Казахстан · VLESS", "исчезнувший узел", "Казахстан · VLESS"}}}
	after, err := writeNodeFolders(before.Revision, folders)
	if err != nil {
		t.Fatal(err)
	}
	read, err := readNodeFolders()
	if err != nil || read.Revision != after.Revision || read.Folders[0].Name != "Игры" || len(read.Folders[0].Nodes) != 2 {
		t.Fatal(read, err)
	}
	if _, err = writeNodeFolders(before.Revision, nil); !errors.Is(err, errNodeFoldersConflict) {
		t.Fatal("stale write accepted", err)
	}
	read, _ = readNodeFolders()
	if len(read.Folders) != 1 {
		t.Fatal("stale write lost folders")
	}
	if _, err = writeNodeFolders(read.Revision, []nodeFolder{{ID: "other", Name: "Игры"}, {ID: "duplicate", Name: "игры"}}); err == nil {
		t.Fatal("duplicate names accepted")
	}
	if _, err = writeNodeFolders(read.Revision, []nodeFolder{{ID: "../escape", Name: "bad"}}); err == nil {
		t.Fatal("bad id accepted")
	}
	if _, err = writeNodeFolders(read.Revision, nil); err != nil {
		t.Fatal(err)
	}
	read, _ = readNodeFolders()
	if read.Folders == nil || len(read.Folders) != 0 {
		t.Fatal(read)
	}
}
func TestNodeFoldersCorruptionIsNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MIHOMO_STATE_DIR", dir)
	path := filepath.Join(dir, "node-folders.json")
	os.WriteFile(path, []byte("broken"), 0o600)
	if _, err := writeNodeFolders("", nil); err == nil {
		t.Fatal("corrupt data overwritten")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "broken" {
		t.Fatal(string(raw))
	}
}

func TestNodeFoldersConcurrentWritersUseCAS(t *testing.T) {
	t.Setenv("MIHOMO_STATE_DIR", t.TempDir())
	initial, err := readNodeFolders()
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
			_, err := writeNodeFolders(initial.Revision, []nodeFolder{{ID: id, Name: id, Nodes: []string{"node"}}})
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
		} else if errors.Is(err, errNodeFoldersConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal(successes, conflicts)
	}
	read, err := readNodeFolders()
	if err != nil || len(read.Folders) != 1 {
		t.Fatal(read, err)
	}
}
