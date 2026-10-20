package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A trimmed /api/states of the home: Zigbee bridge down for half an hour, a Wi-Fi plug
// gone for 20 min, a sensor that blinked 5 min ago, a disabled device, batteries,
// updates, lights (one of them a group) and a backup three days old.
func haFixture(now time.Time) []haState {
	at := func(ago time.Duration) string { return now.Add(-ago).UTC().Format(time.RFC3339Nano) }
	raw := `[
{"entity_id":"binary_sensor.zigbee2mqtt_bridge_connection_state","state":"off","last_changed":"` + at(30*time.Minute) + `","attributes":{"friendly_name":"Zigbee2MQTT Bridge Connection state"}},
{"entity_id":"light.kitchen","state":"unavailable","last_changed":"` + at(30*time.Minute) + `","attributes":{"friendly_name":"Кухня"}},
{"entity_id":"sensor.door_battery","state":"unavailable","last_changed":"` + at(30*time.Minute) + `","attributes":{"device_class":"battery","unit_of_measurement":"%"}},
{"entity_id":"binary_sensor.door_contact","state":"unavailable","last_changed":"` + at(30*time.Minute) + `","attributes":{}},
{"entity_id":"switch.plug","state":"unavailable","last_changed":"` + at(20*time.Minute) + `","attributes":{"friendly_name":"Розетка ИБП"}},
{"entity_id":"sensor.plug_power","state":"unavailable","last_changed":"` + at(25*time.Minute) + `","attributes":{}},
{"entity_id":"sensor.climate_temp","state":"unavailable","last_changed":"` + at(5*time.Minute) + `","attributes":{}},
{"entity_id":"switch.old","state":"unavailable","last_changed":"` + at(48*time.Hour) + `","attributes":{}},
{"entity_id":"sensor.remote_battery","state":"12","last_changed":"` + at(time.Hour) + `","attributes":{"device_class":"battery","unit_of_measurement":"%","friendly_name":"Пульт Батарея"}},
{"entity_id":"sensor.remote_battery_2","state":"14.5","last_changed":"` + at(time.Hour) + `","attributes":{"device_class":"battery","unit_of_measurement":"%"}},
{"entity_id":"sensor.motion_battery","state":"80","last_changed":"` + at(time.Hour) + `","attributes":{"device_class":"battery","unit_of_measurement":"%"}},
{"entity_id":"binary_sensor.lock_battery_low","state":"on","last_changed":"` + at(time.Hour) + `","attributes":{"device_class":"battery","friendly_name":"Замок батарея"}},
{"entity_id":"sensor.phone_battery_temp","state":"30","last_changed":"` + at(time.Hour) + `","attributes":{"device_class":"battery","unit_of_measurement":"°C"}},
{"entity_id":"update.home_assistant_core_update","state":"on","last_changed":"` + at(time.Hour) + `","attributes":{"title":"Home Assistant Core","installed_version":"2026.7.2","latest_version":"2026.10.2","friendly_name":"Home Assistant Core Update"}},
{"entity_id":"update.zigbee2mqtt_update","state":"on","last_changed":"` + at(time.Hour) + `","attributes":{"friendly_name":"Zigbee2MQTT Update","installed_version":"2.13.0","latest_version":"2.14.2"}},
{"entity_id":"update.matter_update","state":"off","last_changed":"` + at(time.Hour) + `","attributes":{"title":"Matter Server"}},
{"entity_id":"light.hall","state":"on","last_changed":"` + at(time.Hour) + `","attributes":{"friendly_name":"Прихожая"}},
{"entity_id":"light.all","state":"on","last_changed":"` + at(time.Hour) + `","attributes":{"friendly_name":"Весь свет","entity_id":["light.hall","light.kitchen"]}},
{"entity_id":"automation.night","state":"unavailable","last_changed":"` + at(time.Hour) + `","attributes":{}},
{"entity_id":"sensor.backup_last_successful_automatic_backup","state":"` + now.Add(-72*time.Hour).UTC().Format("2006-01-02T15:04:05+00:00") + `","last_changed":"` + at(time.Hour) + `","attributes":{"device_class":"timestamp"}}
]`
	var states []haState
	if err := json.Unmarshal([]byte(raw), &states); err != nil {
		panic(err)
	}
	return states
}

// What POST /api/template renders for the fixture.
const haFixtureMap = `{"e": [["binary_sensor.zigbee2mqtt_bridge_connection_state","bridge"],["light.kitchen","kitchen"],
["sensor.door_battery","door"],["binary_sensor.door_contact","door"],["switch.plug","plug"],["sensor.plug_power","plug"],
["sensor.climate_temp","climate"],["switch.old","old"],["sensor.remote_battery","remote"],["sensor.remote_battery_2","remote"],
["sensor.motion_battery","motion"],["binary_sensor.lock_battery_low","lock"],["light.hall","hall"],
["update.home_assistant_core_update","core"],["sensor.backup_last_successful_automatic_backup","backup"]],
"d": [["bridge","Zigbee2MQTT Bridge","","mqtt:zigbee2mqtt_bridge_0x00124b",false],
["kitchen","Свет на кухне","Кухня","mqtt:zigbee2mqtt_0xa4c1",false],
["door","Датчик двери","Коридор","mqtt:zigbee2mqtt_0xa4c2",false],
["plug","Розетка ИБП","Серверная","tuya:abc",false],
["climate","Климат спальни","Спальня","mqtt:zigbee2mqtt_0xa4c3x tuya:x",false],
["old","Старый выключатель","","ha_keenetic:x",true],
["remote","Пульт","Гостиная","mqtt:zigbee2mqtt_0xa4c4",false],
["motion","Датчик движения","","mqtt:zigbee2mqtt_0xa4c5",false],
["lock","Замок","","matter:1",false],
["hall","Прихожая","Прихожая","matter:2",false],
["core","Home Assistant Core","","hassio:core",false],
["backup","Backup","","backup:x",false]]}`

func haTestMonitor(t *testing.T, now time.Time, byDevice bool) *haMonitor {
	t.Helper()
	m := &haMonitor{cfg: haConfig{URL: "http://192.168.99.12:8123", Token: strings.Repeat("t", 40)}, info: haInfo{Version: "2026.7.2", LocationName: "Дом"}}
	var dm *haDeviceMap
	if byDevice {
		var err error
		if dm, err = parseHADeviceMap(haFixtureMap); err != nil {
			t.Fatal(err)
		}
	}
	m.states, m.devmap = haFixture(now), dm
	v := haAnalyze(m.states, dm, now)
	m.view, m.lastOK, m.checked = &v, now, now
	return m
}

func TestHAAnalyze(t *testing.T) {
	now := time.Now()
	m := haTestMonitor(t, now, true)
	v := m.view
	if !v.ByDevice {
		t.Fatal("device map ignored")
	}
	// disabled «old» skipped; bridge, kitchen, door, plug, climate, remote, motion, lock, hall, core, backup
	if v.Total != 11 {
		t.Errorf("total devices = %d, want 11", v.Total)
	}
	// kitchen and door (Zigbee) are behind the down bridge; plug is the only reported one;
	// climate is down for 5 min only; the bridge device itself is on line (its sensor reports off)
	if v.ZigbeeDown != 3 {
		t.Errorf("zigbee down = %d, want 3 (kitchen, door, climate)", v.ZigbeeDown)
	}
	if len(v.Offline) != 1 || v.Offline[0].Name != "Розетка ИБП" || v.Offline[0].Area != "Серверная" || v.Offline[0].Entities != 2 {
		t.Errorf("offline = %+v", v.Offline)
	}
	if d := now.Sub(v.Offline[0].Since); d < 20*time.Minute-time.Second || d > 20*time.Minute+time.Second {
		t.Errorf("device is off line since its last entity went: %v", v.Offline[0].Since)
	}
	if v.Online != 11-1-3 {
		t.Errorf("online = %d", v.Online)
	}
	low := v.lowBatteries()
	// «low battery» binary sensors have no level and come first, then the lowest reading
	if len(low) != 2 || low[0].Name != "Замок" || low[0].Level != nil || low[1].Name != "Пульт" || *low[1].Level != 12 || low[1].Area != "Гостиная" {
		t.Errorf("low batteries = %+v", low)
	}
	if len(v.Batteries) != 3 {
		t.Errorf("battery devices = %d, want 3 (°C sensor and unavailable ones skipped)", len(v.Batteries))
	}
	if len(v.Updates) != 2 || v.Updates[0].Name != "Home Assistant Core" || v.Updates[1].Name != "Zigbee2MQTT" {
		t.Errorf("updates = %+v", v.Updates)
	}
	if len(v.Lights) != 1 || v.Lights[0].Name != "Прихожая" {
		t.Errorf("lights = %+v (groups must not count)", v.Lights)
	}
	if v.Backup == nil || v.Backup.Last == nil {
		t.Fatalf("backup = %+v", v.Backup)
	}
}

func TestHAAttention(t *testing.T) {
	now := time.Now()
	m := haTestMonitor(t, now, true)
	got := map[string]response{}
	items := m.attention(now)
	for _, item := range items {
		got[item["id"].(string)] = item
	}
	for id, severity := range map[string]string{"zigbee-bridge": "critical", "batteries": "warning", "backup": "warning", "updates": "info"} {
		if got[id] == nil || got[id]["severity"] != severity {
			t.Errorf("%s: %v (all: %v)", id, got[id], items)
		}
	}
	if !strings.Contains(got["zigbee-bridge"]["text"].(string), "недоступно 3 устройства") {
		t.Errorf("bridge text: %v", got["zigbee-bridge"]["text"])
	}
	if !strings.Contains(got["batteries"]["text"].(string), "Пульт 12 %") || !strings.Contains(got["batteries"]["text"].(string), "Замок (разряжена)") {
		t.Errorf("batteries text: %v", got["batteries"]["text"])
	}
	if !strings.Contains(got["backup"]["text"].(string), "3 дня") {
		t.Errorf("backup text: %v", got["backup"]["text"])
	}
	plug := 0
	for _, item := range items {
		if strings.Contains(item["text"].(string), "Розетка ИБП (Серверная) не на связи") {
			plug++
		}
	}
	if plug != 1 {
		t.Errorf("Wi-Fi plug reported %d times: %v", plug, items)
	}
	if items[0]["severity"] != "critical" || items[len(items)-1]["severity"] != "info" {
		t.Errorf("order by severity: %v", items)
	}
	for _, item := range items {
		if id := item["id"].(string); !pvhIDRe.MatchString(id) && len(id) > 64 {
			t.Errorf("odd id %q", id)
		}
	}
}

func TestHAAttentionStates(t *testing.T) {
	now := time.Now()
	m := haTestMonitor(t, now, true)
	// many devices off line fold into one line
	for i := 0; i < 7; i++ {
		m.view.Offline = append(m.view.Offline, haOffline{Name: "Датчик " + string(rune('A'+i)), Since: now.Add(-time.Hour)})
	}
	folded := 0
	for _, item := range m.attention(now) {
		if strings.HasPrefix(item["id"].(string), "offline") {
			folded++
			if !strings.Contains(item["text"].(string), "Не на связи 8 устройств") || !strings.Contains(item["text"].(string), "и ещё 4") {
				t.Errorf("folded text: %v", item["text"])
			}
		}
	}
	if folded != 1 {
		t.Errorf("offline items = %d, want 1", folded)
	}
	// unreachable HA: one critical item, nothing from stale data
	m.err, m.errSince = "dial tcp 192.168.99.12:8123: connect: connection refused", now.Add(-3*time.Minute)
	items := m.attention(now)
	if len(items) != 1 || items[0]["id"] != "offline" || items[0]["severity"] != "critical" {
		t.Errorf("unreachable: %v", items)
	}
	m.authErr, m.err = true, (&haHTTPError{Status: 401}).Error()
	if items := m.attention(now); len(items) != 1 || items[0]["id"] != "auth" || items[0]["action"].(response)["page"] != "hasettings" {
		t.Errorf("auth: %v", items)
	}
	// not configured: quiet
	empty := &haMonitor{}
	if items := empty.attention(now); len(items) != 0 {
		t.Errorf("unconfigured: %v", items)
	}
	if w := empty.widgetHome(now); w["state"] != "unknown" {
		t.Errorf("unconfigured widget: %v", w)
	}
}

func TestHAWidget(t *testing.T) {
	now := time.Now()
	m := haTestMonitor(t, now, true)
	w := m.widgetHome(now)
	if w["state"] != "bad" {
		t.Errorf("bridge down → bad, got %v", w["state"])
	}
	body := w["body"].(response)
	if body["label"] != "Zigbee2MQTT не на связи" {
		t.Errorf("label %v", body["label"])
	}
	texts := []string{}
	for _, item := range body["items"].([]response) {
		texts = append(texts, item["text"].(string))
	}
	joined := strings.Join(texts, " | ")
	for _, want := range []string{"Устройства на связи: 7 из 11", "Zigbee2MQTT: мост не на связи", "Свет включён: Прихожая", "Батарейки: 2 ниже 20 %", "Доступно 2 обновления", "Резервная копия: 3 дня назад"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %s", want, joined)
		}
	}
	if w["note"] != "HA 2026.7.2 · Дом · 192.168.99.12:8123" {
		t.Errorf("note %v", w["note"])
	}
	b, _ := json.Marshal(w)
	if len(b) > 16<<10 {
		t.Errorf("widget answer %d bytes, limit 16 KB", len(b))
	}
}

func TestHAEntityFallback(t *testing.T) {
	now := time.Now()
	m := haTestMonitor(t, now, false)
	v := m.view
	if v.ByDevice {
		t.Fatal("expected entity mode")
	}
	// no device map: no Zigbee grouping, every entity is counted; automation.night is
	// down an hour as well and counts too in this mode
	if v.ZigbeeDown != 0 || v.Total != len(m.states) {
		t.Errorf("zigbee down %d, total %d", v.ZigbeeDown, v.Total)
	}
	text := ""
	for _, item := range m.attention(now) {
		if item["id"] == "offline-devices" {
			text = item["text"].(string)
		}
	}
	if !strings.Contains(text, "сущностей") {
		t.Errorf("entity mode text: %q", text)
	}
	if !strings.Contains(m.widgetHome(now)["body"].(response)["items"].([]response)[0]["text"].(string), "Сущности") {
		t.Error("entity mode widget label")
	}
}

func TestHAConfigValidation(t *testing.T) {
	for in, want := range map[string]string{
		"http://192.168.99.12:8123/": "http://192.168.99.12:8123",
		" https://ha.example.org ":   "https://ha.example.org",
	} {
		if got, err := normalizeHAURL(in); err != nil || got != want {
			t.Errorf("%q → %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "192.168.99.12:8123", "ftp://x", "http://u:p@x", "http://x/api", "http://x?a=1"} {
		if _, err := normalizeHAURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if validateHAToken("short") == nil || validateHAToken(strings.Repeat("a", 30)+" b") == nil || validateHAToken(strings.Repeat("a", 180)) != nil {
		t.Error("token validation")
	}
}

// End to end against a fake HA: poll, then the settings endpoints never leak the token.
func TestHAPollAndConfig(t *testing.T) {
	now := time.Now()
	token := strings.Repeat("x", 40)
	templateCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "401: Unauthorized", 401)
			return
		}
		switch r.URL.Path {
		case "/api/config":
			_, _ = w.Write([]byte(`{"version":"2026.7.2","location_name":"Дом","external_url":"https://ha.example.org","state":"RUNNING"}`))
		case "/api/states":
			_ = json.NewEncoder(w).Encode(haFixture(now))
		case "/api/template":
			templateCalls++
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if !strings.Contains(body["template"], "device_id(s.entity_id)") {
				http.Error(w, "bad template", 400)
				return
			}
			_, _ = w.Write([]byte(haFixtureMap))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	dir := t.TempDir()
	t.Setenv("HA_DIR", dir)
	m := newHAMonitor()
	ha = m
	defer func() { ha = nil }()
	a := &app{}

	put := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		a.handleHA(rec, httptest.NewRequest("PUT", "/api/ha/config", strings.NewReader(body)))
		return rec
	}
	if rec := put(`{"url":"` + srv.URL + `","token":"short"}`); rec.Code != 400 {
		t.Fatalf("short token accepted: %d %s", rec.Code, rec.Body)
	}
	if rec := put(`{"url":"` + srv.URL + `/","token":"` + token + `"}`); rec.Code != 200 {
		t.Fatalf("save: %d %s", rec.Code, rec.Body)
	}
	workerTasks.Wait()
	// a second save without a token keeps the saved one
	if rec := put(`{"url":"` + srv.URL + `","token":""}`); rec.Code != 200 {
		t.Fatalf("save without token: %d %s", rec.Code, rec.Body)
	}
	workerTasks.Wait()
	m.poll()
	if templateCalls != 1 {
		t.Errorf("device map fetched %d times, want once per %v", templateCalls, haDeviceMapEvery)
	}

	rec := httptest.NewRecorder()
	a.handleHA(rec, httptest.NewRequest("GET", "/api/ha/config", nil))
	if strings.Contains(rec.Body.String(), token) || !strings.Contains(rec.Body.String(), `"token_set":true`) {
		t.Errorf("config answer: %s", rec.Body)
	}
	saved := readFileString(dir + "/config.json")
	if !strings.Contains(saved, token) || !strings.Contains(saved, `"url": "`+srv.URL+`"`) {
		t.Errorf("saved config: %s", saved)
	}

	rec = httptest.NewRecorder()
	a.handleHA(rec, httptest.NewRequest("GET", "/api/ha/overview", nil))
	var ov struct {
		Configured bool   `json:"configured"`
		Link       string `json:"link"`
		Error      string `json:"error"`
		View       haView `json:"view"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ov); err != nil {
		t.Fatal(err)
	}
	if !ov.Configured || ov.Error != "" || ov.Link != "https://ha.example.org" || !ov.View.ByDevice || ov.View.Total != 11 {
		t.Errorf("overview: %+v", ov)
	}

	rec = httptest.NewRecorder()
	a.handleHA(rec, httptest.NewRequest("POST", "/api/ha/config/test", strings.NewReader(`{"url":"`+srv.URL+`","token":"`+strings.Repeat("y", 40)+`"}`)))
	if !strings.Contains(rec.Body.String(), "токен отклонён") {
		t.Errorf("test with a wrong token: %s", rec.Body)
	}
	rec = httptest.NewRecorder()
	a.handleHA(rec, httptest.NewRequest("POST", "/api/ha/config/test", strings.NewReader(`{"url":"`+srv.URL+`"}`)))
	if !strings.Contains(rec.Body.String(), `"devices":true`) || !strings.Contains(rec.Body.String(), `"device_count":12`) {
		t.Errorf("test with the saved token: %s", rec.Body)
	}

	// HA goes away: the widget turns bad and keeps the last data
	srv.Close()
	m.poll()
	w := m.widgetHome(time.Now())
	if w["state"] != "bad" || !strings.HasPrefix(w["body"].(response)["label"].(string), "Нет связи с HA") {
		t.Errorf("widget after HA is gone: %v", w)
	}
}
