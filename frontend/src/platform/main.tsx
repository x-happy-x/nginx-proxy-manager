import { ReleaseSet } from "./ReleaseSet";
import { System } from "./System";
import PortalBase from "../PortalBase";
import { IntegrationDetails } from "./IntegrationDetails";
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as ReactDOM from "react-dom";
import { useEffect, useRef, useState } from "react";
import { request, type Installed, type IntegrationModule, type Host } from "./sdk";
import "./style.css";

declare global { var __HOMENET_RUNTIME__: { React: typeof React; ReactDOM: typeof ReactDOM; ReactDOMClient: { createRoot: typeof createRoot }; portalTarget?: Element | DocumentFragment }; }
globalThis.__HOMENET_RUNTIME__ = { React, ReactDOM, ReactDOMClient: { createRoot } };

const catalog = [
  { id: "proxy", name: "Прокси и домены", icon: "↗", description: "Сервисы на своих доменах, HTTPS, сертификаты и DNS.", detail: "Управление nginx с сохранением существующих маршрутов и сертификатов." },
  { id: "network", name: "Мониторинг связи", icon: "⌁", description: "Доступность интернета, LTE и состояние устройств.", detail: "История связи, диагностика, сканер и ресурсы роутеров и Proxmox." },
  { id: "vpn", name: "VPN и маршрутизация", icon: "◇", description: "Подписки, узлы, правила и проверка обхода ограничений.", detail: "mihomo / XKeen, Tailscale и OLCRTC, включая режим «Всё через OLCRTC»." },
];
type Platform = { identity: { login: string; admin: boolean }; protocol: number; integrations: Installed[] };
type Job = { id: string; status: string; app?: string; error?: string };
const navigate = (page: string) => { location.hash = `/${page}`; };

class Boundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <div role="alert" className="hn-error">Не удалось открыть интеграцию: {this.state.error}</div> : this.props.children; }
}
function ModuleView({ item, notify }: { item: Installed; notify: (text: string) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const m = item.manifest;
    const base = `/integrations/${encodeURIComponent(m.id)}/${encodeURIComponent(m.version)}/`;
    if (!element.current) return;
    const target = element.current;
    const shadow = target.shadowRoot || target.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    container.className = "homenet-module-root";
    shadow.appendChild(container);
    globalThis.__HOMENET_RUNTIME__.portalTarget = shadow;
    const syncTheme = () => { target.dataset.theme = document.documentElement.dataset.theme || "light"; };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const links = (m.ui.css || []).map(css => { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = base + css; shadow.appendChild(link); return link; });
    const host: Host = {
      protocol: 1, React, createRoot, navigate, notify,
      api: (path, init) => {
        if (!path.startsWith("/") || path.includes("..") || path.includes("\\") || path.includes("%")) return Promise.reject(new Error("Недопустимый путь API"));
        return request(`/api/integrations/${m.id}${path}`, init);
      },
    };
    setError("");
    (async () => {
      const mod = await import(/* @vite-ignore */ base + m.ui.entry) as IntegrationModule;
      if (disposed || !element.current) return;
      if (typeof mod.mount !== "function") throw new Error("Несовместимый интерфейс интеграции");
      const unmount = await mod.mount(container, host);
      if (typeof unmount !== "function") throw new Error("Интеграция не предоставила завершение работы");
      if (disposed) unmount(); else cleanup = unmount;
    })().catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; cleanup?.(); observer.disconnect(); container.remove(); links.forEach(link => link.remove()); };
  }, [item.manifest.id, item.manifest.version, notify]);
  return <><div className="hn-error" role="alert" hidden={!error}>{error}</div><div className={`integration-${item.manifest.id}`} ref={element} /></>;
}
function App({onPortal}: {onPortal: () => void}) {
  const [data, setData] = useState<Platform>();
  const [error, setError] = useState("");
  const [page, setPage] = useState(location.hash.replace(/^#\/?/, "") || "overview");
  const [tab, setTab] = useState("installed");
  const [detail, setDetail] = useState<string>();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!detail || !dialog.current) return;
    const previous=document.activeElement as HTMLElement | null;
    const bodyOverflow=document.body.style.overflow;document.body.style.overflow="hidden";
    const outside=Array.from(document.querySelectorAll<HTMLElement>(".hn-sidebar,.hn-workspace"));
    outside.forEach(node=>node.setAttribute("inert",""));
    const focusable=()=>Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]')||[]);
    focusable()[0]?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){event.preventDefault();setDetail(undefined);}
      if(event.key==="Tab"){const nodes=focusable();const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
    };
    document.addEventListener("keydown",key);
    return()=>{document.removeEventListener("keydown",key);document.body.style.overflow=bodyOverflow;outside.forEach(node=>node.removeAttribute("inert"));previous?.focus();};
  },[detail]);
  const [dms, setDms] = useState<"loading" | "available" | "unavailable">("loading");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("homenet-theme") || "light");
  const notify = React.useCallback((message: string) => setNotice(message), []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("homenet-theme", theme); }, [theme]);
  useEffect(() => { const change = () => setPage(location.hash.replace(/^#\/?/, "") || "overview"); window.addEventListener("hashchange", change); return () => window.removeEventListener("hashchange", change); }, []);
  useEffect(() => {
    let alive = true;
    request("/api/platform").then(r => r.json()).then(p => { if (alive) setData(p); }).catch(e => { if (alive) setError(String(e)); });
    request("/api/dms/health").then(() => { if (alive) setDms("available"); }).catch(() => { if (alive) setDms("unavailable"); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (page !== "integrations" || tab !== "history") return;
    let alive = true;
    const poll=()=>request("/api/platform/operations").then(r => r.json()).then(body => { if (alive) setJobs(Array.isArray(body) ? body : body.items || body.jobs || []); }).catch(e => { if (alive) setNotice(String(e)); });
    void poll(); const timer=setInterval(()=>void poll(),2000);
    return () => { alive = false; clearInterval(timer); };
  }, [page, tab]);
  const installed = data?.integrations || [];
  const active = installed.filter(i => i.enabled);
  const selected = installed.find(i => i.manifest.id === detail);
  const module = installed.find(i => i.manifest.ui.pages.some(p => p.id === page || p.aliases?.includes(page)));
  const choose = () => { setTab("catalog"); navigate("integrations"); };
  if (!data) return <main className="hn-boot"><div className="hn-logo">H</div><h1>HomeNet</h1><p role="status">{error || "Подключение к HomeNet…"}</p>{error && <a className="hn-primary" href="/_gate/login?return=/">Войти через Account</a>}</main>;
  return <div className="hn-layout">
    <aside className="hn-sidebar"><a className="hn-brand" href="#/overview"><span className="hn-logo">H</span><span>HomeNet<small>Ваша домашняя сеть</small></span></a><div className="hn-nav-label">УПРАВЛЕНИЕ</div>
      <button onClick={onPortal}>← Приложения</button><nav>{[{ id: "overview", title: "Обзор" }, ...active.map(i => ({ id: i.manifest.ui.pages[0]?.id || "integrations", title: i.manifest.name })), { id: "integrations", title: "Интеграции" }, { id: "system", title: "Система" }].map(n => <a key={n.id} className={page === n.id ? "active" : ""} href={`#/${n.id}`}>{n.title}{n.id === "integrations" && <span>{installed.length}</span>}</a>)}</nav>
      <div className="hn-sidebar-bottom"><span className="hn-dot" /> HomeNet Core<small>Базовая платформа · API 1</small></div>
    </aside>
    <div className="hn-workspace"><header className="hn-header"><span>Домашняя сеть <b>/</b> {page === "integrations" ? "Интеграции" : page === "overview" ? "Обзор" : page === "system" ? "Система" : module?.manifest.name || "Раздел"}</span><div><button aria-label="Сменить тему" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "◐"}</button><span>{data.identity.login || "Администратор"}</span></div></header>
      <main className="hn-main">{notice && <div className="hn-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Закрыть уведомление">×</button></div>}
        {page === "overview" && <><div className="hn-heading"><div><span className="hn-eyebrow">HOMENET</span><h1>{installed.length ? "Ваша домашняя сеть" : "Ваша сеть начинается здесь"}</h1><p>{installed.length ? "Управляйте подключёнными интеграциями в одном месте." : "HomeNet готов к настройке. Добавьте возможности, которые нужны вашей сети."}</p></div><span className="hn-badge">Ядро работает</span></div>
          <section className="hn-hero"><div><span className="hn-eyebrow">ОДНА ПАНЕЛЬ · ВАШ НАБОР ВОЗМОЖНОСТЕЙ</span><h2>{installed.length ? `${installed.length} интеграции установлено` : "Начните с первой интеграции"}</h2><p>Домены для сервисов, наблюдение за связью или управление VPN — каждый модуль подключается отдельно.</p><button className="hn-primary" onClick={choose}>Выбрать интеграции →</button></div><div className="hn-network-art" aria-hidden="true"><span>↗</span><b>H</b><span>◇</span></div></section>
          <div className="hn-section-title"><h2>Возможности HomeNet</h2><button onClick={choose}>Открыть каталог →</button></div><div className="hn-grid">{catalog.map(c => <article className="hn-card" key={c.id}><span className="hn-icon">{c.icon}</span><h3>{c.name}</h3><p>{c.description}</p><button onClick={() => { setDetail(c.id); navigate("integrations"); }}>{installed.some(i => i.manifest.id === c.id) ? "Управление" : "Подробнее"} →</button></article>)}</div></>}
        {page === "integrations" && <><div className="hn-heading"><div><span className="hn-eyebrow">ВОЗМОЖНОСТИ ВАШЕЙ СЕТИ</span><h1>Интеграции</h1><p>Подключайте, обновляйте и настраивайте модули HomeNet.</p></div></div><div className="hn-tabs">{[["installed", `Установленные · ${installed.length}`], ["catalog", "Каталог"], ["history", "История"], ["release", "Набор версий"]].map(([id, title]) => <button className={tab === id ? "active" : ""} key={id} onClick={() => setTab(id)}>{title}</button>)}</div>
          {dms === "unavailable" && <div className="hn-warning">Служба установки DMS недоступна. Работающие интеграции остаются доступны; загрузка новых пакетов временно невозможна.</div>}
          {tab === "installed" && (installed.length ? <div className="hn-grid">{installed.map(i => <article className="hn-card" key={i.manifest.id}><div className="hn-card-head"><span className="hn-icon">{catalog.find(c => c.id === i.manifest.id)?.icon || "+"}</span><span className="hn-badge" data-state={i.enabled?i.connection:"disabled"}>{i.enabled ? i.connection === "connected" ? "Подключено" : i.connection === "unconfigured" ? "Нужна настройка" : "Нет связи" : "Отключено"}</span></div><h3>{i.manifest.name}</h3><small>Версия {i.manifest.version}</small><p>{i.manifest.description}</p><div className="hn-actions"><button onClick={() => setDetail(i.manifest.id)}>Управление</button>{i.enabled && <button className="hn-primary" onClick={() => navigate(i.manifest.ui.pages[0]?.id || "integrations")}>Открыть</button>}</div></article>)}</div> : <div className="hn-empty"><span className="hn-icon">＋</span><h2>Пока нет интеграций</h2><p>Core и DMS уже входят в платформу. Выберите дополнительные возможности в каталоге.</p><button className="hn-primary" onClick={choose}>Выбрать интеграции</button></div>)}
          {tab === "catalog" && <div className="hn-grid">{catalog.map(c => <article className="hn-card" key={c.id}><span className="hn-icon">{c.icon}</span><h3>{c.name}</h3><p>{c.description}</p><button onClick={() => setDetail(c.id)}>{installed.some(i => i.manifest.id === c.id) ? "Установлено · Подробнее" : "Подробнее"}</button></article>)}</div>}
          {tab === "release" && <ReleaseSet installed={installed} onRefresh={() => { void request("/api/platform").then(r=>r.json()).then(setData); }} />}
          {tab === "history" && <section className="hn-card"><h2>Операции интеграций</h2>{jobs.some(j=>j.status==="recovery_required")&&<button onClick={()=>void request("/api/platform/recover",{method:"POST"}).then(()=>setNotice("Восстановление запущено. Состояние обновится в журнале.")).catch(e=>setNotice(String(e)))}>Повторить восстановление</button>}{jobs.length ? jobs.map(job => <div className="hn-job" key={job.id}><b>{job.app || "Набор интеграций"}</b><span>{job.status}</span><small>{job.id}</small>{job.error && <p role="alert">{job.error}</p>}</div>) : <p>Операций пока нет.</p>}</section>}
        </>}
        {page === "system" && <System />}
        {!["overview", "integrations", "system"].includes(page) && (module?.enabled ? <Boundary key={module.manifest.id}><ModuleView item={module} notify={notify} /></Boundary> : <div className="hn-empty"><h2>Интеграция недоступна</h2><p>Для этого раздела требуется установленная и включённая интеграция.</p><button onClick={choose}>Открыть интеграции</button></div>)}
        {["overview", "integrations", "system"].includes(page) && <section className="hn-baseline"><div><b>Базовые компоненты</b><p>Основа HomeNet, доступная при любом наборе интеграций.</p></div><div><span className="hn-dot" /><b>HomeNet Core</b><small>Работает</small></div><div><span className={`hn-dot ${dms !== "available" ? "muted" : ""}`} /><b>DMS</b><small>{dms === "available" ? "Готов к установке" : dms === "loading" ? "Проверка…" : "Недоступен"}</small></div></section>}
      </main><footer>HomeNet · Локальное управление домашней сетью</footer>
    </div>
    {detail && <div className="hn-overlay" onClick={() => setDetail(undefined)}><section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="detail-title" className="hn-dialog" onClick={e => e.stopPropagation()}><button className="hn-close" aria-label="Закрыть" onClick={() => setDetail(undefined)}>×</button><span className="hn-eyebrow">ИНТЕГРАЦИЯ</span><h2 id="detail-title">{catalog.find(c => c.id === detail)?.name || selected?.manifest.name}</h2><p>{catalog.find(c => c.id === detail)?.detail || selected?.manifest.description}</p><hr /><IntegrationDetails key={detail} id={detail} installed={selected} dmsAvailable={dms === "available"} onRefresh={() => { void request("/api/platform").then(r => r.json()).then(setData); }} /><button onClick={() => setDetail(undefined)}>Закрыть</button></section></div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<PortalBase Console={App} />);
