import { useMemo, useState } from "react";
import type { LteLive, LteSurvey } from "../../api";
import { Icon } from "../../components/ui/Icon";

// Band survey as an abstract radar: the antenna in the middle, one ring per
// surveyed band, found cells as blips. Directions are symbolic — the modem
// cannot tell where a signal comes from — but a base station keeps the same
// bearing on every band (angle from its eNB id), so bands of one station line
// up on one ray: that is where aggregation is possible.

type Blip = {
  key: string;
  band: number;
  angle: number;
  r: number;
  size: number;
  serving: boolean;
  title: string;
  detail: string[];
  enb?: string;
};

const SIZE = 420;
const C = SIZE / 2;
const INNER = 62;
const OUTER = 188;

function hashAngle(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 3600) / 10;
}

function polar(angle: number, r: number) {
  const a = ((angle - 90) * Math.PI) / 180;
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
}

function blipSize(rsrp: number) {
  const t = Math.min(1, Math.max(0, (rsrp + 125) / 60));
  return 3.5 + t * 6;
}

export function Radar({ survey, live, running }: { survey: LteSurvey | null; live?: LteLive; running: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const bands = useMemo(() => {
    const list = survey?.bands.length ? [...survey.bands] : live?.band ? [Number(live.band.replace("B", ""))] : [];
    return list.sort((a, b) => a - b);
  }, [survey, live]);
  const ringR = (band: number) => {
    const i = bands.indexOf(band);
    if (bands.length <= 1) return (INNER + OUTER) / 2;
    return INNER + ((OUTER - INNER) * i) / (bands.length - 1);
  };

  const blips = useMemo(() => {
    const out: Blip[] = [];
    const add = (band: number, s: LteLive | undefined, cells: { pci: number; earfcn: number; rsrp: number; rsrq: number; band?: string }[]) => {
      if (s) {
        out.push({
          key: `s${band}-${s.pci}`,
          band,
          angle: hashAngle("enb" + (s.enb || s.pci)),
          r: ringR(band),
          size: blipSize(s.rsrp) + 2,
          serving: true,
          enb: s.enb,
          title: `B${band} · станция ${s.enb || "?"}`,
          detail: [`Сектор ${s.sector || "—"}, PCI ${s.pci}, EARFCN ${s.earfcn}`, `RSRP ${s.rsrp} дБм · SINR ${s.sinr} дБ · RSRQ ${s.rsrq} дБ`, s.carriers[0]?.width_mhz ? `Ширина ${s.carriers[0].width_mhz} МГц` : ""].filter(Boolean),
        });
      }
      for (const c of cells) {
        if (s && c.pci === s.pci) continue;
        out.push({
          key: `n${band}-${c.earfcn}-${c.pci}`,
          band,
          angle: hashAngle(`pci${c.earfcn}/${c.pci}`),
          r: ringR(band),
          size: blipSize(c.rsrp),
          serving: false,
          title: `B${band} · соседняя сота PCI ${c.pci}`,
          detail: [`EARFCN ${c.earfcn}`, `RSRP ${c.rsrp} дБм · RSRQ ${c.rsrq} дБ`],
        });
      }
    };
    if (survey) {
      for (const r of survey.results) if (r.found) add(r.band, r.serving, r.cells);
    } else if (live?.band) {
      const band = Number(live.band.replace("B", ""));
      add(band, live, live.neighbours);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [survey, live, bands]);

  // Stations heard on two or more bands.
  const stations = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const b of blips) if (b.serving && b.enb) map.set(b.enb, [...(map.get(b.enb) || []), b.band]);
    return [...map.entries()].filter(([, list]) => list.length >= 2);
  }, [blips]);

  const status = (band: number) => {
    const r = survey?.results.find((x) => x.band === band);
    if (running && survey?.current === band) return "current";
    if (!r) return survey ? "queued" : "found";
    return r.found ? "found" : "missing";
  };
  const sel = blips.find((b) => b.key === selected);
  const sweeping = running;

  return (
    <div className="net-radar-wrap">
      <svg className={`net-radar${sweeping ? " is-sweeping" : ""}`} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Карта найденных сот">
        <defs>
          <radialGradient id="net-radar-bg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.10" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="net-radar-beam" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <circle cx={C} cy={C} r={OUTER + 18} fill="url(#net-radar-bg)" />
        {[0, 45, 90, 135].map((a) => {
          const p = polar(a, OUTER + 14);
          const q = polar(a + 180, OUTER + 14);
          return <line key={a} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="net-radar-axis" />;
        })}
        {bands.map((b) => {
          const st = status(b);
          const r = ringR(b);
          const lp = polar(0, r);
          return (
            <g key={b} className={`net-radar-ring is-${st}`}>
              <circle cx={C} cy={C} r={r} />
              <g transform={`translate(${lp.x},${lp.y})`}>
                <rect x={-17} y={-9} width={34} height={18} rx={9} />
                <text textAnchor="middle" dy="4">
                  B{b}
                </text>
              </g>
            </g>
          );
        })}
        {stations.map(([enb, list]) => {
          const b = blips.find((x) => x.enb === enb && x.serving)!;
          const end = polar(b.angle, OUTER + 10);
          return <line key={enb} x1={C} y1={C} x2={end.x} y2={end.y} className="net-radar-ray" aria-label={`Станция ${enb}: ${list.map((x) => "B" + x).join(" + ")}`} />;
        })}
        {sweeping ? (
          <g className="net-radar-sweep">
            <path d={`M${C},${C} L${C + OUTER + 16},${C} A${OUTER + 16},${OUTER + 16} 0 0,0 ${polar(60, OUTER + 16).x},${polar(60, OUTER + 16).y} Z`} fill="url(#net-radar-beam)" transform={`rotate(-150 ${C} ${C})`} />
          </g>
        ) : null}
        {blips.map((b) => {
          const p = polar(b.angle, b.r);
          return (
            <g
              key={b.key}
              className={`net-radar-blip${b.serving ? " is-serving" : ""}${selected === b.key ? " is-selected" : ""}`}
              transform={`translate(${p.x},${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={b.title}
              onClick={() => setSelected(selected === b.key ? null : b.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(selected === b.key ? null : b.key);
                }
              }}
            >
              <circle r={b.size + 8} className="net-radar-hit" />
              {b.serving ? <circle r={b.size + 5} className="net-radar-pulse" /> : null}
              <circle r={b.size} />
            </g>
          );
        })}
        <g className={`net-radar-core${sweeping ? " is-live" : ""}`}>
          <circle cx={C} cy={C} r={30} className="net-radar-wave" />
          <circle cx={C} cy={C} r={24} className="net-radar-center" />
          <svg x={C - 12} y={C - 12} width={24} height={24} viewBox="0 0 24 24" className="net-radar-antenna">
            <Icon name="activity" size={24} />
          </svg>
        </g>
      </svg>
      <div className="net-radar-side">
        {sel ? (
          <div className="net-radar-detail">
            <b>{sel.title}</b>
            {sel.detail.map((d) => (
              <span key={d}>{d}</span>
            ))}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(null)}>
              Закрыть
            </button>
          </div>
        ) : (
          <p className="muted">Нажмите на точку — подробности о соте. Крупная точка с ореолом — станция, к которой модем подключился в этом диапазоне.</p>
        )}
        {stations.length ? (
          stations.map(([enb, list]) => (
            <p key={enb} className="net-radar-station">
              <Icon name="checkCircle" size={14} /> Станция {enb} слышна в {list.map((x) => "B" + x).join(" и ")} — на одном луче. Здесь агрегация возможна, если оператор объединяет эти диапазоны.
            </p>
          ))
        ) : survey?.finished ? (
          <p className="muted">Ни одна станция не слышна сразу в двух диапазонах — для агрегации попробуйте другое положение.</p>
        ) : null}
        <ul className="net-radar-legend">
          <li>
            <i className="is-found" /> диапазон найден
          </li>
          <li>
            <i className="is-missing" /> сети нет
          </li>
          <li>
            <i className="is-current" /> ищу сейчас
          </li>
        </ul>
        <p className="muted net-radar-note">Направления условные: модем не знает, откуда приходит сигнал. Одна станция всегда рисуется на одном луче.</p>
      </div>
    </div>
  );
}
