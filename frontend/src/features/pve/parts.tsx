import type { ReactNode } from "react";
import type { Tone } from "./model";

/** Ring gauge: the value in the middle, a thin arc coloured by tone. */
export function Ring({ value, max = 100, tone, label, display, sub }: { value: number | null; max?: number; tone: Tone; label: string; display: string; sub?: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const share = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  // 270° arc that starts bottom-left: gauges read like a speedometer
  const arc = c * 0.75;
  return (
    <figure className={`pve-ring tone-${tone}`} aria-label={`${label}: ${display}`}>
      <svg viewBox="0 0 84 84" aria-hidden="true">
        <circle className="pve-ring-track" cx="42" cy="42" r={r} strokeDasharray={`${arc} ${c}`} transform="rotate(135 42 42)" />
        <circle className="pve-ring-value" cx="42" cy="42" r={r} strokeDasharray={`${arc * share} ${c}`} transform="rotate(135 42 42)" />
      </svg>
      <div className="pve-ring-text">
        <strong>{display}</strong>
        {sub ? <small>{sub}</small> : null}
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/** Horizontal fill bar; `marks` draws thresholds (e.g. warning and critical temperature). */
export function Bar({ value, max = 100, tone, marks = [], thin }: { value: number; max?: number; tone: Tone; marks?: number[]; thin?: boolean }) {
  const share = max > 0 ? Math.max(0, Math.min(100, (100 * value) / max)) : 0;
  return (
    <span className={`pve-bar tone-${tone}${thin ? " thin" : ""}`} aria-hidden="true">
      <span className="pve-bar-fill" style={{ width: `${share}%` }} />
      {marks.filter((m) => m > 0 && m < max).map((m) => <span key={m} className="pve-bar-mark" style={{ left: `${(100 * m) / max}%` }} />)}
    </span>
  );
}

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={`pve-dot tone-${tone}${pulse ? " pulse" : ""}`} aria-hidden="true" />;
}

export function Pill({ tone = "idle", children, title }: { tone?: Tone | "accent"; children: ReactNode; title?: string }) {
  return <span className={`pve-pill tone-${tone}`} title={title}>{children}</span>;
}

/** Mini line for table rows (guest CPU over the day). */
export function Spark({ values, max, tone = "ok", label }: { values: number[]; max?: number; tone?: Tone; label: string }) {
  if (values.length < 2) return <span className="pve-spark empty" aria-hidden="true" />;
  const top = max || Math.max(1, ...values);
  const w = 120;
  const h = 28;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - (Math.min(v, top) / top) * (h - 4)).toFixed(1)}`);
  return (
    <svg className={`pve-spark tone-${tone}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <polygon points={`0,${h} ${pts.join(" ")} ${w},${h}`} className="pve-spark-area" />
      <polyline points={pts.join(" ")} className="pve-spark-line" />
    </svg>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={`pve-stat${tone ? ` tone-${tone}` : ""}`}>
      <span className="pve-stat-label">{label}</span>
      <span className="pve-stat-value">{value}</span>
      {sub ? <span className="pve-stat-sub">{sub}</span> : null}
    </div>
  );
}

export function Section({ title, hint, actions, children }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="pve-section">
      <header className="pve-section-head">
        <div>
          <h2>{title}</h2>
          {hint ? <p>{hint}</p> : null}
        </div>
        {actions ? <div className="pve-section-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pve-empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
