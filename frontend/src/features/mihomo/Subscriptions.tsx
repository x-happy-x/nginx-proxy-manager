import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { bytes, errText } from "../../lib/format";
import { core, mihomo, type HealthPoint, type MProvider, type MProxy, type ProviderUpdate } from "./api";
import { ChartTip, VpnChart, dm, intoSlots, slots } from "./VpnCharts";
import { Pill, type Tone } from "./VpnOverview";
import { useNodeRows } from "./Nodes";
import { useStored } from "./NodeTiles";

type SubView = "cards" | "table";
type SubTab = "overview" | "nodes" | "log" | "settings";

/*
 * VPN → «Подписки» (NPM-51): each subscription — how many nodes and how many
 * answer, its traffic and term, when it was updated and by which path, and
 * its nodes by day and by country.
 */

const SUBS_GROUP = "Подписки";
const ago = (sec: number) => (sec < 90 ? "только что" : sec < 3600 ? `${Math.round(sec / 60)} мин назад` : sec < 86400 ? `${Math.floor(sec / 3600)} ч назад` : `${Math.floor(sec / 86400)} дн назад`);
const ts = (iso?: string) => (iso ? new Date(iso).getTime() / 1000 : 0);

/** Country of a node: the fork's verified exit, else the flag in its name. */
function countryOf(p: MProvider, node: MProxy): string {
  const verified = p.adaptive?.results?.[node.name]?.country;
  if (verified) return verified.toUpperCase();
  const flag = [...node.name].filter((c) => {
    const cp = c.codePointAt(0) || 0;
    return cp >= 0x1f1e6 && cp <= 0x1f1ff;
  });
  if (flag.length >= 2) return flag.slice(0, 2).map((c) => String.fromCharCode((c.codePointAt(0) || 0) - 0x1f1e6 + 65)).join("");
  return "";
}

const COUNTRY: Record<string, string> = {
  RU: "Россия", LT: "Литва", LV: "Латвия", EE: "Эстония", DE: "Германия", NL: "Нидерланды", FI: "Финляндия", PL: "Польша", SE: "Швеция", FR: "Франция", GB: "Великобритания",
  US: "США", CA: "Канада", TR: "Турция", KZ: "Казахстан", AM: "Армения", GE: "Грузия", AE: "ОАЭ", JP: "Япония", SG: "Сингапур", HK: "Гонконг", AT: "Австрия", CH: "Швейцария",
  CZ: "Чехия", MD: "Молдова", UA: "Украина", BY: "Беларусь", IT: "Италия", ES: "Испания", RO: "Румыния", BG: "Болгария", HU: "Венгрия", IL: "Израиль", IN: "Индия",
};

function leafOf(name: string, proxies: Record<string, MProxy>): string {
  let cur = proxies[name];
  for (let i = 0; cur && cur.now && i < 10; i++) {
    if (!proxies[cur.now]) return cur.now;
    cur = proxies[cur.now];
  }
  return cur?.name || "";
}

export function Subscriptions() {
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [log, setLog] = useState<Record<string, ProviderUpdate[]>>({});
  const [pick, setPick] = useState("");
  const [days, setDays] = useState<HealthPoint[]>([]);
  const [sel, setSel] = useState(13);
  const [busy, setBusy] = useState("");
  const [view, setView] = useStored<SubView>("homenet.subs.view", "cards", (v): v is SubView => v === "cards" || v === "table");
  const [tab, setTab] = useState<SubTab>("overview");
  const [err, setErr] = useState("");

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
        .filter((p) => p.vehicleType === "HTTP" || p.vehicleType === "File")
        .sort((a, b) => b.proxies.length - a.proxies.length),
    [providers],
  );
  const cur = subs.find((p) => p.name === pick) || subs[0];
  useEffect(() => {
    if (!cur) return;
    void core
      .health(cur.name, "30d")
      .then((r) => setDays(r.provider === cur.name ? r.series : []))
      .catch(() => setDays([]));
  }, [cur?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = async (name: string) => {
    setBusy(name);
    setErr("");
    try {
      await mihomo.updateProvider(name);
      pull();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  const healthcheck = async (name: string) => {
    setBusy(`hc:${name}`);
    try {
      await mihomo.healthcheck(name);
      pull();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };
  const updateAll = async () => {
    setBusy("all");
    setErr("");
    await Promise.all(subs.filter((p) => p.vehicleType === "HTTP").map((p) => mihomo.updateProvider(p.name).catch((e) => setErr(errText(e)))));
    pull();
    setBusy("");
  };
  const kindOf = (p: MProvider) => (p.name === "CHAIN" ? "каскады: копия основной через обходы" : p.name === "AI" ? "копия основной для ИИ" : p.vehicleType === "HTTP" ? "подписка по ссылке" : "файл на роутере");
  const nodeRowsMap = useNodeRows({}, cur ? { [cur.name]: cur } : {}, [], {});
  const nodeRows = [...nodeRowsMap.values()];
  const now = Date.now() / 1000;
  const subsGroup = proxies[SUBS_GROUP];
  const subsLeaf = subsGroup ? leafOf(SUBS_GROUP, proxies) : "";

  const state = (p: MProvider): { tone: Tone; text: string } => {
    if (p.vehicleType !== "HTTP") return { tone: "idle", text: "свой файл" };
    const age = now - ts(p.updatedAt);
    const last = log[p.name]?.[log[p.name].length - 1];
    if (!p.updatedAt) return { tone: "idle", text: "ещё не скачана" };
    if (age > 3 * 3600) return { tone: "warn", text: `не обновлялась ${Math.floor(age / 3600)} ч` };
    if (last?.via && last.via !== "DIRECT") return { tone: "warn", text: "только через обходы" };
    return { tone: "ok", text: "обновляется" };
  };

  // 14 days: nodes in the subscription and how many answered, by day
  const dayTimes = useMemo(() => slots(14, 86400), []);
  const total = intoSlots(dayTimes, 86400, days, (pts) => Math.max(...pts.map((p) => p.total)));
  const alive = intoSlots(dayTimes, 86400, days, (pts) => Math.round(pts.reduce((a, p) => a + p.working, 0) / pts.length));
  const wl = intoSlots(dayTimes, 86400, days, (pts) => pts.reduce((a, p) => a + p.whitelist, 0));
  const di = Math.min(sel, dayTimes.length - 1);

  const countries = useMemo(() => {
    if (!cur) return [];
    const m = new Map<string, { n: number; alive: number }>();
    cur.proxies.forEach((x) => {
      const c = countryOf(cur, x) || "?";
      const e = m.get(c) || { n: 0, alive: 0 };
      e.n++;
      const r = cur.adaptive?.results?.[x.name];
      if (r ? (r.available ?? r.ok) : x.alive) e.alive++;
      m.set(c, e);
    });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [cur]);
  const aliveNow = (p: MProvider) => (p.adaptive ? Object.values(p.adaptive.results || {}).filter((r) => !r.skipped && (r.available ?? r.ok)).length : p.proxies.filter((x) => x.alive).length);

  return (
    <div className="stack vn">
      <PageHeader page="subs" />
      {err ? <p className="vn-err">{err}</p> : null}

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

      <div className="su-toolbar">
        <div className="nx-views" role="group" aria-label="Вид">
          {(
            [
              ["cards", "Карточки"],
              ["table", "Таблица"],
            ] as Array<[SubView, string]>
          ).map(([k, label]) => (
            <button key={k} type="button" className={view === k ? "is-on" : ""} aria-pressed={view === k} onClick={() => setView(k)}>
              {label}
            </button>
          ))}
        </div>
        <span className="su-toolbar-gap" />
        <button type="button" className="btn" disabled={busy === "all"} onClick={() => void updateAll()}>
          <Icon name="refresh" size={14} /> {busy === "all" ? "Обновляю…" : "Обновить все"}
        </button>
        <a className="btn btn-primary" href="#/coreconfig/providers">
          <Icon name="plus" size={14} /> Добавить подписку
        </a>
      </div>

      {view === "cards" ? (
        <div className="su-cards">
          {subs.map((p) => {
            const st = state(p);
            const info = p.subscriptionInfo;
            const used = (info?.Download || 0) + (info?.Upload || 0);
            const on = p.name === cur?.name;
            const a = aliveNow(p);
            return (
              <button key={p.name} className={`vn-card su-card${on ? " is-sel" : ""}`} aria-pressed={on} onClick={() => setPick(p.name)}>
                <span className="vn-card-top">
                  <span className="vn-card-name">
                    <b>{p.name}</b>
                    <small>{kindOf(p)}</small>
                  </span>
                  <Pill tone={st.tone}>{st.text}</Pill>
                </span>
                <span className="su-big">
                  <b>{a}</b> из {p.proxies.length} отвечают
                </span>
                <span className="su-split" aria-hidden="true">
                  <span style={{ width: `${p.proxies.length ? (a / p.proxies.length) * 100 : 0}%` }} />
                </span>
                {info?.Total ? (
                  <span className="su-quota">
                    <span>
                      <small>Трафик подписки</small>
                      <small>
                        {bytes(used)} из {bytes(info.Total)}
                      </small>
                    </span>
                    <span className="bar-track">
                      <span className={`bar-fill${used / info.Total > 0.9 ? " is-bad" : used / info.Total > 0.75 ? " is-warn" : ""}`} style={{ width: `${Math.min(100, (used / info.Total) * 100)}%` }} />
                    </span>
                  </span>
                ) : null}
                <span className="vn-card-foot">
                  <span>{p.updatedAt ? `обновлена ${ago(now - ts(p.updatedAt))}` : p.vehicleType === "HTTP" ? "не скачивалась" : "свой файл"}</span>
                  <span>{info?.Expire ? `до ${new Date(info.Expire * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}` : ""}</span>
                </span>
              </button>
            );
          })}
          {!subs.length ? <p className="mh-muted">Подписок в конфиге нет. Добавьте ссылку в «Настройке».</p> : null}
        </div>
      ) : (
        <div className="su-table" role="table" aria-label="Подписки">
          <div className="su-trow su-thead" role="row">
            <span role="columnheader">Подписка</span>
            <span role="columnheader">Отвечают</span>
            <span role="columnheader" className="nx-hm">
              Трафик
            </span>
            <span role="columnheader" className="nx-hm">
              Обновлена
            </span>
            <span role="columnheader" className="nx-hm">
              Срок
            </span>
            <span role="columnheader">Состояние</span>
          </div>
          {subs.map((p) => {
            const st = state(p);
            const info = p.subscriptionInfo;
            const used = (info?.Download || 0) + (info?.Upload || 0);
            return (
              <button key={p.name} type="button" role="row" className={`su-trow${p.name === cur?.name ? " is-sel" : ""}`} onClick={() => setPick(p.name)}>
                <span role="cell" className="su-tname">
                  <b className="truncate">{p.name}</b>
                  <small className="truncate">{kindOf(p)}</small>
                </span>
                <span role="cell" className="mono">
                  {aliveNow(p)} / {p.proxies.length}
                </span>
                <span role="cell" className="nx-hm mono">
                  {info?.Total ? `${Math.round((used / info.Total) * 100)}%` : used ? bytes(used) : "—"}
                </span>
                <span role="cell" className="nx-hm">
                  {p.updatedAt ? ago(now - ts(p.updatedAt)) : "—"}
                </span>
                <span role="cell" className="nx-hm">
                  {info?.Expire ? new Date(info.Expire * 1000).toLocaleDateString("ru-RU") : "—"}
                </span>
                <span role="cell">
                  <Pill tone={st.tone}>{st.text}</Pill>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {cur ? (
        <section className="su-detail" aria-label={cur.name}>
          <div className="su-detail-head">
            <span className="vn-card-name">
              <b>{cur.name}</b>
              <small>
                {cur.updatedAt ? `обновлена ${ago(now - ts(cur.updatedAt))}` : kindOf(cur)}
                {log[cur.name]?.length && log[cur.name][log[cur.name].length - 1].via ? ` · через ${log[cur.name][log[cur.name].length - 1].via}` : ""}
              </small>
            </span>
            <span className="nx-actions">
              <button className="btn btn-sm" disabled={busy === `hc:${cur.name}`} onClick={() => void healthcheck(cur.name)}>
                <Icon name="bolt" size={13} /> {busy === `hc:${cur.name}` ? "Проверяю…" : "Проверить узлы"}
              </button>
              {cur.vehicleType === "HTTP" ? (
                <button className="btn btn-sm btn-primary" disabled={busy === cur.name} onClick={() => void update(cur.name)}>
                  <Icon name="refresh" size={14} /> {busy === cur.name ? "Обновляю…" : "Обновить сейчас"}
                </button>
              ) : null}
            </span>
          </div>
          <div className="su-tabs" role="tablist">
            {(
              [
                ["overview", "Обзор"],
                ["nodes", `Узлы · ${cur.proxies.length}`],
                ["log", "Журнал обновлений"],
                ["settings", "Настройки"],
              ] as Array<[SubTab, string]>
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "is-on" : ""} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>

          {tab === "overview" ? (
            <>
              <div className="su-stats">
                <div>
                  <small>Узлов</small>
                  <b>{cur.proxies.length}</b>
                </div>
                <div>
                  <small>Отвечают</small>
                  <b>{aliveNow(cur)}</b>
                </div>
                <div>
                  <small>Стран</small>
                  <b>{countries.filter(([c]) => c !== "?").length || "—"}</b>
                </div>
                <div>
                  <small>Проверка</small>
                  <b>{cur.adaptive ? "адаптивная" : "обычная"}</b>
                </div>
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
                        { key: "alive", label: "отвечали", color: "var(--status-good)", values: alive },
                        { key: "dead", label: "не отвечали", color: "var(--series-neutral)", values: total.map((t, k) => (t == null ? null : Math.max(0, t - (alive[k] || 0)))) },
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
                              { color: "var(--status-good)", label: "отвечали в среднем", value: String(alive[di]) },
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

              <div className="su-block">
                <span className="vn-eyebrow">Страны выхода</span>
                <div className="su-countries">
                  {countries.map(([c, v]) => (
                    <div key={c}>
                      <span>
                        <span>{c === "?" ? "не известна" : `${COUNTRY[c] || c}`}</span>
                        <b>
                          {v.alive} / {v.n}
                        </b>
                      </span>
                      <span className="bar-track">
                        <span className="bar-fill" style={{ width: `${(v.alive / v.n) * 100}%` }} />
                      </span>
                    </div>
                  ))}
                </div>
                {cur.adaptive ? null : <small className="mh-muted">Страна — по флагу в названии узла; у адаптивной подписки — по факту выхода.</small>}
              </div>
            </>
          ) : null}

          {tab === "nodes" ? (
            <div className="su-block">
              <span className="mh-muted">
                Узлы только этой подписки. Сравнить с другими и закрепить в группе — на вкладке{" "}
                <a href="#/proxies" onClick={() => undefined}>
                  «Узлы»
                </a>
                .
              </span>
              <div className="nx-tiles">
                {nodeRows.map((r) => (
                  <span key={r.name} className={`nx-tile nx-t-${r.state}`} title={r.note}>
                    <span className="nx-tile-top">
                      {r.country ? <span className="nx-cc">{r.country}</span> : null}
                      <b className="truncate">{r.name}</b>
                    </span>
                    <span className="nx-tile-foot">
                      <span className={`nx-pill nx-${r.state}`}>{r.state === "ok" ? "живой" : r.state === "slow" ? "медленно" : r.state === "out" ? "снят" : r.state === "reset" ? "сброс" : r.state === "silent" ? "молчит" : "не проверялся"}</span>
                      <span className="mono">{r.delay && r.delay > 0 ? `${r.delay} мс` : ""}</span>
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "log" ? (
            <div className="su-block">
              {log[cur.name]?.length ? (
                <div className="su-log">
                  {[...log[cur.name]].reverse().slice(0, 30).map((u) => (
                    <div key={u.t}>
                      <time>{new Date(u.t * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
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

          {tab === "settings" ? <SubSettings name={cur.name} managed={cur.name === "CHAIN" || cur.name === "AI"} onSaved={pull} /> : null}
        </section>
      ) : null}
    </div>
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
