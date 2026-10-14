package integration

import "testing"

func widgetFixture() Manifest {
	m := fixture("vpn")
	m.UIAPI = 2
	m.UI.Widgets = []Widget{{ID: "channel", Title: "Канал провайдера", Kind: "status", Sizes: []string{"s", "m"}, Data: "/api/items/channel", Refresh: 30, Modes: []string{"simple", "pro"}, Default: map[string]int{"pro": 10}, Page: "vpn"}}
	m.UI.Summary = &Summary{Attention: "/api/items/attention", Tasks: "/api/status"}
	return m
}

func TestWidgetManifest(t *testing.T) {
	if err := widgetFixture().Validate("amd64"); err != nil {
		t.Fatal(err)
	}
	old := fixture("vpn")
	if err := old.Validate("amd64"); err != nil {
		t.Fatalf("ui_api 1 must stay valid: %v", err)
	}
	old.UI.Widgets = widgetFixture().UI.Widgets
	if old.Validate("amd64") == nil {
		t.Fatal("widgets accepted with ui_api 1")
	}
	future := widgetFixture()
	future.UIAPI = 3
	if future.Validate("amd64") == nil {
		t.Fatal("unknown ui_api accepted")
	}
	custom := widgetFixture()
	custom.UI.Widgets[0].Kind, custom.UI.Widgets[0].Data = "custom", ""
	if err := custom.Validate("amd64"); err != nil {
		t.Fatalf("custom widget without data: %v", err)
	}
	bad := map[string]func(*Manifest){
		"data outside paths":    func(m *Manifest) { m.UI.Widgets[0].Data = "/api/other" },
		"no data":               func(m *Manifest) { m.UI.Widgets[0].Data = "" },
		"segment prefix":        func(m *Manifest) { m.UI.Widgets[0].Data = "/api/statusx" },
		"summary outside paths": func(m *Manifest) { m.UI.Summary.Tasks = "/api/secret" },
		"kind":                  func(m *Manifest) { m.UI.Widgets[0].Kind = "html" },
		"size":                  func(m *Manifest) { m.UI.Widgets[0].Sizes = []string{"xl"} },
		"duplicate size":        func(m *Manifest) { m.UI.Widgets[0].Sizes = []string{"s", "s"} },
		"mode":                  func(m *Manifest) { m.UI.Widgets[0].Modes = []string{"expert"} },
		"no modes":              func(m *Manifest) { m.UI.Widgets[0].Modes = nil },
		"default mode":          func(m *Manifest) { m.UI.Widgets[0].Default = map[string]int{"x": 1} },
		"id":                    func(m *Manifest) { m.UI.Widgets[0].ID = "Bad/id" },
		"duplicate id":          func(m *Manifest) { m.UI.Widgets = append(m.UI.Widgets, m.UI.Widgets[0]) },
		"title":                 func(m *Manifest) { m.UI.Widgets[0].Title = "" },
		"refresh":               func(m *Manifest) { m.UI.Widgets[0].Refresh = 5 },
		"page":                  func(m *Manifest) { m.UI.Widgets[0].Page = "elsewhere" },
		"too many": func(m *Manifest) {
			for i := 0; i < 16; i++ {
				w := m.UI.Widgets[0]
				w.ID = "w" + string(rune('a'+i))
				m.UI.Widgets = append(m.UI.Widgets, w)
			}
		},
	}
	for name, change := range bad {
		m := widgetFixture()
		change(&m)
		if m.Validate("amd64") == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
