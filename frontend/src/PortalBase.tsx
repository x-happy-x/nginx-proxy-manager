import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import { buildItems, defaultLauncher, type LauncherItem } from "./features/launcher/model";
import { usePlacement } from "./features/launcher/placement";
import { useSystemItems } from "./features/launcher/system";
import { AppTile, deviceList, loadLevel, loadParts, PortalApps, useDeviceLoads, usePlacedItems, useRouterNow } from "./features/launcher/PortalApps";
import "./styles/portal-home.css";
import type { LauncherConfig } from "./api";
import type { RoutesDocument } from "./types";
import "./styles/portal.css";

type Mode = "admin" | "users" | "public";
type Rule = { mode: Mode; users: string[]; ip_url?: string; domain_url?: string };
type Policy = { apps: Record<string, Rule> };
type Data = { login: string; admin: boolean; doc: RoutesDocument; launcher: LauncherConfig | null; links: Record<string, Rule> };
type Probe = { ok: boolean; ms: number; since?: number; exact?: boolean };

const OPENS_KEY = "homenet.portal.opens";
const MODE_LABEL: Record<Mode, string> = { admin: "Админы", users: "Выбранные", public: "Все" };
const ACCESS_BADGE: Record<Mode, string> = { admin: "Админы", users: "Пользователи", public: "Открыто" };

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new HttpError(r.status);
  return r.json();
}

function readOpens(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(OPENS_KEY) || "{}");
  } catch {
    return {};
  }
}

function hostLabel(url?: string) {
  if (!url) return "";
  try {
    const u = new URL(url, location.origin);
    const first = u.hostname.split(".")[0];
    return /^\d+$/.test(first) ? u.host : first;
  } catch {
    return url;
  }
}

function idOf(key: string) {
  return key.startsWith("app:") ? key.slice(4) : key;
}

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const I = {
  brand: "M8 19h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6M6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-3.5-3.5",
  lock: "M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Zm2 0V7a4 4 0 0 1 8 0v4",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 12h2m12 0h2M12 4v2m0 12v2M6.3 6.3l1.4 1.4m8.6 8.6 1.4 1.4m0-11.4-1.4 1.4m-8.6 8.6-1.4 1.4",
  arrow: "M5 12h14M13 6l6 6-6 6",
  back: "M19 12H5M11 18l-6-6 6-6",
  down: "m6 9 6 6 6-6",
  chevron: "m9 6 6 6-6 6",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  apps: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  pc: "M3 4h18v12H3zM8.5 20h7M12 16v4",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z",
};


function Brand() {
  return (
    <a className="pt-brand" href="/">
      <span className="pt-brand-mark">
        <Icon d={I.brand} />
      </span>
      <span className="pt-brand-name">
        <strong>HomeNet</strong>
        <small>Домашняя сеть</small>
      </span>
    </a>
  );
}

type View = "apps" | "access" | "manage";

function viewFromHash(): View {
  const h = location.hash;
  if (h === "#access") return "access";
  if (h.startsWith("#/")) return "manage";
  return "apps";
}

export default function PortalBase({ Console }: { Console: ComponentType<{onPortal: () => void}> }) {
  const [data, setData] = useState<Data | null>(null);
  const [guest, setGuest] = useState(false);
  const [error, setError] = useState("");
  // The address keeps the screen across reloads: #/<page> is the router console, #access the access table.
  const [view, setViewState] = useState<View>(viewFromHash);
  const setView = (next: View) => {
    setViewState(next);
    const want = next === "access" ? "#access" : next === "manage" ? (location.hash.startsWith("#/") ? location.hash : "#/overview") : "";
    if (location.hash !== want) history.pushState(null, "", want || location.pathname + location.search);
  };
  useEffect(() => {
    const sync = () => setViewState(viewFromHash());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [status, setStatus] = useState<Record<string, Probe>>({});
  const placement = usePlacement(!!data?.admin);
  const router = useRouterNow(!!data?.admin);

  const load = useCallback(() => {
    setError("");
    return get<Data>("/api/portal")
      .then((d) => {
        setData(d);
        setGuest(!d.login && !d.admin);
      })
      .catch((e) => {
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) setGuest(true);
        else setError(e instanceof HttpError ? `HomeNet не ответил (${e.status}). Обновите страницу через минуту.` : "Нет связи с роутером.");
      });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const cfg = useMemo(() => data?.launcher || defaultLauncher(), [data]);
  const systemItems = useSystemItems(!!data?.admin, cfg);
  const items = useMemo(() => (data ? buildItems(data.doc, cfg, data.links).filter((i) => !i.hidden && i.key !== "app:homenet") : []), [data]);

  // Admins see policy badges and reachability; other users only their list.
  useEffect(() => {
    if (!data?.admin) return;
    get<Policy>("/api/access").then(setPolicy).catch(() => setPolicy({ apps: {} }));
    const probes = [...new Set([...items, ...systemItems].map((i) => i.probe).filter(Boolean) as string[])];
    if (!probes.length) return;
    const pull = () =>
      fetch("/api/launcher/status?" + probes.map((t) => "t=" + encodeURIComponent(t)).join("&"))
        .then((r) => (r.ok ? r.json() : null))
        .then((r) => r?.status && setStatus(r.status))
        .catch(() => undefined);
    void pull();
    const t = setInterval(() => document.visibilityState === "visible" && void pull(), 60000);
    return () => clearInterval(t);
  }, [data?.admin, items, systemItems]);

  // NPM-85: the signed-in user's name from Account, for the greeting (administrators can list users)
  const [name, setName] = useState("");
  useEffect(() => {
    if (!data?.admin) return;
    get<{ users: { login: string; name: string }[] }>("/api/access/users")
      .then((u) => setName(u.users?.find((x) => x.login === data.login)?.name || ""))
      .catch(() => undefined);
  }, [data?.admin, data?.login]);
  const [device, setDevice] = useState("");

  if (view === "manage" && data?.admin)
    return <Console onPortal={() => setView("apps")} />;

  if (guest) return <Guest />;

  const admin = !!data?.admin;
  const goApps = (d = "") => {
    setDevice(d);
    setView("apps");
  };
  return (
    <div className="hp">
      <aside className="hp-side">
        <Brand />
        <nav className="hp-nav" aria-label="Разделы">
          <button type="button" className={view === "apps" ? "is-on" : ""} onClick={() => goApps()}>
            <Icon d={I.apps} />
            Приложения
            <em>{items.length + systemItems.length || ""}</em>
          </button>
          {admin ? (
            <>
              <a href="#/pve">
                <Icon d={I.server} />
                Серверы и VM
              </a>
              <a href="#/pc">
                <Icon d={I.pc} />
                Компьютеры
              </a>
              <button type="button" className={view === "access" ? "is-on" : ""} onClick={() => setView("access")}>
                <Icon d={I.lock} />
                Доступы
              </button>
              <a href="#/overview">
                <Icon d={I.gear} />
                Управление роутером
              </a>
            </>
          ) : null}
        </nav>
        {admin && data ? <SideDevices items={items} cfg={cfg} placement={placement} router={router} status={status} device={view === "apps" ? device : ""} onPick={goApps} /> : null}
        <span className="pt-grow" />
        {data ? <AccountMenu login={data.login} name={name} admin={admin} /> : null}
      </aside>
      <div className="hp-body">
        <header className="hp-mobile">
          <Brand />
          <span className="pt-grow" />
          {admin ? (
            <>
              <button type="button" className={`hp-mobile-btn${view === "access" ? " is-on" : ""}`} aria-label="Доступы" onClick={() => setView(view === "access" ? "apps" : "access")}>
                <Icon d={I.lock} size={16} />
              </button>
              <a className="hp-mobile-btn" href="#/overview" aria-label="Управление роутером">
                <Icon d={I.gear} size={16} />
              </a>
            </>
          ) : null}
          {data ? <AccountMenu login={data.login} name={name} admin={admin} /> : null}
        </header>
        {error ? (
          <main className="pt-main">
            <div className="pt-notice" role="alert">
              <strong>Не удалось загрузить приложения</strong>
              <span>{error}</span>
              <button type="button" className="pt-btn" onClick={() => void load()}>
                Повторить
              </button>
            </div>
          </main>
        ) : !data ? (
          <main className="pt-main">
            <p className="pt-muted">Загружаю приложения…</p>
          </main>
        ) : view === "access" && data.admin ? (
          <Access items={items} cfg={cfg} policy={policy} onSaved={(p) => { setPolicy(p); void load(); }} onBack={() => setView("apps")} />
        ) : (
          <PortalApps items={items} cfg={cfg} admin={admin} name={name} status={status} policy={admin ? policy : null} placement={admin ? placement : null} router={admin ? router : null} device={device} setDevice={setDevice} onChanged={() => void load()} />
        )}
      </div>
    </div>
  );
}

// Devices in the side menu: app count and a red mark when something there does not answer.
function SideDevices({ items: listed, cfg, placement, router, status, device, onPick }: { items: LauncherItem[]; cfg: LauncherConfig; placement: ReturnType<typeof usePlacement>; router: ReturnType<typeof useRouterNow>; status: Record<string, Probe>; device: string; onPick: (d: string) => void }) {
  const system = useSystemItems(true, cfg);
  const { items } = usePlacedItems(useMemo(() => [...listed, ...system], [listed, system]), cfg, placement);
  const loads = useDeviceLoads(cfg, placement, router);
  const rows = deviceList(cfg)
    .map((d) => ({ d, apps: items.filter((i) => i.device === d.id) }))
    .filter((r) => r.apps.length);
  if (rows.length < 2) return null;
  return (
    <div className="hp-devices">
      <h2>Устройства</h2>
      {rows.map(({ d, apps }) => {
        const down = apps.filter((i) => i.probe && status[i.probe] && !status[i.probe].ok).length;
        const level = loadLevel(loads[d.id]);
        const parts = loadParts(loads[d.id]).map((p) => p.text).join(" · ");
        return (
          <button key={d.id} type="button" className={device === d.id ? "is-on" : ""} onClick={() => onPick(device === d.id ? "" : d.id)} title={[d.note || d.name, parts].filter(Boolean).join("\n")}>
            <i className={down ? "is-bad" : ""} />
            <span className="hp-devices-name">{d.name}</span>
            {level !== undefined ? (
              <span className="hp-bar" aria-label={parts}>
                <b className={level >= 85 ? "is-warn" : ""} style={{ width: `${Math.max(4, Math.min(100, level))}%` }} />
              </span>
            ) : null}
            <em>{apps.length}</em>
          </button>
        );
      })}
    </div>
  );
}

function readTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

// Account, theme and sign-out at the bottom of the side menu; the menu opens upwards.
function AccountMenu({ login, name, admin }: { login: string; name: string; admin: boolean }) {
  const [open, setOpen] = useState(false);
  const [theme, setThemeState] = useState(readTheme);
  const [at, setAt] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const toggle = (button: HTMLElement) => {
    // fixed to the viewport: the menu floats over the page and never moves the side panel
    const r = button.getBoundingClientRect();
    const below = r.top < 160;
    setAt(below ? { top: r.bottom + 8, right: Math.max(8, innerWidth - r.right) } : { bottom: innerHeight - r.top + 8, left: r.left, width: Math.max(220, r.width) });
    setOpen(!open);
  };
  const setTheme = (t: "light" | "dark") => {
    setThemeState(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("homenet-theme", t);
    } catch {
      /* per-browser preference */
    }
  };
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
  return (
    <div className="hp-me" ref={ref}>
      <button type="button" className="hp-me-btn" aria-haspopup="menu" aria-expanded={open} onClick={(e) => toggle(e.currentTarget)}>
        <span className="hp-avatar">{(name || login || "?").slice(0, 1).toUpperCase()}</span>
        <span className="hp-me-text">
          <b>{name || login || "гость"}</b>
          <small>{admin ? "администратор" : login}</small>
        </span>
        <Icon d={I.down} size={14} />
      </button>
      <button type="button" className="hp-theme" aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"} title={theme === "dark" ? "Светлая тема" : "Тёмная тема"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        <Icon d={theme === "dark" ? I.sun : I.moon} size={16} />
      </button>
      {open ? (
        <div className="hp-me-menu" role="menu" style={at}>
          <span className="hp-me-menu-who">
            <b>{name || login}</b>
            <small>{login}</small>
          </span>
          <a role="menuitem" href="/_gate/login">
            Сменить учётную запись
          </a>
          <form method="post" action="/_gate/logout">
            <button role="menuitem" type="submit">
              Выйти
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function Guest() {
  return (
    <div className="pt">
      <header className="pt-head">
        <Brand />
      </header>
      <main className="pt-main pt-guest">
        <section className="pt-guest-text">
          <h1>Войдите, чтобы увидеть свои приложения</h1>
          <p>HomeNet показывает только то, к чему у вашей учётной записи есть доступ: облако, умный дом, семейное древо. Вход один для всех домашних сервисов.</p>
          <div className="pt-guest-actions">
            <a className="pt-btn pt-primary" href="/_gate/login">
              Войти через Account
              <Icon d={I.arrow} size={18} />
            </a>
            <span className="pt-muted">Нет учётной записи — спросите администратора</span>
          </div>
        </section>
        <aside className="pt-guest-card">
          <span className="pt-guest-lock">
            <Icon d={I.lock} />
          </span>
          <p>Какие приложения открыты и кому, решает администратор в разделе «Доступы». После входа список появится здесь.</p>
        </aside>
      </main>
      <footer className="pt-foot">
        <span>Дома HomeNet открывается и по адресу 192.168.1.1:63412</span>
        <span className="pt-mono">{location.host}</span>
      </footer>
    </div>
  );
}

function Access({ items, cfg, policy, onSaved, onBack }: { items: LauncherItem[]; cfg: LauncherConfig; policy: Policy | null; onSaved: (p: Policy) => void; onBack: () => void }) {
  const [draft, setDraft] = useState<Policy>({ apps: {} });
  const [users, setUsers] = useState<{ login: string; name: string }[]>([]);
  const [filter, setFilter] = useState<"" | Mode>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState("");

  useEffect(() => {
    if (policy) setDraft(JSON.parse(JSON.stringify(policy)));
  }, [policy]);
  useEffect(() => {
    get<{ users: { login: string; name: string }[] }>("/api/access/users")
      .then((u) => setUsers(u.users || []))
      .catch(() => setUsers([]));
  }, []);

  const rows = items.filter((i) => i.key !== "app:account");
  const ruleOf = (id: string): Rule => draft.apps[id] || { mode: "admin", users: [] };
  const update = (id: string, change: Partial<Rule>) => {
    setMsg("");
    setDraft((p) => ({ apps: { ...p.apps, [id]: { ...ruleOf(id), ...change } } }));
  };
  const count = (m: Mode) => rows.filter((i) => ruleOf(idOf(i.key)).mode === m).length;
  const shown = rows.filter((i) => !filter || ruleOf(idOf(i.key)).mode === filter);
  const deviceName = (id: string) => cfg.devices.find((d) => d.id === id)?.name || "Другие устройства";
  const dirty = JSON.stringify(draft) !== JSON.stringify(policy || { apps: {} });

  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json", "X-HomeNet-UI": "1" }, body: JSON.stringify(draft) });
      if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
      setMsg("Сохранено. Правила уже действуют.");
      onSaved(draft);
    } catch (e) {
      setMsg(`Не сохранилось: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pt-main">
      <section className="pt-top">
        <div className="pt-title">
          <button type="button" className="pt-crumb" onClick={onBack}>
            <Icon d={I.back} size={16} /> Приложения
          </button>
          <h1>Кто что видит</h1>
          <p>Правила действуют на вход через шлюз роутера. Администраторы HomeNet видят всё; собственные логины приложений остаются как были.</p>
        </div>
        <div className="pt-save">
          {msg ? <span className={msg.startsWith("Сохранено") ? "pt-ok" : "pt-warn"} role="status">{msg}</span> : null}
          <button type="button" className="pt-btn pt-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Сохраняю…" : "Сохранить доступы"}
          </button>
        </div>
      </section>

      <nav className="pt-chips" aria-label="Режим доступа">
        <button type="button" className={!filter ? "is-on" : ""} aria-pressed={!filter} onClick={() => setFilter("")}>
          Все <span>{rows.length}</span>
        </button>
        {(["admin", "users", "public"] as Mode[]).map((m) => (
          <button key={m} type="button" className={filter === m ? "is-on" : ""} aria-pressed={filter === m} onClick={() => setFilter(filter === m ? "" : m)}>
            {m === "admin" ? "Только админы" : m === "users" ? "Выбранные" : "Открыто"} <span>{count(m)}</span>
          </button>
        ))}
      </nav>

      <section className="pt-table" role="table" aria-label="Доступ к приложениям">
        <div className="pt-row pt-row-head" role="row">
          <span role="columnheader">Приложение</span>
          <span role="columnheader">Кто может открыть</span>
          <span role="columnheader">Пользователи</span>
          <span role="columnheader">Ссылки</span>
        </div>
        {shown.map((i) => {
          const id = idOf(i.key);
          const rule = ruleOf(id);
          return (
            <div key={i.key} className="pt-row" role="row">
              <span className="pt-cell-app" role="cell">
                <AppTile item={i} size={34} />
                <span>
                  <strong>{i.title}</strong>
                  <small>{deviceName(i.device)}</small>
                </span>
              </span>
              <span role="cell">
                <span className="pt-seg" role="radiogroup" aria-label={`Кто может открыть ${i.title}`}>
                  {(["admin", "users", "public"] as Mode[]).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={rule.mode === m} className={rule.mode === m ? "is-on" : ""} onClick={() => update(id, { mode: m })}>
                      {MODE_LABEL[m]}
                    </button>
                  ))}
                </span>
              </span>
              <span className="pt-users" role="cell">
                {rule.mode === "users" ? (
                  <>
                    {rule.users.map((u) => (
                      <button key={u} type="button" className="pt-user" title="Убрать" onClick={() => update(id, { users: rule.users.filter((x) => x !== u) })}>
                        {users.find((x) => x.login === u)?.name || u} ×
                      </button>
                    ))}
                    <span className="pt-add">
                      <button type="button" className="pt-user is-add" aria-expanded={open === id} onClick={() => setOpen(open === id ? "" : id)}>
                        + добавить
                      </button>
                      {open === id ? (
                        <span className="pt-menu pt-menu-left" role="menu">
                          {users.filter((u) => !rule.users.includes(u.login)).map((u) => (
                            <button key={u.login} type="button" role="menuitem" onClick={() => { update(id, { users: [...rule.users, u.login] }); setOpen(""); }}>
                              {u.name} <small>{u.login}</small>
                            </button>
                          ))}
                          {!users.length ? <span className="pt-muted">Пользователей Account не получить</span> : null}
                        </span>
                      ) : null}
                    </span>
                  </>
                ) : (
                  <span className="pt-muted">{rule.mode === "admin" ? "только администраторы HomeNet" : "без входа, и через публичный домен"}</span>
                )}
              </span>
              <span className="pt-cell-links" role="cell">
                <details>
                  <summary className="pt-mono">{hostLabel(i.public || i.primary)}</summary>
                  <label>
                    По IP
                    <input value={rule.ip_url || ""} placeholder={i.direct || "http://192.168.…"} onChange={(e) => update(id, { ip_url: e.target.value })} />
                  </label>
                  <label>
                    По домену
                    <input value={rule.domain_url || ""} placeholder={i.public || "https://…"} onChange={(e) => update(id, { domain_url: e.target.value })} />
                  </label>
                </details>
              </span>
            </div>
          );
        })}
      </section>
      <p className="pt-muted pt-small">Пользователи берутся из Account. «Все» открывает приложение и через публичный домен — без входа. Account всегда доступен для входа.</p>
    </main>
  );
}

function plural(n: number, forms: [string, string, string]) {
  const a = Math.abs(n) % 100;
  const l = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (l > 1 && l < 5) return forms[1];
  if (l === 1) return forms[0];
  return forms[2];
}
