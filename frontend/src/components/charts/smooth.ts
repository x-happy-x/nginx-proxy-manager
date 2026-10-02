/*
 * Smooth line through points (NPM-31): monotone cubic interpolation
 * (Fritsch–Carlson), so the curve never overshoots the data — a series of
 * counts stays above zero and peaks are not invented.
 */

export type Pt = [number, number];

const f = (v: number) => v.toFixed(1);

/** "M… C…" path through the points; a straight line for fewer than 3. */
export function smoothLine(pts: Pt[]): string {
  const n = pts.length;
  if (!n) return "";
  if (n < 3) return pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join(" ");
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    slope[i] = dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0;
  }
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  m[n - 1] = slope[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${f(pts[i][0] + h)} ${f(pts[i][1] + m[i] * h)} ${f(pts[i + 1][0] - h)} ${f(pts[i + 1][1] - m[i + 1] * h)} ${f(pts[i + 1][0])} ${f(pts[i + 1][1])}`;
  }
  return d;
}

/** Closed area under the smooth line down to `base`. */
export function smoothArea(pts: Pt[], base: number): string {
  if (!pts.length) return "";
  return `${smoothLine(pts)} L${f(pts[pts.length - 1][0])} ${f(base)} L${f(pts[0][0])} ${f(base)} Z`;
}

/** Evenly spaced time labels for an axis under a chart. */
export function timeTicks(times: number[], count = 5): Array<{ at: number; label: string }> {
  const n = times.length;
  if (n < 2) return [];
  const span = times[n - 1] - times[0];
  const opts: Intl.DateTimeFormatOptions =
    span > 3 * 86400 ? { day: "2-digit", month: "2-digit" } : span > 20 * 3600 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
  const out: Array<{ at: number; label: string }> = [];
  for (let k = 0; k < count; k++) {
    const i = Math.round((k / (count - 1)) * (n - 1));
    out.push({ at: n <= 1 ? 1 : i / (n - 1), label: new Date(times[i] * 1000).toLocaleString("ru-RU", opts) });
  }
  return out;
}

/** Averages a series into at most `max` buckets; nulls stay gaps. */
export function bucketize(times: number[], values: Array<Array<number | null>>, max: number): { times: number[]; values: Array<Array<number | null>> } {
  const n = times.length;
  if (n <= max) return { times, values };
  const size = n / max;
  const outT: number[] = [];
  const outV: Array<Array<number | null>> = values.map(() => []);
  for (let b = 0; b < max; b++) {
    const from = Math.floor(b * size);
    const to = Math.max(from + 1, Math.floor((b + 1) * size));
    outT.push(times[Math.min(n - 1, Math.floor((from + to - 1) / 2))]);
    values.forEach((vals, k) => {
      let sum = 0;
      let cnt = 0;
      for (let i = from; i < to; i++) {
        const v = vals[i];
        if (v != null) {
          sum += v;
          cnt++;
        }
      }
      outV[k].push(cnt ? sum / cnt : null);
    });
  }
  return { times: outT, values: outV };
}
