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

// NPM-49: own services, hidden built-ins and the order.
func TestServiceConfigListOrderAndHidden(t *testing.T) {
	t.Setenv("MIHOMO_STATE_DIR", t.TempDir())
	c := serviceConfig{
		Custom: []serviceDef{{Name: "Госуслуги", What: "госуслуги", URL: "gosuslugi.ru", Group: "ignored"}},
		Hidden: []string{"tiktok"},
		Order:  []string{"telegram", "", "ai"},
	}
	if err := c.normalize(); err != nil {
		t.Fatal(err)
	}
	own := c.Custom[0]
	if !strings.HasPrefix(own.ID, "custom-") || own.URL != "https://gosuslugi.ru" || own.Group != "" {
		t.Fatalf("own service = %+v", own)
	}
	again := c
	again.Custom = append([]serviceDef(nil), c.Custom...)
	if err := again.normalize(); err != nil || again.Custom[0].ID != own.ID {
		t.Fatalf("id changed on a second save: %v %s", err, again.Custom[0].ID)
	}
	if err := saveServiceConfig(c); err != nil {
		t.Fatal(err)
	}
	list := serviceList()
	ids := []string{}
	for _, d := range list {
		ids = append(ids, d.ID)
	}
	joined := strings.Join(ids, ",")
	if !strings.HasPrefix(joined, "telegram,ai,") || strings.Contains(joined, "tiktok") || ids[len(ids)-1] != own.ID {
		t.Errorf("list = %s", joined)
	}
	for _, bad := range []serviceConfig{
		{Custom: []serviceDef{{Name: "", URL: "x.org"}}},
		{Custom: []serviceDef{{Name: "Сайт", URL: "ftp://x.org"}}},
		{Custom: []serviceDef{{Name: strings.Repeat("я", 41), URL: "x.org"}}},
	} {
		if err := bad.normalize(); err == nil {
			t.Errorf("accepted %+v", bad.Custom[0])
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
