package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var pciID = regexp.MustCompile(`\[([0-9a-fA-F]{4,6})\]$`)
var unknownPCIName = regexp.MustCompile(`(?i)^(?:Device\s*)?[0-9a-f]{4}$`)

func parsePCIDevices(text string) []map[string]any {
	devices := []map[string]any{}
	for _, block := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n") {
		fields := map[string]string{}
		for _, line := range strings.Split(block, "\n") {
			k, v, ok := strings.Cut(line, ":\t")
			if ok {
				fields[k] = strings.TrimSpace(v)
			}
		}
		if fields["Slot"] == "" {
			continue
		}
		ids := map[string]string{}
		for _, key := range []string{"Class", "Vendor", "Device"} {
			if m := pciID.FindStringSubmatch(fields[key]); len(m) > 1 {
				ids[key] = strings.ToLower(m[1])
			}
		}
		name := strings.TrimSpace(pciID.ReplaceAllString(fields["Device"], ""))
		status := "identified"
		if name == "" || strings.EqualFold(name, "device") || unknownPCIName.MatchString(name) {
			name, status = "", "unrecognized"
		}
		devices = append(devices, map[string]any{"id": "pci:" + fields["Slot"], "bus": "pci", "address": fields["Slot"], "name": name, "kind": strings.TrimSpace(pciID.ReplaceAllString(fields["Class"], "")), "vendor_id": ids["Vendor"], "device_id": ids["Device"], "class_id": ids["Class"], "driver": fields["Driver"], "status": status, "source": "lspci -D -vmm -nn -k", "raw": fields})
	}
	return devices
}

func parseDIMMs(text string) (modules []map[string]any, slots int) {
	modules = []map[string]any{}
	for _, block := range strings.Split(text, "Handle ") {
		if !strings.Contains(block, "Memory Device\n") {
			continue
		}
		fields := map[string]string{}
		for _, line := range strings.Split(block, "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
			if ok {
				fields[k] = strings.TrimSpace(v)
			}
		}
		slots++
		f := strings.Fields(fields["Size"])
		if len(f) != 2 {
			continue
		}
		n, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			continue
		}
		mult := map[string]uint64{"kB": 1024, "MB": 1024 * 1024, "GB": 1024 * 1024 * 1024, "TB": 1024 * 1024 * 1024 * 1024}[f[1]]
		if mult == 0 {
			continue
		}
		speed := fields["Configured Memory Speed"]
		if speed == "" {
			speed = fields["Speed"]
		}
		modules = append(modules, map[string]any{"slot": fields["Locator"], "size_bytes": n * mult, "type": fields["Type"], "speed": speed, "vendor": fields["Manufacturer"], "part": fields["Part Number"], "source": "dmidecode type 17"})
	}
	return
}

func platformHardware(ctx context.Context, run runner) map[string]any {
	h := map[string]any{"source": "Linux sysfs + system inventory", "os": "linux"}
	sources := map[string]any{}
	command := func(key, name string, args ...string) []byte {
		// lscpu's JSON field names are localised unless its locale is pinned.
		b, err := run(ctx, "env", append([]string{"LC_ALL=C", name}, args...)...)
		if err != nil {
			sources[key] = map[string]any{"status": "unavailable", "reason": err.Error()}
			return nil
		}
		sources[key] = map[string]any{"status": "collected"}
		return b
	}
	dmi := func(key string) string { return strings.TrimSpace(readFile("/sys/class/dmi/id/" + key)) }
	h["vendor"], h["product"], h["board"], h["bios"] = dmi("sys_vendor"), dmi("product_name"), strings.TrimSpace(dmi("board_vendor")+" "+dmi("board_name")), dmi("bios_version")
	cpu := map[string]any{}
	var lscpu struct {
		CPU []struct{ Field, Data string } `json:"lscpu"`
	}
	if b := command("cpu", "lscpu", "-J"); json.Unmarshal(b, &lscpu) == nil {
		f := map[string]string{}
		for _, row := range lscpu.CPU {
			f[strings.TrimSuffix(row.Field, ":")] = row.Data
		}
		cores, _ := strconv.Atoi(f["Core(s) per socket"])
		sockets, _ := strconv.Atoi(f["Socket(s)"])
		threads, _ := strconv.Atoi(f["CPU(s)"])
		cpu = map[string]any{"model": f["Model name"], "cores": cores * sockets, "sockets": sockets, "threads": threads, "source": "lscpu"}
	}
	h["cpu"] = cpu
	modules, slots := parseDIMMs(string(command("memory", "dmidecode", "-t", "17")))
	var installed uint64
	for _, m := range modules {
		installed += m["size_bytes"].(uint64)
	}
	h["memory"] = map[string]any{"modules": modules, "slots": slots, "installed": installed, "total": parseMemory(readFile("/proc/meminfo")).Total}
	devices := parsePCIDevices(string(command("pci", "lspci", "-D", "-vmm", "-nn", "-k")))
	seen := map[string]bool{}
	for _, d := range devices {
		seen[d["address"].(string)] = true
	}
	paths, _ := filepath.Glob("/sys/bus/pci/devices/*")
	for _, p := range paths {
		address := filepath.Base(p)
		if seen[address] {
			continue
		}
		driver, _ := os.Readlink(p + "/driver")
		if driver != "" {
			driver = filepath.Base(driver)
		}
		devices = append(devices, map[string]any{"id": "pci:" + address, "bus": "pci", "address": address, "name": "", "kind": "", "vendor_id": strings.TrimPrefix(strings.TrimSpace(readFile(p+"/vendor")), "0x"), "device_id": strings.TrimPrefix(strings.TrimSpace(readFile(p+"/device")), "0x"), "class_id": strings.TrimPrefix(strings.TrimSpace(readFile(p+"/class")), "0x"), "driver": driver, "status": "unrecognized", "source": "sysfs pci"})
	}
	paths, _ = filepath.Glob("/sys/bus/usb/devices/*")
	for _, p := range paths {
		vendor := strings.TrimSpace(readFile(p + "/idVendor"))
		if vendor == "" {
			continue
		}
		name := strings.TrimSpace(readFile(p + "/product"))
		status := "identified"
		if name == "" {
			status = "unrecognized"
		}
		devices = append(devices, map[string]any{"id": "usb:" + filepath.Base(p), "bus": "usb", "address": filepath.Base(p), "name": name, "kind": "USB", "vendor_id": vendor, "device_id": strings.TrimSpace(readFile(p + "/idProduct")), "status": status, "source": "sysfs usb"})
	}
	h["devices"] = devices
	gpus := []map[string]any{}
	for _, d := range devices {
		class, _ := d["class_id"].(string)
		if strings.HasPrefix(class, "03") {
			gpus = append(gpus, d)
		}
	}
	h["gpus"] = gpus
	var block map[string]any
	if b := command("storage", "lsblk", "-b", "-J", "-o", "NAME,TYPE,SIZE,MODEL,ROTA,TRAN,MOUNTPOINTS"); json.Unmarshal(b, &block) == nil {
		h["blockdevices"] = block["blockdevices"]
	}
	disks := []map[string]any{}
	var mounts func(map[string]any) []string
	mounts = func(node map[string]any) []string {
		out := []string{}
		for _, v := range list(node["mountpoints"]) {
			if s, ok := v.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		for _, v := range list(node["children"]) {
			if child, ok := v.(map[string]any); ok {
				out = append(out, mounts(child)...)
			}
		}
		return out
	}
	for _, raw := range list(block["blockdevices"]) {
		d, ok := raw.(map[string]any)
		if !ok || d["type"] != "disk" {
			continue
		}
		name, _ := d["name"].(string)
		if !regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`).MatchString(name) {
			continue
		}
		kind := "unknown"
		if rota, ok := d["rota"].(bool); ok {
			if rota {
				kind = "hdd"
			} else {
				kind = "ssd"
			}
		}
		if d["tran"] == "nvme" || strings.HasPrefix(name, "nvme") {
			kind = "nvme"
		}
		disks = append(disks, map[string]any{"id": "disk:" + name, "dev": name, "model": d["model"], "size": d["size"], "transport": d["tran"], "kind": kind, "volumes": mounts(d), "source": "lsblk + smartctl"})
	}
	var smart sync.WaitGroup
	limit := make(chan struct{}, 3)
	for _, disk := range disks {
		smart.Add(1)
		go func(d map[string]any) {
			defer smart.Done()
			select {
			case limit <- struct{}{}:
			case <-ctx.Done():
				d["smart_status"] = "unavailable"
				d["smart_reason"] = "Inventory deadline reached"
				return
			}
			defer func() { <-limit }()
			probe, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			b, err := run(probe, "smartctl", "-j", "-a", "-n", "standby", "/dev/"+d["dev"].(string))
			s, e := hardwareJSON(b)
			if e != nil || s["smart_status"] == nil {
				d["smart_status"] = "unavailable"
				if err != nil {
					d["smart_reason"] = err.Error()
				} else {
					d["smart_reason"] = "SMART not provided (standby or unsupported)"
				}
				return
			}
			d["smart_status"] = "collected"
			if status, ok := s["smart_status"].(map[string]any); ok {
				d["health"] = status["passed"]
			}
			if temp, ok := s["temperature"].(map[string]any); ok {
				d["temp"] = temp["current"]
			}
			if nvme, ok := s["nvme_smart_health_information_log"].(map[string]any); ok {
				d["wear"] = nvme["percentage_used"]
				d["hours"] = nvme["power_on_hours"]
			}
			d["firmware"] = s["firmware_version"]
		}(disk)
	}
	smart.Wait()
	h["disks"] = disks
	nics := []map[string]any{}
	paths, _ = filepath.Glob("/sys/class/net/*")
	for _, p := range paths {
		if _, err := os.Stat(p + "/device"); err != nil {
			continue
		}
		kind := "ethernet"
		if _, err := os.Stat(p + "/wireless"); err == nil {
			kind = "wifi"
		}
		speed, _ := strconv.Atoi(strings.TrimSpace(readFile(p + "/speed")))
		var mbps any
		if speed > 0 {
			mbps = speed
		}
		nics = append(nics, map[string]any{"iface": filepath.Base(p), "kind": kind, "state": strings.TrimSpace(readFile(p + "/operstate")), "speed": mbps, "source": "sysfs net"})
	}
	h["nics"] = nics
	temps := []map[string]any{}
	fans := []map[string]any{}
	paths, _ = filepath.Glob("/sys/class/hwmon/hwmon*")
	for _, p := range paths {
		chip := strings.TrimSpace(readFile(p + "/name"))
		for _, kind := range []string{"temp", "fan"} {
			files, _ := filepath.Glob(p + "/" + kind + "*_input")
			for _, file := range files {
				v, err := strconv.ParseFloat(strings.TrimSpace(readFile(file)), 64)
				if err != nil {
					continue
				}
				stem := strings.TrimSuffix(file, "_input")
				label := strings.TrimSpace(readFile(stem + "_label"))
				if label == "" {
					label = filepath.Base(stem)
				}
				if kind == "temp" {
					temps = append(temps, map[string]any{"chip": chip, "label": label, "c": v / 1000, "source": "sysfs hwmon"})
				} else {
					fans = append(fans, map[string]any{"label": label, "rpm": v, "source": "sysfs hwmon"})
				}
			}
		}
	}
	h["temps"], h["fans"], h["sources"] = temps, fans, sources
	return h
}

func list(v any) []any { a, _ := v.([]any); return a }
