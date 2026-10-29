package main

// NPM-98: Sub Lab is the catalog/converter; HomeNet owns the selection,
// authenticated downloads and schedule. Mihomo gets private file providers.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type slSelection struct {
	ID    string `json:"id"`
	Split bool   `json:"split"`
}
type slItem struct {
	ID         string         `json:"id"`
	Title      string         `json:"title"`
	ShortID    string         `json:"shortId,omitempty"`
	URL        string         `json:"url,omitempty"`
	Params     map[string]any `json:"payload"`
	Children   []slItem       `json:"children,omitempty"`
	SplitError string         `json:"split_error,omitempty"`
	Filter     struct {
		Pattern string `json:"pattern"`
		OnEmpty string `json:"onEmpty"`
	} `json:"filter,omitempty"`
}
type slManaged struct {
	Key      string `json:"key"`
	Title    string `json:"title"`
	Provider string `json:"provider"`
	Path     string `json:"path"`
	Nodes    int    `json:"nodes"`
	Expire   int64  `json:"expire,omitempty"`
	Error    string `json:"error,omitempty"`
}
type slState struct {
	URL           string        `json:"url"`
	Token         string        `json:"token,omitempty"`
	Every         int           `json:"every"` // seconds; zero is manual
	Groups        []string      `json:"groups"`
	AppliedGroups []string      `json:"applied_groups,omitempty"`
	Selected      []slSelection `json:"selected"`
	Links         []string      `json:"links,omitempty"`
	Catalog       []slItem      `json:"catalog"`
	Managed       []slManaged   `json:"managed"`
	CatalogAt     int64         `json:"catalog_at"`
	LastSync      int64         `json:"last_sync"`
	Attempt       int64         `json:"attempt"`
	Error         string        `json:"error,omitempty"`
}

var slMu sync.Mutex

func slDir() string { return filepath.Join(coreStateDir(), "sublab") }
func slLoad() (slState, error) {
	s := slState{URL: "https://sub.nl.cdn6.ru", Catalog: []slItem{}, Managed: []slManaged{}, Selected: []slSelection{}, Groups: []string{}}
	b, err := os.ReadFile(filepath.Join(slDir(), "state.json"))
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(b, &s)
	return s, err
}
func slSave(s slState) error {
	if err := os.MkdirAll(slDir(), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(slDir(), ".state-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(slDir(), "state.json"))
}
func slBase(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && u.Scheme != "http") {
		return "", fmt.Errorf("нужен адрес панели http(s)://хост[:порт] без пути и параметров")
	}
	return u.Scheme + "://" + u.Host, nil
}
func slHTTP() *http.Client {
	return &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}
func slRequest(ctx context.Context, s slState, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.URL+path, reader)
	if err != nil {
		return err
	}
	if s.Token != "" {
		req.Header.Set("Authorization", "Bearer "+s.Token)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := slHTTP().Do(req)
	if err != nil {
		return fmt.Errorf("Sub Lab недоступен")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return fmt.Errorf("Sub Lab: войдите заново и проверьте права учётной записи")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Sub Lab: HTTP %d; операция не повторялась", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out); err != nil {
		return fmt.Errorf("Sub Lab вернул некорректный JSON")
	}
	return nil
}

// Catalog uses the existing favorites API, including grants. Do not expose
// params, URLs or cached credentials in HomeNet's read API.
func slCatalog(ctx context.Context, s *slState) error {
	var out struct {
		Favorites []slItem `json:"favorites"`
	}
	if err := slRequest(ctx, *s, "GET", "/api/favorites", nil, &out); err != nil {
		return err
	}
	for _, id := range s.Links {
		var got struct {
			Link struct {
				ID     string         `json:"id"`
				Title  string         `json:"title"`
				Params map[string]any `json:"params"`
			} `json:"link"`
		}
		if err := slRequest(ctx, *s, "GET", "/api/short-links/"+url.PathEscape(id), nil, &got); err != nil {
			continue // a selected missing item will stop sync; the UI can deselect it
		}
		out.Favorites = append(out.Favorites, slItem{ShortID: got.Link.ID, Title: got.Link.Title, Params: got.Link.Params})
	}
	items := []slItem{}
	seen := map[string]bool{}
	for _, item := range out.Favorites {
		item.ID = item.ShortID
		if item.ID == "" {
			item.ID = slHash(item.Params)
		}
		if seen[item.ID] || item.Params["sub_url"] == nil {
			continue
		}
		seen[item.ID] = true
		if item.Title == "" {
			item.Title = item.ID
		}
		if src, ok := item.Params["sub_url"].(string); ok && strings.HasPrefix(src, "merge:") {
			var merged struct {
				Source struct {
					Items []map[string]any `json:"items"`
				} `json:"source"`
			}
			if err := slRequest(ctx, *s, "GET", "/api/merged-sources/"+url.PathEscape(strings.TrimPrefix(src, "merge:")), nil, &merged); err != nil {
				item.SplitError = err.Error()
			} else {
				for i, p := range merged.Source.Items {
					child := slItem{ID: item.ID + "/" + slHash(p), Title: fmt.Sprintf("%s · %d", item.Title, i+1), Params: p}
					if title, ok := p["title"].(string); ok && title != "" {
						child.Title = title
					}
					if f, ok := p["filter"]; ok {
						b, _ := json.Marshal(f)
						_ = json.Unmarshal(b, &child.Filter)
					}
					// Duplicate identical sources intentionally become one provider.
					if !seen[child.ID] {
						item.Children = append(item.Children, child)
						seen[child.ID] = true
					}
				}
			}
		}
		items = append(items, item)
	}
	s.Catalog, s.CatalogAt = items, time.Now().Unix()
	return nil
}
func slHash(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])[:16]
}
func slPicked(s slState) ([]slItem, error) {
	out := []slItem{}
	seen := map[string]bool{}
	for _, sel := range s.Selected {
		var found *slItem
		for i := range s.Catalog {
			if s.Catalog[i].ID == sel.ID {
				found = &s.Catalog[i]
				break
			}
		}
		if found == nil {
			return nil, fmt.Errorf("подписка %s исчезла или доступ отозван; сохранён последний рабочий конфиг", sel.ID)
		}
		items := []slItem{*found}
		if sel.Split {
			if found.SplitError != "" || len(found.Children) == 0 {
				return nil, fmt.Errorf("не удалось раскрыть состав %s; сохранён рабочий конфиг", found.Title)
			}
			items = found.Children
		}
		for _, item := range items {
			if !seen[item.ID] {
				out = append(out, item)
				seen[item.ID] = true
			}
		}
	}
	if len(out) > 64 {
		return nil, fmt.Errorf("выберите не более 64 источников")
	}
	return out, nil
}

var slParamKeys = []string{"sub_url", "endpoint", "app", "device", "profile", "profiles", "hwid", "nodes"}

func slDownload(ctx context.Context, s slState, item slItem) ([]byte, int, int64, error) {
	q := url.Values{"output": {"yml"}, "clash_groups": {"0"}}
	for _, key := range slParamKeys {
		if v, ok := item.Params[key].(string); ok && v != "" {
			q.Set(key, v)
		}
	}
	// Short links retain Sub Lab access/device policies; merge members retain
	// each member's device/profile parameters through /sub.
	path := "/sub?" + q.Encode()
	if item.ShortID != "" {
		path = "/l/" + url.PathEscape(item.ShortID) + "?type=yml"
	}
	req, err := http.NewRequestWithContext(ctx, "GET", s.URL+path, nil)
	if err != nil {
		return nil, 0, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	req.Header.Set("User-Agent", "HomeNet-SubLab/1.0")
	req.Header.Set("X-HWID", "homenet-"+slHash(coreConfigPath()))
	resp, err := slHTTP().Do(req)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("не удалось скачать %s", item.Title)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, 0, 0, fmt.Errorf("%s: Sub Lab HTTP %d", item.Title, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
	if err != nil || len(b) > 8<<20 {
		return nil, 0, 0, fmt.Errorf("%s: ответ слишком большой или оборвался", item.Title)
	}
	var data struct {
		Proxies []map[string]any `yaml:"proxies"`
	}
	if yaml.Unmarshal(b, &data) != nil || len(data.Proxies) == 0 {
		return nil, 0, 0, fmt.Errorf("%s: ответ не содержит серверов Clash", item.Title)
	}
	if pattern := item.Filter.Pattern; pattern != "" {
		re, err := regexp.Compile("(?i)" + pattern)
		if err != nil {
			return nil, 0, 0, fmt.Errorf("%s: фильтр не поддерживается; добавьте объединение целиком", item.Title)
		}
		filtered := []map[string]any{}
		for _, p := range data.Proxies {
			name, _ := p["name"].(string)
			if re.MatchString(name) {
				filtered = append(filtered, p)
			}
		}
		if len(filtered) > 0 {
			data.Proxies = filtered
		} else {
			switch item.Filter.OnEmpty {
			case "skip":
				data.Proxies = filtered
			case "error":
				return nil, 0, 0, fmt.Errorf("%s: фильтр не выбрал серверы", item.Title)
			}
		}
	}
	for _, p := range data.Proxies {
		if name, _ := p["name"].(string); name == "" {
			return nil, 0, 0, fmt.Errorf("%s: сервер без имени", item.Title)
		}
	}
	clean, err := yaml.Marshal(data)
	var expiry int64
	for _, part := range strings.Split(resp.Header.Get("subscription-userinfo"), ";") {
		_, _ = fmt.Sscanf(strings.TrimSpace(part), "expire=%d", &expiry)
	}
	return clean, len(data.Proxies), expiry, err
}

// Files are immutable and addressed by content. A rejected/reverted config
// still points to its original data; downloads never mutate active providers.
func slCandidate(ctx context.Context, s slState, original []byte) ([]byte, []slManaged, error) {
	items, err := slPicked(s)
	if err != nil {
		return nil, nil, err
	}
	providers := map[string]any{}
	groups := []map[string]any{}
	_, root, err := yamlRoot(original)
	if err != nil {
		return nil, nil, err
	}
	if n := yamlGet(root, "proxy-providers"); n != nil {
		if err = n.Decode(&providers); err != nil {
			return nil, nil, err
		}
	}
	if n := yamlGet(root, "proxy-groups"); n != nil {
		if err = n.Decode(&groups); err != nil {
			return nil, nil, err
		}
	}
	old := map[string]bool{}
	previous := map[string]slManaged{}
	for _, p := range s.Managed {
		previous[p.Key] = p
		if p.Path == "" {
			continue
		}
		old[p.Provider] = true
		if current, ok := providers[p.Provider].(map[string]any); ok && current["path"] != p.Path {
			return nil, nil, fmt.Errorf("провайдер %s изменён вне Sub Lab; проверьте конфигурацию", p.Provider)
		}
	}
	selectedGroups := map[string]bool{}
	for _, g := range s.Groups {
		selectedGroups[g] = true
	}
	for _, g := range groups {
		if name, ok := g["name"].(string); ok {
			delete(selectedGroups, name)
		}
	}
	if len(selectedGroups) > 0 || (len(items) > 0 && len(s.Groups) == 0) {
		return nil, nil, fmt.Errorf("выберите существующую группу для подписок")
	}
	managed := []slManaged{}
	names := []string{}
	for _, item := range items {
		key := slHash(item.ID)
		name := "SL-" + key[:12]
		if _, exists := providers[name]; exists && !old[name] {
			return nil, nil, fmt.Errorf("провайдер %s уже существует и не принадлежит Sub Lab", name)
		}
		b, count, expiry, err := slDownload(ctx, s, item)
		if err != nil {
			p := slManaged{Key: item.ID, Title: item.Title, Provider: name, Error: err.Error()}
			if before, ok := previous[item.ID]; ok && before.Path != "" && providers[before.Provider] != nil {
				p.Path, p.Nodes, p.Expire = before.Path, before.Nodes, before.Expire
				names = append(names, before.Provider)
			}
			managed = append(managed, p)
			continue
		}
		home := getenv("MIHOMO_HOME", filepath.Dir(coreConfigPath()))
		file := filepath.Join(home, "providers", "homenet-sublab", key+"-"+slHash(string(b))+".yaml")
		if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			return nil, nil, err
		}
		if previous, readErr := os.ReadFile(file); readErr == nil {
			if !bytes.Equal(previous, b) {
				return nil, nil, fmt.Errorf("снимок подписки изменён вне HomeNet; синхронизация остановлена")
			}
		} else if os.IsNotExist(readErr) {
			staged, writeErr := mihomoPrivateFile(filepath.Dir(file), ".sublab-*", b)
			if writeErr != nil {
				return nil, nil, writeErr
			}
			if err = os.Rename(staged, file); err != nil {
				_ = os.Remove(staged)
				return nil, nil, err
			}
		} else {
			return nil, nil, readErr
		}
		// A skip filter producing no nodes removes this member from use, as in
		// Sub Lab's merge. It will reappear on the next successful matching sync.
		if count == 0 {
			managed = append(managed, slManaged{Key: item.ID, Title: item.Title, Provider: name, Error: "Фильтр не выбрал серверы: источник пропущен"})
			continue
		}
		providers[name] = map[string]any{"type": "file", "path": file, "health-check": slHealthCheck(providers[name]), "override": map[string]any{"additional-prefix": item.Title + " · "}}
		names = append(names, name)
		managed = append(managed, slManaged{Key: item.ID, Title: item.Title, Provider: name, Path: file, Nodes: count, Expire: expiry})
	}
	current := map[string]bool{}
	if len(items) > 0 && len(names) == 0 {
		return nil, nil, fmt.Errorf("ни один источник не загрузился и нет сохранённых файлов; рабочий конфиг сохранён")
	}
	for _, name := range names {
		current[name] = true
	}
	for name := range old {
		if !current[name] {
			delete(providers, name)
		}
	}
	for _, g := range groups {
		use := []string{}
		name, _ := g["name"].(string)
		previousTarget := false
		for _, target := range s.AppliedGroups {
			if target == name {
				previousTarget = true
			}
		}
		if raw, ok := g["use"].([]any); ok {
			for _, v := range raw {
				if provider, ok := v.(string); ok && !(old[provider] && (!current[provider] || previousTarget)) {
					use = append(use, provider)
				}
			}
		}
		for _, target := range s.Groups {
			if target == name {
				for _, provider := range names {
					exists := false
					for _, v := range use {
						if provider == v {
							exists = true
						}
					}
					if !exists {
						use = append(use, provider)
					}
				}
				break
			}
		}
		if _, exists := g["use"]; exists || len(use) > 0 {
			g["use"] = use
		}
	}
	p, _ := json.Marshal(providers)
	g, _ := json.Marshal(groups)
	candidate, err := buildCandidate(original, configEdit{Set: map[string]json.RawMessage{"proxy-providers": p, "proxy-groups": g}})
	return candidate, managed, err
}

// Subscription updates must not reset the operator's probe interval.
func slHealthCheck(previous any) map[string]any {
	health := adaptiveHealthCheck()
	health["interval"] = 600
	if provider, ok := previous.(map[string]any); ok {
		if old, ok := provider["health-check"].(map[string]any); ok {
			if interval, ok := old["interval"].(int); ok && interval > 0 {
				health["interval"] = interval
			}
		}
	}
	return health
}

func slSync(ctx context.Context, s *slState) error {
	return slSynchronize(ctx, s, mihomoValidateCandidate, mihomoReload)
}

func slSynchronize(ctx context.Context, s *slState, validate func(mihomoSettings, string) error, reload func(mihomoSettings) error) error {
	s.Attempt = time.Now().Unix()
	if len(s.Selected) > 0 {
		if err := slCatalog(ctx, s); err != nil {
			return err
		}
	}
	coreConfigMu.Lock()
	defer coreConfigMu.Unlock()
	if err := vpnDNSPending(""); err != nil {
		return err
	}
	settings, err := coreSettings()
	if err != nil {
		return err
	}
	target, original, err := readActiveConfig(settings)
	if err != nil {
		return err
	}
	candidate, managed, err := slCandidate(ctx, *s, original)
	if err != nil {
		return err
	}
	if !bytes.Equal(candidate, original) {
		if _, err = mihomoSwapConfig(settings, target, original, candidate, "sublab", validate, reload); err != nil {
			return err
		}
	}
	s.Managed, s.LastSync, s.Error = managed, time.Now().Unix(), ""
	for _, p := range managed {
		if p.Error != "" {
			s.Error = "Часть источников не обновилась. Для доступных применены новые данные, для остальных сохранена предыдущая версия, если она была."
			break
		}
	}
	s.AppliedGroups = append([]string{}, s.Groups...)
	return nil
}

// The routing builder owns many groups. Preserve the Sub Lab providers that
// the operator explicitly added to them when it regenerates those groups.
func slKeepRoutingUses(oldGroups, groups, providers *yaml.Node) {
	if oldGroups == nil {
		return
	}
	wanted := map[string][]string{}
	for _, g := range oldGroups.Content {
		if u := mapGet(g, "use"); u != nil {
			for _, x := range u.Content {
				if strings.HasPrefix(x.Value, "SL-") && mapGet(providers, x.Value) != nil {
					name := scalar(mapGet(g, "name"))
					wanted[name] = append(wanted[name], x.Value)
				}
			}
		}
	}
	for _, g := range groups.Content {
		name := scalar(mapGet(g, "name"))
		if len(wanted[name]) == 0 {
			continue
		}
		u := mapGet(g, "use")
		if u == nil {
			u = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			yamlSet(g, "use", u)
		}
		for _, provider := range wanted[name] {
			exists := false
			for _, x := range u.Content {
				if x.Value == provider {
					exists = true
				}
			}
			if !exists {
				u.Content = append(u.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: provider})
			}
		}
	}
}

func (a *app) startSubLab() {
	if os.Getenv("MAINTENANCE_DISABLED") == "1" {
		return
	}
	managedGo(func() {
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-workerContext.Done():
				return
			case <-tick.C:
				slMu.Lock()
				s, err := slLoad()
				if err == nil && s.Every > 0 && len(s.Selected) > 0 && time.Now().Unix()-s.Attempt >= int64(s.Every) {
					ctx, cancel := context.WithTimeout(workerContext, 3*time.Minute)
					if err = slSync(ctx, &s); err != nil {
						s.Error = err.Error()
					}
					cancel()
					if err = slSave(s); err != nil {
						log.Print("Sub Lab: failed to persist sync state")
					}
				}
				slMu.Unlock()
			}
		}
	})
}

func slPublic(s slState) response {
	var items []response
	for _, i := range s.Catalog {
		c := []response{}
		for _, x := range i.Children {
			c = append(c, response{"id": x.ID, "title": x.Title})
		}
		items = append(items, response{"id": i.ID, "title": i.Title, "children": c, "split_error": i.SplitError})
	}
	groups := []string{}
	if _, b, err := readActiveConfig(mihomoSettings{config: coreConfigPath()}); err == nil {
		if _, root, err := yamlRoot(b); err == nil {
			var gs []struct {
				Name string `yaml:"name"`
			}
			if n := yamlGet(root, "proxy-groups"); n != nil {
				_ = n.Decode(&gs)
				for _, g := range gs {
					groups = append(groups, g.Name)
				}
			}
		}
	}
	managed := []response{}
	for _, m := range s.Managed {
		managed = append(managed, response{"key": m.Key, "title": m.Title, "provider": m.Provider, "nodes": m.Nodes, "expire": m.Expire, "error": m.Error})
	}
	return response{"ok": true, "url": s.URL, "token_set": s.Token != "", "every": s.Every, "groups": s.Groups, "available_groups": groups, "selected": s.Selected, "catalog": items, "managed": managed, "catalog_at": s.CatalogAt, "last_sync": s.LastSync, "error": s.Error, "usage": slUsageReport(traffic, time.Now())}
}
func (a *app) handleSubLab(w http.ResponseWriter, r *http.Request) {
	slMu.Lock()
	defer slMu.Unlock()
	s, err := slLoad()
	importedID := ""
	fail := func(err error) { a.writeJSON(w, 400, response{"ok": false, "error": err.Error()}) }
	if err != nil {
		fail(fmt.Errorf("не удалось прочитать настройки Sub Lab"))
		return
	}
	if r.Method == "GET" {
		a.writeJSON(w, 200, slPublic(s))
		return
	}
	switch r.URL.Path {
	case "/api/core/sublab/connect":
		var b struct {
			URL      string `json:"url"`
			Token    string `json:"token"`
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if !a.decodeJSON(w, r, &b) {
			return
		}
		u, e := slBase(b.URL)
		if e != nil {
			fail(e)
			return
		}
		if u != s.URL && len(s.Managed) > 0 {
			fail(fmt.Errorf("сначала снимите выбор подписок и синхронизируйте перед сменой панели"))
			return
		}
		next := s
		next.URL = u
		if u != s.URL {
			next.Token = ""
			next.Catalog = nil
		}
		if b.Token != "" {
			next.Token = strings.TrimSpace(b.Token)
		}
		if b.Username != "" || b.Password != "" {
			var out struct {
				Token string `json:"token"`
			}
			if err = slRequest(r.Context(), slState{URL: u}, "POST", "/api/auth/password", map[string]string{"login": b.Username, "password": b.Password}, &out); err != nil {
				fail(err)
				return
			}
			if out.Token == "" {
				fail(fmt.Errorf("Sub Lab не вернул сессию"))
				return
			}
			next.Token = out.Token
		}
		if next.Token == "" {
			fail(fmt.Errorf("войдите в Sub Lab или укажите токен сессии"))
			return
		}
		if err = slCatalog(r.Context(), &next); err != nil {
			fail(err)
			return
		}
		s = next
	case "/api/core/sublab/refresh":
		if err = slCatalog(r.Context(), &s); err != nil {
			fail(err)
			return
		}
	case "/api/core/sublab/import":
		var b struct {
			URL string `json:"url"`
		}
		if !a.decodeJSON(w, r, &b) {
			return
		}
		u, e := url.Parse(strings.TrimSpace(b.URL))
		if e != nil || u.Scheme+"://"+u.Host != s.URL || u.RawQuery != "" || u.Fragment != "" || !regexp.MustCompile(`^/l/[A-Za-z0-9_-]+/?$`).MatchString(u.Path) {
			fail(fmt.Errorf("нужна короткая ссылка /l/… с подключённой панели Sub Lab"))
			return
		}
		id := strings.TrimSuffix(strings.TrimPrefix(u.Path, "/l/"), "/")
		if len(s.Links) >= 64 {
			fail(fmt.Errorf("можно добавить не более 64 коротких ссылок"))
			return
		}
		next := s
		found := false
		for _, v := range next.Links {
			if v == id {
				found = true
			}
		}
		if !found {
			next.Links = append(append([]string{}, next.Links...), id)
		}
		if err = slCatalog(r.Context(), &next); err != nil {
			fail(err)
			return
		}
		for _, item := range next.Catalog {
			if item.ID == id {
				if item.SplitError != "" {
					fail(fmt.Errorf("состав объединения недоступен; нужны права редактора Sub Lab"))
					return
				}
				importedID = id
			}
		}
		if importedID == "" {
			fail(fmt.Errorf("короткая ссылка не найдена или нет доступа"))
			return
		}
		s = next
	case "/api/core/sublab/pause":
		s.Every = 0
	case "/api/core/sublab/sync-now":
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		if err = slSync(ctx, &s); err != nil {
			s.Error = err.Error()
			_ = slSave(s)
			fail(err)
			return
		}
	case "/api/core/sublab/sync":
		var b struct {
			Selected []slSelection `json:"selected"`
			Every    int           `json:"every"`
			Groups   []string      `json:"groups"`
		}
		if !a.decodeJSON(w, r, &b) {
			return
		}
		if b.Every != 0 && b.Every != 3600 && b.Every != 21600 && b.Every != 86400 {
			fail(fmt.Errorf("интервал: вручную, час, 6 часов или сутки"))
			return
		}
		if len(b.Selected) > 64 {
			fail(fmt.Errorf("слишком много подписок"))
			return
		}
		next := s
		next.Selected = b.Selected
		next.Groups = b.Groups
		next.Every = b.Every
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		if err = slSync(ctx, &next); err != nil {
			s.Error = err.Error()
			_ = slSave(s)
			fail(err)
			return
		}
		s = next
	case "/api/core/sublab/create":
		var b struct {
			Title string   `json:"title"`
			URL   string   `json:"url"`
			Tags  []string `json:"tags"`
		}
		if !a.decodeJSON(w, r, &b) {
			return
		}
		u, e := url.Parse(strings.TrimSpace(b.URL))
		if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || strings.TrimSpace(b.Title) == "" {
			fail(fmt.Errorf("нужны название и http(s)-ссылка подписки"))
			return
		}
		// Fetch before the write. Never retry a creation whose outcome is uncertain.
		var favorites struct {
			Favorites []map[string]any `json:"favorites"`
		}
		if err = slRequest(r.Context(), s, "GET", "/api/favorites", nil, &favorites); err != nil {
			fail(err)
			return
		}
		var created struct {
			Link struct {
				ID string `json:"id"`
			} `json:"link"`
			URLs struct {
				Short string `json:"shortUrl"`
			} `json:"urls"`
		}
		payload := map[string]any{"sub_url": u.String(), "output": "yml", "title": strings.TrimSpace(b.Title), "tags": b.Tags}
		if err = slRequest(r.Context(), s, "POST", "/api/short-links", payload, &created); err != nil {
			fail(fmt.Errorf("создание не повторялось; проверьте Sub Lab перед повтором: %w", err))
			return
		}
		if created.Link.ID == "" {
			fail(fmt.Errorf("Sub Lab принял запрос без идентификатора; проверьте панель перед повтором"))
			return
		}
		favorites.Favorites = append(favorites.Favorites, map[string]any{"shortId": created.Link.ID, "title": b.Title, "url": created.URLs.Short, "payload": map[string]string{"sub_url": u.String(), "output": "yml"}, "tags": b.Tags, "ts": time.Now().UnixMilli()})
		if err = slRequest(r.Context(), s, "PUT", "/api/favorites", favorites, nil); err != nil {
			fail(fmt.Errorf("ссылка %s создана, но добавить её в избранное не удалось; откройте Sub Lab, не создавайте повторно", created.Link.ID))
			return
		}
		if err = slCatalog(r.Context(), &s); err != nil {
			fail(fmt.Errorf("подписка создана; обновите каталог позже"))
			return
		}
	default:
		http.NotFound(w, r)
		return
	}
	if err = slSave(s); err != nil {
		fail(fmt.Errorf("операция выполнена, но настройки не сохранены; проверьте каталог и конфиг перед повтором"))
		return
	}
	out := slPublic(s)
	if importedID != "" {
		out["imported_id"] = importedID
	}
	a.writeJSON(w, 200, out)
}

// Keep ordering deterministic for recommendations and tests.
func slSortedKeys[T any](m map[string]T) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
