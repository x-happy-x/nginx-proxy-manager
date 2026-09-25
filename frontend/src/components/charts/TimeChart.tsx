import { useId, useMemo, useRef, useState } from "react";

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
};

const COLORS = ["var(--series-1)", "var(--series-2)"];

export function TimeChart({ times, series, format, height = 120, max, area = true, compact = false, label }: Props) {
  const id = useId().replace(/:/g, "");
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
    let run: Array<[number, number]> = [];
    const flush = () => {
      if (run.length) {
        line += run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ") + " ";
        fill += `M${run[0][0].toFixed(1)} ${height - padBottom} ` + run.map(([px, py]) => `L${px.toFixed(1)} ${py.toFixed(1)}`).join(" ") + ` L${run[run.length - 1][0].toFixed(1)} ${height - padBottom} Z `;
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

  return (
    <div className={`tchart${compact ? " is-compact" : ""}`} style={{ height }}>
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
      {hover != null && times[hover] ? (
        <div className="tchart-tip" style={{ left: `${tipLeft}%`, transform: `translateX(${tipLeft > 50 ? "-105%" : "5%"})` }}>
          <time>{new Date(times[hover] * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
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
