import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Segmented } from "../../components/ui/controls";
import { timeTicks } from "../../components/charts/smooth";
import { TimeAxis } from "../../components/charts/TimeChart";
import { bytes, dateTime, errText } from "../../lib/format";
import { core, mihomo, type BypassReport, type RoutePoint, type TrafficReport } from "./api";
import { useMihomo } from "./context";

/*
 * «Трафик → Через обходы» (NPM-36): how much went through bypass nodes
 * (limited traffic), the cascade (spends it too), other servers and directly,
 * who spends it, and the monthly limit.
 */

type Period = "24h" | "30d";
const KINDS: Array<[keyof Omit<RoutePoint, "t">, string, string]> = [
  ["direct", "DIRECT", "var(--series-neutral)"],
  ["proxy", "прямые серверы", "var(--series-1)"],
  ["bypass", "обходы", "var(--warning)"],
  ["chain", "каскад", "var(--series-2)"],
];

const sum = (p: RoutePoint) => p.direct + p.proxy + p.bypass + p.chain;
const GB = 1024 ** 3;

function LimitEditor({ gb, day, onSaved }: { gb: number; day: number; onSaved: () => void }) {
  const { log } = useMihomo();
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(String(gb || ""));
  const [d, setD] = useState(day);
  if (!edit)
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(true)}>
        {gb ? "Изменить" : "Задать лимит"}
      </button>
    );
  return (
    <span className="bt-limit-edit">
      <label>
        <span className="sr-only">Лимит, ГБ</span>
        <input type="number" min={0} max={100000} value={v} onChange={(e) => setV(e.target.value)} placeholder="ГБ" />
      </label>
      <span className="cell-sub">ГБ, сброс</span>
      <label>
        <span className="sr-only">День сброса</span>
        <select value={d} onChange={(e) => setD(Number(e.target.value))}>
          {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}-го
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={async () => {
          try {
            await core.setBypassLimit(Math.max(0, Math.round(Number(v) || 0)), d);
            setEdit(false);
            onSaved();
          } catch (err) {
            log("Лимит обходов", errText(err), "error");
          }
        }}
      >
        Сохранить
      </button>
    </span>
  );
}

export function BypassTraffic() {
  const { deviceName } = useMihomo();
  const [period, setPeriod] = useState<Period>("30d");
  const [rep, setRep] = useState<BypassReport | null>(null);
  const [dims, setDims] = useState<TrafficReport["dims"] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [b, t] = await Promise.all([core.bypassTraffic(period), core.traffic(period)]);
      setRep(b);
      setDims(t.dims);
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, [period]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60000);
    return () => clearInterval(t);
  }, [load]);

  const total = rep ? sum(rep.total) : 0;
  const pct = (v: number) => (total ? `${Math.round((v / total) * 100)}%` : "—");
  // a fixed grid: 30 days or 24 hours, empty slots stay at zero
  const slots = useMemo(() => {
    const series = rep?.series || [];
    if (!series.length) return [];
    const step = period === "30d" ? 86400 : 3600;
    const count = period === "30d" ? 30 : 24;
    const last = series[series.length - 1].t;
    const byT = new Map(series.map((p) => [p.t, p]));
    return Array.from({ length: count }, (_, i) => {
      const t = last - (count - 1 - i) * step;
      return byT.get(t) || { t, direct: 0, proxy: 0, bypass: 0, chain: 0 };
    });
  }, [rep, period]);
  const peak = useMemo(() => Math.max(1, ...slots.map(sum)), [slots]);
  const top = (dims?.bypass_use || []).slice(0, 8).map((r) => {
    const [ip, site, group] = r.key.split("|");
    return { ip, site, group, value: r.up + r.down };
  });
  const lim = rep?.limit;
  const limPct = lim && lim.gb ? Math.min(100, (lim.used / (lim.gb * GB)) * 100) : 0;

  return (
    <div className="stack">
      {error ? <Alert tone="warning" title="Роутер не отдал учёт трафика">{error}</Alert> : null}
      <div className="bt-grid">
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Сколько ушло через обходы</h2>
              <p className="cell-sub">Считает роутер по узлу каждого соединения. Обходы — по словам из «Маршрутизации».</p>
            </div>
            <Segmented<Period>
              label="Период"
              value={period}
              onChange={setPeriod}
              options={[
                { value: "24h", label: "Сутки" },
                { value: "30d", label: "30 дней" },
              ]}
            />
          </div>
          <div className="card-body stack">
            <div className="bt-stats">
              <div>
                <small>Через обходы</small>
                <b>{bytes(rep?.total.bypass)}</b>
                <em className="is-warn">{pct(rep?.total.bypass || 0)} всего трафика</em>
              </div>
              <div>
                <small>Через каскад</small>
                <b>{bytes(rep?.total.chain)}</b>
                <em>тоже тратит обход</em>
              </div>
              <div>
                <small>Прямые серверы</small>
                <b>{bytes(rep?.total.proxy)}</b>
                <em>{pct(rep?.total.proxy || 0)}</em>
              </div>
              <div>
                <small>DIRECT</small>
                <b>{bytes(rep?.total.direct)}</b>
                <em>РФ, белые списки, игры</em>
              </div>
            </div>
            <div className="bt-limit">
              <div className="bt-limit-row">
                <span>
                  {lim?.gb ? (
                    <>
                      Лимит обходов в месяц: <b>{lim.gb} ГБ</b> · использовано {bytes(lim.used)} ({Math.round(limPct)}%) · сброс {new Date(lim.cycle_end * 1000).toLocaleDateString("ru-RU")}
                    </>
                  ) : (
                    <>Лимит обходов не задан · с {lim ? new Date(lim.cycle_start * 1000).toLocaleDateString("ru-RU") : "—"} через обходы и каскад {bytes(lim?.used)}</>
                  )}
                </span>
                {lim ? <LimitEditor key={`${lim.gb}-${lim.day}`} gb={lim.gb} day={lim.day} onSaved={() => void load()} /> : null}
              </div>
              {lim?.gb ? (
                <div className="bar-track">
                  <div className={`bar-fill${limPct >= 90 ? " is-bad" : limPct >= 75 ? " is-warn" : ""}`} style={{ width: `${limPct}%` }} />
                </div>
              ) : null}
            </div>
            <div className="bt-legend">
              {KINDS.map(([k, label, color]) => (
                <span key={k}>
                  <i style={{ background: color }} />
                  {label}
                </span>
              ))}
            </div>
            {slots.length ? (
              <div>
                <div className="bt-bars" role="img" aria-label="Трафик по способу выхода">
                  {slots.map((p) => {
                    const s = sum(p);
                    return (
                      <div
                        key={p.t}
                        className="bt-bar"
                        style={{ height: `${Math.max(s ? 2 : 0, (s / peak) * 100)}%` }}
                        title={`${dateTime(new Date(p.t * 1000).toISOString())}: ${KINDS.map(([k, label]) => `${label} ${bytes(p[k])}`).join(" · ")}`}
                      >
                        {KINDS.map(([k, , color]) => (s ? <span key={k} style={{ height: `${(p[k] / s) * 100}%`, background: color }} /> : null))}
                      </div>
                    );
                  })}
                </div>
                <TimeAxis ticks={timeTicks(slots.map((p) => p.t))} />
              </div>
            ) : (
              <p className="mh-muted">Данных за период пока нет.</p>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Что тратит обходы</h2>
              <p className="cell-sub">{period === "24h" ? "за сутки" : "за 30 дней"}, по устройству и сайту</p>
            </div>
          </div>
          {top.length ? (
            <table className="table bt-top">
              <thead>
                <tr>
                  <th>Устройство · сайт</th>
                  <th className="col-num">Объём</th>
                </tr>
              </thead>
              <tbody>
                {top.map((r) => (
                  <tr key={`${r.ip}|${r.site}|${r.group}`}>
                    <td>
                      <strong>{deviceName(r.ip) || r.ip}</strong>
                      <span className="cell-sub">
                        {r.site || "—"} · {r.group}
                      </span>
                    </td>
                    <td className="col-num mono">{bytes(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mh-muted cb-pad">Разбивка по устройствам и сайтам собирается с обновления HomeNet: соединения через обходы появятся здесь по мере использования.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/** Bypass usage and whether AUTO left the direct servers, for alerts (NPM-36). */
export function useBypassStatus(enabled: boolean) {
  const [st, setSt] = useState<{ limitPct: number | null; gb: number; used: number; onBypass: boolean; fastMs?: number }>({ limitPct: null, gb: 0, used: 0, onBypass: false });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const pull = async () => {
      try {
        const [b, p] = await Promise.all([core.bypassTraffic("24h"), mihomo.proxies()]);
        const auto = p.proxies.AUTO;
        const fast = p.proxies["Быстрые"];
        const onBypass = !!auto && (auto.now === "Обходы" || auto.now === "Каскад" || (auto.now === "Быстрые" && fast?.now === "Обходы"));
        if (alive) setSt({ limitPct: b.limit.gb ? (b.limit.used / (b.limit.gb * GB)) * 100 : null, gb: b.limit.gb, used: b.limit.used, onBypass });
      } catch {
        /* alerts stay quiet without data */
      }
    };
    void pull();
    const t = setInterval(() => document.visibilityState === "visible" && void pull(), 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return st;
}
