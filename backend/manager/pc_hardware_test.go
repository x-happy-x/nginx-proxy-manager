package main

import (
	"encoding/json"
	"testing"
)

func TestPCHardwarePreservesUnknownExtensions(t *testing.T) {
	var snap pcSnapshot
	input := []byte(`{"v":1,"host":"pc","hardware":{"devices":[{"id":"pci:unknown","vendor_id":"ffff","unknown_extension":{"data":[1,2]}}],"future_section":true}}`)
	if err := json.Unmarshal(input, &snap); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err = json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	hw := got["hardware"].(map[string]any)
	if hw["future_section"] != true || hw["devices"].([]any)[0].(map[string]any)["unknown_extension"] == nil {
		t.Fatal(hw)
	}
	var legacy pcSnapshot
	if err = json.Unmarshal([]byte(`{"v":1,"host":"old-agent"}`), &legacy); err != nil || legacy.Hardware != nil {
		t.Fatal(legacy, err)
	}
}
