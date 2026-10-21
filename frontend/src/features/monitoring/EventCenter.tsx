import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/ui/Icon";
import { Segmented } from "../../components/ui/controls";
import type { Host } from "../../platform/sdk";
import "./events.css";

export type MonitoringEvent = {
  id: string; host: string; kind: "connection_lost" | "connection_restored" | "task_error" | "task_unknown";
  severity: "warning" | "info" | "error"; title: string; message: string; created_at: string; read_at?: string;
};
type Events = { events: MonitoringEvent[]; unread: number; storage_error?: string };
type Service = "pc" | "pve";
const eventIcons: Record<MonitoringEvent["kind"], IconName> = { connection_lost: "network", connection_restored: "checkCircle", task_error: "error", task_unknown: "alert" };
const formatTime = (value: string) => new Date(value).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** A saved inbox shared by the PC and Proxmox modules; polling never sends toasts. */
export function EventCenter({ host, service, hosts, enabled }: { host: Host; service: Service; hosts: { id: string; name: string }[]; enabled: boolean }) {
  const [data, setData] = useState<Events | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("all");
  const [writing, setWriting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [limit, setLimit] = useState(20);
  const serial = useRef(0);
  const heading = useRef<HTMLButtonElement>(null);
  const panel = useId();
  const load = useCallback(async () => {
    if (!enabled) return;
    const current = ++serial.current;
    setRefreshing(true);
    try {
      const next = await (await host.api(`/api/${service}/events`)).json() as Events;
      if (current === serial.current) { setData(next); setError(""); }
    } catch (e) { if (current === serial.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (current === serial.current) setRefreshing(false); }
  }, [host, service, enabled]);
  useEffect(() => {
    setData(null); setError(""); setActionError("");
    const tick = () => { if (document.visibilityState !== "hidden") void load(); };
    tick();
    const timer = window.setInterval(tick, 10_000);
    document.addEventListener("visibilitychange", tick);
    return () => { ++serial.current; window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [load]);
  const markRead = async (id?: string) => {
    if (writing) return;
    ++serial.current;
    setWriting(id || "all"); setActionError("");
    try {
      const next = await (await host.api(`/api/${service}/events/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(id ? { ids: [id] } : { all: true }) })).json() as Events;
      ++serial.current;
      setData(next); setError(""); setRefreshing(false);
      if (filter === "unread") heading.current?.focus();
    } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setWriting(null); setRefreshing(false); }
  };
  if (!enabled) return null;
  const events = data?.events || [];
  const unread = data?.unread || 0;
  const filtered = filter === "unread" ? events.filter((event) => !event.read_at) : events;
  const latest = events.find((event) => !event.read_at) || events[0];
  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name || id;
  return <section className={`monitor-events card${unread ? " has-unread" : ""}`} aria-label="События мониторинга">
    <header className="monitor-events-head">
      <button ref={heading} type="button" className="monitor-events-toggle" aria-expanded={expanded} aria-controls={panel} onClick={() => setExpanded(!expanded)}>
        <span className="monitor-events-icon"><Icon name="inbox" size={18} /></span>
        <span className="monitor-events-title"><strong>События{unread ? <span className="monitor-events-count" aria-label={`${unread} непрочитанных`}>{unread}</span> : null}</strong>
          <small>{!data && !error ? "Загружаем журнал…" : error ? "Журнал не обновлён" : latest ? `${hostName(latest.host)} · ${latest.title}` : "Пока без событий"}</small>
        </span>
        <Icon name="chevronDown" className={expanded ? "expanded" : ""} size={16} />
      </button>
      <span className="sr-only" role="status">{data ? `Непрочитанных событий: ${unread}` : ""}</span>
      <button type="button" className="monitor-events-read-all" disabled={!unread || !!writing || !!error} onClick={() => void markRead()}><Icon name="check" size={14} />{writing === "all" ? "Сохраняю…" : "Прочитать все"}</button>
    </header>
    {data?.storage_error ? <div className="monitor-events-alert storage" role="alert"><Icon name="alert" size={17} /><div><strong>Не удалось сохранить данные мониторинга</strong><p>Новые данные могут не пережить перезапуск. Проверьте доступность хранилища интеграции.</p><small>{data.storage_error}</small></div></div> : null}
    {error || actionError ? <div className="monitor-events-alert" role="alert"><Icon name="error" size={17} /><div><strong>{actionError ? "Не удалось отметить события прочитанными" : "Не удалось обновить события"}</strong><p>{actionError || error}</p>{error && data ? <small>Показан последний полученный список.</small> : null}</div><button type="button" className="monitor-events-retry" disabled={refreshing} onClick={() => { setActionError(""); void load(); }}>Обновить</button></div> : null}
    {expanded ? <div className="monitor-events-panel" id={panel}>
      <div className="monitor-events-toolbar"><Segmented label="События" value={filter} onChange={(value) => { setFilter(value); setLimit(20); }} options={[{ value: "all", label: "Все", count: events.length }, { value: "unread", label: "Непрочитанные", count: unread }]} /><button type="button" className="monitor-events-refresh" disabled={refreshing} onClick={() => void load()}><Icon name="refresh" size={14} />{refreshing ? "Обновляю…" : "Обновить"}</button></div>
      <p className="monitor-events-hint">Потеря и восстановление связи, ошибки и неизвестные результаты операций. Журнал и отметки о прочтении сохраняются между перезапусками.</p>
      {filtered.length ? <ol className="monitor-events-list">{filtered.slice(0, limit).map((event) => <li key={event.id} className={`monitor-event severity-${event.severity}${event.read_at ? " read" : " unread"}`}>
        <span className="monitor-event-kind"><Icon name={eventIcons[event.kind] || "info"} size={17} /></span>
        <div className="monitor-event-body"><div className="monitor-event-meta"><span>{hostName(event.host)}</span><time dateTime={event.created_at} title={new Date(event.created_at).toLocaleString("ru-RU")}>{formatTime(event.created_at)}</time>{!event.read_at ? <span className="monitor-event-new">Новое</span> : null}</div>
          <strong>{event.title}</strong>{event.message ? <p>{event.message}</p> : null}
          {event.kind === "task_unknown" ? <small>Проверьте состояние перед повтором. Операция не запускается повторно автоматически.</small> : null}
        </div>
        {!event.read_at ? <button type="button" className="monitor-event-read" disabled={!!writing} aria-label={`Отметить прочитанным: ${event.title}, ${hostName(event.host)}`} onClick={() => void markRead(event.id)}><Icon name={writing === event.id ? "clock" : "check"} size={14} /><span>{writing === event.id ? "Сохраняю…" : "Прочитать"}</span></button> : <span className="monitor-event-done"><Icon name="check" size={13} /><span>Прочитано</span></span>}
      </li>)}</ol> : <div className="monitor-events-empty"><Icon name={filter === "unread" ? "checkCircle" : "inbox"} size={24} /><strong>{filter === "unread" ? "Все события прочитаны" : "Событий пока нет"}</strong><p>{filter === "unread" ? "Ранее прочитанные записи доступны во вкладке «Все»." : "Здесь появятся изменения связи с устройствами и проблемы при выполнении операций."}</p></div>}
      {filtered.length > limit ? <button type="button" className="monitor-events-more" onClick={() => setLimit((value) => value + 20)}>Показать ещё · осталось {filtered.length - limit}</button> : null}
    </div> : null}
  </section>;
}
