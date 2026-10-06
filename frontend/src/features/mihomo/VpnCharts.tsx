import { useMemo, type KeyboardEvent, type ReactNode } from "react";

/*
 * Interactive chart of the VPN pages (NPM-51): lines or stacked bars over
 * fixed time slots, shaded slots (the whitelist mode), an optional reference
 * line, and a selected slot the page describes under the chart. Hover, a tap
 * or the arrow keys pick the slot. Design: https://claude.ai/artifact/N8GcahufsywH132N9xS1mk
 */

export type ChartSeries = { key: string; label: string; color: string; values: Array<number | null>; off?: boolean };

/** Colors for named series, distinct in both themes (mihomo.css, --vc-*). */
export const VC_COLORS = ["var(--vc-a)", "var(--vc-b)", "var(--vc-c)", "var(--vc-d)", "var(--vc-e)", "var(--vc-f)"];

type Props = {
  times: number[];
  kind: "line" | "bars";
  series: ChartSeries[];
  format: (v: number) => string;
  selected: number;
  onSelect: (i: number) => void;
  label: string;
  xLabel: (t: number, i: number) => string;
  /** slot label for the accessible name and the tooltip */
  slotLabel: (t: number, i: number) => string;
  bands?: boolean[];
  refLine?: { value: number; label: string };
  max?: number;
  height?: number;
};

export function niceCeil(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function VpnChart({ times, kind, series, format, selected, onSelect, label, xLabel, slotLabel, bands, refLine, max, height = 220 }: Props) {
  const on = series.filter((s) => !s.off);
  const n = times.length;
  const top = useMemo(() => {
    if (max) return max;
    let peak = refLine?.value || 0;
    for (let i = 0; i < n; i++) {
      if (kind === "bars") peak = Math.max(peak, on.reduce((a, s) => a + (s.values[i] || 0), 0));
      else for (const s of on) peak = Math.max(peak, s.values[i] || 0);
    }
    return niceCeil(peak * 1.05 || 1);
  }, [on, n, kind, max, refLine]);
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => top * f);
  const y = (v: number) => (1 - Math.min(v, top) / top) * 100;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const sel = Math.min(Math.max(0, selected), n - 1);

  const paths =
    kind === "line"
      ? on.map((s) => {
          let d = "";
          let pen = false;
          s.values.forEach((v, i) => {
            if (v == null) {
              pen = false;
              return;
            }
            d += `${pen ? "L" : "M"}${(x(i) * 10).toFixed(1)} ${y(v).toFixed(2)} `;
            pen = true;
          });
          // a lone point between gaps is drawn as a dot by the marker layer
          return { key: s.key, color: s.color, d: d.trim() };
        })
      : [];

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onSelect(Math.min(n - 1, Math.max(0, sel + (e.key === "ArrowLeft" ? -1 : 1))));
    }
  };

  if (!n) return null;
  return (
    <div className="vc" role="group" aria-label={label}>
      <div className="vc-body">
        <div className="vc-y" style={{ height }} aria-hidden="true">
          {ticks.map((v) => (
            <span key={v} style={{ top: `${y(v)}%` }}>
              {format(v)}
            </span>
          ))}
        </div>
        <div className="vc-plot" style={{ height }}>
          {bands?.map((b, i) => (b ? <span key={i} className="vc-band" style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%` }} /> : null))}
          {ticks.map((v) => (
            <span key={v} className="vc-grid" style={{ top: `${y(v)}%` }} />
          ))}
          {refLine ? (
            <>
              <span className="vc-ref" style={{ top: `${y(refLine.value)}%` }} />
              <span className="vc-ref-label" style={{ top: `${y(refLine.value)}%` }}>
                {refLine.label}
              </span>
            </>
          ) : null}
          {kind === "line" ? (
            <svg className="vc-svg" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
              {paths.map((p) => (p.d ? <path key={p.key} d={p.d} stroke={p.color} /> : null))}
            </svg>
          ) : (
            <div className="vc-bars" aria-hidden="true">
              {times.map((t, i) => (
                <div key={t} className={`vc-col${i === sel ? " is-sel" : ""}`}>
                  {on.map((s) => {
                    const v = s.values[i] || 0;
                    return v > 0 ? <span key={s.key} style={{ height: `${(v / top) * 100}%`, background: s.color }} /> : null;
                  })}
                </div>
              ))}
            </div>
          )}
          <span className="vc-marker" style={{ left: `${x(sel)}%` }} />
          {kind === "line"
            ? on.map((s) =>
                s.values[sel] != null ? <span key={s.key} className="vc-pt" style={{ left: `${x(sel)}%`, top: `${y(s.values[sel] as number)}%`, background: s.color }} /> : null,
              )
            : null}
          <div className="vc-hits" onKeyDown={onKey}>
            {times.map((t, i) => (
              <button
                key={t}
                type="button"
                tabIndex={i === sel ? 0 : -1}
                aria-label={slotLabel(t, i)}
                aria-pressed={i === sel}
                onMouseEnter={() => onSelect(i)}
                onFocus={() => onSelect(i)}
                onClick={() => onSelect(i)}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="vc-x" aria-hidden="true">
        {times.map((t, i) => (
          <span key={t}>{xLabel(t, i)}</span>
        ))}
      </div>
    </div>
  );
}

/** The line under a chart: the slot, its mode and the values in it. */
export function ChartTip({ title, tag, rows, note }: { title: string; tag?: ReactNode; rows: Array<{ color: string; label: string; value: string }>; note?: string }) {
  return (
    <div className="vc-tip" aria-live="polite">
      <b className="vc-tip-time">{title}</b>
      {tag}
      {rows.map((r) => (
        <span key={r.label} className="vc-tip-row">
          <i style={{ background: r.color }} />
          <span>{r.label}</span>
          <b>{r.value}</b>
        </span>
      ))}
      {note ? <small>{note}</small> : null}
    </div>
  );
}

/** Toggle chips for the series of a chart. */
export function SeriesChips({ series, onToggle }: { series: ChartSeries[]; onToggle: (key: string) => void }) {
  return (
    <div className="vn-chips" role="group" aria-label="Что показывать">
      {series.map((s) => (
        <button key={s.key} type="button" className={`vn-chip vc-chip${s.off ? " is-off" : ""}`} aria-pressed={!s.off} onClick={() => onToggle(s.key)}>
          <i style={{ background: s.color }} />
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** Fixed slots ending at the current one: hours of the last day, days of a month. */
export function slots(count: number, step: number, now = Date.now() / 1000): number[] {
  const last = step === 86400 ? dayStart(now) : Math.floor(now / step) * step;
  return Array.from({ length: count }, (_, i) => last - (count - 1 - i) * step);
}

function dayStart(sec: number) {
  const d = new Date(sec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Puts points into the slot that holds them; `pick` folds a slot's points into one value. */
export function intoSlots<T extends { t: number }>(times: number[], step: number, points: T[], pick: (pts: T[]) => number | null): Array<number | null> {
  const buckets: T[][] = times.map(() => []);
  const first = times[0];
  for (const p of points) {
    let i: number;
    if (step === 86400) {
      i = times.findIndex((t, k) => p.t >= t && (k === times.length - 1 || p.t < times[k + 1]));
    } else i = Math.floor((p.t - first) / step);
    if (i >= 0 && i < times.length) buckets[i].push(p);
  }
  return buckets.map((b) => (b.length ? pick(b) : null));
}

export const hh = (t: number) => new Date(t * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
export const dm = (t: number) => new Date(t * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
