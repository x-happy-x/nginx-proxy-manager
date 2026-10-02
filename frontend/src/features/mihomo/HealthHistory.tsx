import { useCallback, useEffect, useState } from "react";
import { TimeChart } from "../../components/charts/TimeChart";
import { Alert, Segmented } from "../../components/ui/controls";
import { errText, number, timeOf } from "../../lib/format";
import { core, type HealthPoint } from "./api";

type Period = "1h" | "24h" | "7d" | "30d";
const MODES: Array<[keyof Pick<HealthPoint, "normal" | "whitelist" | "offline" | "unknown">, string, string]> = [
  ["normal", "без ограничений", "mh-mode-normal"],
  ["whitelist", "белые списки", "mh-mode-whitelist"],
  ["offline", "нет сети", "mh-mode-offline"],
  ["unknown", "не определён", "mh-mode-unknown"],
];

function dominant(p: HealthPoint) {
  return MODES.reduce((best, m) => (p[m[0]] > p[best[0]] ? m : best), MODES[3]);
}

/** Network mode and admitted nodes over time, recorded on the router (NPM-29). */
export function HealthHistory({ provider }: { provider: string }) {
  const [period, setPeriod] = useState<Period>("24h");
  const [series, setSeries] = useState<HealthPoint[]>([]);
  const [resolution, setResolution] = useState(60);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await core.health(provider, period);
      setSeries(r.series || []);
      setResolution(r.resolution);
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, [provider, period]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60000);
    return () => clearInterval(t);
  }, [load]);

  const minutes = (k: (typeof MODES)[number][0]) => series.reduce((s, p) => s + p[k], 0);
  const totalMin = Math.max(1, MODES.reduce((s, m) => s + minutes(m[0]), 0));
  const times = series.map((p) => p.t);

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">История режима и рабочих узлов</h2>
          <p className="cell-sub">роутер записывает раз в минуту · {provider}</p>
        </div>
        <Segmented<Period>
          label="Период"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "1h", label: "Час" },
            { value: "24h", label: "Сутки" },
            { value: "7d", label: "Неделя" },
            { value: "30d", label: "30 дней" },
          ]}
        />
      </div>
      {error ? <Alert tone="warning" title="Роутер не отдал историю">{error}</Alert> : null}
      <div className="card-body stack">
        {series.length ? (
          <>
            <div className="mh-mode-strip" role="img" aria-label="Режим сети по времени">
              {series.map((p) => {
                const [, label, cls] = dominant(p);
                const mixed = MODES.filter((m) => p[m[0]] > 0).length > 1;
                return <span key={p.t} className={`${cls}${mixed ? " is-mixed" : ""}`} title={`${timeOf(new Date(p.t * 1000).toISOString())}${resolution > 60 ? " (час)" : ""}: ${label}${mixed ? ` · ${MODES.filter((m) => p[m[0]] > 0).map((m) => `${m[1]} ${p[m[0]]} мин`).join(", ")}` : ""} · работают ${p.working} из ${p.total}`} />;
              })}
            </div>
            <div className="mh-mode-legend">
              {MODES.filter((m) => minutes(m[0]) > 0).map(([k, label, cls]) => (
                <span key={k}>
                  <i className={cls} />
                  {label} · {Math.round((minutes(k) / totalMin) * 100)}%
                </span>
              ))}
            </div>
            {series.length > 1 ? (
              <TimeChart
                label="Рабочие узлы"
                times={times}
                format={(v) => number(Math.round(v))}
                height={150}
                area={false}
                series={[
                  { label: "Допущено", values: series.map((p) => p.working), color: "var(--status-good)" },
                  { label: "Стабильных (без ограничений)", values: series.map((p) => p.stable_normal), color: "var(--series-1)" },
                  { label: "Стабильных (белые списки)", values: series.map((p) => p.stable_whitelist), color: "var(--series-2)" },
                ]}
              />
            ) : null}
            <div className="mh-mode-legend">
              <span><i style={{ background: "var(--status-good)" }} />допущено узлов (сейчас {series[series.length - 1].working} из {series[series.length - 1].total})</span>
              <span><i style={{ background: "var(--series-1)" }} />стабильных без ограничений</span>
              <span><i style={{ background: "var(--series-2)" }} />стабильных при белых списках</span>
            </div>
          </>
        ) : (
          <p className="mh-muted">Истории пока нет: первая точка появится в течение минуты после включения адаптивной проверки.</p>
        )}
      </div>
    </section>
  );
}
