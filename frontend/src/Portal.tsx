import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import App from "./App";
import { buildItems, defaultLauncher, OTHER_DEVICE, type LauncherItem } from "./features/launcher/model";
import { artFor } from "./features/launcher/art";
import type { LauncherConfig } from "./api";
import type { RoutesDocument } from "./types";
import "./styles/portal.css";

type Mode = "admin" | "users" | "public";
type Rule = { mode: Mode; users: string[]; ip_url?: string; domain_url?: string };
type Policy = { apps: Record<string, Rule> };
type Data = { login: string; admin: boolean; doc: RoutesDocument; launcher: LauncherConfig | null; links: Record<string, Rule> };
type Probe = { ok: boolean; ms: number };

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
};

function AppIcon({ item, tint, size = 40 }: { item: LauncherItem; tint: number; size?: number }) {
  const spec = artFor(item.art, item.title, ...item.hints);
  return (
    <span className={`pt-icon tint-${tint}`} style={{ width: size, height: size, borderRadius: Math.round(size / 4) }} aria-hidden="true">
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        {spec.icon}
      </svg>
    </span>
  );
}

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

export default function Portal() {
  const [data, setData] = useState<Data | null>(null);
  const [guest, setGuest] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"apps" | "access" | "manage">("apps");
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [status, setStatus] = useState<Record<string, Probe>>({});

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

  const cfg = data?.launcher || defaultLauncher();
  const items = useMemo(() => (data ? buildItems(data.doc, cfg, data.links).filter((i) => !i.hidden && i.key !== "app:homenet") : []), [data]);

  // Admins see policy badges and reachability; other users only their list.
  useEffect(() => {
    if (!data?.admin) return;
    get<Policy>("/api/access").then(setPolicy).catch(() => setPolicy({ apps: {} }));
    const probes = [...new Set(items.map((i) => i.probe).filter(Boolean) as string[])];
    if (!probes.length) return;
    const pull = () =>
      fetch("/api/launcher/status?" + probes.map((t) => "t=" + encodeURIComponent(t)).join("&"))
        .then((r) => (r.ok ? r.json() : null))
        .then((r) => r?.status && setStatus(r.status))
        .catch(() => undefined);
    void pull();
    const t = setInterval(() => document.visibilityState === "visible" && void pull(), 60000);
    return () => clearInterval(t);
  }, [data?.admin, items]);

  if (view === "manage" && data?.admin)
    return (
      <>
        <button className="portal-back" onClick={() => setView("apps")}>
          ← Приложения и доступы
        </button>
        <App />
      </>
    );

  if (guest) return <Guest />;

  return (
    <div className="pt">
      <header className="pt-head">
        <Brand />
        <span className="pt-grow" />
        {data?.admin ? (
          <>
            <button type="button" className="pt-btn" onClick={() => setView("manage")}>
              <Icon d={I.gear} size={16} />
              <span className="pt-hide-sm">Управление роутером</span>
            </button>
            <button type="button" className={`pt-btn${view === "access" ? " is-on" : ""}`} onClick={() => setView(view === "access" ? "apps" : "access")}>
              <Icon d={I.lock} size={16} />
              <span className="pt-hide-sm">Доступы</span>
            </button>
          </>
        ) : null}
        {data ? <AccountMenu login={data.login} /> : null}
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
        <Apps items={items} cfg={cfg} status={status} policy={data.admin ? policy : null} />
      )}
    </div>
  );
}

function AccountMenu({ login }: { login: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
    <div className="pt-account" ref={ref}>
      <button type="button" className="pt-account-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="pt-avatar">{(login || "?").slice(0, 1).toUpperCase()}</span>
        <span className="pt-hide-sm">{login || "гость"}</span>
        <Icon d={I.down} size={14} />
      </button>
      {open ? (
        <div className="pt-menu" role="menu">
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

function Apps({ items, cfg, status, policy }: { items: LauncherItem[]; cfg: LauncherConfig; status: Record<string, Probe>; policy: Policy | null }) {
  const [query, setQuery] = useState("");
  const [device, setDevice] = useState("");
  const [opens, setOpens] = useState<Record<string, number>>(readOpens);
  const search = useRef<HTMLInputElement>(null);

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

  const devices = [...cfg.devices, { id: OTHER_DEVICE, name: "Другие устройства", kind: "other", note: "", addresses: [] }];
  const tintOf = (id: string) => Math.max(0, devices.findIndex((d) => d.id === id)) % 5;
  const q = query.trim().toLowerCase();
  const match = (i: LauncherItem) => !q || [i.title, i.description, ...i.hints].join(" ").toLowerCase().includes(q);
  const visible = items.filter((i) => (!device || i.device === device) && match(i));
  const groups = devices.map((d) => ({ d, apps: visible.filter((i) => i.device === d.id) })).filter((g) => g.apps.length);
  const counts = (id: string) => items.filter((i) => i.device === id).length;
  const usedDevices = devices.filter((d) => counts(d.id));
  const probed = items.filter((i) => i.probe && status[i.probe]);
  const down = probed.filter((i) => !status[i.probe!].ok).length;
  const pinned = Object.entries(opens)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => items.find((i) => i.key === k))
    .filter(Boolean)
    .slice(0, 6) as LauncherItem[];

  const remember = (key: string) => {
    const next = { ...opens, [key]: (opens[key] || 0) + 1 };
    setOpens(next);
    try {
      localStorage.setItem(OPENS_KEY, JSON.stringify(next));
    } catch {
      /* per-browser convenience */
    }
  };

  return (
    <main className="pt-main">
      <section className="pt-top">
        <div className="pt-title">
          <h1>Приложения</h1>
          <p>
            {items.length} {plural(items.length, ["приложение", "приложения", "приложений"])} на {usedDevices.length} {plural(usedDevices.length, ["устройстве", "устройствах", "устройствах"])}
            {probed.length ? (
              <>
                {" · "}
                <span className="pt-ok">{probed.length - down} {probed.length - down === 1 ? "отвечает" : "отвечают"}</span>
                {down ? (
                  <>
                    {" · "}
                    <span className="pt-warn">{down} {down === 1 ? "не отвечает" : "не отвечают"}</span>
                  </>
                ) : null}
              </>
            ) : null}
          </p>
        </div>
        <label className="pt-search">
          <Icon d={I.search} />
          <input ref={search} type="search" placeholder="Найти приложение или домен" aria-label="Поиск приложений" value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd className="pt-hide-sm">/</kbd>
        </label>
      </section>

      {usedDevices.length > 1 ? (
        <nav className="pt-chips" aria-label="Устройства">
          <button type="button" aria-pressed={!device} className={!device ? "is-on" : ""} onClick={() => setDevice("")}>
            Все <span>{items.length}</span>
          </button>
          {usedDevices.map((d) => (
            <button key={d.id} type="button" aria-pressed={device === d.id} className={device === d.id ? "is-on" : ""} onClick={() => setDevice(device === d.id ? "" : d.id)}>
              {d.name} <span>{counts(d.id)}</span>
            </button>
          ))}
        </nav>
      ) : null}

      {pinned.length && !q && !device ? (
        <section className="pt-section">
          <h2 className="pt-label">Часто открываете</h2>
          <div className="pt-pinned">
            {pinned.map((i) => (
              <a key={i.key} className="pt-pin" href={i.primary} onClick={() => remember(i.key)}>
                <AppIcon item={i} tint={tintOf(i.device)} size={36} />
                <span>{i.title}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {groups.map(({ d, apps }) => {
        const dDown = apps.filter((i) => i.probe && status[i.probe] && !status[i.probe].ok).length;
        return (
          <section key={d.id} className="pt-section">
            <div className="pt-device">
              <h2>{d.name}</h2>
              {d.note ? <span className="pt-mono pt-muted">{d.note}</span> : null}
              <span className="pt-grow" />
              <span className="pt-muted pt-hide-sm">
                {apps.length} {plural(apps.length, ["приложение", "приложения", "приложений"])}
                {probed.length ? (dDown ? ` · ${dDown} ${dDown === 1 ? "не отвечает" : "не отвечают"}` : " · все отвечают") : ""}
              </span>
            </div>
            <div className="pt-grid">
              {apps.map((i) => {
                const probe = i.probe ? status[i.probe] : undefined;
                const rule = policy ? policy.apps[idOf(i.key)] : undefined;
                const mode: Mode = rule?.mode || "admin";
                const lan = i.direct && i.direct !== i.primary ? i.direct : undefined;
                return (
                  <article key={i.key} className="pt-card">
                    <a className="pt-card-main" href={i.primary} onClick={() => remember(i.key)}>
                      <AppIcon item={i} tint={tintOf(i.device)} />
                      <span className="pt-card-text">
                        <strong>{i.title}</strong>
                        <span>{i.description}</span>
                      </span>
                      <Icon d={I.chevron} size={16} />
                    </a>
                    <div className="pt-card-foot">
                      {probe ? (
                        <span className={`pt-state ${probe.ok ? "is-ok" : "is-down"}`}>
                          <i />
                          {probe.ok ? "работает" : "не отвечает"}
                        </span>
                      ) : null}
                      {policy ? <span className={`pt-access is-${mode}`}>{ACCESS_BADGE[mode]}</span> : null}
                      <span className="pt-grow" />
                      <a className="pt-link" href={i.primary} onClick={() => remember(i.key)} title={i.primary}>
                        {hostLabel(i.public || i.primary)} ↗
                      </a>
                      {lan ? (
                        <a className="pt-link is-lan" href={lan} onClick={() => remember(i.key)} title={`В домашней сети: ${lan}`}>
                          LAN
                        </a>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}

      {!groups.length ? (
        <div className="pt-notice">
          <strong>{items.length ? "Ничего не нашлось" : "Пока нет доступных приложений"}</strong>
          <span>{items.length ? "Измените запрос или фильтр." : "Попросите администратора HomeNet открыть вам доступ."}</span>
        </div>
      ) : null}
      {probed.length ? <p className="pt-muted pt-small">Состояние — проверка порта приложения с роутера раз в минуту. Ссылка с доменом работает отовсюду, LAN — только дома.</p> : null}
    </main>
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
                <AppIcon item={i} tint={Math.max(0, cfg.devices.findIndex((d) => d.id === i.device)) % 5} size={34} />
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
