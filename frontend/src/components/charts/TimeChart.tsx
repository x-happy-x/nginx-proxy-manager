import { useId, useMemo, useRef, useState } from "react";
import { bucketize, smoothArea, smoothLine, timeTicks, type Pt } from "./smooth";

/*
 * Small time-series chart for the resources dashboard: one y-scale, 1–2
 * series (series-1/series-2 tokens, validated for both themes), thin 2px
 * lines with a soft area under the first series, recessive grid, and a
 * crosshair tooltip on hover. Gaps in the data break the line.
 */

export type Series = {
  label: string;
  values: Array<number | null>;
  color?: string;
};

type Props = {
  times: number[]; // unix seconds, same length as each series
  series: Series[];
  format: (value: number) => string;
  height?: number;
  max?: number; // fixed top of the scale (e.g. 100 for %)
  area?: boolean;
  compact?: boolean; // sparkline: no grid, no labels
  label: string; // accessible name
  axis?: boolean; // time labels under the chart (NPM-31)
};

const COLORS = ["var(--series-1)", "var(--series-2)"];

export function TimeChart({ times: rawTimes, series: rawSeries, format, height = 120, max, area = true, compact = false, label, axis = false }: Props) {
  const id = useId().replace(/:/g, "");
  // Dense series (a day of minutes) are averaged to ~160 points so the line reads smoothly.
  const { times, series } = useMemo(() => {
    const b = bucketize(rawTimes, rawSeries.map((s) => s.values), compact ? 80 : 160);
    return { times: b.times, series: rawSeries.map((s, i) => ({ ...s, values: b.values[i] })) };
  }, [rawTimes, rawSeries, compact]);
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 600;
  const padTop = compact ? 2 : 10;
  const padBottom = compact ? 2 : 4;

  const top = useMemo(() => {
    if (max) return max;
    let peak = 0;
    for (const s of series) for (const v of s.values) if (v != null && v > peak) peak = v;
    return niceCeil(peak || 1);
  }, [series, max]);

  const n = times.length;
  const x = (i: number) => (n <= 1 ? width : (i / (n - 1)) * width);
  const y = (v: number) => padTop + (1 - Math.min(v, top) / top) * (height - padTop - padBottom);

  const paths = series.map((s) => {
    let line = "";
    let fill = "";
    let run: Pt[] = [];
    const flush = () => {
      if (run.length) {
        line += smoothLine(run) + " ";
        fill += smoothArea(run, height - padBottom) + " ";
      }
      run = [];
    };
    s.values.forEach((v, i) => {
      if (v == null) flush();
      else run.push([x(i), y(v)]);
    });
    flush();
    return { line, fill };
  });

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (n - 1)));
  };

  const hoverX = hover != null ? x(hover) : 0;
  const tipLeft = hover != null ? (hoverX / width) * 100 : 0;
  const ticks = axis && !compact ? timeTicks(times) : [];

  return (
    <div className={`tchart${compact ? " is-compact" : ""}${ticks.length ? " has-axis" : ""}`} style={{ height: height + (ticks.length ? 18 : 0) }}>
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={series[0]?.color || COLORS[0]} stopOpacity="0.22" />
            <stop offset="1" stopColor={series[0]?.color || COLORS[0]} stopOpacity="0" />
          </linearGradient>
        </defs>
        {!compact
          ? [0.5, 1].map((f) => (
              <line key={f} x1="0" x2={width} y1={y(top * f)} y2={y(top * f)} className="tchart-grid" vectorEffect="non-scaling-stroke" />
            ))
          : null}
        <line x1="0" x2={width} y1={height - padBottom} y2={height - padBottom} className="tchart-base" vectorEffect="non-scaling-stroke" />
        {area && paths[0] ? <path d={paths[0].fill} fill={`url(#${id}-fill)`} /> : null}
        {paths.map((p, i) => (
          <path key={i} d={p.line} fill="none" stroke={series[i].color || COLORS[i]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
        {hover != null ? (
          <>
            <line x1={hoverX} x2={hoverX} y1={padTop} y2={height - padBottom} className="tchart-cross" vectorEffect="non-scaling-stroke" />
            {series.map((s, i) => {
              const v = s.values[hover];
              return v == null ? null : <circle key={i} cx={hoverX} cy={y(v)} r="4" fill={s.color || COLORS[i]} className="tchart-dot" vectorEffect="non-scaling-stroke" />;
            })}
          </>
        ) : null}
      </svg>
      {!compact ? <span className="tchart-max">{format(top)}</span> : null}
      {ticks.length ? <TimeAxis ticks={ticks} /> : null}
      {hover != null && times[hover] ? (
        <div className="tchart-tip" style={{ left: `${tipLeft}%`, transform: `translateX(${tipLeft > 50 ? "-105%" : "5%"})` }}>
          <time>
            {n > 1 && times[n - 1] - times[0] > 20 * 3600
              ? new Date(times[hover] * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
              : new Date(times[hover] * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </time>
          {series.map((s, i) => (
            <div key={i} className="tchart-tip-row">
              <span className="tchart-key" style={{ background: s.color || COLORS[i] }} />
              <span>{s.label}</span>
              <strong>{s.values[hover] == null ? "—" : format(s.values[hover]!)}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Time labels under a chart or a strip; `at` is 0..1 across the width. */
export function TimeAxis({ ticks }: { ticks: Array<{ at: number; label: string }> }) {
  return (
    <div className="tchart-axis" aria-hidden="true">
      {ticks.map((t, i) => (
        <span key={i} style={{ left: `${t.at * 100}%` }} className={i === 0 ? "is-first" : i === ticks.length - 1 ? "is-last" : ""}>
          {t.label}
        </span>
      ))}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="tchart-legend">
      {series.map((s, i) => (
        <span key={i}>
          <span className="tchart-key" style={{ background: s.color || COLORS[i] }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function niceCeil(value: number) {
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * exp) return step * exp;
  }
  return 10 * exp;
}
