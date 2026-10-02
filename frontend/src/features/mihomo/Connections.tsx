import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, useHashTab } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState, SearchInput, Segmented } from "../../components/ui/controls";
import { bytes, dateTime, number } from "../../lib/format";
import { mihomo, openStream, type MConnection } from "./api";
import { useMihomo } from "./context";
import { Chain, DeviceLabel, TabCount, Tabs, speed } from "./shared";

type Row = MConnection & { downSpeed: number; upSpeed: number; closedAt?: number };
type Tab = "active" | "closed" | "devices";
type Sort = "start" | "down" | "speed";
const CLOSED_LIMIT = 500;

function host(c: MConnection) {
  const m = c.metadata;
  return m.host || m.sniffHost || m.destinationIP || m.remoteDestination || "—";
}

function age(start: string, end = Date.now()) {
  const sec = Math.max(0, Math.round((end - new Date(start).getTime()) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function ruleText(c: MConnection) {
  return c.rulePayload ? `${c.rule} ${c.rulePayload}` : c.rule;
}

export function Connections({ onAnalyze }: { onAnalyze: (host: string) => void }) {
  const { act, deviceName, devices } = useMihomo();
  const [tab, setTab] = useHashTab<Tab>("connections", "active");
  const [rows, setRows] = useState<Row[]>([]);
  const [closed, setClosed] = useState<Row[]>([]);
  const [totals, setTotals] = useState({ down: 0, up: 0 });
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [device, setDevice] = useState("");
  const [sort, setSort] = useState<Sort>("start");
  const [selected, setSelected] = useState<Row | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const prev = useRef(new Map<string, Row>());
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(
    () =>
      openStream<{ downloadTotal: number; uploadTotal: number; connections: MConnection[] | null }>("/connections?interval=1000", (d) => {
        if (pausedRef.current) return;
        const next = new Map<string, Row>();
        const list = (d.connections || []).map((c) => {
          const old = prev.current.get(c.id);
          const row: Row = { ...c, downSpeed: old ? Math.max(0, c.download - old.download) : 0, upSpeed: old ? Math.max(0, c.upload - old.upload) : 0 };
          next.set(c.id, row);
          return row;
        });
        const gone: Row[] = [];
        prev.current.forEach((row, id) => {
          if (!next.has(id)) gone.push({ ...row, downSpeed: 0, upSpeed: 0, closedAt: Date.now() });
        });
        if (gone.length) setClosed((c) => [...gone, ...c].slice(0, CLOSED_LIMIT));
        prev.current = next;
        setRows(list);
        setTotals({ down: d.downloadTotal, up: d.uploadTotal });
      }),
    [],
  );

  const source = tab === "closed" ? closed : rows;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = source.filter((c) => {
      if (device && c.metadata.sourceIP !== device) return false;
      if (!q) return true;
      const hay = [host(c), c.metadata.sourceIP, deviceName(c.metadata.sourceIP), ruleText(c), c.chains.join(" "), c.metadata.process || "", c.metadata.destinationIP].join(" ").toLowerCase();
      return hay.includes(q);
    });
    if (sort === "down") list = [...list].sort((a, b) => b.download - a.download);
    else if (sort === "speed") list = [...list].sort((a, b) => b.downSpeed + b.upSpeed - (a.downSpeed + a.upSpeed));
    else list = [...list].sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
    return list;
  }, [source, query, device, sort, deviceName]);

  const byDevice = useMemo(() => {
    const m = new Map<string, { ip: string; count: number; down: number; up: number; speed: number; chains: Map<string, number> }>();
    rows.forEach((c) => {
      const ip = c.metadata.sourceIP;
      const e = m.get(ip) || { ip, count: 0, down: 0, up: 0, speed: 0, chains: new Map() };
      e.count++;
      e.down += c.download;
      e.up += c.upload;
      e.speed += c.downSpeed;
      const exit = c.chains[0] || "—";
      e.chains.set(exit, (e.chains.get(exit) || 0) + c.download);
      m.set(ip, e);
    });
    return [...m.values()].sort((a, b) => b.down - a.down);
  }, [rows]);

  const ips = useMemo(() => [...new Set(rows.map((c) => c.metadata.sourceIP))].sort(), [rows]);
  const totalSpeed = rows.reduce((s, c) => s + c.downSpeed, 0);

  return (
    <div className="stack">
      <PageHeader
        page="connections"
        actions={
          <>
            <span className="mh-speed" title="Скорость загрузки по активным соединениям">
              ↓ {speed(totalSpeed)}
            </span>
            <button type="button" className="btn" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
              <Icon name={paused ? "play" : "pause"} />
              {paused ? "Продолжить" : "Пауза"}
            </button>
            <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirmAll(true)} disabled={!rows.length}>
              <Icon name="close" />
              Закрыть все
            </button>
          </>
        }
      >
        Активных {number(rows.length)} · всего загружено {bytes(totals.down)}, отдано {bytes(totals.up)} с запуска ядра.
      </PageHeader>
      <Tabs<Tab>
        label="Соединения"
        value={tab}
        onChange={setTab}
        items={[
          ["active", <>Активные <TabCount n={rows.length} /></>],
          ["closed", <>Закрытые <TabCount n={closed.length} /></>],
          ["devices", <>По устройствам <TabCount n={byDevice.length} /></>],
        ]}
      />
      {tab !== "devices" ? (
        <>
          <div className="toolbar">
            <SearchInput label="Поиск соединений" placeholder="Хост, устройство, правило, цепочка" value={query} onChange={setQuery} />
            <select aria-label="Устройство" value={device} onChange={(e) => setDevice(e.target.value)}>
              <option value="">Все устройства</option>
              {ips.map((ip) => (
                <option key={ip} value={ip}>
                  {deviceName(ip) ? `${deviceName(ip)} · ${ip}` : ip}
                </option>
              ))}
            </select>
            <Segmented<Sort>
              label="Сортировка"
              value={sort}
              onChange={setSort}
              options={[
                { value: "start", label: "Новые" },
                { value: "speed", label: "Скорость" },
                { value: "down", label: "Объём" },
              ]}
            />
          </div>
          <section className="card card-flush">
            {visible.length ? (
              <div className="table-wrap">
                <table className="table responsive mh-conn-table">
                  <thead>
                    <tr>
                      <th>Хост</th>
                      <th>Устройство</th>
                      <th>Правило</th>
                      <th>Цепочка</th>
                      <th className="col-num">↓</th>
                      <th className="col-num">↓/с</th>
                      <th className="col-num">{tab === "closed" ? "Длилось" : "Время"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.slice(0, 400).map((c) => (
                      <tr key={c.id + (c.closedAt || "")} className="clickable" tabIndex={0} onClick={() => setSelected(c)} onKeyDown={(e) => e.key === "Enter" && setSelected(c)}>
                        <td className="cell-primary" data-label="">
                          <strong className="break">{host(c)}</strong>
                          <span className="cell-sub mono">
                            {c.metadata.network} · {c.metadata.destinationPort}
                            {c.metadata.process ? ` · ${c.metadata.process}` : ""}
                          </span>
                        </td>
                        <td data-label="Устройство">
                          <DeviceLabel ip={c.metadata.sourceIP} />
                        </td>
                        <td data-label="Правило">
                          <span className="badge badge-accent truncate" title={ruleText(c)}>
                            {ruleText(c)}
                          </span>
                        </td>
                        <td data-label="Цепочка">
                          <Chain chains={c.chains} />
                        </td>
                        <td className="col-num mono" data-label="↓">{bytes(c.download)}</td>
                        <td className="col-num mono" data-label="↓/с">{c.downSpeed ? speed(c.downSpeed) : "—"}</td>
                        <td className="col-num mono" data-label="Время">{age(c.start, c.closedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon="network" title={tab === "closed" ? "Закрытых соединений пока нет" : "Соединений нет"}>
                {tab === "closed" ? "Сюда попадают соединения, закрытые с момента открытия страницы." : "Измените фильтр или подождите трафика через mihomo."}
              </EmptyState>
            )}
            <div className="card-footer">
              {visible.length > 400 ? `Показаны первые 400 из ${number(visible.length)}. ` : ""}
              Имена устройств берутся из списка Keenetic; своё имя задаётся в «Конфигурация → Устройства».
            </div>
          </section>
        </>
      ) : (
        <section className="card card-flush">
          {byDevice.length ? (
            <div className="table-wrap">
              <table className="table responsive">
                <thead>
                  <tr>
                    <th>Устройство</th>
                    <th className="col-num">Соединений</th>
                    <th className="col-num">↓/с</th>
                    <th className="col-num">Загружено</th>
                    <th>Куда уходит трафик</th>
                  </tr>
                </thead>
                <tbody>
                  {byDevice.map((d) => (
                    <tr
                      key={d.ip}
                      className="clickable"
                      tabIndex={0}
                      onClick={() => {
                        setDevice(d.ip);
                        setTab("active");
                      }}
                    >
                      <td className="cell-primary" data-label="">
                        <DeviceLabel ip={d.ip} />
                      </td>
                      <td className="col-num mono" data-label="Соединений">{number(d.count)}</td>
                      <td className="col-num mono" data-label="↓/с">{speed(d.speed)}</td>
                      <td className="col-num mono" data-label="Загружено">{bytes(d.down)}</td>
                      <td data-label="Выходы">
                        <span className="mh-probes">
                          {[...d.chains.entries()]
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 4)
                            .map(([exit, v]) => (
                              <span key={exit} className="badge">
                                {exit} · {bytes(v)}
                              </span>
                            ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="network" title="Нет активных устройств" />
          )}
          <div className="card-footer">{devices.length ? `Keenetic знает ${number(devices.length)} устройств.` : "Список устройств Keenetic недоступен — показываются IP."}</div>
        </section>
      )}

      {selected ? (
        <Modal
          open
          variant="drawer"
          onClose={() => setSelected(null)}
          title={<span className="drawer-title mono">{host(selected)}</span>}
          description={`${selected.metadata.network.toUpperCase()} · ${selected.metadata.type}${selected.closedAt ? " · закрыто" : ""}`}
          footer={
            <>
              <button type="button" className="btn" onClick={() => onAnalyze(host(selected))}>
                <Icon name="network" />
                Проверить в «Анализаторе»
              </button>
              {!selected.closedAt ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() =>
                    void act("Соединение закрыто", () => mihomo.closeConnection(selected.id), host(selected)).then(() => setSelected(null))
                  }
                >
                  Закрыть соединение
                </button>
              ) : null}
            </>
          }
        >
          <div className="stack">
            <div className="mh-flow">
              <span>{deviceName(selected.metadata.sourceIP) || selected.metadata.sourceIP}</span>
              <Icon name="arrowRight" size={14} />
              <span className="is-accent">{ruleText(selected)}</span>
              <Icon name="arrowRight" size={14} />
              <Chain chains={selected.chains} />
            </div>
            <dl className="kv">
              {(
                [
                  ["Источник", `${selected.metadata.sourceIP}:${selected.metadata.sourcePort}`],
                  ["Назначение", `${selected.metadata.destinationIP || selected.metadata.remoteDestination || "—"}:${selected.metadata.destinationPort}`],
                  ["Страна / ASN", [selected.metadata.destinationGeoIP, selected.metadata.destinationIPASN].filter(Boolean).join(" · ")],
                  ["Вход", selected.metadata.inboundName || ""],
                  ["Процесс", selected.metadata.process || ""],
                  ["DNS", selected.metadata.dnsMode || ""],
                  ["Отдано / получено", `${bytes(selected.upload)} / ${bytes(selected.download)}`],
                  ["Начало", dateTime(selected.start)],
                ] as Array<[string, string]>
              )
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd className="mono">{v}</dd>
                  </div>
                ))}
            </dl>
            <details className="raw-details">
              <summary>Исходная запись</summary>
              <pre className="code-block">{JSON.stringify(selected, null, 2)}</pre>
            </details>
          </div>
        </Modal>
      ) : null}
      <ConfirmDialog
        open={confirmAll}
        title="Закрыть все соединения?"
        confirmLabel="Закрыть все"
        onClose={() => setConfirmAll(false)}
        onConfirm={() => {
          setConfirmAll(false);
          void act("Соединения", () => mihomo.closeAll(), `Закрыто ${rows.length}`);
        }}
      >
        Будет разорвано {number(rows.length)} соединений. Приложения переподключатся сами, но загрузки и звонки прервутся.
      </ConfirmDialog>
    </div>
  );
}
