package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

var moduleKind, moduleTokenFile string

func moduleRPC(path string, input, output any) error {
	token, err := os.ReadFile(moduleTokenFile)
	if err != nil {
		return fmt.Errorf("module credential unavailable")
	}
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(workerContext, 90*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(os.Getenv("HOMENET_CORE_URL"), "/")+"/internal/proxy/"+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("Core contract unavailable: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("Core contract returned HTTP %d", res.StatusCode)
	}
	if output != nil {
		return json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(output)
	}
	return nil
}
