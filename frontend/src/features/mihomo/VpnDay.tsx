import { useCallback, useEffect, useMemo, useState } from "react";
import { core, type GroupLatency, type HealthPoint, type MProxy, type TrafficReport } from "./api";
import { ChartTip, SeriesChips, VC_COLORS, VpnChart, hh, intoSlots, slots, type ChartSeries } from "./VpnCharts";

/*
 * «Сейчас» → «Сутки по часам» (NPM-51): the delay of the node each path group
 * uses, connections nobody answered, and the nodes alive in each subscription;
 * the hours of the whitelist mode are shaded.
 */

type Metric = "lat" | "empty" | "alive";
const METRICS: Array<[Metric, string]> = [
  ["lat", "Задержка групп"],
  ["empty", "Пустые соединения"],
  ["alive", "Живые узлы"],
];

const median = (xs: number[]) => {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1).replace(".", ",")} с` : `${Math.round(v)} мс`);

export function DayChart({ proxies, main }: { proxies: Record<string, MProxy>; main: HealthPoint[] }) {
  const [metric, setMetric] = useState<Metric>("lat");
  const [sel, setSel] = useState(23);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [groups, setGroups] = useState<Record<string, GroupLatency[]>>({});
  const [traffic, setTraffic] = useState<TrafficReport["series"]>([]);
  const [subs, setSubs] = useState<Record<string, HealthPoint[]>>({});

  const pull = useCallback(() => {
    void core
      .groups("24h")
      .then((r) => setGroups(r.groups || {}))
      .catch(() => undefined);
    void core
      .traffic("24h")
      .then((r) => setTraffic(r.series || []))
      .catch(() => undefined);
    void core
      .health("", "24h")
      .then(async (r) => {
        const out: Record<string, HealthPoint[]> = {};
        await Promise.all(
          r.providers.map((name) =>
            core
              .health(name, "24h")
              .then((h) => (out[name] = h.series))
              .catch(() => undefined),
          ),
        );
        setSubs(out);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), 60000);
    return () => clearInterval(t);
  }, [pull]);

  const times = useMemo(() => slots(24, 3600), []);
  const bands = useMemo(() => intoSlots(times, 3600, main, (pts) => pts.reduce((a, p) => a + p.whitelist, 0)).map((v) => (v || 0) >= 10), [times, main]);
  const modeAt = (i: number) => (bands[i] ? "whitelist" : "normal");

  // the path groups of AUTO, then whatever else has history
  const latNames = useMemo(() => {
    const auto = (proxies.AUTO?.all || []).filter((n) => groups[n]);
    const rest = Object.keys(groups).filter((n) => !auto.includes(n) && n !== "AUTO" && n !== "GLOBAL");
    return (auto.length ? auto : rest).slice(0, 6);
  }, [proxies, groups]);

  const series: ChartSeries[] = useMemo(() => {
    if (metric === "lat")
      return latNames.map((name, k) => ({
        key: name,
        label: name,
        color: VC_COLORS[k % VC_COLORS.length],
        off: !!off[name],
        values: intoSlots(times, 3600, groups[name] || [], (pts) => {
          const ok = pts.filter((p) => p.ms > 0);
          return ok.length ? Math.round(ok.reduce((a, p) => a + p.ms, 0) / ok.length) : null;
        }),
      }));
    if (metric === "empty")
      return [
        {
          key: "empty",
          label: "без ответа",
          color: "var(--vc-d)",
          values: intoSlots(times, 3600, traffic, (pts) => pts.reduce((a, p) => a + (p.empty || 0), 0)),
        },
      ];
    return Object.keys(subs)
      .sort((a, b) => (subs[b][subs[b].length - 1]?.total || 0) - (subs[a][subs[a].length - 1]?.total || 0))
      .map((name, k) => ({
        key: name,
        label: name,
        color: VC_COLORS[(k + 2) % VC_COLORS.length],
        off: !!off[name],
        values: intoSlots(times, 3600, subs[name], (pts) => Math.round(pts.reduce((a, p) => a + p.working, 0) / pts.length)),
      }));
  }, [metric, latNames, groups, traffic, subs, off, times]);

  const closed = useMemo(() => intoSlots(times, 3600, traffic, (pts) => pts.reduce((a, p) => a + (p.closed || 0), 0)), [times, traffic]);
  const usual = metric === "empty" ? median(series[0]?.values.map((v) => v || 0) || []) : 0;
  const i = Math.min(sel, times.length - 1);
  const t = times[i];
  const slot = `${hh(t)}–${i === times.length - 1 ? "сейчас" : hh(t + 3600)}`;

  let rows: Array<{ color: string; label: string; value: string }> = [];
  let note = "";
  if (metric === "lat") {
    rows = series.filter((s) => !s.off).map((s) => ({ color: s.color, label: s.label, value: s.values[i] == null ? "не отвечали" : ms(s.values[i] as number) }));
    const slow = series.filter((s) => !s.off && s.values[i] != null && (s.values[i] as number) > 2 * median(s.values.map((v) => v || 0)) && (s.values[i] as number) > 500);
    const silent = series.filter((s) => !s.off && s.values[i] == null && s.values.some((v) => v != null));
    note = silent.length
      ? `${silent.map((s) => s.label).join(", ")} — все проверки за час не прошли${bands[i] ? ": прямые узлы молчат при белых списках, трафик держат обходы" : ""}.`
      : slow.length
        ? `${slow.map((s) => s.label).join(", ")} медленнее обычного — сайты через эту группу открываются дольше.`
        : bands[i]
          ? "Белые списки, но группы отвечают."
          : "Обычный час.";
  } else if (metric === "empty") {
    const e = series[0]?.values[i] || 0;
    const c = closed[i] || 0;
    rows = [
      { color: "var(--vc-d)", label: "без ответа", value: String(e) },
      { color: "var(--series-neutral)", label: "закрыто соединений", value: String(c) },
      { color: "var(--series-neutral)", label: "доля", value: c ? `${Math.round((e / c) * 100)}%` : "—" },
    ];
    note =
      e > usual * 2 && e > 20
        ? "Больше обычного: узлы принимали соединения и молчали. Пассивная проверка снимает такие узлы на 3 минуты."
        : "Пустое соединение — сайт или узел приняли его и не прислали ни байта. Немного таких бывает всегда.";
  } else {
    let total = 0;
    rows = series
      .filter((s) => !s.off)
      .map((s) => {
        total += s.values[i] || 0;
        return { color: s.color, label: s.label, value: s.values[i] == null ? "—" : String(s.values[i]) };
      });
    rows.push({ color: "var(--text)", label: "всего", value: String(total) });
    note = bands[i] ? "При белых списках живы в основном обходы." : "";
  }

  const toggle = (key: string) => setOff((o) => ({ ...o, [key]: !o[key] }));
  const fmt = metric === "lat" ? ms : (v: number) => String(Math.round(v));

  return (
    <section className="vn-section vd" aria-label="Сутки по часам">
      <div className="vn-section-head">
        <h3>
          Сутки по часам <span>· наведите или нажмите на час</span>
        </h3>
        <div className="vd-metrics" role="group" aria-label="Что показать">
          {METRICS.map(([k, label]) => (
            <button key={k} type="button" className={metric === k ? "is-on" : ""} aria-pressed={metric === k} onClick={() => setMetric(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="vd-legend">
        {metric !== "empty" ? <SeriesChips series={series} onToggle={toggle} /> : <span />}
        <span className="vd-band-key">
          <i />
          белые списки
        </span>
      </div>
      {series.length && series.some((s) => s.values.some((v) => v != null)) ? (
        <>
          <VpnChart
            times={times}
            kind={metric === "lat" ? "line" : "bars"}
            series={series}
            format={fmt}
            selected={i}
            onSelect={setSel}
            bands={bands}
            refLine={metric === "empty" && usual ? { value: usual, label: "обычно" } : undefined}
            label={METRICS.find((m) => m[0] === metric)![1]}
            xLabel={(tt, k) => (k % 3 === 0 ? hh(tt) : "")}
            slotLabel={(tt, k) => `${hh(tt)}${bands[k] ? ", белые списки" : ""}`}
          />
          <ChartTip
            title={slot}
            tag={<span className={`vn-pill vn-${modeAt(i) === "whitelist" ? "warn" : "ok"}`}>{modeAt(i) === "whitelist" ? "белые списки" : "обычный"}</span>}
            rows={rows}
            note={note}
          />
        </>
      ) : (
        <p className="mh-muted">
          {metric === "lat" ? "Задержки групп роутер записывает раз в минуту с этого обновления HomeNet — график заполнится за час." : "Данных за сутки пока нет."}
        </p>
      )}
    </section>
  );
}
