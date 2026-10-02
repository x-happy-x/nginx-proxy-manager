import { useMemo, useState } from "react";
import type { NetAvailability, NetworkPayload } from "../../api";
import { Legend, TimeChart } from "../../components/charts/TimeChart";
import { Alert } from "../../components/ui/controls";
import { bytes } from "../../lib/format";
import { formatBps, formatUptime } from "../../pages/Resources";
import { carriersText } from "./Antenna";
import { Tag, formatAgo, formatClock, formatDuration, formatMs, type Tone } from "./shared";

// «Обзор»: what Netping used to show — LTE, availability of the internet and
// of domains from both routers, latency, traffic, interfaces, incidents.

export function NetworkOverview({ data, onAntenna }: { data: NetworkPayload; onAntenna: () => void }) {
  const times = data.series.map((b) => b.t);
  const mt = data.mikrotik;
  const sig = mt.signal;
  const summary = data.availability.filter((a) => a.group === "summary");
  const avgMT = useMemo(
    () =>
      data.series.map((b) => {
        const vals = (data.targets || []).filter((t) => t.category === "internet").map((t) => b.mt[t.id]).filter((v): v is number => v != null);
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      }),
    [data],
  );
  const quality = sig?.quality ?? null;
  const qualityTone: Tone = quality == null ? "neutral" : quality >= 60 ? "good" : quality >= 35 ? "warning" : "critical";
  const wan = data.keenetic.interfaces?.find((i) => i.wan);
  const lte = mt.system?.interfaces.find((i) => i.type === "lte");
  const [allIfaces, setAllIfaces] = useState(false);
  // Netcraze has dozens of interfaces; idle ones (no bytes) are hidden and
  // the rest sorted by traffic, WAN first.
  const ifaces = (data.keenetic.interfaces || [])
    .filter((i) => i.wan || i.rx_bytes + i.tx_bytes > 0)
    .sort((a, b) => Number(!!b.wan) - Number(!!a.wan) || b.rx_bps + b.tx_bps - (a.rx_bps + a.tx_bps) || b.rx_bytes + b.tx_bytes - (a.rx_bytes + a.tx_bytes));

  return (
    <div className="net-stack">
      {mt.error ? <Alert tone="warning" title="MikroTik: не все данные">{mt.error}</Alert> : null}
      <div className="net-checks">
        {summary.map((a) => (
          <CheckTile key={a.id} item={a} />
        ))}
      </div>

      <div className="res-kpis">
        <div className="card res-kpi">
          <span className="res-kpi-label">LTE{sig?.operator ? ` · ${sig.operator}` : ""}{sig?.band ? ` · ${sig.band}` : ""}</span>
          <strong className="res-kpi-value">{quality != null ? `${quality} %` : "—"}</strong>
          <span className="res-kpi-sub">
            <Tag tone={qualityTone}>{qualityTone === "good" ? "хороший сигнал" : qualityTone === "warning" ? "средний сигнал" : qualityTone === "critical" ? "слабый сигнал" : "нет данных"}</Tag>
            {sig ? ` RSRP ${sig.rsrp} · RSRQ ${sig.rsrq} · SINR ${sig.sinr}` : ""}
          </span>
          {sig?.carriers?.length ? (
            <span className="res-kpi-sub">
              {sig.carriers.filter((c) => c.active).length > 1 ? (
                <Tag tone="good">агрегация: {carriersText(sig.carriers)}</Tag>
              ) : (
                <>без агрегации · {carriersText(sig.carriers)}</>
              )}{" "}
              ·{" "}
              <button type="button" className="net-link" onClick={onAntenna}>
                наведение антенны
              </button>
            </span>
          ) : null}
          <TimeChart label="SINR сигнала LTE" times={times} series={[{ label: "SINR, дБ", values: data.series.map((b) => b.sinr) }]} format={(v) => `${v.toFixed(0)} дБ`} height={70} />
        </div>
        <div className="card res-kpi">
          <span className="res-kpi-label">Задержка до интернета</span>
          <strong className="res-kpi-value">{formatMs(avgMT[avgMT.length - 1] ?? data.current?.mt?.["google-dns"]?.ms)}</strong>
          <Legend series={[{ label: "MikroTik, ICMP", values: [] }, { label: "через mihomo, HTTP", values: [] }]} />
          <TimeChart
            label="Задержка до интернета"
            times={times}
            series={[{ label: "MikroTik", values: avgMT }, { label: "через mihomo", values: data.series.map((b) => b.proxy_ms) }]}
            format={formatMs}
            height={70}
            area={false}
          />
        </div>
        <div className="card res-kpi">
          <span className="res-kpi-label">Трафик LTE (MikroTik)</span>
          <strong className="res-kpi-value res-kpi-traffic">
            <span>↓ {formatBps(lte?.rx_bps || 0)}</span>
            <span>↑ {formatBps(lte?.tx_bps || 0)}</span>
          </strong>
          <Legend series={[{ label: "Входящий", values: [] }, { label: "Исходящий", values: [] }]} />
          <TimeChart
            label="Трафик LTE"
            times={times}
            series={[{ label: "↓ входящий", values: data.series.map((b) => b.lte_rx) }, { label: "↑ исходящий", values: data.series.map((b) => b.lte_tx) }]}
            format={formatBps}
            height={70}
            area={false}
          />
        </div>
        <div className="card res-kpi">
          <span className="res-kpi-label">Трафик Netcraze{wan ? ` (${wan.name})` : ""}</span>
          <strong className="res-kpi-value res-kpi-traffic">
            <span>↓ {formatBps(wan?.rx_bps || 0)}</span>
            <span>↑ {formatBps(wan?.tx_bps || 0)}</span>
          </strong>
          <Legend series={[{ label: "Входящий", values: [] }, { label: "Исходящий", values: [] }]} />
          <TimeChart
            label="Трафик интернет-подключения Netcraze"
            times={times}
            series={[{ label: "↓ входящий", values: data.series.map((b) => b.wan_rx) }, { label: "↑ исходящий", values: data.series.map((b) => b.wan_tx) }]}
            format={formatBps}
            height={70}
            area={false}
          />
        </div>
      </div>

      <section className="res-section">
        <header className="res-section-head">
          <div>
            <h2>Доступность</h2>
            <p>Каждый столбик — {formatDuration(data.bucket_sec)}; проверки каждые {data.interval_sec} с с MikroTik (напрямую через LTE) и с Netcraze.</p>
          </div>
        </header>
        <div className="card net-avail">
          {data.availability.map((a) => (
            <AvailabilityRow key={a.id} item={a} bucketSec={data.bucket_sec} start={data.series[0]?.t ?? 0} />
          ))}
        </div>
      </section>

      <div className="grid-2 net-grid">
        <section className="res-section">
          <header className="res-section-head">
            <div>
              <h2>Цели</h2>
              <p>Последняя проверка: ping ×3 с каждого роутера</p>
            </div>
          </header>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Цель</th>
                  <th>MikroTik</th>
                  <th>Netcraze</th>
                </tr>
              </thead>
              <tbody>
                {(data.targets || []).map((t) => {
                  const m = data.details?.mikrotik?.[t.id];
                  const n = data.details?.netcraze?.[t.id];
                  return (
                    <tr key={t.id}>
                      <td>
                        <div className="cell-title">{t.name}</div>
                        <div className="cell-sub mono">{t.address} · {t.category === "internet" ? "IP" : "домен"}</div>
                      </td>
                      <td>{m ? <PingCell ok={m.ok} ms={m.avg_ms} loss={m.loss} error={m.error} /> : "—"}</td>
                      <td>{n ? <PingCell ok={n.ok} ms={n.avg_ms} loss={n.loss} error={n.error} /> : "—"}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td>
                    <div className="cell-title">www.gstatic.com</div>
                    <div className="cell-sub">HTTP через mihomo</div>
                  </td>
                  <td>—</td>
                  <td>{data.current ? <PingCell ok={data.current.proxy.ok} ms={data.current.proxy.ms} error={data.details?.proxy_error} /> : "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="res-section">
          <header className="res-section-head">
            <div>
              <h2>Инциденты</h2>
              <p>Периоды, когда проверка не проходила</p>
            </div>
          </header>
          <div className="card net-incidents">
            {data.incidents.length === 0 ? <p className="muted">За период сбоев нет.</p> : null}
            {data.incidents.slice(0, 30).map((i) => (
              <div key={`${i.check}-${i.start}`} className="net-incident">
                <Tag tone={i.end ? "warning" : "critical"}>{i.end ? "был сбой" : "сейчас"}</Tag>
                <span className="net-incident-name">{i.name}</span>
                <span className="muted">
                  {formatClock(i.start)} · {formatDuration(i.duration_sec)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid-2 net-grid">
        <section className="res-section">
          <header className="res-section-head">
            <div>
              <h2>Интерфейсы Netcraze</h2>
            </div>
          </header>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Интерфейс</th>
                  <th>↓ сейчас</th>
                  <th>↑ сейчас</th>
                  <th>Всего ↓ / ↑</th>
                </tr>
              </thead>
              <tbody>
                {(allIfaces ? ifaces : ifaces.slice(0, 8)).map((i) => (
                  <tr key={i.name}>
                    <td className="mono">
                      {i.name}
                      {i.wan ? <span className="badge badge-accent net-inline-badge">WAN</span> : null}
                    </td>
                    <td>{formatBps(i.rx_bps)}</td>
                    <td>{formatBps(i.tx_bps)}</td>
                    <td className="muted">{bytes(i.rx_bytes)} / {bytes(i.tx_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ifaces.length > 8 ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAllIfaces((v) => !v)}>
              {allIfaces ? "Свернуть" : `Показать все ${ifaces.length}`}
            </button>
          ) : null}
        </section>
        <section className="res-section">
          <header className="res-section-head">
            <div>
              <h2>Интерфейсы MikroTik</h2>
              <p>{mt.system ? `${mt.system.board} · RouterOS ${mt.system.version} · аптайм ${formatUptime(mt.system.uptime_seconds)}` : "нет данных"}</p>
            </div>
          </header>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Интерфейс</th>
                  <th>Состояние</th>
                  <th>↓ сейчас</th>
                  <th>↑ сейчас</th>
                </tr>
              </thead>
              <tbody>
                {(mt.system?.interfaces || []).filter((i) => i.type !== "loopback").map((i) => (
                  <tr key={i.name}>
                    <td>
                      <span className="mono">{i.name}</span> <span className="muted">{i.type}</span>
                    </td>
                    <td>{i.running ? <Tag tone="good">работает</Tag> : <Tag tone="neutral">не подключён</Tag>}</td>
                    <td>{formatBps(i.rx_bps)}</td>
                    <td>{formatBps(i.tx_bps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mt.system?.dns_servers?.length ? <p className="muted net-note">DNS MikroTik: {mt.system.dns_servers.join(", ")}</p> : null}
        </section>
      </div>
    </div>
  );
}

function PingCell({ ok, ms, loss, error }: { ok: boolean; ms?: number; loss?: number; error?: string }) {
  if (!ok) return <Tag tone="critical" title={error}>нет ответа</Tag>;
  return (
    <span className="net-ping">
      <Tag tone={loss && loss > 0 ? "warning" : "good"}>{formatMs(ms)}</Tag>
      {loss ? <span className="muted"> потери {loss}%</span> : null}
    </span>
  );
}

function CheckTile({ item }: { item: NetAvailability }) {
  const tone: Tone = !item.valid ? "neutral" : item.ok ? "good" : "critical";
  return (
    <div className={`card net-check net-check-${tone}`}>
      <span className="net-check-name">{item.name}</span>
      <Tag tone={tone}>{!item.valid ? "нет данных" : item.ok ? "работает" : "не работает"}</Tag>
      <span className="net-check-meta">
        {item.valid ? `${item.uptime.toFixed(item.uptime >= 99.95 ? 0 : 2)} % за период` : ""}
        {item.last_change ? ` · изменилось ${formatAgo(item.last_change)}` : ""}
      </span>
    </div>
  );
}

function AvailabilityRow({ item, bucketSec, start }: { item: NetAvailability; bucketSec: number; start: number }) {
  return (
    <div className="net-avail-row">
      <div className="net-avail-name">
        <span>{item.name}</span>
        <span className="muted">{item.valid ? `${item.uptime.toFixed(item.uptime >= 99.95 ? 0 : 2)} %` : "—"}</span>
      </div>
      <div className="net-avail-bars" role="img" aria-label={`${item.name}: доступность ${item.uptime} %`}>
        {item.buckets.map((v, i) => {
          const cls = v < 0 ? "none" : v >= 100 ? "ok" : v <= 0 ? "down" : "part";
          const at = formatClock(start + i * bucketSec);
          const title = v < 0 ? `${at}: нет данных` : `${at}: ${v}% проверок успешно`;
          return <i key={i} className={`net-bar net-bar-${cls}`} title={title} />;
        })}
      </div>
    </div>
  );
}
