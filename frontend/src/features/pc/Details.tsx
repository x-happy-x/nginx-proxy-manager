import { useEffect, useRef, useState } from "react";
import { Legend, TimeChart } from "../../components/charts/TimeChart";
import { Modal } from "../../components/ui/Modal";
import { ago, bits, bytes, percent, ratio, uptime } from "../pve/model";
import { Empty } from "../pve/parts";
import type { MonitoringEvent } from "../monitoring/EventCenter";
import { usePc } from "./context";
import { containersOf, contextName, outdated, usePcPoll, type Computer, type Container } from "./model";
import { Disks, MachineHead, Ports, ViewSwitch } from "./parts";
import { AppBadges, ContainerList, Wsl } from "./Workloads";
import { Controls } from "./Actions";

type Tab = "overview" | "docker" | "wsl" | "disks" | "events";
function ComputerDetail({ h }: { h: Computer }) {
  const { host, history } = usePc();
  const [tab, setTab] = useState<Tab>("overview");
  const events = usePcPoll<{ events: MonitoringEvent[] }>(host, tab === "events" ? "/api/pc/events" : null, 15);
  const points = (history.data[h.id]?.points || []).filter(p => p.t >= Date.now() / 1000 - 86400);
  const times = points.map(p => p.t);
  const network = [{ label: "Приём", values: points.map(p => p.network_valid === false ? null : p.net_rx_bps) }, { label: "Передача", values: points.map(p => p.network_valid === false ? null : p.net_tx_bps) }];
  const disks = [...new Set(points.flatMap(p => p.disks?.map(d => d.path) || []))];
  const ownEvents = events.data?.events.filter(e => e.host === h.id) || [];
  return <div className="pc-page"><MachineHead h={h} />{outdated(h) ? <p className="pc-error">{h.error || "Нет свежих данных"}. Последний снимок: {ago(h.current?.ts || h.last_ok)}.</p> : null}<ViewSwitch label="Раздел компьютера" value={tab} onChange={setTab} options={[{ value: "overview", label: "Обзор" }, { value: "docker", label: "Docker" }, { value: "wsl", label: "WSL" }, { value: "disks", label: "Диски" }, { value: "events", label: "События" }]} />
    {tab === "overview" ? <><dl className="pc-kv"><dt>Процессор</dt><dd>{h.current?.cpu.model || "—"}</dd><dt>Память</dt><dd>{h.current ? bytes(h.current.memory.total) : "—"}</dd><dt>Время работы</dt><dd>{h.current ? uptime(h.current.uptime) : "—"}</dd><dt>Агент</dt><dd>{h.current?.agent || "—"} · {h.latency_ms} мс</dd></dl><p className="pc-muted">Последние сутки · точки раз в минуту</p>{history.errors[h.id] ? <p className="pc-error">История не обновлена: {history.errors[h.id]}</p> : null}{points.length > 1 ? <div className="pc-detail-charts"><section className="pc-chart"><h3>CPU <b>{percent(h.current?.cpu.percent ?? null)}</b></h3><TimeChart times={times} series={[{ label: "CPU", values: points.map(p => p.cpu) }]} max={100} height={120} axis format={percent} label="CPU за сутки" /></section><section className="pc-chart"><h3>Память</h3><TimeChart times={times} series={[{ label: "Память", values: points.map(p => p.mem_total ? ratio(p.mem_used, p.mem_total) : null) }]} max={100} height={120} axis format={percent} label="Память за сутки" /></section><section className="pc-chart"><h3>Сеть · основной маршрут</h3><TimeChart times={times} series={network} height={120} axis format={v => bits(v / 8)} label="Сеть за сутки" /><Legend series={network} /></section></div> : <Empty title="История копится">Графики появятся после нескольких минут работы.</Empty>}<section className="pc-chart"><h3>Диски</h3><Disks h={h} /></section></> : null}
    {tab === "docker" ? containersOf([h]).length ? <ContainerList rows={containersOf([h])} view="cards" /> : <Empty title="Контейнеров нет">Docker может быть недоступен или не установлен.</Empty> : null}
    {tab === "wsl" ? <Wsl only={h} /> : null}
    {tab === "disks" ? <><Disks h={h} />{disks.length ? <section className="pc-chart"><h3>Заполнение дисков · сутки</h3><TimeChart times={times} series={disks.map(path => ({ label: path, values: points.map(p => { const d = p.disks?.find(d => d.path === path); return d?.total ? ratio(d.used, d.total) : null; }) }))} max={100} height={180} axis format={percent} label="Заполнение дисков за сутки" /><Legend series={disks.map(label => ({ label, values: [] }))} /></section> : <p className="pc-muted">История дисков появится после обновления сборщика.</p>}</> : null}
    {tab === "events" ? <>{events.error ? <p className="pc-error">{events.error}</p> : null}{ownEvents.length ? <ol className="pc-events">{ownEvents.map(e => <li key={e.id}><time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString("ru-RU")}</time><strong>{e.title}</strong><p>{e.message}</p></li>)}</ol> : <Empty title={events.loading ? "Загружаем события…" : "Событий нет"}>Потеря связи, восстановление и результаты операций.</Empty>}</> : null}
  </div>;
}

function ContainerDetail({ h, c, context, initialLogs }: { h: Computer; c: Container; context: string; initialLogs: boolean }) {
  const { host } = usePc();
  const [logs, setLogs] = useState(initialLogs), [tail, setTail] = useState("300"), [copied, setCopied] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  const reply = usePcPoll<{ ok: boolean; text?: string; error?: string; truncated?: boolean }>(host, logs ? `/api/pc/logs?${new URLSearchParams({ host: h.id, context, id: c.id, tail })}` : null, 3600);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [reply.data]);
  const d = h.current?.docker.find(d => d.context === context)!;
  return <div className="pc-page"><p className="pc-muted">{h.name} · {contextName(context)} · {c.status}</p><dl className="pc-kv"><dt>Образ</dt><dd className="pc-mono">{c.image}</dd><dt>ID</dt><dd className="pc-mono">{c.id}</dd><dt>Порты</dt><dd><Ports value={c.ports} /></dd><dt>Приложение</dt><dd><AppBadges row={{ h, d, c }} /></dd></dl><Controls target={{ h, c, context }} />
    <div className="pc-toolbar"><button type="button" className="hp-btn" aria-expanded={logs} disabled={!h.current?.capabilities.docker_logs || outdated(h)} title={!h.current?.capabilities.docker_logs ? "Агент не поддерживает логи или доступ не разрешён" : undefined} onClick={() => setLogs(!logs)}>≡ {logs ? "Скрыть логи" : "Логи"}</button>{logs ? <><ViewSwitch label="Сколько строк" value={tail} onChange={setTail} options={["100", "300", "1000"].map(value => ({ value, label: value }))} /><button type="button" className="hp-btn" onClick={() => void reply.reload()}>Обновить логи</button>{reply.data?.text ? <button type="button" className="hp-btn" onClick={() => void navigator.clipboard.writeText(reply.data?.text || "").then(() => setCopied(true)).catch(() => host.notify("Не удалось скопировать логи"))}>{copied ? "Скопировано" : "Скопировать"}</button> : null}</> : null}</div>
    {logs ? reply.error || reply.data?.error ? <p role="alert" className="pc-error">{reply.error || reply.data?.error}</p> : <><pre className="hp-logs" ref={box} tabIndex={0}>{reply.loading ? "Загружаем…" : reply.data?.text || "Лог пуст"}</pre><small className="pc-muted">Последние {tail} строк{reply.data?.truncated ? " · обрезано до 512 КБ" : ""}</small></> : null}
  </div>;
}

export function Details() {
  const { computers, computer, container, application, openComputer, openContainer, openApplication, hideAddresses } = usePc();
  const h = computers.find(h => h.id === (computer || container?.host));
  const c = h?.current?.docker.find(d => d.context === container?.context)?.containers.find(c => c.id === container?.id);
  return <><Modal open={!!computer} title="Компьютер подробно" variant="drawer" onClose={() => openComputer(null)}><div className="hp pc-dialog-body">{h ? <ComputerDetail key={h.id} h={h} /> : <Empty title="Компьютер больше не найден">Обновите список компьютеров.</Empty>}</div></Modal><Modal open={!!container} title={c ? `${container?.logs ? "Логи" : "Контейнер"} · ${c.name}` : "Контейнер"} size="xl" onClose={() => openContainer(null)}><div className="hp pc-dialog-body">{h && c && container ? <ContainerDetail key={`${h.id}/${container.context}/${c.id}/${container.logs}`} h={h} c={c} context={container.context} initialLogs={!!container.logs} /> : <Empty title="Контейнер больше не найден">Возможно, он был удалён или окружение остановлено.</Empty>}</div></Modal><Modal open={!!application} title="Приложение HomeNet" onClose={() => openApplication(null)}><div className="hp pc-dialog-body">{application ? <article className="pc-application-card"><h2>{application.title}</h2><p>{application.about || "Приложение домашней сети"}</p>{!hideAddresses ? <p className="pc-muted">{application.primary}</p> : null}<a className="hp-btn is-primary" href={application.primary} target="_blank" rel="noreferrer">Открыть приложение ↗</a><a className="hp-btn" href="/">Все приложения HomeNet</a></article> : null}</div></Modal></>;
}
