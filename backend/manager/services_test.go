package main

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestGroupPath(t *testing.T) {
	proxies := map[string]proxyNow{"Telegram": {Now: "Обходы"}, "Обходы": {Now: "🇫🇲 ОБХОД №10-1"}, "🇫🇲 ОБХОД №10-1": {}}
	if got := strings.Join(groupPath("Telegram", proxies), " → "); got != "Telegram → Обходы → 🇫🇲 ОБХОД №10-1" {
		t.Errorf("path = %s", got)
	}
	if got := groupPath("Нет такой", proxies); len(got) != 1 {
		t.Errorf("unknown group path = %v", got)
	}
	// a loop in the choices must not hang
	loop := map[string]proxyNow{"A": {Now: "B"}, "B": {Now: "A"}}
	if got := groupPath("A", loop); len(got) != 11 {
		t.Errorf("loop path length = %d", len(got))
	}
}

func TestServiceError(t *testing.T) {
	for in, want := range map[string]string{
		"Get \"https://x\": net/http: request canceled (Client.Timeout exceeded)": "нет ответа за 8 с",
		"mihomo: хост недоступен (код 4)":                                         "хост недоступен (код 4)",
		"read tcp 127.0.0.1:1->127.0.0.1:7891: connection reset by peer":          "соединение оборвалось",
		"сервер ответил 502":                                                      "сервер ответил 502",
		"tls: failed to verify certificate":                                       "ошибка сертификата",
	} {
		if got := serviceError(errors.New(in)); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

func TestServiceCheckerKeepsAnHourAndSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "services.json")
	c := newServiceChecker(path)
	st := &serviceState{serviceDef: defaultServices[0]}
	for i := 0; i < serviceKeep+5; i++ {
		st.History = append(st.History, serviceResult{T: int64(i), OK: true})
	}
	st.History = st.History[len(st.History)-serviceKeep:]
	c.states[st.ID] = st
	c.checked = 42
	c.mu.Lock()
	c.saveLocked()
	c.mu.Unlock()
	again := newServiceChecker(path)
	if again.checked != 42 || len(again.states[st.ID].History) != serviceKeep || again.states[st.ID].History[0].T != 5 {
		t.Fatalf("restored %d, %+v", again.checked, again.states[st.ID])
	}
	_, list := again.snapshot()
	if len(list) == 0 || list[0].ID != "ai" {
		t.Fatalf("snapshot = %+v", list)
	}
}
