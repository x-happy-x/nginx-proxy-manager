import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { request, type HomeMode, type Installed, type IntegrationModule, type WidgetKind, type WidgetSize } from "./sdk";
import { moduleBase, moduleHost, navigate } from "./host";
import "./home.css";

// Home page built from module widgets (NPM-66, docs/modular-homenet/widgets.md).
// Core gathers everything in one GET /api/platform/home; this page only draws it.

type CatalogWidget = { key: string; module: string; module_name: string; version: string; id: string; title: string; kind: WidgetKind; sizes: WidgetSize[]; modes: HomeMode[]; page?: string; data?: string; refresh: number };
type WidgetData = { state: "ok" | "warn" | "bad" | "unknown"; updated_at?: string; note?: string; body?: any; fetched_at?: string; stale?: boolean; error?: string; unavailable?: string };
type Attention = { module: string; module_name: string; id: string; severity: "critical" | "warning" | "info"; text: string; since?: string; action?: { label: string; page: string }; stale?: boolean };
type Task = { module: string; module_name: string; id: string; label: string; value?: number; total?: number; step?: string; eta_s?: number; cancel?: string; note?: string };
type HomeModule = { id: string; name: string; version: string; ui_api: number; enabled: boolean; page?: string; state: "ok" | "stale" | "updating" | "disabled"; reason?: string };
type LayoutItem = { w: string; size: WidgetSize };
type HomeReply = { mode: HomeMode; generated_at: string; customized: boolean; layout: LayoutItem[]; catalog: CatalogWidget[]; data: Record<string, WidgetData>; attention: Attention[]; tasks: Task[]; modules: HomeModule[]; can_save: boolean };

const SIZE_LABEL: Record<WidgetSize, string> = { s: "S", m: "M", l: "L" };
const KIND_LABEL: Record<WidgetKind, string> = { stat: "число", status: "статус", list: "список", progress: "прогресс", series: "график", bars: "столбцы", custom: "свой" };
const MODE_KEY = "homenet-home-mode";

const readMode = (): HomeMode => { try { return localStorage.getItem(MODE_KEY) === "simple" ? "simple" : "pro"; } catch { return "pro"; } };
const hhmm = (iso?: string) => { if (!iso) return ""; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
function ago(iso?: string, now = Date.now()) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const min = Math.round((now - t) / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  if (min < 24 * 60) return `в ${hhmm(iso)}`;
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}
// short source labels for first-party modules; others show their manifest name
const SHORT: Record<string, string> = { vpn: "VPN", proxy: "Прокси", network: "Связь", core: "Core" };
const short = (id: string, name: string) => SHORT[id] || name;
function span(ms: number) { const h = Math.round(ms / 3600000); return h >= 1 ? `${h} ч назад` : `${Math.max(1, Math.round(ms / 60000))} мин назад`; }
const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/* ---------- standard kinds: text and numbers only, React escapes them ---------- */

function Stat({ body }: { body: any }) {
  return <div className="hw-value"><b>{text(body?.value) || "—"}</b>{body?.unit && <span>{text(body.unit)}</span>}{body?.delta && <small>{text(body.delta)}</small>}</div>;
}
function Status({ body, state }: { body: any; state: string }) {
  const items: any[] = Array.isArray(body?.items) ? body.items.slice(0, 8) : [];
  return <><div className="hw-value"><b data-state={state}>{text(body?.label) || "—"}</b></div>
    {items.length > 0 && <ul className="hw-chips">{items.map((it, i) => <li key={i} data-ok={it?.ok === true ? "yes" : it?.ok === false ? "no" : undefined}><span aria-hidden="true">{it?.ok === true ? "✓" : it?.ok === false ? "✗" : "·"}</span>{text(it?.text)}{it?.value && <small>{text(it.value)}</small>}<span className="sr-only">{it?.ok === true ? " — работает" : it?.ok === false ? " — не работает" : ""}</span></li>)}</ul>}</>;
}
function List({ body }: { body: any }) {
  const items: any[] = Array.isArray(body?.items) ? body.items.slice(0, 8) : [];
  return <ul className="hw-list">{items.map((it, i) => <li key={i}><span className="hw-dot" data-state={text(it?.state) || "unknown"} aria-hidden="true" />{it?.page ? <a href={`#/${text(it.page)}`}>{text(it?.text)}</a> : <span>{text(it?.text)}</span>}<small>{text(it?.value)}</small></li>)}
    {num(body?.more) > 0 && <li className="hw-more">ещё {num(body.more)}</li>}</ul>;
}
function Progress({ body }: { body: any }) {
  const value = num(body?.value), total = num(body?.total);
  const pct = total > 0 ? Math.min(100, Math.round(value / total * 100)) : 0;
  return <div className="hw-progress"><div className="hw-progress-head"><span>{text(body?.label)}</span><b>{total > 0 ? `${value} из ${total}` : value}</b></div>
    <div className="hn-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total || 100} aria-valuenow={value}><i style={{ width: `${pct}%` }} /></div>
    {num(body?.eta_s) > 0 && <small>осталось около {Math.max(1, Math.round(num(body.eta_s) / 60))} мин</small>}</div>;
}

// One series, a 2px line; whitelist stretches as quiet bands; crosshair tooltip on hover.
function Series({ body, title }: { body: any; title: string }) {
  const raw: any[] = Array.isArray(body?.points) ? body.points.slice(-288) : [];
  const points = raw.map(p => ({ t: new Date(text(p?.[0])).getTime(), v: num(p?.[1]) })).filter(p => !Number.isNaN(p.t));
  const [hover, setHover] = useState<number>();
  const box = useRef<SVGSVGElement>(null);
  if (points.length < 2) return <p className="hw-empty">Пока мало данных для графика</p>;
  const W = 600, H = 110, top = 6, bottom = 2;
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const max = Math.max(1, ...points.map(p => p.v));
  const x = (t: number) => (t - t0) / Math.max(1, t1 - t0) * W;
  const y = (v: number) => top + (1 - v / max) * (H - top - bottom);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const bands: any[] = Array.isArray(body?.bands) ? body.bands.slice(0, 48) : [];
  const unit = text(body?.unit);
  const move = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect(); if (!r) return;
    const t = t0 + (e.clientX - r.left) / r.width * (t1 - t0);
    let best = 0; points.forEach((p, i) => { if (Math.abs(p.t - t) < Math.abs(points[best].t - t)) best = i; });
    setHover(best);
  };
  const h = hover !== undefined ? points[hover] : undefined;
  return <figure className="hw-chart">
    <svg ref={box} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title}: от ${points[0].v} до ${points[points.length - 1].v} ${unit}, максимум ${max}`} onPointerMove={move} onPointerLeave={() => setHover(undefined)}>
      {bands.map((b, i) => { const a = new Date(text(b?.from)).getTime(), z = new Date(text(b?.to)).getTime(); if (Number.isNaN(a) || Number.isNaN(z)) return null; return <rect key={i} className="hw-band" x={x(Math.max(a, t0))} y={top} width={Math.max(1, x(Math.min(z, t1)) - x(Math.max(a, t0)))} height={H - top - bottom}><title>{text(b?.label)}</title></rect>; })}
      <line className="hw-axis" x1={0} x2={W} y1={H - bottom} y2={H - bottom} />
      <path className="hw-line" d={d} vectorEffect="non-scaling-stroke" />
      {h && <><line className="hw-cross" x1={x(h.t)} x2={x(h.t)} y1={top} y2={H - bottom} vectorEffect="non-scaling-stroke" /><circle className="hw-point" cx={x(h.t)} cy={y(h.v)} r={4} vectorEffect="non-scaling-stroke" /></>}
    </svg>
    <div className="hw-bar-labels" aria-hidden="true"><span>{span(Date.now() - t0)}</span><span>{Date.now() - t1 < 15 * 60000 ? "сейчас" : hhmm(new Date(t1).toISOString())}</span></div>
    {h && <div className="hw-tip" style={{ left: `${Math.min(80, Math.max(0, x(h.t) / W * 100))}%` }}><b>{h.v} {unit}</b> · {hhmm(new Date(h.t).toISOString())}</div>}
    {bands.length > 0 && <figcaption><i className="hw-band-key" aria-hidden="true" /> {text(bands[0]?.label)}</figcaption>}
  </figure>;
}

function Bars({ body, title }: { body: any; title: string }) {
  const bars: any[] = Array.isArray(body?.bars) ? body.bars.slice(0, 24) : [];
  const [hover, setHover] = useState<number>();
  if (!bars.length) return <p className="hw-empty">Нет данных</p>;
  const max = Math.max(1, ...bars.map(b => num(b?.value)));
  const scale = (v: number) => (body?.scale === "sqrt" ? Math.sqrt(v / max) : v / max);
  const unit = text(body?.unit);
  return <figure className="hw-chart"><div className="hw-bars" role="img" aria-label={`${title}: ${bars.map(b => `${text(b?.label)} — ${num(b?.value)}`).join(", ")}`} onPointerLeave={() => setHover(undefined)}>
    {bars.map((b, i) => <div key={i} className="hw-bar-slot" onPointerEnter={() => setHover(i)}><i style={{ height: `${Math.max(2, scale(num(b?.value)) * 100)}%` }} data-active={hover === i ? "yes" : undefined} /></div>)}
  </div>
    <div className="hw-bar-labels" aria-hidden="true"><span>{text(bars[0]?.label)}</span><span>{text(bars[bars.length - 1]?.label)}</span></div>
    {hover !== undefined && <div className="hw-tip" style={{ left: `${Math.min(80, hover / bars.length * 100)}%` }}><b>{num(bars[hover]?.value)} {unit}</b> · {text(bars[hover]?.label)}</div>}
  </figure>;
}

/* ---------- a module's own widget: shadow root, own error boundary, 3 s to mount ---------- */

function CustomWidget({ item, widget, size, mode, notify }: { item?: Installed; widget: CatalogWidget; size: WidgetSize; mode: HomeMode; notify: (t: string) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const target = element.current;
    if (!target || !item) return;
    let disposed = false, cleanup: (() => void) | undefined;
    const m = item.manifest, base = moduleBase(m);
    const shadow = target.shadowRoot || target.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const links = (m.ui.css || []).map(css => { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = base + css; shadow.appendChild(link); return link; });
    const container = document.createElement("div");
    container.className = "homenet-widget-root";
    shadow.appendChild(container);
    setError("");
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("виджет не ответил за 3 с")), 3000));
    Promise.race([(async () => {
      const mod = await import(/* @vite-ignore */ base + m.ui.entry) as IntegrationModule;
      const spec = mod.widgets?.[widget.id];
      if (!spec || typeof spec.mount !== "function") throw new Error("модуль не экспортирует этот виджет");
      const unmount = await spec.mount(container, moduleHost(m, notify), { size, mode });
      if (typeof unmount !== "function") throw new Error("виджет не вернул завершение работы");
      if (disposed) unmount(); else cleanup = unmount;
    })(), timeout]).catch(e => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); });
    return () => { disposed = true; try { cleanup?.(); } catch { /* a widget failing on unmount must not break the page */ } container.remove(); links.forEach(l => l.remove()); };
  }, [item?.manifest.id, item?.manifest.version, widget.id, size, mode, attempt, notify]);
  if (!item) return <p className="hw-empty">Модуль недоступен</p>;
  return <>{error && <div className="hw-crash" role="alert"><b>Виджет не отрисовался</b><p>Ошибка в коде интеграции. Остальное на главной работает.</p>
    <div className="hn-actions"><button type="button" onClick={() => setAttempt(a => a + 1)}>Перезагрузить виджет</button><button type="button" className="hw-link" aria-expanded={details} onClick={() => setDetails(v => !v)}>Подробности ошибки</button></div>
    {details && <pre>{error}</pre>}</div>}
    <div ref={element} hidden={!!error} className="hw-custom" /></>;
}

class WidgetBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() { return this.state.error ? <div className="hw-crash" role="alert"><b>Виджет не отрисовался</b><p>{this.state.error}</p></div> : this.props.children; }
}

function footer(d: WidgetData | undefined, now: number) {
  if (!d) return { text: "нет данных", tone: "muted" };
  if (d.unavailable) return { text: `модуль ${d.unavailable}${d.fetched_at ? ` · данные ${hhmm(d.fetched_at)}` : ""}`, tone: "info" };
  if (d.stale) return { text: `${d.error || "нет ответа"}${d.fetched_at ? ` · данные ${hhmm(d.fetched_at)}` : ""}`, tone: "warn" };
  if (d.error) return { text: d.error, tone: "warn" };
  const when = d.updated_at || d.fetched_at;
  return { text: when ? `обновлено ${ago(when, now)}` : "", tone: "muted" };
}

function WidgetBody({ widget, data, size, mode, item, notify }: { widget: CatalogWidget; data?: WidgetData; size: WidgetSize; mode: HomeMode; item?: Installed; notify: (t: string) => void }) {
  if (widget.kind === "custom") return data?.unavailable ? <p className="hw-empty">Модуль {data.unavailable}</p> : <CustomWidget item={item} widget={widget} size={size} mode={mode} notify={notify} />;
  if (!data || data.body === undefined || data.body === null) return <p className="hw-empty">{data?.error ? "Данных пока нет" : "Загрузка…"}</p>;
  const b = data.body;
  switch (widget.kind) {
    case "stat": return <Stat body={b} />;
    case "status": return <Status body={b} state={data.state} />;
    case "list": return <List body={b} />;
    case "progress": return <Progress body={b} />;
    case "series": return <Series body={b} title={widget.title} />;
    case "bars": return <Bars body={b} title={widget.title} />;
    default: return null;
  }
}

/* ---------- the page ---------- */

export function Home({ installed, notify, onCatalog }: { installed: Installed[]; notify: (text: string) => void; onCatalog: () => void }) {
  const [mode, setMode] = useState<HomeMode>(readMode);
  const [reply, setReply] = useState<HomeReply>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [draft, setDraft] = useState<LayoutItem[]>();
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [dragging, setDragging] = useState<number>();
  const [over, setOver] = useState<number>();
  const [announce, setAnnounce] = useState("");
  const editing = draft !== undefined;

  const load = useCallback(async (m: HomeMode) => {
    try {
      const body = await (await request(`/api/platform/home?mode=${m}`)).json() as HomeReply;
      setReply(body); setError(""); setNow(Date.now());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* per-viewer convenience only */ } void load(mode); }, [mode, load]);
  // every 30 s while the tab is visible; not while the layout is being edited
  useEffect(() => {
    if (editing) return;
    const tick = () => { if (document.visibilityState === "visible") void load(mode); };
    const timer = setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [mode, editing, load]);

  const catalog = useMemo(() => new Map((reply?.catalog || []).map(w => [w.key, w])), [reply]);
  const byModule = useMemo(() => new Map(installed.map(i => [i.manifest.id, i])), [installed]);
  const layout = draft || reply?.layout || [];
  const legacy = (reply?.modules || []).filter(m => m.enabled && m.ui_api < 2);
  const answered = (reply?.modules || []).filter(m => m.enabled && m.ui_api >= 2);
  const fresh = answered.filter(m => m.state === "ok").length;

  const startEdit = () => { setMenu(false); setDraft([...(reply?.layout || [])]); };
  const cancelEdit = () => { setDraft(undefined); setAnnounce("Изменения отменены"); };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await request("/api/platform/home/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, items: draft }) });
      const saved = draft;
      setReply(r => r && { ...r, layout: saved, customized: true });
      setDraft(undefined); notify("Главная сохранена"); await load(mode);
    } catch (e) { notify(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };
  const reset = async () => {
    setSaving(true);
    try { await request(`/api/platform/home/layout?mode=${mode}`, { method: "DELETE" }); setDraft(undefined); notify("Возвращена стандартная главная"); await load(mode); }
    catch (e) { notify(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };
  const move = (from: number, to: number) => setDraft(list => {
    if (!list || to < 0 || to >= list.length || from === to) return list;
    const next = [...list]; const [it] = next.splice(from, 1); next.splice(to, 0, it);
    setAnnounce(`«${catalog.get(it.w)?.title || it.w}» — место ${to + 1} из ${next.length}`);
    return next;
  });
  const resize = (i: number, size: WidgetSize) => setDraft(list => list && list.map((it, n) => n === i ? { ...it, size } : it));
  const remove = (i: number) => setDraft(list => { if (!list) return list; setAnnounce(`«${catalog.get(list[i].w)?.title || list[i].w}» убран`); return list.filter((_, n) => n !== i); });
  const add = (w: CatalogWidget) => setDraft(list => { setAnnounce(`«${w.title}» добавлен в конец`); return [...(list || []), { w: w.key, size: w.sizes[0] }]; });
  const keyMove = (e: React.KeyboardEvent, i: number) => {
    if (!e.altKey) return;
    const w = catalog.get(layout[i].w);
    const k = e.key.toLowerCase();
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i, i - 1); }
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i, i + 1); }
    else if (["s", "m", "l", "ы", "ь", "д"].includes(k)) {
      const size = ({ s: "s", m: "m", l: "l", ы: "s", ь: "m", д: "l" } as Record<string, WidgetSize>)[k];
      if (w?.sizes.includes(size)) { e.preventDefault(); resize(i, size); setAnnounce(`Размер ${SIZE_LABEL[size]}`); }
    }
  };
  const changes = useMemo(() => {
    if (!draft || !reply) return "";
    const before = new Set(reply.layout.map(i => i.w)), after = new Set(draft.map(i => i.w));
    const added = draft.filter(i => !before.has(i.w)).length, removed = reply.layout.filter(i => !after.has(i.w)).length;
    const same = JSON.stringify(draft) === JSON.stringify(reply.layout);
    if (same) return "Изменений нет";
    const parts = [added && `добавлено: ${added}`, removed && `убрано: ${removed}`].filter(Boolean);
    return parts.length ? `Изменено — ${parts.join(", ")}` : "Изменены порядок или размеры";
  }, [draft, reply]);

  if (!reply) return <section className="hw-loading" aria-busy={!error}>{error ? <div className="hn-error" role="alert">Главная не загрузилась: {error} <button type="button" onClick={() => void load(mode)}>Повторить</button></div> : <p role="status">Собираю главную…</p>}</section>;

  const modules = Array.from(new Set(reply.catalog.map(w => w.module)));
  const shown = new Set(layout.map(i => i.w));
  const offer = reply.catalog.filter(w => w.modes.includes(mode) && (!filter || w.module === filter) && (!query || `${w.title} ${w.module_name}`.toLowerCase().includes(query.toLowerCase())));

  return <div className={`hw-page${editing ? " hw-editing" : ""}`}>
    <div className="hw-main">
      <div className="hw-head">
        <div><h1>{editing ? "Главная · изменение" : "Главная"}</h1>
          <p>{editing ? `Раскладка режима «${mode === "simple" ? "Просто" : "Подробно"}». Перетаскивайте за ⠿ или Alt+стрелки, размер — Alt+S/M/L.` : `обновлено ${ago(reply.generated_at, now)}${answered.length ? ` · ответили ${fresh} из ${answered.length} интеграций` : ""}`}</p></div>
        <div className="hw-tools">
          <div className="hw-seg" role="group" aria-label="Режим главной">
            {(["simple", "pro"] as HomeMode[]).map(m => <button type="button" key={m} aria-pressed={mode === m} disabled={editing} onClick={() => setMode(m)}>{m === "simple" ? "Просто" : "Подробно"}</button>)}
          </div>
          {!editing && reply.can_save && (mode === "pro"
            ? <button type="button" onClick={startEdit}>✎ Изменить</button>
            : <div className="hw-menu"><button type="button" aria-label="Ещё" aria-expanded={menu} onClick={() => setMenu(v => !v)}>⋯</button>{menu && <div role="menu"><button role="menuitem" type="button" onClick={startEdit}>Изменить главную</button></div>}</div>)}
        </div>
      </div>
      {error && <div className="hn-warning" role="alert">Не удалось обновить: {error}. Показаны данные {hhmm(reply.generated_at)}.</div>}

      {editing ? <div className="hw-note" role="note">«Требует внимания» и «Идёт сейчас» закреплены сверху — их нельзя убрать, чтобы проблема не потерялась.</div> :
        <div className="hw-top">
          <section className="hw-panel hw-attention" aria-labelledby="hw-attention-title">
            <h2 id="hw-attention-title">Требует внимания{reply.attention.length ? ` · ${reply.attention.length}` : ""}</h2>
            {reply.attention.length ? <ul>{reply.attention.map(a => <li key={`${a.module}/${a.id}`} data-stale={a.stale ? "yes" : undefined}>
              <span className="hw-sev" data-sev={a.severity} aria-label={a.severity === "critical" ? "Критично" : a.severity === "warning" ? "Предупреждение" : "Сведения"} />
              <span className="hw-src">{short(a.module, a.module_name)}</span><span className="hw-text">{a.text}</span>
              {a.action && <a href={`#/${a.action.page}`}>{a.action.label}</a>}</li>)}</ul>
              : <p className="hw-ok"><span aria-hidden="true">✓</span> Всё в порядке — интеграции не сообщают о проблемах</p>}
          </section>
          <section className={`hw-panel hw-tasks${reply.tasks.length ? " hw-active" : ""}`} aria-labelledby="hw-tasks-title">
            <h2 id="hw-tasks-title">Идёт сейчас</h2>
            {reply.tasks.length ? <ul>{reply.tasks.map(t => { const pct = t.total ? Math.min(100, Math.round((t.value || 0) / t.total * 100)) : undefined; return <li key={`${t.module}/${t.id}`}>
              <div className="hw-task-head"><span className="hw-src">{short(t.module, t.module_name)}</span><span className="hw-text">{t.label}{t.total ? ` · ${t.value || 0} из ${t.total}` : ""}{t.step ? ` · ${t.step}` : ""}</span>{pct !== undefined && <b>{pct}%</b>}</div>
              {pct !== undefined ? <div className="hn-bar" role="progressbar" aria-label={t.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div> : <div className="hn-bar hn-bar-busy" role="progressbar" aria-label={t.label}><i /></div>}
              {(t.note || t.eta_s) && <small>{t.note}{t.eta_s ? `${t.note ? " · " : ""}осталось около ${Math.max(1, Math.round(t.eta_s / 60))} мин` : ""}</small>}
              {t.cancel && <button type="button" className="hw-link" onClick={() => void request(`/api/integrations/${t.module}${t.cancel}`, { method: "POST" }).then(() => load(mode)).catch(e => notify(String(e)))}>Остановить</button>}
            </li>; })}</ul> : <p className="hw-quiet">Сейчас ничего не выполняется</p>}
          </section>
        </div>}

      <section className="hw-grid" aria-label="Виджеты">
        {layout.map((it, i) => {
          const w = catalog.get(it.w);
          if (!w) return null;
          const d = reply.data[it.w];
          const f = footer(d, now);
          const item = byModule.get(w.module);
          return <article key={it.w} className="hw-card" data-size={it.size} data-state={d?.unavailable ? "off" : d?.state || "unknown"} data-stale={d?.stale ? "yes" : undefined}
            data-drop={over === i && dragging !== undefined && dragging !== i ? "yes" : undefined}
            tabIndex={editing ? 0 : undefined} aria-label={editing ? `${w.title}, ${w.module_name}, размер ${SIZE_LABEL[it.size]}, место ${i + 1} из ${layout.length}` : undefined}
            onKeyDown={editing ? e => keyMove(e, i) : undefined}
            draggable={editing} onDragStart={editing ? e => { setDragging(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); } : undefined}
            onDragOver={editing ? e => { e.preventDefault(); setOver(i); } : undefined}
            onDrop={editing ? e => { e.preventDefault(); if (dragging !== undefined) move(dragging, i); setDragging(undefined); setOver(undefined); } : undefined}
            onDragEnd={() => { setDragging(undefined); setOver(undefined); }}>
            <header>
              {editing && <span className="hw-handle" aria-hidden="true">⠿</span>}
              <h3>{!editing && w.page ? <a href={`#/${w.page}`}>{w.title}</a> : w.title}</h3>
              <span className="hw-src">{short(w.module, w.module_name)}</span>
              {editing && <button type="button" className="hw-remove" aria-label={`Убрать «${w.title}»`} onClick={() => remove(i)}>×</button>}
            </header>
            <div className="hw-body"><WidgetBoundary key={`${it.w}:${it.size}`}><WidgetBody widget={w} data={d} size={it.size} mode={mode} item={item} notify={notify} /></WidgetBoundary></div>
            {d?.note && !editing && <p className="hw-note-line">{d.note}</p>}
            {editing ? <div className="hw-sizes" role="group" aria-label="Размер">{w.sizes.map(s => <button type="button" key={s} aria-pressed={it.size === s} onClick={() => resize(i, s)}>{SIZE_LABEL[s]}</button>)}</div>
              : w.kind !== "custom" && <footer data-tone={f.tone}>{f.text}</footer>}
          </article>;
        })}
        {!editing && legacy.map(m => <article key={m.id} className="hw-card hw-legacy" data-size="s"><header><h3>{m.name}</h3></header><p className="hw-empty">Интеграция пока без виджетов</p><footer><a className="hn-primary" href={`#/${m.page || "integrations"}`}>Открыть</a></footer></article>)}
        {!layout.length && !legacy.length && <div className="hn-empty hw-none"><h2>На главной пусто</h2><p>{reply.catalog.length ? "Добавьте виджеты интеграций в режиме «Изменить»." : "Установленные интеграции пока не дают виджетов."}</p>
          {reply.catalog.length ? (!editing && reply.can_save && <button type="button" className="hn-primary" onClick={startEdit}>Изменить главную</button>) : <button type="button" onClick={onCatalog}>Открыть интеграции</button>}</div>}
      </section>

      {editing && <div className="hw-savebar" role="region" aria-label="Сохранение раскладки">
        <span>{changes}</span>
        <button type="button" className="hw-link" disabled={saving} onClick={() => void reset()}>Сбросить к стандартной</button>
        <button type="button" disabled={saving} onClick={cancelEdit}>Отмена</button>
        <button type="button" className="hn-primary" disabled={saving} onClick={() => void save()}>{saving ? "Сохраняю…" : "Сохранить"}</button>
      </div>}
      <div className="sr-only" aria-live="polite">{announce}</div>
    </div>

    {editing && <aside className="hw-catalog" aria-label="Каталог виджетов">
      <h2>Каталог виджетов</h2>
      <label>Найти<input type="search" value={query} placeholder="«серверы», «канал»…" onChange={e => setQuery(e.target.value)} /></label>
      <div className="hw-filters" role="group" aria-label="Интеграция">
        <button type="button" aria-pressed={!filter} onClick={() => setFilter("")}>Все</button>
        {modules.map(id => { const n = reply.catalog.filter(w => w.module === id && w.modes.includes(mode)).length; return <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{reply.catalog.find(w => w.module === id)?.module_name} · {n}</button>; })}
      </div>
      {offer.length ? <ul>{offer.map(w => <li key={w.key}><span><b>{w.title}</b><small>{w.module_name} · {KIND_LABEL[w.kind]} · {w.sizes.map(s => SIZE_LABEL[s]).join(", ")} · {w.modes.length > 1 ? "оба режима" : w.modes[0] === "simple" ? "Просто" : "Подробно"}</small></span>
        {shown.has(w.key) ? <span className="hw-placed">на главной</span> : <button type="button" onClick={() => add(w)}>Добавить</button>}</li>)}</ul> : <p className="hw-quiet">Ничего не нашлось</p>}
    </aside>}
  </div>;
}
