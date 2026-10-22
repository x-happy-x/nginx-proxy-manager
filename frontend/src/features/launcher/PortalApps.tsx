import { useEffect, useMemo, useRef, useState } from "react";
import { fetchLauncher, fetchResources, saveLauncher, type AppGroupUsage, type LauncherConfig, type SystemSnapshot } from "../../api";
import { artFor } from "./art";
import { defaultLauncher, OTHER_DEVICE, slug, type LauncherItem } from "./model";
import { containerLabel, deviceLoad, guestLabel, placedDevice, placeOf, placeSteps, unlistedContainers, type Found, type Load, type PlaceContainer, type Placement, type PlacementData } from "./placement";
import { LogsDialog } from "./LogsDialog";

// NPM-85: the app list of the portal, after mock-up A2 — summary, frequent apps,
// device tabs and cards in the style of Account. Administrators also see where
// each app runs, its state, access and source; other users only their apps.

export type Mode = "admin" | "users" | "public";
export type Rule = { mode: Mode; users: string[]; ip_url?: string; domain_url?: string };
export type Policy = { apps: Record<string, Rule> };
export type Probe = { ok: boolean; ms: number; since?: number; exact?: boolean };

const OPENS_KEY = "homenet.portal.opens";
const VIEW_KEY = "homenet.portal.view";

export function plural(n: number, forms: [string, string, string]) {
  const a = Math.abs(n) % 100;
  const l = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (l > 1 && l < 5) return forms[1];
  if (l === 1) return forms[0];
  return forms[2];
}

const APPS: [string, string, string] = ["приложение", "приложения", "приложений"];

function readJSON<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) || "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* per-browser convenience */
  }
}

export function hostOf(url?: string) {
  if (!url) return "";
  try {
    return new URL(url, location.origin).host;
  } catch {
    return url;
  }
}

export const idOf = (key: string) => (key.startsWith("app:") ? key.slice(4) : key);

export function Svg({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const P = {
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-3.5-3.5",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  warn: "M12 4 2.5 20h19zM12 10v4M12 17h.01",
  vm: "m12 3 8 4.5v9L12 21l-8-4.5v-9ZM4 7.5l8 4.5 8-4.5M12 12v9",
  box: "M3 7h18v12H3zM7 7V5h10v2M7 11h.01M11 11h.01M15 11h.01",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  git: "M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM6 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM18 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM6 8.5v7M18 10.5a7 7 0 0 1-7 7H8.5",
  home: "M4 11 12 4l8 7v9H4zM10 20v-5h4v5",
  ext: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  cpu: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  logs: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  pc: "M3 4h18v12H3zM8.5 20h7M12 16v4",
};

/** «12 мин», «3 ч 5 мин», «2 дн» */
export function duration(sec: number) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

/** How long an app has not answered, from Core's own checks (NPM-86). */
export function downFor(p: Probe | undefined, now = Date.now() / 1000) {
  if (!p || p.ok || !p.since) return "";
  if (p.exact) return `${duration(now - p.since)}`;
  const at = new Date(p.since * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `замечено в ${at}`;
}

const pct = (used?: number, total?: number) => (used && total ? Math.round((used / total) * 100) : undefined);

/** CPU, memory and temperature as short pills; warn from 85 %. */
export function loadParts(load?: Load) {
  if (!load) return [];
  const parts: { text: string; warn: boolean }[] = [];
  if (typeof load.cpu === "number") parts.push({ text: `CPU ${Math.round(load.cpu)}%`, warn: load.cpu >= 85 });
  const mem = pct(load.mem_used, load.mem_total);
  if (mem !== undefined) parts.push({ text: `RAM ${mem}%`, warn: mem >= 85 });
  if (typeof load.temp === "number" && load.temp > 0) parts.push({ text: `${Math.round(load.temp)} °C`, warn: load.temp >= 80 });
  return parts;
}

/** The busiest of CPU and memory, for the bars in the side menu. */
export function loadLevel(load?: Load) {
  if (!load) return undefined;
  const values = [typeof load.cpu === "number" ? load.cpu : undefined, pct(load.mem_used, load.mem_total)].filter((v): v is number => v !== undefined);
  return values.length ? Math.max(...values) : undefined;
}

/** Load of each launcher device: the router from its own resources, others from the modules. */
export function useDeviceLoads(cfg: LauncherConfig, placement: PlacementData | null, router: SystemSnapshot | null) {
  return useMemo(() => {
    const out: Record<string, Load | undefined> = {};
    for (const d of cfg.devices) {
      out[d.id] = d.kind === "router" && router ? { cpu: router.cpu, mem_used: router.mem_used, mem_total: router.mem_total, temp: router.temp_max } : deviceLoad(d.addresses, placement);
    }
    return out;
  }, [cfg.devices, placement, router]);
}

/** The app's line icon on a colored tile; the hue comes from its artwork, like the icons in Account. */
export function AppTile({ item, size = 48 }: { item: LauncherItem; size?: number }) {
  const spec = artFor(item.art, item.title, ...item.hints);
  return (
    <span className="hp-tile" style={{ width: size, height: size, borderRadius: Math.round(size * 0.29), ["--hue" as string]: String(spec.hue) }} aria-hidden="true">
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {spec.icon}
      </svg>
    </span>
  );
}

function accessBadge(rule: Rule | undefined) {
  const mode = rule?.mode || "admin";
  if (mode === "public") return { cls: "is-public", text: "Открыто всем" };
  if (mode === "users") {
    const n = rule?.users.length || 0;
    return { cls: "is-users", text: n ? `${n} ${plural(n, ["пользователь", "пользователя", "пользователей"])}` : "Выбранные" };
  }
  return { cls: "is-admin", text: "Только админы" };
}

function bytes(n: number) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} ГБ`;
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} МБ`;
  return `${Math.round(n / 1024)} КБ`;
}

type Ctx = {
  admin: boolean;
  status: Record<string, Probe>;
  policy: Policy | null;
  places: Map<string, Placement | undefined>;
  usage: (item: LauncherItem) => AppGroupUsage | undefined;
  remember: (key: string) => void;
  placement: PlacementData | null;
  showLogs: (c: PlaceContainer) => void;
};

function Where({ item, ctx }: { item: LauncherItem; ctx: Ctx }) {
  const place = ctx.places.get(item.key);
  const usage = ctx.usage(item);
  const chips: { icon: string; text: string; title?: string }[] = [];
  if (place?.vm) chips.push({ icon: P.vm, text: guestLabel(place.vm), title: `${place.vm.type === "lxc" ? "Контейнер LXC" : "Виртуальная машина"} на сервере ${place.server}` });
  else if (place) chips.push({ icon: P.server, text: place.server });
  if (place?.container) chips.push({ icon: P.box, text: containerLabel(place.container), title: `${place.container.image} — ${place.container.status}` });
  if (!place && usage) chips.push({ icon: P.cpu, text: `CPU ${usage.cpu >= 10 ? Math.round(usage.cpu) : usage.cpu.toFixed(1)}% · ${bytes(usage.rss)}`, title: `Процессы на роутере: ${usage.name}` });
  if (!chips.length) return null;
  return (
    <div className="hp-where">
      {chips.map((c) => (
        <span key={c.text} title={c.title}>
          <Svg d={c.icon} size={13} />
          {c.text}
        </span>
      ))}
    </div>
  );
}

// The card's «⋯»: logs of its container, its VM and container in the modules, its address.
function CardMenu({ item, ctx }: { item: LauncherItem; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const place = ctx.places.get(item.key);
  const c = place?.container;
  const host = c ? ctx.placement?.hosts.find((h) => h.id === c.host) : undefined;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const copy = () => {
    void navigator.clipboard?.writeText(item.primary).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span className="hp-menu-wrap" ref={ref}>
      <button type="button" className="hp-icon" aria-label={`Ещё: ${item.title}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Svg d={P.dots} size={18} />
      </button>
      {open ? (
        <span className="hp-menu" role="menu">
          {c ? (
            <button type="button" role="menuitem" disabled={host?.logs === false} title={host?.logs === false ? "Агент на этом компьютере не отдаёт логи" : undefined} onClick={() => { setOpen(false); ctx.showLogs(c); }}>
              <Svg d={P.logs} size={16} />
              Логи контейнера
            </button>
          ) : null}
          {place?.vm ? (
            <a role="menuitem" href="#/pveguests">
              <Svg d={P.vm} size={16} />
              {guestLabel(place.vm)} в «Серверах»
            </a>
          ) : null}
          {c ? (
            <a role="menuitem" href="#/pcdocker">
              <Svg d={P.box} size={16} />
              Docker на {c.host_name}
            </a>
          ) : null}
          <button type="button" role="menuitem" onClick={copy}>
            <Svg d={P.copy} size={16} />
            {copied ? "Скопировано" : "Скопировать адрес"}
          </button>
        </span>
      ) : null}
    </span>
  );
}

function AppCard({ item, ctx }: { item: LauncherItem; ctx: Ctx }) {
  const probe = item.probe ? ctx.status[item.probe] : undefined;
  const place = ctx.places.get(item.key);
  const stopped = place?.container && place.container.state !== "running";
  const down = probe ? !probe.ok : false;
  const lan = item.direct && item.direct !== item.primary ? item.direct : undefined;
  const badge = ctx.policy ? accessBadge(ctx.policy.apps[idOf(item.key)]) : null;
  const open = () => ctx.remember(item.key);
  return (
    <article className={`hp-card${down ? " is-down" : ""}`}>
      <a className="hp-hit" href={item.primary} onClick={open} aria-label={`Открыть ${item.title}`} />
      <div className="hp-card-head">
        <AppTile item={item} />
        <div className="hp-card-title">
          <strong>
            {item.title}
            {probe ? <i className={`hp-dot${down ? " is-down" : ""}`} title={down ? "Не отвечает" : `Работает · ${probe.ms} мс`} /> : null}
          </strong>
          <span>{hostOf(item.public || item.primary)}</span>
        </div>
        <span className="hp-card-tools">
          {ctx.admin && item.repo ? (
            <a className="hp-icon" href={item.repo} target="_blank" rel="noopener noreferrer" title={`Исходный код: ${item.repo}`} aria-label="Исходный код">
              <Svg d={P.git} size={16} />
            </a>
          ) : null}
          {lan ? (
            <a className="hp-icon" href={lan} onClick={open} title={`В домашней сети: ${lan}`} aria-label="Открыть в домашней сети">
              <Svg d={P.home} size={16} />
            </a>
          ) : null}
          {ctx.admin ? <CardMenu item={item} ctx={ctx} /> : null}
        </span>
      </div>
      {item.about ? <p className="hp-about">{item.about}</p> : null}
      {down || stopped ? (
        <div className="hp-alert" role="status">
          <Svg d={P.warn} size={15} />
          {down ? `Не отвечает${downFor(probe) ? ` · ${downFor(probe)}` : ""}` : "Работает"}
          {stopped ? ` · контейнер ${place!.container!.state === "exited" ? "остановлен" : place!.container!.state}` : ""}
        </div>
      ) : null}
      {ctx.admin ? <Where item={item} ctx={ctx} /> : null}
      <div className="hp-card-foot">
        {badge ? <span className={`hp-badge ${badge.cls}`}>{badge.text}</span> : null}
        <span className="hp-grow" />
        <a className="hp-open" href={item.primary} onClick={open}>
          Открыть
          <Svg d={P.ext} size={15} />
        </a>
      </div>
    </article>
  );
}

function FoundBlock({ found, devices, onChanged }: { found: Found[]; devices: LauncherConfig["devices"]; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const change = async (f: Found, add: boolean) => {
    setBusy(f.key);
    setMsg("");
    try {
      const cfg = (await fetchLauncher()) || defaultLauncher();
      cfg.links ||= [];
      cfg.order ||= [];
      if (add) {
        const id = slug(f.container.name);
        cfg.links.push({ id, title: f.container.name, url: f.url, device: placedDevice(f.place, devices), description: f.container.image.replace(/:[0-9a-f]{12,}$/, ""), upstream: f.key });
        cfg.order.push("link:" + id);
      } else {
        cfg.dismissed = [...(cfg.dismissed || []), f.key];
      }
      await saveLauncher(cfg);
      onChanged();
    } catch (e) {
      setMsg(`Не сохранилось: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="hp-found" id="found">
      <div className="hp-found-head">
        <span className="hp-found-ico">
          <Svg d={P.box} />
        </span>
        <div>
          <strong>Найдено на серверах</strong>
          <small>Контейнеры с открытым портом, которых нет в списке</small>
        </div>
      </div>
      {msg ? <p className="hp-error" role="alert">{msg}</p> : null}
      {found.map((f) => (
        <div key={f.key} className="hp-found-row">
          <span className="hp-found-tile">?</span>
          <div>
            <strong>{f.container.name}</strong>
            <small>{[...(f.place ? placeSteps(f.place).slice(0, -1) : []), `:${f.port}`, f.container.image.replace(/:[0-9a-f]{12,}$/, "")].join(" · ")}</small>
          </div>
          <a className="hp-btn" href={f.url} target="_blank" rel="noopener noreferrer">
            Открыть
          </a>
          <button type="button" className="hp-btn is-primary" disabled={!!busy} onClick={() => void change(f, true)}>
            {busy === f.key ? "…" : "Добавить"}
          </button>
          <button type="button" className="hp-btn is-quiet" disabled={!!busy} onClick={() => void change(f, false)} title="Больше не предлагать">
            Скрыть
          </button>
        </div>
      ))}
    </section>
  );
}

/** The router's own resources (CPU, memory, processes by port), refreshed every minute. */
export function useRouterNow(enabled: boolean) {
  const [now, setNow] = useState<SystemSnapshot | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const pull = () =>
      fetchResources(4e9)
        .then((r) => alive && setNow(r.now))
        .catch(() => undefined);
    void pull();
    const t = setInterval(() => document.visibilityState === "visible" && void pull(), 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return now;
}

/** Live CPU/RAM of router processes by listening port, for apps served by the router itself. */
function useRouterUsage(router: SystemSnapshot | null, routerAddrs: string[]) {
  return useMemo(() => {
    const byPort = new Map<number, AppGroupUsage>();
    for (const g of router?.apps || []) for (const port of g.ports) byPort.set(port, g);
    const addrs = new Set(routerAddrs);
    return (item: LauncherItem) => {
      if (!item.probe) return undefined;
      const i = item.probe.lastIndexOf(":");
      return addrs.has(item.probe.slice(0, i)) ? byPort.get(Number(item.probe.slice(i + 1))) : undefined;
    };
  }, [router, routerAddrs]);
}

export type AppsProps = {
  items: LauncherItem[];
  cfg: LauncherConfig;
  admin: boolean;
  name: string;
  status: Record<string, Probe>;
  policy: Policy | null;
  placement: PlacementData | null;
  router: SystemSnapshot | null;
  device: string;
  setDevice: (d: string) => void;
  onChanged: () => void;
};

export function deviceList(cfg: LauncherConfig) {
  return [...cfg.devices, { id: OTHER_DEVICE, name: "Другие устройства", kind: "other", note: "", addresses: [] }];
}

/** Items with the device an unlisted address belongs to, judged by its Proxmox server. */
export function usePlacedItems(listed: LauncherItem[], cfg: LauncherConfig, placement: PlacementData | null) {
  const places = useMemo(() => new Map(listed.map((i) => [i.key, placeOf(i.probe, placement)])), [listed, placement]);
  const items = useMemo(
    () => listed.map((i) => (i.device === OTHER_DEVICE && places.get(i.key) ? { ...i, device: placedDevice(places.get(i.key), cfg.devices) } : i)),
    [listed, places, cfg.devices],
  );
  return { items, places };
}

export function PortalApps({ items: listed, cfg, admin, name, status, policy, placement, router, device, setDevice, onChanged }: AppsProps) {
  const [query, setQuery] = useState("");
  const [onlyDown, setOnlyDown] = useState(false);
  const [view, setViewState] = useState<"cards" | "list">(() => (readJSON<string>(VIEW_KEY, "cards") === "list" ? "list" : "cards"));
  const [opens, setOpens] = useState<Record<string, number>>(() => readJSON(OPENS_KEY, {}));
  const search = useRef<HTMLInputElement>(null);
  const setView = (v: "cards" | "list") => {
    setViewState(v);
    writeJSON(VIEW_KEY, v);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const { items, places } = usePlacedItems(listed, cfg, placement);
  const routerAddrs = useMemo(() => cfg.devices.find((d) => d.kind === "router")?.addresses || [], [cfg.devices]);
  const usage = useRouterUsage(router, routerAddrs);
  const loads = useDeviceLoads(cfg, placement, router);
  const [logsOf, setLogsOf] = useState<PlaceContainer | null>(null);
  const remember = (key: string) => {
    const next = { ...opens, [key]: (opens[key] || 0) + 1 };
    setOpens(next);
    writeJSON(OPENS_KEY, next);
  };
  const ctx: Ctx = { admin, status, policy, places, usage, remember, placement, showLogs: setLogsOf };

  const devices = deviceList(cfg);
  const isDown = (i: LauncherItem) => !!(i.probe && status[i.probe] && !status[i.probe].ok);
  const q = query.trim().toLowerCase();
  const match = (i: LauncherItem) => {
    if (!q) return true;
    const p = places.get(i.key);
    return [i.title, i.description, i.about || "", ...i.hints, p?.vm?.name || "", p?.container?.name || ""].join(" ").toLowerCase().includes(q);
  };
  const visible = items.filter((i) => (!device || i.device === device) && (!onlyDown || isDown(i)) && match(i));
  const groups = devices.map((d) => ({ d, apps: visible.filter((i) => i.device === d.id) })).filter((g) => g.apps.length);
  const counts = (id: string) => items.filter((i) => i.device === id).length;
  const used = devices.filter((d) => counts(d.id));
  const probed = items.filter((i) => i.probe && status[i.probe]);
  const down = items.filter(isDown);
  const vms = placement?.machines || [];
  const found = useMemo(() => unlistedContainers(placement, new Set(items.map((i) => i.probe).filter(Boolean) as string[]), cfg.dismissed), [placement, items, cfg.dismissed]);
  const pinned = Object.entries(opens)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => items.find((i) => i.key === k))
    .filter(Boolean)
    .slice(0, 6) as LauncherItem[];
  const first = name.split(/\s+/)[0];
  const browsing = !q && !device && !onlyDown;

  return (
    <main className="hp-main">
      <section className="hp-top">
        <div>
          <h1>{first ? `Здравствуйте, ${first}` : "Приложения"}</h1>
          <p>
            {admin
              ? `${items.length} ${plural(items.length, APPS)} на ${used.length} ${plural(used.length, ["устройстве", "устройствах", "устройствах"])}`
              : `${items.length} ${plural(items.length, APPS)} ${items.length % 10 === 1 && items.length % 100 !== 11 ? "доступно" : "доступны"} вам`}
          </p>
        </div>
        <label className="hp-search">
          <Svg d={P.search} />
          <input ref={search} type="search" placeholder={admin ? "Найти приложение, домен или контейнер" : "Найти приложение"} aria-label="Поиск приложений" value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd>/</kbd>
        </label>
      </section>

      {admin && probed.length ? (
        <section className="hp-stats" aria-label="Сводка">
          <button type="button" className="hp-stat is-ok" onClick={() => setOnlyDown(false)}>
            <span className="hp-stat-ico"><Svg d={P.pulse} /></span>
            <span><b>{probed.length - down.length}</b><small>работают</small></span>
          </button>
          <button type="button" className={`hp-stat${down.length ? " is-bad" : ""}`} aria-pressed={onlyDown} onClick={() => down.length && setOnlyDown(!onlyDown)}>
            <span className="hp-stat-ico"><Svg d={P.warn} /></span>
            <span><b>{down.length}</b><small>{down.length ? `не ${down.length === 1 ? "отвечает" : "отвечают"} · ${down.slice(0, 2).map((i) => i.title).join(", ")}` : "все отвечают"}</small></span>
          </button>
          {vms.length ? (
            <a className="hp-stat is-vm" href="#/pveguests">
              <span className="hp-stat-ico"><Svg d={P.vm} /></span>
              <span><b>{vms.filter((m) => m.status === "running").length}</b><small>VM запущено из {vms.length}</small></span>
            </a>
          ) : null}
          {placement ? (
            <a className="hp-stat is-found" href="#found" onClick={(e) => { e.preventDefault(); document.getElementById("found")?.scrollIntoView({ behavior: "smooth" }); }}>
              <span className="hp-stat-ico"><Svg d={P.box} /></span>
              <span><b>{found.length}</b><small>{found.length ? "найдено, не в списке" : "все контейнеры в списке"}</small></span>
            </a>
          ) : null}
        </section>
      ) : null}

      {pinned.length && browsing ? (
        <section className="hp-pins">
          <h2>Часто открываете</h2>
          <div>
            {pinned.map((i) => (
              <a key={i.key} className="hp-pin" href={i.primary} onClick={() => remember(i.key)}>
                <AppTile item={i} size={30} />
                {i.title}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {admin ? (
        <nav className="hp-tabs" aria-label="Устройства">
          <button type="button" className={!device && !onlyDown ? "is-on" : ""} aria-pressed={!device && !onlyDown} onClick={() => { setDevice(""); setOnlyDown(false); }}>
            Все <span>{items.length}</span>
          </button>
          {used.length > 1
            ? used.map((d) => (
                <button key={d.id} type="button" className={device === d.id ? "is-on" : ""} aria-pressed={device === d.id} onClick={() => setDevice(device === d.id ? "" : d.id)}>
                  {d.name} <span>{counts(d.id)}</span>
                </button>
              ))
            : null}
          {down.length ? (
            <button type="button" className={`is-bad${onlyDown ? " is-on" : ""}`} aria-pressed={onlyDown} onClick={() => setOnlyDown(!onlyDown)}>
              Не отвечают <span>{down.length}</span>
            </button>
          ) : null}
          <span className="hp-grow" />
          <span className="hp-view" role="radiogroup" aria-label="Вид">
            <button type="button" role="radio" aria-checked={view === "cards"} className={view === "cards" ? "is-on" : ""} onClick={() => setView("cards")}>Карточки</button>
            <button type="button" role="radio" aria-checked={view === "list"} className={view === "list" ? "is-on" : ""} onClick={() => setView("list")}>Список</button>
          </span>
        </nav>
      ) : null}

      {/* other users get one plain grid: servers are not their concern */}
      {!admin && visible.length ? (
        <div className="hp-grid hp-user-grid">
          {visible.map((i) => (
            <AppCard key={i.key} item={i} ctx={ctx} />
          ))}
        </div>
      ) : null}

      {admin && groups.map(({ d, apps }) => {
        const dDown = apps.filter(isDown).length;
        return (
          <section key={d.id} className="hp-section">
            <header className="hp-section-head">
              <span className="hp-section-ico"><Svg d={P.server} /></span>
              <div>
                <h2>{d.name}</h2>
                {d.note ? <small>{d.note}</small> : null}
              </div>
              <span className="hp-grow" />
              {admin ? loadParts(loads[d.id]).map((p) => <span key={p.text} className={`hp-pill${p.warn ? " is-warn" : ""}`}>{p.text}</span>) : null}
              <span className="hp-pill">{apps.length} {plural(apps.length, APPS)}</span>
              {admin && dDown ? <span className="hp-pill is-bad">{dDown} не {dDown === 1 ? "отвечает" : "отвечают"}</span> : null}
            </header>
            <div className={view === "list" ? "hp-list" : "hp-grid"}>
              {apps.map((i) => (
                <AppCard key={i.key} item={i} ctx={ctx} />
              ))}
            </div>
          </section>
        );
      })}

      {!groups.length ? (
        <div className="hp-empty">
          <strong>{items.length ? "Ничего не нашлось" : "Пока нет доступных приложений"}</strong>
          <span>{items.length ? "Измените запрос или фильтр." : "Попросите администратора HomeNet открыть вам доступ."}</span>
        </div>
      ) : null}

      {admin && found.length && browsing ? <FoundBlock found={found} devices={cfg.devices} onChanged={onChanged} /> : null}
      {logsOf ? <LogsDialog container={logsOf} onClose={() => setLogsOf(null)} /> : null}
      {admin && probed.length ? <p className="hp-foot">Состояние — проверка порта приложения с роутера раз в минуту. Домен работает отовсюду, значок дома — адрес в домашней сети.</p> : null}
    </main>
  );
}
