package main

import (
	"fmt"
	"html"
	"net"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

// Pages for errors nginx itself produces when an upstream cannot be reached.
// Upstream responses are never intercepted: an application's own 502/503 pages pass through.
// The router's nginx is built without SSI, so every page is rendered per host and status
// here; the embedded script only adds the request time, path and the retry countdown.
var unavailableCodes = []int{502, 504}

const unavailableURIPrefix = "/__homenet/unavailable-"

func (g *generator) unavailablePagePath(host string, external bool, code int) string {
	variant := "local"
	if external {
		variant = "public"
	}
	return filepath.Join(g.errorsDir, fmt.Sprintf("%s.%s.%d.html", host, variant, code))
}

func (g *generator) unavailableDirectives(host string, external bool) string {
	lines := []string{}
	for _, code := range unavailableCodes {
		uri := fmt.Sprintf("%s%d.html", unavailableURIPrefix, code)
		lines = append(lines,
			fmt.Sprintf("error_page %d %s;", code, uri),
			fmt.Sprintf("location = %s {\n    internal;\n    alias %s;\n    add_header Cache-Control \"no-store\" always;\n  }", uri, quote(g.unavailablePagePath(host, external, code))),
		)
	}
	return strings.Join(lines, "\n  ")
}

func (g *generator) addUnavailablePages(routes schema.Routes, apps map[string]schema.App, files map[string]string) {
	manager := ""
	if ui := routes.Globals.UI; ui.Host != "" && ui.Port > 0 {
		if ip := net.ParseIP(ui.Host); ip == nil || !ip.IsUnspecified() {
			manager = "http://" + net.JoinHostPort(ui.Host, strconv.Itoa(ui.Port)) + "/#/servers"
		}
	}
	for _, host := range routes.Hosts {
		external := false
		for _, ep := range host.Endpoints {
			if ep.Name != "web" {
				external = true
			}
		}
		for _, code := range unavailableCodes {
			files[g.unavailablePagePath(host.Host, false, code)] = renderUnavailablePage(host, apps[host.AppID], code, false, manager)
			if external {
				files[g.unavailablePagePath(host.Host, true, code)] = renderUnavailablePage(host, apps[host.AppID], code, true, "")
			}
		}
	}
}

type pageItem struct{ title, text string }

func renderUnavailablePage(host schema.Host, app schema.App, code int, public bool, manager string) string {
	name := app.Name
	if name == "" {
		name = app.ID
	}
	if name == "" {
		name = host.Host
	}
	scheme := app.Upstream.Scheme
	if scheme == "" {
		scheme = "http"
	}
	address := app.Upstream.Address
	port := strconv.Itoa(app.Upstream.Port)
	upstream := scheme + "://" + net.JoinHostPort(address, port)

	codeText := "нет соединения с приложением"
	if code == 504 {
		codeText = "приложение не ответило вовремя"
	}

	var headline, lead, appState string
	var checks []pageItem
	switch {
	case public:
		headline = fmt.Sprintf("«%s» временно недоступен", name)
		lead = "Сервис сейчас не отвечает. Обычно это ненадолго: страница обновится сама, как только он снова заработает."
		appState = "Не отвечает"
	case code == 504:
		headline = fmt.Sprintf("«%s» не ответил вовремя", name)
		lead = fmt.Sprintf("Прокси HomeNet работает, но так и не дождался ответа от %s. Похоже, компьютер недоступен по сети или приложение зависло.", upstream)
		appState = "Нет ответа"
		checks = []pageItem{
			{fmt.Sprintf("Компьютер %s включён", address), "и доступен из сети роутера: проверьте питание, кабель или Wi-Fi."},
			{"Приложение не зависло", "и не перегружено: посмотрите его журнал, при необходимости перезапустите."},
			{fmt.Sprintf("Порт %s не закрыт файрволом", port), "на самом компьютере или в правилах сети."},
		}
	default:
		headline = fmt.Sprintf("«%s» не принимает подключения", name)
		lead = fmt.Sprintf("Прокси HomeNet работает, но не смог подключиться к %s. Чаще всего приложение остановлено или слушает другой порт.", upstream)
		appState = "Недоступен"
		checks = []pageItem{
			{"Приложение запущено", fmt.Sprintf("на компьютере %s, а сам компьютер включён.", address)},
			{fmt.Sprintf("Оно слушает порт %s", port), fmt.Sprintf("по протоколу %s и принимает подключения не только с localhost.", strings.ToUpper(scheme))},
			{"Адрес в маршруте актуален", "— если приложение переехало, исправьте его в HomeNet → Сервисы."},
		}
	}

	e := html.EscapeString
	var b strings.Builder
	b.WriteString(managedHTMLHeader)
	b.WriteString(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>`)
	b.WriteString(e(name) + " — ошибка " + strconv.Itoa(code))
	b.WriteString(`</title>
<style>` + unavailableCSS + `</style>
</head>
<body>
<main class="card" aria-labelledby="title">
  <div class="top">
    <span class="brand"><span class="mark" aria-hidden="true">` + iconRoute + `</span>HomeNet</span>
    <span class="code" title="HTTP ` + strconv.Itoa(code) + `">Ошибка ` + strconv.Itoa(code) + `</span>
  </div>
  <div class="hero">
    <span class="hero-icon" aria-hidden="true">` + iconPlug + `</span>
    <h1 id="title">` + e(headline) + `</h1>
    <p class="lead">` + e(lead) + `</p>
  </div>
  <ol class="chain" aria-label="Путь запроса">
    <li class="ok"><span class="node">` + iconDevice + `</span><b>Вы</b><small>Запрос отправлен</small></li>
    <li class="ok"><span class="node">` + iconProxy + `</span><b>Прокси HomeNet</b><small>Работает</small></li>
    <li class="bad"><span class="node">` + iconServer + `</span><b>` + e(name) + `</b><small>` + e(appState) + `</small></li>
  </ol>
`)
	if len(checks) > 0 {
		b.WriteString(`  <section class="checks">
    <h2>Что проверить</h2>
    <ul>
`)
		for _, item := range checks {
			b.WriteString(`      <li><span class="tick" aria-hidden="true">` + iconCheck + `</span><span><b>` + e(item.title) + `</b> ` + e(item.text) + `</span></li>
`)
		}
		b.WriteString(`    </ul>
  </section>
`)
	}
	b.WriteString(`  <dl class="facts">
    <div><dt>Домен</dt><dd class="mono">` + e(host.Host) + `</dd></div>
`)
	if !public {
		b.WriteString(`    <div><dt>Приложение</dt><dd class="mono">` + e(upstream) + `</dd></div>
`)
	}
	b.WriteString(`    <div><dt>Код ответа</dt><dd>` + strconv.Itoa(code) + ` — ` + e(codeText) + `</dd></div>
    <div><dt>Путь</dt><dd class="mono" data-path>/</dd></div>
    <div><dt>Время</dt><dd data-time>—</dd></div>
  </dl>
  <div class="actions">
    <button type="button" class="primary" data-retry>` + iconRefresh + `Повторить</button>
`)
	if manager != "" {
		b.WriteString(`    <a class="secondary" href="` + e(manager) + `">Открыть HomeNet</a>
`)
	}
	b.WriteString(`    <span class="countdown" data-countdown></span>
  </div>
</main>
<p class="foot">HomeNet Proxy Manager · страница показана прокси, а не приложением</p>
<script>` + unavailableJS + `</script>
</body>
</html>
`)
	return b.String()
}

const managedHTMLHeader = "<!-- managed by homenet-nginx-yaml -->\n"

const (
	svgOpen     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">`
	iconRoute   = svgOpen + `<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/></svg>`
	iconPlug    = svgOpen + `<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0Z"/><path d="M12 17v5"/><path d="m3 3 18 18"/></svg>`
	iconDevice  = svgOpen + `<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>`
	iconProxy   = svgOpen + `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`
	iconServer  = svgOpen + `<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>`
	iconCheck   = svgOpen + `<path d="m5 12 5 5 9-10"/></svg>`
	iconRefresh = svgOpen + `<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/></svg>`
)

const unavailableCSS = `
:root{color-scheme:light dark;--bg:#f5f6f8;--surface:#fff;--surface2:#f8f9fb;--border:#e2e5ea;--text:#14171c;--text2:#464d59;--text3:#69717d;--accent:#2459d6;--accent-hover:#1d4bbb;--ok:#17803d;--ok-soft:#e8f5ed;--bad:#c4322d;--bad-soft:#fdeeed;--line:#cdd2d9;--shadow:0 24px 56px rgba(16,24,40,.12),0 2px 6px rgba(16,24,40,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#0c0e11;--surface:#13161a;--surface2:#171a1f;--border:#252a31;--text:#e8eaed;--text2:#b4bac4;--text3:#8b929d;--accent:#3b7cf5;--accent-hover:#5b92f7;--ok:#43b872;--ok-soft:rgba(67,184,114,.14);--bad:#f06a64;--bad-soft:rgba(240,106,100,.14);--line:#343a43;--shadow:0 24px 56px rgba(0,0,0,.55)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px 16px;background:var(--bg);color:var(--text);font:15px/1.55 Inter,"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
svg{display:block;width:100%;height:100%}
.card{width:100%;max-width:640px;background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border)}
.brand{display:inline-flex;align-items:center;gap:9px;font-weight:650;letter-spacing:-.01em}
.mark{display:grid;place-items:center;width:26px;height:26px;padding:5px;border-radius:7px;background:var(--text);color:var(--surface)}
.code{padding:3px 10px;border-radius:999px;background:var(--bad-soft);color:var(--bad);font:600 12px/18px ui-monospace,"JetBrains Mono","Cascadia Mono",Consolas,monospace}
.hero{padding:32px 28px 8px;text-align:center}
.hero-icon{display:grid;place-items:center;width:56px;height:56px;margin:0 auto 18px;padding:14px;border-radius:16px;background:var(--bad-soft);color:var(--bad)}
h1{margin:0;font-size:24px;line-height:1.3;font-weight:650;letter-spacing:-.02em;overflow-wrap:anywhere}
.lead{max-width:500px;margin:10px auto 0;color:var(--text2);overflow-wrap:anywhere}
.chain{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:24px 28px 8px;padding:0;list-style:none}
.chain li{position:relative;display:grid;justify-items:center;gap:2px;text-align:center;min-width:0}
.chain li+li::before{content:"";position:absolute;top:21px;right:calc(50% + 28px);left:calc(-50% + 28px);height:2px;border-radius:2px;background:var(--ok)}
.chain li.bad::before{background:repeating-linear-gradient(90deg,var(--bad) 0 6px,transparent 6px 11px)}
.node{display:grid;place-items:center;width:44px;height:44px;margin-bottom:6px;padding:11px;border-radius:50%;border:1px solid var(--border);background:var(--surface2);color:var(--ok)}
.chain li.ok .node{border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:var(--ok-soft)}
.chain li.bad .node{border-color:color-mix(in srgb,var(--bad) 35%,transparent);background:var(--bad-soft);color:var(--bad)}
.chain b{max-width:100%;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chain small{color:var(--text3);font-size:12px}
.chain li.bad small{color:var(--bad);font-weight:500}
.checks{margin:24px 28px 0;padding:16px 18px;border:1px solid var(--border);border-radius:12px;background:var(--surface2)}
h2{margin:0 0 10px;font-size:14px;font-weight:600}
.checks ul{display:grid;gap:9px;margin:0;padding:0;list-style:none}
.checks li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;color:var(--text2);font-size:14px;line-height:1.5}
.checks li b{color:var(--text);font-weight:600}
.tick{width:18px;height:18px;margin-top:2px;color:var(--accent)}
.facts{display:grid;margin:20px 28px 0;padding:0}
.facts div{display:grid;grid-template-columns:130px minmax(0,1fr);gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px}
.facts div:last-child{border-bottom:0}
dt{color:var(--text3)}
dd{margin:0;min-width:0;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,"JetBrains Mono","Cascadia Mono","SF Mono",Consolas,monospace;font-size:13px}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;margin-top:20px;padding:16px 28px 22px;border-top:1px solid var(--border);background:var(--surface2)}
.primary,.secondary{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:38px;padding:0 16px;border-radius:9px;font-family:inherit;font-size:14px;font-weight:500;line-height:1;text-decoration:none;cursor:pointer}
.primary{border:1px solid var(--accent);background:var(--accent);color:#fff}
.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.primary svg{width:16px;height:16px}
.secondary{border:1px solid var(--line);background:var(--surface);color:var(--text)}
.secondary:hover{background:var(--bg)}
.primary:focus-visible,.secondary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.countdown{margin-left:auto;color:var(--text3);font-size:13px}
.countdown button{padding:0;border:0;background:none;color:var(--accent);font:inherit;cursor:pointer}
.foot{margin:0;color:var(--text3);font-size:12px;text-align:center}
@media (max-width:520px){body{justify-content:flex-start;padding:16px 12px}.hero{padding:26px 18px 4px}h1{font-size:21px}.chain{margin:22px 12px 4px}.checks,.facts{margin-left:18px;margin-right:18px}.facts div{grid-template-columns:minmax(0,1fr);gap:1px}.actions{padding:14px 18px 18px}.primary,.secondary{flex:1 1 auto}.countdown{width:100%;margin-left:0;text-align:center}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`

// Retries back off per path (15 s doubling up to 2 min) and pause while the tab is hidden.
const unavailableJS = `
(function(){
  var path = location.pathname || "/";
  var el = document.querySelector("[data-path]"); if (el) el.textContent = path;
  var t = document.querySelector("[data-time]"); if (t) t.textContent = new Date().toLocaleString("ru-RU");
  document.querySelector("[data-retry]").addEventListener("click", function(){ location.reload(); });
  var key = "homenet-retry:" + path, attempt = 0;
  try {
    var saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (saved && Date.now() - saved.at < 300000) attempt = saved.n;
    sessionStorage.setItem(key, JSON.stringify({ n: attempt + 1, at: Date.now() }));
  } catch (e) {}
  var left = Math.min(15 * Math.pow(2, attempt), 120), stopped = false;
  var box = document.querySelector("[data-countdown]"), seconds = document.createElement("span");
  var stop = document.createElement("button");
  stop.type = "button"; stop.textContent = "не повторять"; seconds.textContent = left;
  box.append("Повтор через ", seconds, " с · ", stop);
  stop.addEventListener("click", function(){ stopped = true; box.textContent = "Автоповтор выключен"; });
  setInterval(function(){
    if (stopped || document.hidden) return;
    left -= 1;
    if (left <= 0) { location.reload(); return; }
    seconds.textContent = left;
  }, 1000);
})();
`
