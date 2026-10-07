import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, useHashTab } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Flag, NodeName, useFlagMode } from "../../components/ui/Flag";
import { bytes, errText } from "../../lib/format";
import { countryName, flagCode, nodeCC, type FlagMode } from "../../lib/flags";
import { core, mihomo, type ExitRecord, type HealthPoint, type MProvider, type MProxy, type ProviderUpdate } from "./api";
import { ChartTip, VpnChart, dm, intoSlots, slots } from "./VpnCharts";
import { Pill, type Tone } from "./VpnOverview";
import { OlcrtcPage, TailscalePage } from "./Proxies";
import { useExits } from "./useExits";
import { lastDelay } from "./shared";

type SubTab = "nodes" | "overview" | "log" | "settings";
type Fit = "match" | "region" | "diff" | "added" | "dead" | "unknown";
type FitFilter = "all" | "match" | "diff" | "added" | "unknown";

/*
 * VPN → «Подписки» (NPM-51, hub since NPM-59): every source of nodes in one
 * place — subscriptions, own OLCRTC servers, the Tailscale network — and for
 * each node the country it really exits in, checked through it.
 */

const SUBS_GROUP = "Подписки";
const OLC_SOURCE = "olcrtc";
const TS_SOURCE = "tailscale";
const ago = (sec: number) => (sec < 90 ? "только что" : sec < 3600 ? `${Math.round(sec / 60)} мин назад` : sec < 86400 ? `${Math.floor(sec / 3600)} ч назад` : `${Math.floor(sec / 86400)} дн назад`);
const ts = (iso?: string) => (iso ? new Date(iso).getTime() / 1000 : 0);
const when = (t?: number) => (t ? new Date(t * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const EU = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]);

const FIT: Record<Fit, { label: string; tone: string }> = {
  match: { label: "совпадает", tone: "ok" },
  region: { label: "регион, выход ок", tone: "region" },
  diff: { label: "другая страна", tone: "diff" },
  added: { label: "флаг по выходу", tone: "info" },
  dead: { label: "не ответил", tone: "dead" },
  unknown: { label: "не проверен", tone: "dead" },
};

function leafOf(name: string, proxies: Record<string, MProxy>): string {
  let cur = proxies[name];
  for (let i = 0; cur && cur.now && i < 10; i++) {
    if (!proxies[cur.now]) return cur.now;
    cur = proxies[cur.now];
  }
  return cur?.name || "";
}

/** The exit country of a node: the newest of HomeNet's check and the core's adaptive trace. */
function exitOf(p: MProvider | undefined, name: string, rec?: ExitRecord): string {
  const a = p?.adaptive?.results?.[name];
  const adaptive = (a?.country || (a?.probes || []).find((pr) => pr.country)?.country || "").toUpperCase();
  if (rec?.cc && (!adaptive || !a?.at || rec.t >= ts(a.at))) return rec.cc;
  return adaptive || rec?.cc || "";
}

function fitOf(nameCC: string, exit: string, rec?: ExitRecord): Fit {
  if (!exit) return rec && !rec.ok ? "dead" : "unknown";
  if (!nameCC) return "added";
  if (nameCC === exit) return "match";
  if (nameCC === "EU" && EU.has(exit)) return "region";
  return "diff";
}

function aliveOf(p: MProvider, x: MProxy): boolean {
  const r = p.adaptive?.results?.[x.name];
  return r ? !r.skipped && !!(r.available ?? r.ok) : !!x.alive;
}

/** The countries a source exits in, most nodes first — for the flag strip. */
function topCountries(p: MProvider, exits: Record<string, ExitRecord>): string[] {
  const m = new Map<string, number>();
  p.proxies.forEach((x) => {
    const c = exitOf(p, x.name, exits[x.name]) || flagCode(x.name);
    if (c) m.set(c, (m.get(c) || 0) + 1);
  });
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

export function Subscriptions() {
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [log, setLog] = useState<Record<string, ProviderUpdate[]>>({});
  const [src, setSrc] = useHashTab<string>("subs", "");
  const [days, setDays] = useState<HealthPoint[]>([]);
  const [sel, setSel] = useState(13);
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState<SubTab>("nodes");
  const [err, setErr] = useState("");
  const [flagMode, setFlagMode] = useFlagMode();
  const { exits, checkExits } = useExits();

  // #/tailscale and #/olcrtc were pages of their own before NPM-59
  useEffect(() => {
    const old = window.location.hash.match(/^#\/?(tailscale|olcrtc)\b/);
    if (old) {
      window.history.replaceState(null, "", `#/subs/${old[1]}`);
      window.dispatchEvent(new Event("homenet:subtab"));
    }
  }, []);

  const pull = useCallback(() => {
    void mihomo
      .allProxies()
      .then((r) => {
        setProviders(r.providers);
        setProxies(r.proxies);
      })
      .catch((e) => setErr(errText(e)));
    void core
      .groups("24h")
      .then((r) => setLog(r.provider_log || {}))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), 60000);
    return () => clearInterval(t);
  }, [pull]);

  const subs = useMemo(
    () =>
      Object.values(providers)
        .filter((p) => (p.vehicleType === "HTTP" || p.vehicleType === "File") && p.name !== OLC_SOURCE)
        .sort((a, b) => b.proxies.length - a.proxies.length),
    [providers],
  );
  const olcProv = providers[OLC_SOURCE];
  const tsNodes = Object.values(proxies).filter((x) => x.type.toLowerCase() === "tailscale");
  const tsGroup = proxies.Tailscale;
  const source = src === OLC_SOURCE || src === TS_SOURCE ? src : "";
  const cur = source ? undefined : subs.find((p) => p.name === src) || subs[0];

  useEffect(() => {
    if (!cur) return;
    void core
      .health(cur.name, "30d")
      .then((r) => setDays(r.provider === cur.name ? r.series : []))
      .catch(() => setDays([]));
  }, [cur?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr("");
    try {
      await fn();
      pull();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };
  const kindOf = (p: MProvider) => (p.name === "CHAIN" ? "каскады: копия основной через обходы" : p.name === "AI" ? "копия основной для ИИ" : p.vehicleType === "HTTP" ? "подписка по ссылке" : "файл на роутере");
  const now = Date.now() / 1000;
  const aliveNow = (p: MProvider) => p.proxies.filter((x) => aliveOf(p, x)).length;
  const checking = !!exits.running;

  return (
    <div className="stack vn">
      <PageHeader
        page="subs"
        actions={
          <>
            <button type="button" className="btn" disabled={checking || busy === "exits"} onClick={() => void run("exits", () => checkExits({}))}>
              <Icon name="globe" size={14} /> {checking ? `Проверяю страны: ${exits.done || 0} из ${exits.total || 0}` : "Проверить страны выхода"}
            </button>
            <a className="btn btn-primary" href="#/coreconfig/providers">
              <Icon name="plus" size={14} /> Добавить подписку
            </a>
          </>
        }
      >
        Откуда берутся узлы: подписки, свои серверы и сети. Для каждого узла HomeNet проверяет, в какой стране он на самом деле выходит в интернет.
      </PageHeader>
      {err ? <p className="vn-err">{err}</p> : null}

      <div className="hub">
        <aside className="hub-rail" aria-label="Источники узлов">
          <div className="hub-group">
            <span className="hub-group-title">Подписки</span>
            {subs.map((p) => (
              <SourceItem
                key={p.name}
                name={p.name}
                kind={kindOf(p)}
                alive={aliveNow(p)}
                total={p.proxies.length}
                flags={topCountries(p, exits.nodes)}
                on={!source && cur?.name === p.name}
                onPick={() => setSrc(p.name === subs[0]?.name ? "" : p.name)}
              />
            ))}
            {!subs.length ? <p className="mh-muted">Подписок нет — добавьте ссылку.</p> : null}
          </div>
          <div className="hub-group">
            <span className="hub-group-title">Свои серверы</span>
            <SourceItem
              name="OLCRTC"
              kind="через видеозвонок"
              alive={olcProv ? aliveNow(olcProv) : 0}
              total={olcProv?.proxies.length || 0}
              flags={olcProv ? topCountries(olcProv, exits.nodes) : []}
              empty="добавить свой сервер"
              on={source === OLC_SOURCE}
              onPick={() => setSrc(OLC_SOURCE)}
            />
          </div>
          {tsNodes.length ? (
            <div className="hub-group">
              <span className="hub-group-title">Сети</span>
              <SourceItem
                name="Tailscale"
                kind={tsGroup?.now && tsGroup.now !== "REJECT" ? `tailnet · через ${tsGroup.now}` : "tailnet"}
                alive={tsNodes.filter((x) => x.alive).length}
                total={tsNodes.length}
                flags={tsNodes.map((x) => exits.nodes[x.name]?.cc || "").filter(Boolean)}
                on={source === TS_SOURCE}
                onPick={() => setSrc(TS_SOURCE)}
              />
            </div>
          ) : null}
        </aside>

        <div className="hub-main">
          {source === OLC_SOURCE ? <OlcrtcPage embedded /> : null}
          {source === TS_SOURCE ? <TailscalePage embedded /> : null}
          {!source && cur ? (
            <SubDetail
              cur={cur}
              proxies={proxies}
              log={log[cur.name] || []}
              days={days}
              sel={sel}
              setSel={setSel}
              tab={tab}
              setTab={setTab}
              busy={busy}
              kind={kindOf(cur)}
              now={now}
              exits={exits.nodes}
              exitsBusy={checking}
              flagMode={flagMode}
              setFlagMode={setFlagMode}
              onUpdate={() => void run(cur.name, () => mihomo.updateProvider(cur.name))}
              onHealth={() => void run(`hc:${cur.name}`, () => mihomo.healthcheck(cur.name))}
              onExits={(nodes) => void run(nodes ? `x:${nodes[0]}` : `xs:${cur.name}`, () => checkExits(nodes ? { nodes } : { provider: cur.name }))}
              onSaved={pull}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SourceItem({ name, kind, alive, total, flags, on, onPick, empty }: { name: string; kind: string; alive: number; total: number; flags: string[]; on: boolean; onPick: () => void; empty?: string }) {
  return (
    <button type="button" className={`hub-src${on ? " is-on" : ""}`} aria-pressed={on} onClick={onPick}>
      <span className="hub-src-top">
        <b>{name}</b>
        <span className="mono">{total ? `${alive} / ${total}` : ""}</span>
      </span>
      <small className="truncate">{total || !empty ? kind : empty}</small>
      {total ? (
        <span className="hub-src-bar" aria-hidden="true">
          <span style={{ width: `${(alive / total) * 100}%` }} />
        </span>
      ) : null}
      {flags.length ? (
        <span className="hub-src-flags">
          {flags.slice(0, 6).map((c) => (
            <Flag key={c} cc={c} />
          ))}
          {flags.length > 6 ? <small>+{flags.length - 6}</small> : null}
        </span>
      ) : null}
    </button>
  );
}

function SubDetail({
  cur,
  proxies,
  log,
  days,
  sel,
  setSel,
  tab,
  setTab,
  busy,
  kind,
  now,
  exits,
  exitsBusy,
  flagMode,
  setFlagMode,
  onUpdate,
  onHealth,
  onExits,
  onSaved,
}: {
  cur: MProvider;
  proxies: Record<string, MProxy>;
  log: ProviderUpdate[];
  days: HealthPoint[];
  sel: number;
  setSel: (n: number) => void;
  tab: SubTab;
  setTab: (t: SubTab) => void;
  busy: string;
  kind: string;
  now: number;
  exits: Record<string, ExitRecord>;
  exitsBusy: boolean;
  flagMode: FlagMode;
  setFlagMode: (m: FlagMode) => void;
  onUpdate: () => void;
  onHealth: () => void;
  onExits: (nodes?: string[]) => void;
  onSaved: () => void;
}) {
  const [filter, setFilter] = useState<FitFilter>("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(200);
  useEffect(() => {
    setFilter("all");
    setQ("");
    setLimit(200);
  }, [cur.name]);

  const rows = useMemo(
    () =>
      cur.proxies.map((x) => {
        const rec = exits[x.name];
        const nameCC = flagCode(x.name);
        const exit = exitOf(cur, x.name, rec);
        const delay = lastDelay(x, cur.testUrl);
        return { x, rec, nameCC, exit, fit: fitOf(nameCC, exit, rec), alive: aliveOf(cur, x), delay };
      }),
    [cur, exits],
  );
  const counts = { all: rows.length, match: 0, diff: 0, added: 0, unknown: 0 };
  rows.forEach((r) => {
    const k = r.fit === "region" ? "match" : r.fit === "dead" ? "unknown" : r.fit;
    counts[k]++;
  });
  const query = q.trim().toLowerCase();
  const shown = rows.filter((r) => {
    const k = r.fit === "region" ? "match" : r.fit === "dead" ? "unknown" : r.fit;
    if (filter !== "all" && k !== filter) return false;
    if (query && !`${r.x.name} ${countryName(r.exit || "")} ${r.rec?.city || ""} ${r.rec?.isp || ""} ${r.rec?.ip || ""}`.toLowerCase().includes(query)) return false;
    return true;
  });

  const st: { tone: Tone; text: string } = (() => {
    if (cur.vehicleType !== "HTTP") return { tone: "idle", text: "свой файл" };
    const age = now - ts(cur.updatedAt);
    const last = log[log.length - 1];
    if (!cur.updatedAt) return { tone: "idle", text: "ещё не скачана" };
    if (age > 3 * 3600) return { tone: "warn", text: `не обновлялась ${Math.floor(age / 3600)} ч` };
    if (last?.via && last.via !== "DIRECT") return { tone: "warn", text: "только через обходы" };
    return { tone: "ok", text: "обновляется" };
  })();
  const info = cur.subscriptionInfo;
  const used = (info?.Download || 0) + (info?.Upload || 0);
  const countries = new Set(rows.map((r) => r.exit).filter(Boolean));
  const lastCheck = Math.max(0, ...rows.map((r) => r.rec?.t || 0));
  const alive = rows.filter((r) => r.alive).length;

  // 14 days: nodes in the subscription and how many answered, by day
  const dayTimes = useMemo(() => slots(14, 86400), []);
  const total = intoSlots(dayTimes, 86400, days, (pts) => Math.max(...pts.map((p) => p.total)));
  const aliveDays = intoSlots(dayTimes, 86400, days, (pts) => Math.round(pts.reduce((a, p) => a + p.working, 0) / pts.length));
  const wl = intoSlots(dayTimes, 86400, days, (pts) => pts.reduce((a, p) => a + p.whitelist, 0));
  const di = Math.min(sel, dayTimes.length - 1);
  const byCountry = useMemo(() => {
    const m = new Map<string, { n: number; alive: number }>();
    rows.forEach((r) => {
      const c = r.exit || "?";
      const e = m.get(c) || { n: 0, alive: 0 };
      e.n++;
      if (r.alive) e.alive++;
      m.set(c, e);
    });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [rows]);
  const subsGroup = proxies[SUBS_GROUP];
  const subsLeaf = subsGroup ? leafOf(SUBS_GROUP, proxies) : "";
  const diffs = rows.filter((r) => r.fit === "diff");

  return (
    <section className="su-detail hub-detail" aria-label={cur.name}>
      <div className="su-detail-head">
        <span className="vn-card-name">
          <span className="hub-title">
            <b>{cur.name}</b>
            <Pill tone={st.tone}>{st.text}</Pill>
          </span>
          <small>
            {kind}
            {cur.updatedAt ? ` · обновлена ${ago(now - ts(cur.updatedAt))}` : ""}
            {log.length && log[log.length - 1].via ? ` ${log[log.length - 1].via === "DIRECT" ? "напрямую" : `через ${log[log.length - 1].via}`}` : ""}
            {info?.Expire ? ` · до ${new Date(info.Expire * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}` : ""}
          </small>
        </span>
        <span className="nx-actions">
          <button className="btn btn-sm" disabled={busy === `hc:${cur.name}`} onClick={onHealth}>
            <Icon name="bolt" size={13} /> {busy === `hc:${cur.name}` ? "Проверяю…" : "Проверить узлы"}
          </button>
          {cur.vehicleType === "HTTP" ? (
            <button className="btn btn-sm btn-primary" disabled={busy === cur.name} onClick={onUpdate}>
              <Icon name="refresh" size={14} /> {busy === cur.name ? "Обновляю…" : "Обновить сейчас"}
            </button>
          ) : null}
        </span>
      </div>

      <div className="su-stats">
        <div>
          <small>Узлов</small>
          <b>{rows.length}</b>
          <em>{counts.added ? `${counts.added} без флага в названии` : "все с флагом"}</em>
        </div>
        <div>
          <small>Отвечают</small>
          <b>{alive}</b>
          <em>{cur.adaptive ? (cur.adaptive.mode === "whitelist" ? "сейчас белые списки" : "сейчас обычный режим") : "по последней проверке"}</em>
        </div>
        <div>
          <small>Стран выхода</small>
          <b>{countries.size || "—"}</b>
          <em>по факту, не по названию</em>
        </div>
        <div>
          <small>Флаг не совпал</small>
          <b>{counts.diff}</b>
          <em>{counts.diff ? "название врёт или заглушка" : "расхождений нет"}</em>
        </div>
        <div>
          <small>Трафик</small>
          <b>{used ? bytes(used) : "—"}</b>
          <em>{info?.Total ? `из ${bytes(info.Total)}` : used ? "лимита нет" : ""}</em>
        </div>
      </div>

      <div className="su-tabs" role="tablist">
        {(
          [
            ["nodes", "Узлы и страны"],
            ["overview", "Обзор"],
            ["log", "Журнал"],
            ["settings", "Настройки"],
          ] as Array<[SubTab, string]>
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "is-on" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "nodes" ? (
        <div className="su-block">
          <div className="hub-filters">
            <label className="sr-only" htmlFor="hub-q">
              Найти узел
            </label>
            <input id="hub-q" className="input" placeholder="Узел, страна, город или оператор" value={q} onChange={(e) => setQ(e.target.value)} />
            {(
              [
                ["all", "Все"],
                ["match", "Совпадает"],
                ["diff", "Другая страна"],
                ["added", "Без флага"],
                ["unknown", "Не проверены"],
              ] as Array<[FitFilter, string]>
            ).map(([k, label]) => (
              <button key={k} type="button" className={`vn-chip hub-chip hub-${k}${filter === k ? " is-on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                <i />
                {label} <span className="vs-count">{counts[k]}</span>
              </button>
            ))}
            <button type="button" className="btn btn-sm" disabled={exitsBusy} onClick={() => onExits()}>
              <Icon name="globe" size={13} /> {exitsBusy ? "Проверяю…" : "Проверить страны"}
            </button>
          </div>
          <div className="hub-table" role="table" aria-label="Узлы и страны выхода">
            <div className="hub-row hub-head" role="row">
              <span role="columnheader">Узел</span>
              <span role="columnheader">Выход по факту</span>
              <span role="columnheader" className="nx-hm">
                Оператор · IP
              </span>
              <span role="columnheader">Флаг</span>
              <span role="columnheader" className="nx-hm">
                Задержка
              </span>
              <span role="columnheader" className="nx-hm" />
            </div>
            {shown.slice(0, limit).map((r) => (
              <div key={r.x.name} role="row" className={`hub-row${r.alive ? "" : " is-dim"}`}>
                <span role="cell" className="hub-node">
                  <NodeName name={r.x.name} cc={nodeCC(r.x.name, r.exit, flagMode)} />
                </span>
                <span role="cell" className="hub-exit">
                  <span className="node-name">
                    {r.exit ? <Flag cc={r.exit} /> : <Flag />}
                    <span className="truncate">{r.exit ? countryName(r.exit) : r.fit === "dead" ? "нет ответа" : "не проверен"}</span>
                  </span>
                  <small className="truncate">{r.rec?.city || (r.fit === "dead" ? r.rec?.err || "" : r.exit && !r.rec?.cc ? "по проверке ядра" : "")}</small>
                </span>
                <span role="cell" className="nx-hm hub-isp">
                  <span className="truncate">{r.rec?.isp || "—"}</span>
                  <small className="mono truncate">{r.rec?.ip || ""}</small>
                </span>
                <span role="cell">
                  <span className={`hub-fit hub-fit-${FIT[r.fit].tone}`} title={r.fit === "diff" ? `В названии — ${countryName(r.nameCC)}, выход — ${countryName(r.exit)}` : undefined}>
                    {r.fit === "diff" ? `в названии ${countryName(r.nameCC)}` : FIT[r.fit].label}
                  </span>
                </span>
                <span role="cell" className="nx-hm mono hub-ms">
                  {r.delay && r.delay > 0 ? `${r.delay} мс` : "—"}
                </span>
                <span role="cell" className="nx-hm hub-act">
                  <button type="button" className="btn btn-sm" disabled={exitsBusy || busy === `x:${r.x.name}`} onClick={() => onExits([r.x.name])}>
                    Проверить
                  </button>
                </span>
              </div>
            ))}
            {!shown.length ? <p className="mh-muted hub-empty">Под фильтр ничего не попало.</p> : null}
          </div>
          {shown.length > limit ? (
            <button type="button" className="btn btn-sm" onClick={() => setLimit(limit + 200)}>
              Показать ещё {Math.min(200, shown.length - limit)}
            </button>
          ) : null}
          <small className="mh-muted">
            Как проверяем: через каждый узел открываем ip-api.com (страна, город, оператор), запасной путь — trace Cloudflare. Новые узлы — сразу после обновления подписки, все — ночью.
            {lastCheck ? ` Последняя проверка — ${when(lastCheck)}.` : ""}
          </small>
        </div>
      ) : null}

      {tab === "overview" ? (
        <>
          <section className="su-how">
            <div>
              <span className="vn-eyebrow">Как обновляются подписки</span>
              <p>
                {subsGroup
                  ? "Через группу «Подписки»: сначала напрямую, не ответило — через обходы, потом через каскад. При белых списках список узлов всё равно обновится."
                  : "Напрямую через провайдера. Группу «Подписки» с запасными путями добавляет «Маршрутизация» в настройке."}
              </p>
            </div>
            {subsGroup ? (
              <div className="su-path" aria-label="Порядок путей">
                {(subsGroup.all || []).map((n, i) => (
                  <span key={n} className="su-path-step">
                    {i ? <span className="vn-arrow">→</span> : null}
                    <span className={`su-step${subsGroup.now === n ? " is-cur" : ""}`}>{n === "DIRECT" ? "напрямую" : n}</span>
                  </span>
                ))}
                {subsLeaf && subsLeaf !== "DIRECT" && subsLeaf !== subsGroup.now ? <small>сейчас через {subsLeaf}</small> : null}
              </div>
            ) : null}
          </section>

          <div className="su-block">
            <span className="vn-eyebrow">Страны выхода — по факту, не по названию · нажмите страну</span>
            <div className="su-countries">
              {byCountry.map(([c, v]) => (
                <button
                  key={c}
                  type="button"
                  className="hub-country"
                  onClick={() => {
                    setTab("nodes");
                    setFilter("all");
                    setQ(c === "?" ? "" : countryName(c));
                  }}
                >
                  <span>
                    <span className="node-name">
                      {c === "?" ? <Flag /> : <Flag cc={c} />}
                      {c === "?" ? "не проверена" : countryName(c)}
                    </span>
                    <b>
                      {v.alive} / {v.n}
                    </b>
                  </span>
                  <span className="bar-track">
                    <span className="bar-fill" style={{ width: `${(v.alive / v.n) * 100}%` }} />
                  </span>
                </button>
              ))}
            </div>
            {diffs.length ? (
              <p className="hub-note">
                Название не совпадает с выходом у {diffs.length}:{" "}
                {diffs
                  .slice(0, 4)
                  .map((r) => `«${r.x.name.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "").trim()}» — ${countryName(r.exit)}`)
                  .join(", ")}
                {diffs.length > 4 ? " и другие" : ""}.
              </p>
            ) : null}
          </div>

          <div className="su-block">
            <span className="vn-eyebrow">Узлы за 14 дней · нажмите на день</span>
            {days.length ? (
              <>
                <VpnChart
                  times={dayTimes}
                  kind="bars"
                  height={150}
                  series={[
                    { key: "alive", label: "отвечали", color: "var(--status-good)", values: aliveDays },
                    { key: "dead", label: "не отвечали", color: "var(--series-neutral)", values: total.map((t, k) => (t == null ? null : Math.max(0, t - (aliveDays[k] || 0)))) },
                  ]}
                  format={(v) => String(Math.round(v))}
                  selected={di}
                  onSelect={setSel}
                  bands={wl.map((v) => (v || 0) >= 60)}
                  label="Узлы по дням"
                  xLabel={(t, k) => (k % 2 === 1 ? dm(t) : "")}
                  slotLabel={(t) => dm(t)}
                />
                <ChartTip
                  title={new Date(dayTimes[di] * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "short" })}
                  rows={
                    total[di] == null
                      ? []
                      : [
                          { color: "var(--status-good)", label: "отвечали в среднем", value: String(aliveDays[di]) },
                          { color: "var(--series-neutral)", label: "в подписке", value: String(total[di]) },
                        ]
                  }
                  note={total[di] == null ? "За этот день записей нет." : (wl[di] || 0) >= 60 ? `Белые списки ${Math.round((wl[di] || 0) / 60)} ч: отвечали в основном обходы.` : undefined}
                />
              </>
            ) : (
              <p className="mh-muted">История появится через час: роутер записывает подписки раз в минуту.</p>
            )}
          </div>
        </>
      ) : null}

      {tab === "log" ? (
        <div className="su-block">
          {log.length ? (
            <div className="su-log">
              {[...log].reverse().slice(0, 30).map((u) => (
                <div key={u.t}>
                  <time>{when(u.t)}</time>
                  <i className={`vn-dot vn-${u.via && u.via !== "DIRECT" ? "warn" : "ok"}`} />
                  <span>{u.via ? (u.via === "DIRECT" ? "напрямую" : `через ${u.via}`) : "путь не известен"}</span>
                  <small>
                    {u.total} узлов · отвечали {u.alive}
                    {u.added ? ` · ${u.added > 0 ? "+" : ""}${u.added}` : ""}
                  </small>
                </div>
              ))}
            </div>
          ) : (
            <p className="mh-muted">{cur.vehicleType === "HTTP" ? "Первое обновление появится здесь после ближайшего скачивания подписки." : "Это файл на роутере: он не скачивается, журнала нет."}</p>
          )}
        </div>
      ) : null}

      {tab === "settings" ? (
        <>
          <div className="su-block hub-flags">
            <span className="vn-eyebrow">Флаг рядом с узлом — для всех страниц</span>
            {(
              [
                ["exit", "По стране выхода", "Флаг страны, где узел на самом деле выходит в интернет. Пока не проверен — из названия."],
                ["name", "Как в названии", "Флаг из имени узла, как задумала подписка. У узлов без флага — по стране выхода."],
              ] as Array<[FlagMode, string, string]>
            ).map(([k, label, note]) => (
              <button key={k} type="button" className={`hub-opt${flagMode === k ? " is-on" : ""}`} aria-pressed={flagMode === k} onClick={() => setFlagMode(k)}>
                <i />
                <span>
                  <b>{label}</b>
                  <small>{note}</small>
                </span>
              </button>
            ))}
            <small className="mh-muted">Имена узлов из подписок не меняем — на них держатся фильтры групп. Своим узлам OLCRTC флаг страны выхода дописывается в имя.</small>
          </div>
          <SubSettings name={cur.name} managed={cur.name === "CHAIN" || cur.name === "AI"} onSaved={onSaved} />
        </>
      ) : null}
    </section>
  );
}

type ProviderCfg = { type?: string; url?: string; interval?: number; proxy?: string; filter?: string; "exclude-filter"?: string; path?: string; "health-check"?: { interval?: number; adaptive?: unknown } };

/** «Настройки» of one subscription (NPM-56): the fields people change, checked by mihomo -t before they apply. */
function SubSettings({ name, managed, onSaved }: { name: string; managed: boolean; onSaved: () => void }) {
  const [sha, setSha] = useState("");
  const [all, setAll] = useState<Record<string, ProviderCfg>>({});
  const [form, setForm] = useState<ProviderCfg>({});
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  useEffect(() => {
    setMsg(null);
    setShow(false);
    void core
      .config()
      .then((c) => {
        const providers = ((c.sections || {})["proxy-providers"] || {}) as Record<string, ProviderCfg>;
        setSha(c.sha);
        setAll(providers);
        setForm({ ...(providers[name] || {}) });
      })
      .catch((e) => setMsg({ tone: "bad", text: errText(e) }));
  }, [name]);
  const orig = all[name];
  if (!orig) return <p className="mh-muted">{msg ? msg.text : "Загружаю настройки…"}</p>;
  const isHttp = orig.type === "http";
  const masked = (u?: string) => (u ? u.replace(/^(https?:\/\/[^/]+\/).+$/, "$1••••••••") : "");
  const changed = JSON.stringify(form) !== JSON.stringify(orig);
  const set = (k: keyof ProviderCfg, v: unknown) => setForm((f) => ({ ...f, [k]: v === "" ? undefined : v }));
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const next = { ...all, [name]: Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined)) };
      const res = await core.applyConfig({ sha, set: { "proxy-providers": next } });
      setSha(res.sha);
      setAll(next as Record<string, ProviderCfg>);
      setMsg({ tone: "ok", text: res.message || "Применено" });
      onSaved();
    } catch (e) {
      setMsg({ tone: "bad", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  if (managed)
    return (
      <p className="mh-muted">
        Эту подписку собирает «Маршрутизация» из основной — её настройки меняются там:{" "}
        <a href="#/coreconfig/routing">Настройка → Маршрутизация</a>.
      </p>
    );
  return (
    <div className="su-form">
      {isHttp ? (
        <label className="su-field su-wide">
          <span>Ссылка подписки</span>
          <span className="su-inline">
            <input className="input mono" value={show ? form.url || "" : masked(form.url)} readOnly={!show} onChange={(e) => set("url", e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={() => setShow(!show)}>
              {show ? "Скрыть" : "Показать и изменить"}
            </button>
          </span>
        </label>
      ) : (
        <p className="mh-muted su-wide">Файл на роутере: {orig.path || "—"}. Узлы правятся на своей вкладке.</p>
      )}
      {isHttp ? (
        <label className="su-field">
          <span>Обновлять</span>
          <select className="input" value={String(form.interval || 3600)} onChange={(e) => set("interval", Number(e.target.value))}>
            <option value="3600">раз в час</option>
            <option value="21600">раз в 6 часов</option>
            <option value="43200">раз в 12 часов</option>
            <option value="86400">раз в сутки</option>
          </select>
        </label>
      ) : null}
      {isHttp ? (
        <label className="su-field">
          <span>Скачивать через</span>
          <select className="input" value={form.proxy || ""} onChange={(e) => set("proxy", e.target.value)}>
            <option value="Подписки">Подписки — напрямую, затем обходы и каскад</option>
            <option value="DIRECT">только напрямую</option>
            <option value="">как задано в ядре (напрямую)</option>
          </select>
        </label>
      ) : null}
      <label className="su-field">
        <span>Брать только узлы (регулярное выражение)</span>
        <input className="input mono" placeholder="все" value={form.filter || ""} onChange={(e) => set("filter", e.target.value)} />
      </label>
      <label className="su-field">
        <span>Отсеивать узлы (регулярное выражение)</span>
        <input className="input mono" placeholder="ничего" value={form["exclude-filter"] || ""} onChange={(e) => set("exclude-filter", e.target.value)} />
      </label>
      <div className="nx-actions su-wide">
        <button type="button" className="btn btn-primary" disabled={!changed || busy} onClick={() => void save()}>
          {busy ? "Проверяю и применяю…" : "Проверить и применить"}
        </button>
        <button type="button" className="btn" disabled={!changed || busy} onClick={() => setForm({ ...orig })}>
          Отменить
        </button>
        <a className="btn" href="#/coreconfig/providers">
          Все параметры
        </a>
      </div>
      {msg ? <p className={msg.tone === "ok" ? "su-ok" : "vn-err"}>{msg.text}</p> : null}
      <small className="mh-muted su-wide">Перед применением конфиг проверяется mihomo -t, старый сохраняется копией; при ошибке ничего не меняется.</small>
    </div>
  );
}
