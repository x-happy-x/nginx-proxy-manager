package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// The installer puts the core from the user's own fork on the router:
// release x-happy-x/mihomo, archive checked against the release's
// sha256sums.txt, `mihomo -v` and `mihomo -t` before anything is replaced.
// It never runs by itself: only POST /api/core/install starts it.

func coreReleaseBase() string {
	return strings.TrimRight(getenv("MIHOMO_RELEASE_BASE", "https://github.com/x-happy-x/mihomo/releases/latest/download"), "/")
}

const coreInitScript = "/opt/etc/init.d/S24mihomo"

const xkeenInstallCommand = "curl -sSL https://raw.githubusercontent.com/x-happy-x/XKeen/main/install.sh | sh -s -- --stable"

type installRequest struct {
	SubscriptionURL string `json:"subscription_url"`
	Provider        string `json:"provider"`
	Adaptive        bool   `json:"adaptive"`
	XKeen           bool   `json:"xkeen"`
}

type installStep struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Note  string `json:"note,omitempty"`
}

type installPlanInfo struct {
	Asset        string        `json:"asset"`
	ReleaseBase  string        `json:"release_base"`
	Binary       string        `json:"binary"`
	Config       string        `json:"config"`
	ConfigExists bool          `json:"config_exists"`
	InitScript   string        `json:"init_script,omitempty"`
	XKeen        bool          `json:"xkeen"`
	XKeenCommand string        `json:"xkeen_command,omitempty"`
	Steps        []installStep `json:"steps"`
}

func installPlan(xkeen bool) installPlanInfo {
	st := readCoreStatus()
	p := installPlanInfo{Asset: st.Asset, ReleaseBase: coreReleaseBase(), Binary: st.Binary, Config: st.Config, ConfigExists: st.ConfigExists, XKeen: xkeen}
	p.Steps = []installStep{
		{"release", "Узнать последний релиз форка", p.ReleaseBase + "/version.txt"},
		{"download", "Скачать mihomo-" + p.Asset + "-<версия>.gz", "до 128 МБ, во временный файл рядом с бинарником"},
		{"verify", "Сверить SHA-256 с sha256sums.txt релиза", "при несовпадении установка останавливается"},
		{"binary", "Распаковать и проверить `mihomo -v`", "старый бинарник сохраняется как " + filepath.Base(p.Binary) + ".bak"},
	}
	if p.ConfigExists {
		p.Steps = append(p.Steps, installStep{"config", "Оставить существующий config.yaml", p.Config})
	} else {
		p.Steps = append(p.Steps, installStep{"config", "Создать стартовый config.yaml", "controller 127.0.0.1:9090, новый secret, mixed-port 7890, socks 7891"})
	}
	p.Steps = append(p.Steps, installStep{"test", "Проверить конфиг `mihomo -t`", ""})
	if xkeen {
		p.XKeenCommand = xkeenInstallCommand
		p.Steps = append(p.Steps, installStep{"xkeen", "Установить XKeen из x-happy-x/XKeen", "установщик XKeen задаёт вопросы, поэтому он запускается в SSH: " + xkeenInstallCommand})
	} else {
		p.InitScript = coreInitScript
		p.Steps = append(p.Steps, installStep{"service", "Создать службу " + coreInitScript + " и запустить ядро", "если служба уже есть, она перезапускается"})
	}
	p.Steps = append(p.Steps, installStep{"controller", "Дождаться ответа контроллера", "до 20 секунд"})
	return p
}

type installLine struct {
	Time  string `json:"time"`
	Level string `json:"level"`
	Text  string `json:"text"`
}

type installState struct {
	mu       sync.Mutex
	Running  bool          `json:"running"`
	Done     bool          `json:"done"`
	OK       bool          `json:"ok"`
	Step     string        `json:"step"`
	Version  string        `json:"version,omitempty"`
	Started  string        `json:"started,omitempty"`
	Log      []installLine `json:"log"`
	runSteps func(*installState, installRequest) error
}

var installer = &installState{Log: []installLine{}, runSteps: runInstall}

func (s *installState) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{"running": s.Running, "done": s.Done, "ok": s.OK, "step": s.Step, "version": s.Version, "started": s.Started, "log": append([]installLine(nil), s.Log...)}
}

func (s *installState) logf(level, format string, args ...any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Log = append(s.Log, installLine{Time: time.Now().Format("15:04:05"), Level: level, Text: fmt.Sprintf(format, args...)})
	if len(s.Log) > 400 {
		s.Log = s.Log[len(s.Log)-400:]
	}
}

func (s *installState) step(id string) {
	s.mu.Lock()
	s.Step = id
	s.mu.Unlock()
}

var providerNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,40}$`)

func validateInstallRequest(req *installRequest) error {
	req.SubscriptionURL = strings.TrimSpace(req.SubscriptionURL)
	req.Provider = strings.TrimSpace(req.Provider)
	if req.Provider == "" {
		req.Provider = "ROUTER"
	}
	if !providerNameRe.MatchString(req.Provider) {
		return fmt.Errorf("название провайдера: латиница, цифры, точка, дефис, подчёркивание")
	}
	if req.SubscriptionURL != "" {
		u, err := url.Parse(req.SubscriptionURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("ссылка подписки должна начинаться с http:// или https://")
		}
	}
	return nil
}

func (s *installState) start(req installRequest) error {
	if err := validateInstallRequest(&req); err != nil {
		return err
	}
	s.mu.Lock()
	if s.Running {
		s.mu.Unlock()
		return fmt.Errorf("установка уже идёт")
	}
	s.Running, s.Done, s.OK, s.Step, s.Version = true, false, false, "", ""
	s.Started = time.Now().UTC().Format(time.RFC3339)
	s.Log = []installLine{}
	run := s.runSteps
	s.mu.Unlock()
	go func() {
		err := run(s, req)
		s.mu.Lock()
		s.Running, s.Done, s.OK = false, true, err == nil
		s.mu.Unlock()
		if err != nil {
			s.logf("error", "%v", err)
		} else {
			s.logf("ok", "готово")
		}
	}()
	return nil
}

func installHTTP() *http.Client {
	return &http.Client{Timeout: 10 * time.Minute, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 30 * time.Second}}
}

func fetchSmall(client *http.Client, u string) (string, error) {
	resp, err := client.Get(u)
	if err != nil {
		return "", shortNetErr(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s ответил %d", u, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return string(b), err
}

func runInstall(s *installState, req installRequest) error {
	client := installHTTP()
	base := coreReleaseBase()
	asset := coreAsset()
	binary := coreBinary()
	cfgPath := coreConfigPath()

	s.step("release")
	ver, err := fetchSmall(client, base+"/version.txt")
	if err != nil {
		return fmt.Errorf("не удалось узнать версию релиза: %v", err)
	}
	ver = strings.TrimSpace(ver)
	if !regexp.MustCompile(`^v[0-9][0-9A-Za-z.\-]*$`).MatchString(ver) {
		return fmt.Errorf("неожиданная версия релиза %q", ver)
	}
	s.mu.Lock()
	s.Version = ver
	s.mu.Unlock()
	file := "mihomo-" + asset + "-" + ver + ".gz"
	s.logf("info", "релиз %s, архив %s", ver, file)

	sums, err := fetchSmall(client, base+"/sha256sums.txt")
	if err != nil {
		return fmt.Errorf("не удалось скачать sha256sums.txt: %v", err)
	}
	want := ""
	sc := bufio.NewScanner(strings.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == file {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return fmt.Errorf("в sha256sums.txt нет %s: этот процессор форк не собирает", file)
	}

	s.step("download")
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		return err
	}
	resp, err := client.Get(base + "/" + file)
	if err != nil {
		return fmt.Errorf("скачивание %s: %v", file, shortNetErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("скачивание %s: HTTP %d", file, resp.StatusCode)
	}
	archive, err := os.CreateTemp(filepath.Dir(binary), ".mihomo-download-*.gz")
	if err != nil {
		return err
	}
	defer os.Remove(archive.Name())
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(archive, hash), io.LimitReader(resp.Body, 128<<20+1))
	archive.Close()
	if err != nil {
		return fmt.Errorf("скачивание прервано: %v", shortNetErr(err))
	}
	if n > 128<<20 {
		return fmt.Errorf("архив больше 128 МБ")
	}
	s.logf("info", "скачано %.1f МБ", float64(n)/(1<<20))

	s.step("verify")
	if got := hex.EncodeToString(hash.Sum(nil)); got != want {
		return fmt.Errorf("SHA-256 не совпал: ожидался %s, получен %s", want[:12], got[:12])
	}
	s.logf("info", "SHA-256 совпал")

	s.step("binary")
	newBin := binary + ".new"
	if err := gunzipTo(archive.Name(), newBin); err != nil {
		return fmt.Errorf("распаковка: %v", err)
	}
	defer os.Remove(newBin)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	out, err := exec.CommandContext(ctx, newBin, "-v").CombinedOutput()
	cancel()
	if err != nil || !strings.Contains(string(out), strings.TrimPrefix(ver, "v")) {
		return fmt.Errorf("новый бинарник не запускается на этом процессоре")
	}
	s.logf("info", "%s", firstLine(string(out)))
	if _, err := os.Stat(binary); err == nil {
		if err := copyFile(binary, binary+".bak", 0o755); err != nil {
			return fmt.Errorf("резервная копия бинарника: %v", err)
		}
		s.logf("info", "старый бинарник сохранён: %s.bak", binary)
	}
	if err := os.Rename(newBin, binary); err != nil {
		return fmt.Errorf("замена бинарника: %v", err)
	}

	s.step("config")
	if _, err := os.Stat(cfgPath); os.IsNotExist(err) {
		body, err := starterConfig(req)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(cfgPath, body, 0o600); err != nil {
			return err
		}
		s.logf("info", "создан %s, secret сгенерирован", cfgPath)
	} else {
		s.logf("info", "%s уже есть, не меняется", cfgPath)
	}

	s.step("test")
	ctx, cancel = context.WithTimeout(context.Background(), 60*time.Second)
	err = exec.CommandContext(ctx, binary, "-t", "-d", filepath.Dir(cfgPath), "-f", cfgPath).Run()
	cancel()
	if err != nil {
		return fmt.Errorf("mihomo -t отклонил %s; ядро не запущено", cfgPath)
	}
	s.logf("info", "mihomo -t: конфигурация корректна")

	if req.XKeen {
		s.step("xkeen")
		s.logf("warn", "XKeen ставится в SSH: %s, затем xkeen -mihomo", xkeenInstallCommand)
		return nil
	}

	s.step("service")
	if _, err := os.Stat(coreInitScript); os.IsNotExist(err) {
		script := "#!/bin/sh\n# Created by HomeNet (NPM-19).\nENABLED=yes\nPROCS=mihomo\nARGS=\"-d " + filepath.Dir(cfgPath) + " -f " + cfgPath + "\"\nPREARGS=\"\"\nDESC=$PROCS\nPATH=/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin\n\n. /opt/etc/init.d/rc.func\n"
		if err := os.WriteFile(coreInitScript, []byte(script), 0o755); err != nil {
			return fmt.Errorf("служба %s: %v", coreInitScript, err)
		}
		s.logf("info", "создана служба %s", coreInitScript)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	_ = exec.CommandContext(ctx, coreInitScript, "restart").Run()
	cancel()

	s.step("controller")
	for i := 0; i < 20; i++ {
		var v struct {
			Version string `json:"version"`
		}
		if mihomoGet("/version", &v) == nil {
			s.logf("ok", "контроллер отвечает: %s", v.Version)
			return nil
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("ядро установлено, но контроллер не ответил за 20 секунд; см. журнал службы")
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	return s
}

func gunzipTo(src, dst string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, io.LimitReader(zr, 512<<20))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

func randomSecret() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// adaptiveHealthCheck is the fork's whitelist-aware GET check
// (mihomo docs/adaptive-health.example.yaml).
func adaptiveHealthCheck() map[string]any {
	return map[string]any{
		"enable": true, "url": "https://www.gstatic.com/generate_204", "expected-status": "204",
		"interval": 60, "timeout": 5000, "lazy": false,
		"adaptive": map[string]any{
			"enable": true, "network-key": "home-uplink", "confirmations": 2, "concurrency": 4,
			"direct-allowed": []any{map[string]any{"url": "https://ya.ru", "expected-status": "200-399"}},
			"direct-global": []any{
				map[string]any{"url": "https://www.gstatic.com/generate_204", "expected-status": "204"},
				map[string]any{"url": "https://cp.cloudflare.com/generate_204", "expected-status": "204"},
			},
			"targets": []any{
				map[string]any{"url": "https://www.google.com/", "expected-status": "200", "min-bytes": 1024},
				map[string]any{"url": "https://www.cloudflare.com/cdn-cgi/trace", "expected-status": "200", "min-bytes": 64},
			},
		},
	}
}

func plainHealthCheck() map[string]any {
	return map[string]any{"enable": true, "url": "https://www.gstatic.com/generate_204", "interval": 300, "timeout": 5000, "lazy": true}
}

func starterConfig(req installRequest) ([]byte, error) {
	cfg := map[string]any{
		"mixed-port": 7890, "socks-port": 7891, "allow-lan": false, "mode": "rule", "log-level": "info", "ipv6": false,
		"external-controller": "127.0.0.1:9090", "secret": randomSecret(),
		"profile": map[string]any{"store-selected": true},
		"dns":     map[string]any{"enable": true, "listen": "127.0.0.1:1053", "enhanced-mode": "redir-host", "nameserver": []any{"https://1.1.1.1/dns-query", "https://dns.google/dns-query"}, "default-nameserver": []any{"77.88.8.8", "1.1.1.1"}},
	}
	proxies := []any{"DIRECT"}
	group := map[string]any{"name": "PROXY", "type": "select", "proxies": proxies}
	if req.SubscriptionURL != "" {
		hc := plainHealthCheck()
		if req.Adaptive {
			hc = adaptiveHealthCheck()
		}
		cfg["proxy-providers"] = map[string]any{req.Provider: map[string]any{
			"type": "http", "url": req.SubscriptionURL, "interval": 21600, "path": "./providers/" + req.Provider + ".yaml",
			"health-check": hc,
		}}
		group["use"] = []any{req.Provider}
		if req.Adaptive {
			cfg["proxy-groups"] = []any{
				map[string]any{"name": "PROXY", "type": "select", "proxies": []any{"Auto", "DIRECT"}, "use": []any{req.Provider}},
				map[string]any{"name": "Auto", "type": "fallback", "use": []any{req.Provider}},
			}
		}
	}
	if _, ok := cfg["proxy-groups"]; !ok {
		cfg["proxy-groups"] = []any{group}
	}
	cfg["rules"] = []any{"GEOIP,private,DIRECT,no-resolve", "MATCH,PROXY"}
	head := "# Created by HomeNet (NPM-19). Edit in HomeNet → Прокси mihomo → Конфигурация.\n"
	body, err := yaml.Marshal(cfg)
	return append([]byte(head), body...), err
}
