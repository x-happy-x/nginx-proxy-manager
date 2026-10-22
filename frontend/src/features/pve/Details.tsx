import { useState } from "react";
import { Modal } from "../../components/ui/Modal";
import { ActionButtons } from "./Actions";
import { usePve } from "./context";
import { Inventory } from "./Hardware";
import { AppChips, Chart, SnapshotNote } from "./ui";
import { BackupList } from "./Storage";
import { bytes, celsius, dateTime, guestStatus, percent, proxmoxURL, uptime, usePoll, type PveHost, type PveGuest, type PveTask } from "./model";
import type { MonitoringEvent } from "../monitoring/EventCenter";
import { Empty } from "./parts";
function EventList({ h, g }: { h: PveHost; g?: PveGuest }) {
  const { host } = usePve();
  const events = usePoll<{ events: MonitoringEvent[] }>(host, g ? null : "/api/pve/events", 30);
  const tasks = usePoll<{ tasks: PveTask[] }>(host, "/api/pve/tasks", 15);
  const own = (tasks.data?.tasks || []).filter(t => t.host === h.id && (!g || t.target === "guest" && t.vmid === g.vmid && t.type === g.type));
  const journal = (events.data?.events || []).filter(e => e.host === h.id);
  return <div className="pv-event-list">{events.error || tasks.error ? <p role="alert">Журнал не обновился: {events.error || tasks.error}</p> : null}{journal.map(e => <article key={e.id}><b>{e.title}</b><p>{e.message}</p><small>{new Date(e.created_at).toLocaleString("ru-RU")}</small></article>)}{own.map(t => <article key={t.id}><b>{t.action} · {t.status}</b><p>{t.message}</p><small>{new Date(t.created_at).toLocaleString("ru-RU")}</small></article>)}{!own.length && !journal.length && <Empty title="Событий пока нет" />}</div>;
}
export function Details() {
  const ctx = usePve(); const [tab, setTab] = useState("overview");
  const h = ctx.hosts.find(h => h.id === ctx.target?.host), g = h?.current?.guests.find(g => g.vmid === ctx.target?.vmid && g.type === ctx.target?.type);
  const open = !!ctx.target, close = () => ctx.setTarget(null);
  if (!open) return null;
  const points = h ? ctx.history[h.id]?.points || [] : [], guests = h && g ? ctx.history[h.id]?.guests?.[g.vmid] || [] : [];
  const backups = (h?.current?.backups || []).filter(b => !g || b.vmid === g.vmid || b.vmid == null && b.id === String(g.vmid));
  const last = backups.filter(b => b.status === "OK").sort((a,b) => b.start-a.start)[0];
  const tabs = [["overview", "Обзор"], ["apps", "Приложения"], ["containers", "Контейнеры"], ["backups", "Копии"], ["events", "События"]];
  return <Modal open={open} onClose={close} variant="drawer" title={g ? g.name : h?.name || "Машина не найдена"} description={h ? `${g ? `${g.type === "qemu" ? "VM" : "CT"} ${g.vmid} · ${h.name} · ${guestStatus(g)}` : "Сервер Proxmox"} · ${ctx.hide ? "Адрес скрыт" : g?.ips?.join(", ") || h.address}` : undefined}>
    <div className="hp pv-details"><div className="pve-module">{h ? <><SnapshotNote h={h} />{ctx.target?.vmid && !g ? <Empty title="Машина больше не найдена">Возможно, её перенесли на другой сервер.</Empty> : <><div className="pv-detail-power"><ActionButtons h={h} g={g} /><a className="pve-btn ghost" href={proxmoxURL(h,g)} target="_blank" rel="noreferrer">Консоль Proxmox ↗</a></div><div className="pv-tabs" role="tablist">{tabs.filter(([k]) => g || k !== "apps" && k !== "containers").map(([key, label]) => <button role="tab" aria-selected={tab===key} className={tab===key ? "is-on" : ""} key={key} onClick={() => setTab(key)}>{label}</button>)}</div>
      {tab === "overview" && <><Chart title="CPU · сутки" times={g ? guests.map(p=>p[0]) : points.map(p=>p.t)} values={g ? guests.map(p=>p[1]) : points.map(p=>p.cpu)} max={100} format={percent} /><Chart title="Память · сутки" times={g ? guests.map(p=>p[0]) : points.map(p=>p.t)} values={g ? guests.map(p=>p[2]) : points.map(p=>p.mem)} format={bytes} />{ctx.historyErrors[h.id] && <p role="status">История не обновилась: {ctx.historyErrors[h.id]}</p>}
        {g ? <><dl className="pv-kv"><dt>Процессор</dt><dd>{g.cpus || "—"} vCPU · {g.config?.cpu || "тип неизвестен"}</dd><dt>Память</dt><dd>{bytes(g.maxmem)}{g.config?.balloon === 0 ? " · без balloon" : ""}</dd><dt>Работает</dt><dd>{uptime(g.uptime)}</dd><dt>Диски</dt><dd>{g.config?.disks?.map(d=><div key={d.slot}>{d.slot} · {d.volume} · {d.size || "размер неизвестен"}</div>) || "Конфигурация недоступна (нужен агент 1.4.0)"}</dd><dt>Сеть</dt><dd>{g.config?.networks?.map(n=><div key={n.slot}>{n.slot} · {n.bridge} · {ctx.hide ? "MAC скрыт" : n.mac}</div>) || "Нет данных"}</dd><dt>Guest agent</dt><dd>{g.type === "lxc" ? "Не требуется для LXC" : g.config?.agent == null ? "Нет данных" : /^(1|enabled=1)(,|$)/.test(String(g.config.agent)) ? "Включён в конфигурации" : "Выключен"}</dd><dt>Копия</dt><dd>{last ? `${dateTime(last.start)} · ${bytes(last.size)}` : "Нет данных о копии"}</dd></dl><AppChips g={g} /></> : <><dl className="pv-kv"><dt>Работает</dt><dd>{uptime(h.current?.node.uptime)}</dd><dt>Температура</dt><dd>{celsius(h.current?.node.cpu_temp)}</dd><dt>Версии</dt><dd>PVE {h.current?.versions.pve || "—"} · агент {h.current?.versions.agent || "—"}</dd><dt>Обновления</dt><dd>{h.current?.updates ?? "Нет данных"}</dd><dt>Службы с ошибками</dt><dd>{h.current?.failed_units.join(", ") || "Нет"}</dd></dl><Inventory h={h} /></>}
      </>}{tab === "apps" && g && <AppChips g={g} all />}{tab === "containers" && g && (ctx.containersOf(g).length ? <div className="pv-event-list">{ctx.containersOf(g).map(c=><article key={`${c.host}:${c.context}:${c.id}`}><b>{c.name}</b><p>{c.image}</p><small>{c.context} · {c.state}{c.stale ? " · устаревшие данные" : ""}</small></article>)}</div> : <Empty title={ctx.containersKnown ? "Контейнеры не найдены" : "Модуль «Компьютеры» недоступен или выключен"} />)}{tab === "backups" && <BackupList backups={backups} />}{tab === "events" && <EventList h={h} g={g} />}</>}</> : <Empty title="Сервер не найден" />}</div></div>
  </Modal>;
}
