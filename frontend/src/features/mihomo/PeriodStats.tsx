import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { TimeChart } from "../../components/charts/TimeChart";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Alert, Segmented } from "../../components/ui/controls";
import { bytes, dateTime, errText, number } from "../../lib/format";
import { core, type TrafficReport } from "./api";
import { useMihomo } from "./context";

type Period = "1h" | "24h" | "7d" | "30d";
type Dim = "device" | "site" | "outbound" | "group" | "process";
const PERIODS: Array<[Period, string]> = [
  ["1h", "Час"],
  ["24h", "Сутки"],
  ["7d", "Неделя"],
  ["30d", "30 дней"],
];
const DIMS: Array<[Dim, string]> = [
  ["device", "Устройства"],
  ["site", "Сайты"],
  ["outbound", "Выходы"],
  ["group", "Группы"],
  ["process", "Процессы"],
];

/** Traffic recorded on the router all the time (NPM-28), for a chosen period. */
export function PeriodStats() {
  const { deviceName, act } = useMihomo();
  const [period, setPeriod] = useState<Period>("24h");
  const [dim, setDim] = useState<Dim>("device");
  const [rep, setRep] = useState<TrafficReport | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      setRep(await core.traffic(period));
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, [period]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30000);
    return () => clearInterval(t);
  }, [load]);

  const name = (k: string) => (dim === "device" ? deviceName(k) || k : k);
  const rows = (rep?.dims[dim] || []).filter((r) => !q || `${r.key} ${name(r.key)}`.toLowerCase().includes(q.toLowerCase()));
  const max = Math.max(1, ...rows.map((r) => r.up + r.down));
  const series = rep?.series || [];
  const perSec = rep ? rep.resolution : 60;

  return (
    <>
      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">За период</h2>
            <p className="cell-sub">
              учёт ведёт роутер всё время{rep ? `, с ${dateTime(new Date(rep.since * 1000).toISOString())}` : ""} · ↓ {bytes(rep?.down)} ↑ {bytes(rep?.up)}
            </p>
          </div>
          <div className="button-row">
            <Segmented<Period> label="Период" value={period} onChange={setPeriod} options={PERIODS.map(([value, label]) => ({ value, label }))} />
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Обновить" onClick={() => void load()}>
              <Icon name="refresh" />
            </button>
          </div>
        </div>
        {error ? <Alert tone="warning" title="Роутер не отдал учёт трафика">{error}</Alert> : null}
        <div className="card-body">
          {series.length > 1 ? (
            <TimeChart
              label={`Средняя скорость за ${period}`}
              times={series.map((p) => p.t)}
              format={(v) => `${bytes(v)}/с`}
              height={170}
              series={[
                { label: "Загрузка", values: series.map((p) => p.down / perSec), color: "var(--series-1)" },
                { label: "Отдача", values: series.map((p) => p.up / perSec), color: "var(--series-2)" },
              ]}
            />
          ) : (
            <p className="mh-muted">Данных за период пока нет: роутер пишет точку раз в {rep?.poll_seconds || 5} секунд.</p>
          )}
          <p className="mh-muted pt-small">Средняя скорость за {perSec === 60 ? "минуту" : "час"}; пик открытых соединений за период — {number(Math.max(0, ...series.map((p) => p.conns)))}.</p>
        </div>
      </section>

      <section className="card card-flush">
        <div className="card-header">
          <div>
            <h2 className="card-title">Кто сколько потратил</h2>
            <p className="cell-sub">по приросту трафика соединений; разбивка {period === "1h" ? "по часам — включает начало прошлого часа" : period === "24h" ? "по часам" : "по дням"}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(true)}>
            <Icon name="trash" />
            Сбросить учёт
          </button>
        </div>
        <div className="toolbar mh-pad-x">
          <Segmented<Dim> label="Разбивка" value={dim} onChange={setDim} options={DIMS.map(([value, label]) => ({ value, label }))} />
          <input className="mh-filter" placeholder="Фильтр" aria-label="Фильтр разбивки" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {rows.length ? (
          <div className="table-wrap mh-hist">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>{DIMS.find(([v]) => v === dim)?.[1]}</th>
                  <th className="mh-col-bar">Доля</th>
                  <th className="col-num">↓</th>
                  <th className="col-num">↑</th>
                  <th className="col-num">Соединений</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map((r) => (
                  <tr key={r.key}>
                    <td className="cell-primary" data-label="">
                      <strong className="break">{name(r.key)}</strong>
                      {dim === "device" && name(r.key) !== r.key ? <span className="cell-sub mono">{r.key}</span> : null}
                    </td>
                    <td className="mh-col-bar" data-label="Доля">
                      <span className="bar-track">
                        <span className="bar-fill" style={{ width: `${((r.up + r.down) / max) * 100}%` }} />
                      </span>
                    </td>
                    <td className="col-num mono" data-label="↓">{bytes(r.down)}</td>
                    <td className="col-num mono" data-label="↑">{bytes(r.up)}</td>
                    <td className="col-num mono" data-label="Соединений">{number(r.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mh-muted mh-pad">За период ничего не набралось.</p>
        )}
      </section>

      <section className="card card-flush">
        <div className="card-header">
          <div>
            <h2 className="card-title">Закрытые соединения</h2>
            <p className="cell-sub">последние за период, роутер хранит до 2000</p>
          </div>
        </div>
        {rep?.closed.length ? (
          <div className="table-wrap mh-hist">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Хост</th>
                  <th>Устройство</th>
                  <th>Правило</th>
                  <th>Выход</th>
                  <th className="col-num">↓</th>
                  <th>Закрыто</th>
                </tr>
              </thead>
              <tbody>
                {rep.closed.slice(0, 300).map((c, i) => (
                  <tr key={`${c.end}:${i}`}>
                    <td className="cell-primary" data-label="">
                      <strong className="break">{c.host}</strong>
                      <span className="cell-sub">{c.network}{c.process ? ` · ${c.process}` : ""}</span>
                    </td>
                    <td data-label="Устройство">{deviceName(c.source) || c.source}</td>
                    <td data-label="Правило"><span className="badge badge-accent truncate">{c.rule}</span></td>
                    <td data-label="Выход">{c.chains?.[0] || "—"}</td>
                    <td className="col-num mono" data-label="↓">{bytes(c.down)}</td>
                    <td className="cell-sub" data-label="Закрыто">{dateTime(new Date(c.end * 1000).toISOString())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mh-muted mh-pad">Закрытых соединений за период нет.</p>
        )}
      </section>

      <ConfirmDialog
        open={confirm}
        title="Сбросить учёт трафика?"
        confirmLabel="Сбросить"
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void act("Учёт трафика", core.resetTraffic, "Сброшен").then(load);
        }}
      >
        Все накопленные на роутере ряды, разбивка и история закрытых соединений будут удалены.
      </ConfirmDialog>
    </>
  );
}
