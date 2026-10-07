import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { errText, number } from "../../lib/format";
import { DEFAULT_TEST_URL, mihomo, type MProxy, type TailscalePeer, type TailscaleStatus } from "./api";
import { useMihomo } from "./context";
import { currentExit } from "./Extras";
import { useStored } from "./NodeTiles";

/*
 * VPN → «Tailscale» (NPM-56): the router in the tailnet — the exit to the
 * internet first, then the devices as a table (mine or everyone's, by account,
 * online, old registrations folded), checks of the addresses the tailnet is for.
 * A work tailnet has hundreds of devices: nothing here draws them all at once.
 * Design: https://claude.ai/artifact/8w7GwGhKrK96ePPxL166SG
 */

type Scope = "mine" | "all";
const STALE_DAYS = 90;
const PAGE = 30;
const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

const peerName = (p: TailscalePeer) => p.hostName || p.dnsName.split(".")[0] || p.id;
const daysAgo = (iso?: string) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 0);
function seen(p: TailscalePeer) {
  if (p.online) return "сейчас";
  if (!p.lastSeen) return "давно";
  const d = daysAgo(p.lastSeen);
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} ч назад`;
  if (d < 45) return `${Math.round(d)} дн назад`;
  return `${Math.round(d / 30)} мес назад`;
}
const OS: Record<string, string> = { windows: "Windows", linux: "Linux", macos: "macOS", android: "Android", ios: "iOS" };
const osName = (os?: string) => (os ? OS[os.toLowerCase()] || os : "—");

export function TailscaleView({ nodes }: { nodes: MProxy[] }) {
  const [pick, setPick] = useState(nodes[0]?.name || "");
  const name = nodes.some((n) => n.name === pick) ? pick : nodes[0]?.name || "";
  return (
    <div className="stack ts">
      {nodes.length > 1 ? (
        <div className="vn-chips" role="group" aria-label="Узел Tailscale">
          {nodes.map((n) => (
            <button key={n.name} type="button" className={`vn-chip${n.name === name ? " is-on" : ""}`} aria-pressed={n.name === name} onClick={() => setPick(n.name)}>
              {n.name}
            </button>
          ))}
        </div>
      ) : null}
      {name ? <TailnetNode key={name} name={name} /> : null}
    </div>
  );
}

function TailnetNode({ name }: { name: string }) {
  const { act } = useMihomo();
  const [st, setSt] = useState<TailscaleStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [scope, setScope] = useStored<Scope>("homenet.ts.scope", "mine", (v): v is Scope => v === "mine" || v === "all");
  const [account, setAccount] = useState("");
  const [onlyOnline, setOnlyOnline] = useStored("homenet.ts.online", true, isBool);
  const [hideStale, setHideStale] = useStored("homenet.ts.hideStale", true, isBool);
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [exitCheck, setExitCheck] = useState<{ ok: boolean; text: string } | null>(null);
  // «Мои» are the devices starred here: some coordinators (Headscale) give
  // several people one account id, so the owner a status reports can change
  // from one refresh to the next and cannot say whose a device is
  const [stars, setStars] = useStored<string[]>("homenet.ts.stars", [], (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string"));
  const [unstable, setUnstable] = useStored("homenet.ts.accountsUnstable", false, isBool);
  const seenUsers = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!st || unstable) return;
    const m = seenUsers.current;
    const all = [...(st.peers || []), ...(st.self ? [{ ...st.self, id: "self" }] : [])];
    if (all.some((p) => p.user && m.has(p.id) && m.get(p.id) !== p.user)) setUnstable(true);
    all.forEach((p) => p.user && m.set(p.id, p.user));
  }, [st, unstable, setUnstable]);
  const starKey = (p: TailscalePeer) => peerName(p).toLowerCase();
  const toggleStar = (p: TailscalePeer) => setStars(stars.includes(starKey(p)) ? stars.filter((x) => x !== starKey(p)) : [...stars, starKey(p)]);
  const showAccounts = !unstable;

  const load = useCallback(async () => {
    try {
      setSt(await mihomo.tailscale(name));
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, [name]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 20000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => setLimit(PAGE), [scope, account, onlyOnline, hideStale, q]);

  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    await act(`Tailscale ${name}`, fn, done);
    setBusy("");
    await load();
  };

  const peers = useMemo(() => (st?.peers || []).filter((p) => !p.self), [st]);
  const me = "";
  const exit = st ? currentExit(st) : undefined;
  const exits = peers.filter((p) => p.exitNodeOption || p === exit).sort((a, b) => Number(b.online) - Number(a.online) || peerName(a).localeCompare(peerName(b)));
  const state: "on" | "login" | "off" | "wait" = !st ? "wait" : st.backendState === "Running" ? "on" : st.backendState === "NeedsLogin" || st.authURL ? "login" : !st.wantRunning ? "off" : "wait";

  // one row per name: re-registrations of the same machine fold under the freshest one
  const accounts = useMemo(() => {
    const m = new Map<string, { user: string; label: string; n: number }>();
    peers.forEach((p) => {
      const k = p.user || "";
      const e = m.get(k) || { user: k, label: p.userName || p.user || "без аккаунта", n: 0 };
      e.n++;
      m.set(k, e);
    });
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [peers]);
  const stale = (p: TailscalePeer) => !p.online && daysAgo(p.lastSeen) > STALE_DAYS;
  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    const base = peers.filter((p) => {
      if (scope === "mine" && !stars.includes(starKey(p))) return false;
      if (scope === "all" && showAccounts && account && (p.user || "") !== account) return false;
      if (query && !`${peerName(p)} ${p.dnsName} ${(p.ips || []).join(" ")} ${p.user || ""} ${p.userName || ""} ${p.os || ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
    const byName = new Map<string, TailscalePeer[]>();
    base.forEach((p) => byName.set(peerName(p).toLowerCase(), [...(byName.get(peerName(p).toLowerCase()) || []), p]));
    const folded = [...byName.values()].map((list) => {
      const sorted = [...list].sort((a, b) => Number(b.online) - Number(a.online) || daysAgo(a.lastSeen) - daysAgo(b.lastSeen));
      return { p: sorted[0], extra: sorted.length - 1 };
    });
    return {
      total: base.length,
      list: folded
        .filter((r) => (!onlyOnline || r.p.online) && (!hideStale || !stale(r.p)))
        .sort((a, b) => Number(b.p.online) - Number(a.p.online) || peerName(a.p).localeCompare(peerName(b.p))),
    };
  }, [peers, scope, stars, showAccounts, account, q, onlyOnline, hideStale]);

  const online = peers.filter((p) => p.online).length;
  const mine = peers.filter((p) => stars.includes(starKey(p))).length;
  void me;
  const staleN = peers.filter(stale).length;
  const setExit = (value: string, label: string) => void run("exit", () => mihomo.tailscaleExitNode(name, value), value ? `Выход через ${label}` : "Выход напрямую");
  const checkExit = async () => {
    setBusy("check");
    setExitCheck(null);
    try {
      const r = await mihomo.delay(name, DEFAULT_TEST_URL, 8000);
      setExitCheck({ ok: true, text: `интернет через выход открывается · ${r.delay} мс` });
    } catch (e) {
      setExitCheck({ ok: false, text: `интернет через выход не открывается: ${errText(e)}` });
    } finally {
      setBusy("");
    }
  };

  const title =
    state === "on" ? `Роутер в tailnet${exit ? `, выход через ${peerName(exit)}` : ", выход напрямую"}` : state === "login" ? "Войдите в tailnet, чтобы роутер подключился" : state === "off" ? "Tailscale выключен" : "Подключаюсь к tailnet…";
  const text =
    state === "on"
      ? exit
        ? "Адреса сети доступны из дома, а трафик группы «Tailscale» выходит в интернет через выбранный узел."
        : "Адреса сети доступны из дома. Выход в интернет не выбран — группа «Tailscale» ведёт только в сеть."
      : state === "login"
        ? "Ключ узла не действует. Откройте ссылку и войдите — роутер подключится сам, перезапуск не нужен."
        : state === "off"
          ? "Адреса сети из дома недоступны. Включение займёт несколько секунд."
          : st
            ? `Состояние: ${st.backendState}`
            : "";

  return (
    <>
      <section className={`ts-hero ts-${state}`} aria-label="Состояние Tailscale">
        <div className="ts-hero-top">
          <div className="ts-hero-text">
            <span className="vo-eyebrow">
              <i className="vo-pulse" aria-hidden="true" />
              {state === "on" ? "Подключено" : state === "login" ? "Нужен вход" : state === "off" ? "Выключено" : "Подключение"}
            </span>
            <h2>{title}</h2>
            <p>{text}</p>
          </div>
          <div className="vo-hero-actions">
            {state === "login" && st?.authURL ? (
              <a className="btn btn-primary" href={st.authURL} target="_blank" rel="noopener noreferrer">
                Войти в tailnet
              </a>
            ) : state === "login" ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!!busy}
                onClick={() =>
                  void run(
                    "login",
                    async () => {
                      await mihomo.tailscaleRunning(name, false);
                      await mihomo.tailscaleRunning(name, true);
                    },
                    "Вход запрошен — ссылка появится здесь",
                  )
                }
              >
                Получить ссылку для входа
              </button>
            ) : null}
            {st ? (
              <button type="button" className={`btn${state === "off" ? " btn-primary" : ""}`} disabled={!!busy} onClick={() => void run("run", () => mihomo.tailscaleRunning(name, !st.wantRunning), st.wantRunning ? "Выключен" : "Включён")}>
                {st.wantRunning ? "Выключить" : "Включить"}
              </button>
            ) : null}
            <button type="button" className="btn btn-icon" aria-label="Обновить" onClick={() => void load()}>
              <Icon name="refresh" />
            </button>
          </div>
        </div>
        {error ? <p className="vn-err">Ядро не отдало состояние Tailscale: {error}</p> : null}
        <div className="ts-facts">
          <div>
            <small>Выход</small>
            <b className="truncate">{exit ? peerName(exit) : "напрямую"}</b>
            <span>{exit ? (st?.exitNodeActive ? "активен" : "выбран, не активен") : "без узла выхода"}</span>
          </div>
          <div>
            <small>Устройств</small>
            <b>{number(peers.length)}</b>
            <span>{number(online)} в сети</span>
          </div>
          <div>
            <small>Ваших</small>
            <b>{number(mine)}</b>
            <span className="truncate">{mine ? "отмечены звёздочкой" : "отметьте свои звёздочкой"}</span>
          </div>
          {showAccounts ? (
            <div>
              <small>Аккаунтов</small>
              <b>{number(accounts.length)}</b>
              <span>в tailnet</span>
            </div>
          ) : null}
          <div>
            <small>Старые регистрации</small>
            <b>{number(staleN)}</b>
            <span>не появлялись {STALE_DAYS}+ дней</span>
          </div>
        </div>
      </section>

      <section className="vn-section" aria-label="Выход в интернет">
        <div className="vn-section-head">
          <h3>
            Выход в интернет <span>· узлы, разрешённые администратором tailnet; трафик группы «Tailscale» пойдёт через выбранный</span>
          </h3>
          <button type="button" className="vn-chip" disabled={busy === "check" || state !== "on"} onClick={() => void checkExit()}>
            <Icon name="test" size={13} /> {busy === "check" ? "Проверяю…" : "Проверить выход"}
          </button>
        </div>
        {exitCheck ? <p className={exitCheck.ok ? "su-ok" : "vn-err"}>{exitCheck.text}</p> : null}
        <div className="ts-exits">
          {[{ key: "", label: "без выхода", sub: "только адреса сети", on: !exit && !st?.exitNode, online: true, value: "" }, ...exits.map((p) => ({ key: p.id, label: peerName(p), sub: (p.ips || [])[0] || p.dnsName, on: p === exit, online: p.online, value: (p.ips || [])[0] || p.dnsName.replace(/\.$/, "") }))].map((e) => (
            <button key={e.key || "none"} type="button" className={`ts-exit${e.on ? " is-on" : ""}`} aria-pressed={e.on} disabled={!!busy || state !== "on" || !e.online} onClick={() => setExit(e.value, e.label)}>
              <span className="ts-exit-top">
                <b className="truncate mono">{e.label}</b>
                <i className="ts-radio" aria-hidden="true" />
              </span>
              <small className="mono truncate">{e.sub}</small>
              <span className={`nx-pill ${e.on ? "nx-out" : e.online ? "nx-ok" : "nx-silent"}`}>{e.on ? "используется" : e.key ? (e.online ? "в сети" : "не в сети") : "вариант"}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="ts-layout">
        <section className="ts-devices" aria-label="Устройства">
          <div className="vn-section-head">
            <h3>Устройства</h3>
            <span className="nx-summary">
              показано {number(Math.min(limit, rows.list.length))} из {number(rows.list.length)}
              {rows.list.length !== rows.total ? ` · всего под фильтром ${number(rows.total)}` : ""}
            </span>
          </div>
          <div className="ts-filters">
            <label className="sr-only" htmlFor="ts-q">
              Найти устройство
            </label>
            <input id="ts-q" className="input" placeholder="Имя, адрес, система или аккаунт" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="vn-chips">
              <button type="button" className={`vn-chip${scope === "mine" ? " is-on" : ""}`} aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>
                Мои <span className="vs-count">{number(mine)}</span>
              </button>
              <button type="button" className={`vn-chip${scope === "all" ? " is-on" : ""}`} aria-pressed={scope === "all"} onClick={() => setScope("all")}>
                Все <span className="vs-count">{number(peers.length)}</span>
              </button>
              {scope === "all" && showAccounts && accounts.length > 1 ? (
                <>
                  <label className="sr-only" htmlFor="ts-acc">
                    Аккаунт
                  </label>
                  <select id="ts-acc" className="input input-sm" value={account} onChange={(e) => setAccount(e.target.value)}>
                    <option value="">Все аккаунты</option>
                    {accounts.map((a) => (
                      <option key={a.user} value={a.user}>
                        {a.label}
                        {a.user && a.user !== a.label ? ` · ${a.user}` : ""} ({a.n})
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
              <button type="button" className={`vn-chip${onlyOnline ? " is-on" : ""}`} aria-pressed={onlyOnline} onClick={() => setOnlyOnline(!onlyOnline)}>
                Только в сети
              </button>
              <button type="button" className={`vn-chip${hideStale ? " is-on" : ""}`} aria-pressed={hideStale} onClick={() => setHideStale(!hideStale)}>
                Скрыть старые регистрации
              </button>
            </div>
          </div>
          {unstable ? <small className="mh-muted">Координатор отдаёт владельца устройства непостоянно — один и тот же аккаунт у разных людей, — поэтому колонка и фильтр по аккаунту скрыты. «Мои» — устройства со звёздочкой.</small> : null}
          {scope === "mine" && !mine ? <small className="mh-muted">Своих устройств пока нет: откройте «Все» и отметьте их звёздочкой.</small> : null}
          <div className={`ts-table${showAccounts ? "" : " no-acc"}`} role="table" aria-label="Устройства tailnet">
            <div className="ts-row ts-head" role="row">
              <span role="columnheader">Устройство</span>
              {showAccounts ? (
                <span role="columnheader" className="nx-hm">
                  Аккаунт
                </span>
              ) : null}
              <span role="columnheader">Система</span>
              <span role="columnheader" className="nx-hm">
                Адрес
              </span>
              <span role="columnheader" className="nx-hm">
                В сети
              </span>
            </div>
            {rows.list.slice(0, limit).map(({ p, extra }) => (
              <div key={p.id} className={`ts-row${p.online ? "" : " is-off"}`} role="row">
                <span role="cell" className="ts-dev">
                  <span className="ts-dev-name">
                    <button type="button" className={`ts-star${stars.includes(starKey(p)) ? " is-on" : ""}`} aria-pressed={stars.includes(starKey(p))} aria-label={stars.includes(starKey(p)) ? "Убрать из моих" : "Отметить как моё"} onClick={() => toggleStar(p)}>
                      ★
                    </button>
                    <i className={`nx-dot ${p.online ? "nx-ok" : "nx-silent"}`} />
                    <span className="truncate" title={p.dnsName}>
                      {peerName(p)}
                    </span>
                    {p.exitNodeOption ? <span className="nx-pill nx-out">выход</span> : null}
                  </span>
                  {extra ? <small>и ещё {extra} {extra === 1 ? "старая регистрация" : "старые регистрации"} с этим именем</small> : null}
                </span>
                {showAccounts ? (
                  <span role="cell" className="nx-hm ts-acc">
                    <span className="truncate">{p.userName || p.user || "—"}</span>
                    {p.user && p.user !== p.userName ? <small className="truncate mono">{p.user}</small> : null}
                  </span>
                ) : null}
                <span role="cell">{osName(p.os)}</span>
                <span role="cell" className="nx-hm mono">
                  {(p.ips || [])[0] || "—"}
                </span>
                <span role="cell" className="nx-hm">
                  {seen(p)}
                </span>
              </div>
            ))}
            {!rows.list.length ? <p className="mh-muted ts-empty">{st ? "Под фильтр ничего не попало." : "Загружаю устройства…"}</p> : null}
            {rows.list.length > limit ? (
              <div className="ts-more">
                <button type="button" className="btn" onClick={() => setLimit(limit + 50)}>
                  Показать ещё {number(Math.min(50, rows.list.length - limit))}
                </button>
              </div>
            ) : null}
          </div>
        </section>

        <aside className="ts-side">
          <AddressChecks name={name} />
          <section className="vo-panel" aria-label="Узел роутера">
            <h3>Узел роутера</h3>
            <dl className="nx-dl">
              <dt>Узел mihomo</dt>
              <dd className="mono">{name}</dd>
              <dt>Имя</dt>
              <dd className="truncate">{st?.self?.hostName || "—"}</dd>
              {showAccounts ? (
                <>
                  <dt>Аккаунт</dt>
                  <dd className="truncate">{st?.self ? st.self.userName || st.self.user || "—" : "—"}</dd>
                </>
              ) : null}
              <dt>Адрес</dt>
              <dd className="mono">{(st?.self?.ips || [])[0] || "—"}</dd>
              <dt>Через</dt>
              <dd className="truncate">{st?.self?.relay ? `DERP ${st.self.relay}` : "напрямую"}</dd>
            </dl>
            <small className="mh-muted">Соединение tailnet поднимает само ядро mihomo — отдельный клиент на роутере не нужен.</small>
          </section>
        </aside>
      </div>
    </>
  );
}

/** Own list of tailnet addresses, checked through the node; kept in this browser (NPM-41). */
function AddressChecks({ name }: { name: string }) {
  const [list, setList] = useStored<string[]>("homenet.tailscale.checks", [], isList);
  const [legacy] = useStored("homenet.tailscale.checkUrl", "", (v): v is string => typeof v === "string");
  const [text, setText] = useState("");
  const [res, setRes] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState(false);
  const urls = list.length ? list : legacy ? [legacy] : [];
  const norm = (u: string) => (/^https?:\/\//i.test(u.trim()) ? u.trim() : `http://${u.trim()}`);
  const check = async (targets: string[]) => {
    setBusy(true);
    await Promise.all(
      targets.map(async (u) => {
        try {
          const r = await mihomo.delay(name, u, 10000);
          setRes((x) => ({ ...x, [u]: { ok: true, text: `${r.delay} мс` } }));
        } catch (e) {
          setRes((x) => ({ ...x, [u]: { ok: false, text: errText(e).slice(0, 60) } }));
        }
      }),
    );
    setBusy(false);
  };
  const add = () => {
    const u = norm(text);
    if (!text.trim() || urls.includes(u)) return;
    const next = [...urls, u];
    setList(next);
    setText("");
    void check([u]);
  };
  return (
    <section className="vo-panel" aria-label="Проверка адресов сети">
      <div className="vn-section-head">
        <h3>Проверка адресов сети</h3>
        <button type="button" className="vn-chip" disabled={busy || !urls.length} onClick={() => void check(urls)}>
          {busy ? "Проверяю…" : "Проверить"}
        </button>
      </div>
      <small className="mh-muted">Открываются ли через tailnet адреса, ради которых он нужен. Любой ответ HTTP — доступ есть. Список хранится в этом браузере.</small>
      <div className="ts-checks">
        {urls.map((u) => (
          <div key={u} className="ts-check">
            <i className={`nx-dot ${!res[u] ? "" : res[u].ok ? "nx-ok" : "nx-reset"}`} />
            <span className="truncate mono">{u.replace(/^https?:\/\//, "")}</span>
            <small className="mono">{res[u]?.text || "—"}</small>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Убрать ${u}`} onClick={() => setList(urls.filter((x) => x !== u))}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        {!urls.length ? <p className="mh-muted">Адресов пока нет — добавьте первый.</p> : null}
      </div>
      <form
        className="su-inline"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="sr-only" htmlFor="ts-addr">
          Адрес
        </label>
        <input id="ts-addr" className="input mono" placeholder="host.tailnet или 100.64.x.x:порт" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn" disabled={!text.trim()}>
          Добавить
        </button>
      </form>
    </section>
  );
}
