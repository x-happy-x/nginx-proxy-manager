import { useCallback, useEffect, useMemo, useState } from "react";
import { FlagText } from "../../components/ui/Flag";
import { PageHeader, type PageKey } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { analyzeTarget } from "../../api";
import { bytes, errText, number } from "../../lib/format";
import { core, mihomo, type GroupLatency, type MProxy, type MRule, type TrafficReport } from "./api";
import { lastDelay } from "./shared";
import { ChartTip, VC_COLORS, VpnChart, hh, intoSlots, slots } from "./VpnCharts";

/*
 * VPN → «Маршрутизация» (NPM-51): where an address goes (rule → group →
 * node), how today's connections split between the groups, the rules in order
 * with their hits, and the chosen group: its options in order, which one
 * works, its delay over the day and a manual pin.
 */

type Period = "24h" | "7d" | "30d";
type Measure = "count" | "bytes";
const RECENT_KEY = "homenet.route.recent";
const EXAMPLES = ["youtube.com", "gosuslugi.ru", "chatgpt.com", "t.me", "steampowered.com"];

function leaf(name: string, proxies: Record<string, MProxy>): MProxy | undefined {
  let cur = proxies[name];
  for (let i = 0; cur && cur.now && i < 10; i++) {
    const next: MProxy | undefined = proxies[cur.now];
    if (!next) return { name: cur.now, type: "", history: [] } as MProxy;
    cur = next;
  }
  return cur;
}
const isGroup = (p?: MProxy) => !!p?.all;
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1).replace(".", ",")} с` : `${Math.round(v)} мс`);

export function VpnRoute({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [rules, setRules] = useState<MRule[]>([]);
  const [dims, setDims] = useState<TrafficReport["dims"]>({});
  const [lat, setLat] = useState<Record<string, GroupLatency[]>>({});
  const [period, setPeriod] = useState<Period>("24h");
  const [measure, setMeasure] = useState<Measure>("count");
  const [group, setGroup] = useState("AUTO");
  const [q, setQ] = useState("");
  const [onlyGroup, setOnlyGroup] = useState(false);
  const [host, setHost] = useState("");
  const [route, setRoute] = useState<{ host: string; rule: string; chain: string[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [sel, setSel] = useState(23);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") as string[];
    } catch {
      return [];
    }
  });

  const pull = useCallback(() => {
    void mihomo
      .allProxies()
      .then((r) => setProxies(r.proxies))
      .catch((e) => setMsg(errText(e)));
    void mihomo
      .rules()
      .then((r) => setRules(r.rules || []))
      .catch(() => undefined);
    void core
      .groups("24h")
      .then((r) => setLat(r.groups || {}))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), 60000);
    return () => clearInterval(t);
  }, [pull]);
  useEffect(() => {
    void core
      .traffic(period)
      .then((r) => setDims(r.dims || {}))
      .catch(() => undefined);
  }, [period]);

  const test = async (value = host) => {
    const h = value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!h || testing) return;
    setHost(h);
    setTesting(true);
    setMsg("");
    try {
      const a = await analyzeTarget(h, ["mihomo"]);
      const via = a.paths.find((p) => p.id === "mihomo");
      const chain = via?.chain || a.clients.chain || [];
      setRoute({ host: h, rule: via?.rule || a.clients.rule || "", chain });
      if (chain.length) setGroup(chain[0]);
      const next = [h, ...recent.filter((x) => x !== h)].slice(0, 5);
      setRecent(next);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* a remembered list is a convenience */
      }
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setTesting(false);
    }
  };

  // today's connections by the group that took them
  const share = useMemo(() => {
    const rows = (dims.group || []).filter((r) => r.key);
    const val = (r: { up: number; down: number; count: number }) => (measure === "count" ? r.count : r.up + r.down);
    const total = rows.reduce((a, r) => a + val(r), 0) || 1;
    const sorted = [...rows].sort((a, b) => val(b) - val(a));
    const top = sorted.slice(0, 9);
    const rest = sorted.slice(9).reduce((a, r) => a + val(r), 0);
    const out = top.map((r, k) => ({ key: r.key, value: val(r), pct: (val(r) / total) * 100, color: VC_COLORS[k % VC_COLORS.length] }));
    if (rest) out.push({ key: "", value: rest, pct: (rest / total) * 100, color: "var(--series-neutral)" });
    return out;
  }, [dims, measure]);

  const maxHits = Math.max(1, ...rules.map((r) => r.extra?.hitCount || 0));
  const routeRule = route?.rule.replace(/\s*\(.*\)$/, "") || "";
  const routePayload = route?.rule.match(/\((.*)\)$/)?.[1] || "";
  const shownRules = rules.filter(
    (r) => (!onlyGroup || r.proxy === group) && (!q || `${r.type} ${r.payload} ${r.proxy}`.toLowerCase().includes(q.toLowerCase())),
  );

  const g = proxies[group];
  const gLeaf = g ? leaf(group, proxies) : undefined;
  const members = (g?.all || []).map((name) => {
    const p = proxies[name];
    const l = isGroup(p) ? leaf(name, proxies) : p;
    const d = l ? lastDelay(l, g?.testUrl) : null;
    return { name, group: isGroup(p), leaf: l?.name || name, delay: d, now: g?.now === name, fixed: g?.fixed === name };
  });
  const groupNames = useMemo(() => Object.values(proxies).filter((p) => isGroup(p) && !p.hidden && p.name !== "GLOBAL").map((p) => p.name), [proxies]);

  const pin = async (name: string) => {
    setBusy(name);
    setMsg("");
    try {
      await mihomo.select(group, name);
      setMsg(`«${group}» закреплена на «${name}». Снимется само, если вариант перестанет отвечать.`);
      pull();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy("");
    }
  };
  const unpin = async () => {
    setBusy("unpin");
    try {
      await mihomo.unfix(group);
      setMsg(`«${group}» снова выбирает сама.`);
      pull();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy("");
    }
  };

  const times = useMemo(() => slots(24, 3600), []);
  const gLat = intoSlots(times, 3600, lat[group] || [], (pts) => {
    const ok = pts.filter((p) => p.ms > 0);
    return ok.length ? Math.round(ok.reduce((a, p) => a + p.ms, 0) / ok.length) : null;
  });
  const gFail = intoSlots(times, 3600, lat[group] || [], (pts) => pts.reduce((a, p) => a + p.fail, 0));
  const gNode = intoSlots(times, 3600, lat[group] || [], () => 0).map((_, k) => {
    const pts = (lat[group] || []).filter((p) => p.t >= times[k] && p.t < times[k] + 3600);
    return pts.length ? pts[pts.length - 1].node || "" : "";
  });
  const si = Math.min(sel, times.length - 1);

  return (
    <div className="stack vn">
      <PageHeader page="vroute" />

      <section className="vr-test" aria-label="Куда пойдёт адрес">
        <h3>Куда пойдёт адрес</h3>
        <form
          className="vr-test-row"
          onSubmit={(e) => {
            e.preventDefault();
            void test();
          }}
        >
          <label className="sr-only" htmlFor="vr-host">
            Сайт или IP
          </label>
          <input id="vr-host" className="input" value={host} placeholder="сайт или IP, например t.me" onChange={(e) => setHost(e.target.value)} />
          <button className="btn btn-primary" disabled={testing || !host.trim()}>
            {testing ? "Проверяю…" : "Проверить"}
          </button>
        </form>
        <div className="vn-chips">
          {(recent.length ? recent : EXAMPLES).map((h) => (
            <button key={h} type="button" className="vn-chip" onClick={() => void test(h)}>
              {h}
            </button>
          ))}
        </div>
        {route ? (
          <div className="vr-result">
            <b className="mono">{route.host}</b>
            <span className="vn-arrow">→</span>
            <span>
              правило <span className="mono">{route.rule || "не определено"}</span>
            </span>
            {route.chain.map((c, k) => (
              <span key={`${c}-${k}`} className="vr-result-step">
                <span className="vn-arrow">→</span>
                {k === 0 ? (
                  <button type="button" className="vr-gchip" onClick={() => setGroup(c)}>
                    {c}
                  </button>
                ) : (
                  <b>{c === "DIRECT" ? "напрямую" : c}</b>
                )}
              </span>
            ))}
            {!route.chain.length ? <span className="mh-muted">mihomo не показал цепочку — соединение закрылось слишком быстро.</span> : null}
          </div>
        ) : null}
        {msg ? <p className="mh-muted">{msg}</p> : null}
      </section>

      <section className="vn-section vr-share" aria-label="Соединения по группам">
        <div className="vn-section-head">
          <h3>
            {measure === "count" ? "Соединения" : "Трафик"} по группам <span>· нажмите на часть полосы</span>
          </h3>
          <div className="vn-chips">
            {(["count", "bytes"] as Measure[]).map((m) => (
              <button key={m} className={`vn-chip${measure === m ? " is-on" : ""}`} aria-pressed={measure === m} onClick={() => setMeasure(m)}>
                {m === "count" ? "соединения" : "трафик"}
              </button>
            ))}
            {(["24h", "7d", "30d"] as Period[]).map((p) => (
              <button key={p} className={`vn-chip${period === p ? " is-on" : ""}`} aria-pressed={period === p} onClick={() => setPeriod(p)}>
                {p === "24h" ? "сутки" : p === "7d" ? "7 дней" : "30 дней"}
              </button>
            ))}
          </div>
        </div>
        {share.length ? (
          <>
            <div className="vr-bar">
              {share.map((s) => (
                <button
                  key={s.key || "rest"}
                  type="button"
                  disabled={!s.key}
                  className={s.key === group ? "is-sel" : ""}
                  style={{ flexGrow: s.value, background: s.color }}
                  aria-label={`${s.key || "остальные"}: ${s.pct.toFixed(1)}%`}
                  aria-pressed={s.key === group}
                  onClick={() => s.key && setGroup(s.key)}
                />
              ))}
            </div>
            <div className="vr-bar-legend">
              {share.map((s) => (
                <button key={s.key || "rest"} type="button" disabled={!s.key} onClick={() => s.key && setGroup(s.key)}>
                  <i style={{ background: s.color }} />
                  <span>{s.key || "остальные"}</span>
                  <b>{s.pct < 1 ? "<1" : Math.round(s.pct)}%</b>
                  <small>{measure === "count" ? number(s.value) : bytes(s.value)}</small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="mh-muted">Разбивка по группам собирается роутером — появится после первых соединений.</p>
        )}
      </section>

      <div className="vr-layout">
        <section className="vr-rules" aria-label="Правила">
          <div className="vn-section-head">
            <h3>
              Правила по порядку <span>· срабатывает первое подходящее</span>
            </h3>
            <div className="vr-rules-tools">
              <label className="sr-only" htmlFor="vr-q">
                Найти правило
              </label>
              <input id="vr-q" className="input input-sm" placeholder="найти" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className={`vn-chip${onlyGroup ? " is-on" : ""}`} aria-pressed={onlyGroup} onClick={() => setOnlyGroup(!onlyGroup)}>
                только «{group}»
              </button>
            </div>
          </div>
          <div className="vr-rule-list">
            {shownRules.slice(0, 300).map((r) => {
              const hit = !!route && r.type === routeRule && (!routePayload || r.payload === routePayload);
              const hits = r.extra?.hitCount || 0;
              return (
                <button
                  key={r.index}
                  type="button"
                  className={`vr-rule${r.proxy === group ? " is-sel" : ""}${hit ? " is-hit" : ""}${r.disabled || r.extra?.disabled ? " is-off" : ""}`}
                  onClick={() => setGroup(r.proxy)}
                >
                  <span className="vr-rule-no">{r.index + 1}</span>
                  <span className="vr-rule-what">
                    <span className="mono">{r.type}</span>
                    <small className="truncate">{r.payload || "всё остальное"}</small>
                  </span>
                  <span className="vr-gchip">{r.proxy}</span>
                  <span className="vr-rule-hits">
                    <small>{hits ? number(hits) : "—"}</small>
                    <span className="bar-track">
                      <span className="bar-fill" style={{ width: `${(hits / maxHits) * 100}%` }} />
                    </span>
                  </span>
                </button>
              );
            })}
            {!rules.length ? <p className="mh-muted">Ядро не отдало правила.</p> : null}
          </div>
        </section>

        <aside className="vs-panel vr-group" aria-label={`Группа ${group}`}>
          <div className="vs-panel-head">
            <span className="vn-card-name">
              <span className="vn-eyebrow">Группа</span>
              <b>{group}</b>
              <small>
                {g ? `${g.type}${gLeaf ? ` · сейчас ${gLeaf.name === "DIRECT" ? "напрямую" : gLeaf.name}` : ""}` : "нет в ядре"}
              </small>
            </span>
            <label className="sr-only" htmlFor="vr-group">
              Другая группа
            </label>
            <select id="vr-group" className="input input-sm" value={group} onChange={(e) => setGroup(e.target.value)}>
              {groupNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          {g?.fixed ? (
            <div className="vr-fixed">
              <Icon name="lock" size={14} />
              <span>
                Закреплена на «{g.fixed}» вручную
              </span>
              <button className="btn btn-sm" disabled={busy === "unpin"} onClick={() => void unpin()}>
                Снять
              </button>
            </div>
          ) : null}
          <span className="vn-eyebrow">Порядок выбора</span>
          <div className="vr-members">
            {members.map((m, k) => (
              <div key={m.name} className={`vr-member${m.now ? " is-now" : ""}`}>
                <span className="vr-rule-no">{k + 1}</span>
                <span className="vn-card-name">
                  <b>{m.name === "DIRECT" ? "напрямую" : <FlagText text={m.name} />}</b>
                  <small>
                    {m.group ? <FlagText text={m.leaf} /> : "узел"}
                    {m.delay == null ? "" : m.delay > 0 ? ` · ${ms(m.delay)}` : " · не отвечает"}
                  </small>
                </span>
                {m.now ? <span className="vn-pill vn-ok">выбран</span> : m.delay === 0 ? <span className="vn-pill vn-bad">не отвечает</span> : null}
                {g?.type !== "URLTest" && !m.now ? (
                  <button className="btn btn-sm" disabled={busy === m.name || m.delay === 0} onClick={() => void pin(m.name)}>
                    Закрепить
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <small className="mh-muted">
            Группа берёт первый живой вариант сверху. Порядок задаёт{" "}
            <a href="#/coreconfig/routing" onClick={(e) => (e.preventDefault(), onNavigate("coreconfig"))}>
              «Настройка → Маршрутизация»
            </a>
            .
          </small>
          <span className="vn-eyebrow">Задержка за сутки</span>
          {gLat.some((v) => v != null) || gFail.some((v) => (v || 0) > 0) ? (
            <>
              <VpnChart
                times={times}
                kind="line"
                height={120}
                series={[{ key: group, label: group, color: "var(--vc-a)", values: gLat }]}
                format={ms}
                selected={si}
                onSelect={setSel}
                label={`Задержка группы ${group}`}
                xLabel={(t, k) => (k % 6 === 0 ? hh(t) : "")}
                slotLabel={(t) => hh(t)}
              />
              <ChartTip
                title={`${hh(times[si])}–${si === times.length - 1 ? "сейчас" : hh(times[si] + 3600)}`}
                rows={[
                  { color: "var(--vc-a)", label: "задержка", value: gLat[si] == null ? "не отвечала" : ms(gLat[si] as number) },
                  { color: "var(--status-critical)", label: "неудачных проверок", value: String(gFail[si] || 0) },
                ]}
                note={gNode[si] ? `узел: ${gNode[si]}` : undefined}
              />
            </>
          ) : (
            <p className="mh-muted">Роутер записывает задержку групп раз в минуту — график заполнится за час.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
