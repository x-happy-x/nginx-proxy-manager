import { useEffect, useState } from "react";
import { ModuleBoundary, usePage } from "./module-base";
import type { Host } from "./sdk";
import { PveProvider, usePve, useSaved } from "../features/pve/context";
import { ViewSwitch } from "../features/monitoring/portal";
import { Management } from "../features/pve/Actions";
import { Settings } from "../features/pve/Settings";
import { Hardware } from "../features/pve/Hardware";
import { Storage } from "../features/pve/Storage";
import { Details } from "../features/pve/Details";
import { Machines, Rack, Resources, hostFilter } from "../features/pve/Views";
import { EventCenter } from "../features/monitoring/EventCenter";
import { Bar, Empty } from "../features/pve/parts";
import { ago, backupFailed, bytes, ratio, usageTone, useOverview } from "../features/pve/model";
import "../styles/portal-home.css";
import "../features/pve/pve.css";
import "../features/pve/redesign.css";

function Dashboard({ reload, configured }: { reload: () => Promise<void>; configured: boolean }) {
  const ctx = usePve(), page = usePage();
  const [savedView, saveView] = useSaved("homenet.pve.view", "rack");
  const [subpage, setSubpage] = useState(() => location.hash.split("/")[2] || "");
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { const update = () => setSubpage(location.hash.split("/")[2] || ""); window.addEventListener("hashchange",update); return () => window.removeEventListener("hashchange",update); }, []);
  const view = page === "pveguests" ? "table" : subpage === "resources" ? "resources" : ["rack","table","resources"].includes(savedView) ? savedView : "rack";
  const section = page === "pve" && subpage === "events" ? "events" : page === "pvehw" ? "hardware" : page === "pvestorage" ? "storage" : page === "pvesettings" ? "settings" : view;
  const navigate = (id: string) => { location.hash = `#/${id}`; };
  const chooseView = (v: string) => { saveView(v); navigate(v === "table" ? "pveguests" : v === "resources" ? "pve/resources" : "pve"); };
  const allGuests = ctx.hosts.flatMap(h => h.current?.guests || []), guests = allGuests.filter(g => !g.template);
  const totalMem = ctx.hosts.reduce((s,h)=>s+(h.current?.node.mem.total||0),0), usedMem = ctx.hosts.reduce((s,h)=>s+(h.current?.node.mem.used||0),0);
  const copies = ctx.hosts.flatMap(h => h.current?.backups || []), lastBackup = copies.filter(b=>b.status === "OK").sort((a,b)=>b.start-a.start)[0];
  const cluster = ctx.hosts.map(h=>h.current?.cluster).find(c=>c?.name);
  const filtered = ctx.hosts.filter(h=>ctx.matches(h) && hostFilter(h,ctx.filter) && (!["running","stopped","qemu","lxc","apps"].includes(ctx.filter) || !!h.current?.guests.some(g => ctx.guestMatches(h,g))));
  const titles: Record<string,string> = { rack:"Серверы", table:"Машины", resources:"Ресурсы", hardware:"Железо и температуры", storage:"Хранилища и копии", settings:"Настройка", events:"События" };
  const menu = [["pve","Серверы","rack"],["pveguests","Машины","table"],["pve/resources","Ресурсы","resources"],["pvehw","Железо","hardware"],["pvestorage","Хранилища","storage"],["pve/events","События","events"],["pvesettings","Настройка","settings"]];
  const selectFilter = (f: string) => { ctx.setFilter(ctx.filter === f ? "all" : f); if (!["rack","table","resources"].includes(section)) chooseView("rack"); };
  return <>{!ctx.host.shellNav && <nav className="pv-nav" aria-label="Разделы серверов">{menu.map(([id,label,key])=><a key={id} href={`#/${id}`} aria-current={section===key ? "page" : undefined} onClick={e=>{e.preventDefault(); if(["rack","table","resources"].includes(key)) chooseView(key); else navigate(id);}}>{label}</a>)}</nav>}
  {!ctx.host.shellNav && <div className="pv-cluster"><b>{cluster?.name ? `Кластер ${cluster.name}` : "Proxmox"}</b>{cluster && <span className={!cluster.quorate ? "pv-warning" : ""}>{cluster.quorate ? "Кворум есть" : "Нет кворума"} · {(cluster.nodes||[]).filter(n=>n.online).length} / {cluster.nodes?.length || 0} узлов</span>}<div className="pv-node-loads">{ctx.hosts.map(h=><button key={h.id} onClick={()=>ctx.setTarget({host:h.id})}><span>{h.name} · {h.online ? "на связи" : "нет связи"}</span><Bar thin value={h.current?.node.cpu || 0} tone={h.online ? usageTone(h.current?.node.cpu || 0) : "idle"} /></button>)}</div></div>}
  <header className="pv-heading"><div><h1>{titles[section]}</h1><p>{ctx.hosts.length} сервера · {guests.filter(g=>g.status==="running").length} работают из {guests.length} машин</p></div><div className="pv-heading-tools">{section !== "settings" && <><input type="search" aria-label="Поиск сервера или машины" placeholder="Сервер, VM, VMID, IP или тег" value={ctx.query} onChange={e=>ctx.setQuery(e.target.value)} /><button className="pve-btn ghost" aria-pressed={ctx.hide} onClick={()=>ctx.setHide(!ctx.hide)}>{ctx.hide ? "Адреса скрыты" : "Скрыть адреса"}</button></>}<button className="pve-btn ghost" disabled={refreshing} onClick={()=>{setRefreshing(true);void reload().finally(()=>setRefreshing(false));}}>{refreshing ? "Обновляю…" : "Обновить"}</button></div></header>
  {section !== "settings" && <div className="pv-stats"><button className={ctx.hosts.some(h=>!h.online) ? "bad" : ""} onClick={()=>selectFilter("offline")}><b>{ctx.hosts.filter(h=>h.online).length} / {ctx.hosts.length}</b><small>Серверы на связи</small></button><button onClick={()=>selectFilter("running")}><b>{guests.filter(g=>g.status==="running").length} / {guests.length}</b><small>Машины работают</small></button><button className={ratio(usedMem,totalMem)>=85 ? "warn" : ""} onClick={()=>selectFilter("memory")}><b>{bytes(usedMem)} / {bytes(totalMem)}</b><small>Память занята</small></button><button className={ctx.hosts.some(h=>h.current?.updates) ? "warn" : ""} onClick={()=>selectFilter("updates")}><b>{ctx.hosts.reduce((s,h)=>s+(h.current?.updates||0),0)}</b><small>Обновления</small></button><button className={copies.some(backupFailed) ? "bad" : !lastBackup ? "warn" : ""} onClick={()=>selectFilter("backups")}><b>{lastBackup ? ago(lastBackup.start) : "Нет данных"}</b><small>Последняя копия{copies.some(backupFailed) ? " · есть ошибки" : ""}</small></button></div>}
  {["rack","table","resources"].includes(section) && <div className="pv-tools"><div className="pv-filters">{[["all","Все"],["running","Работают"],["stopped","Остановлены"],["qemu","VM"],["lxc","LXC"],["apps","С приложениями"],...["offline","updates","memory","backups"].includes(ctx.filter) ? [[ctx.filter, {offline:"Нет связи",updates:"Обновления",memory:"Память ≥85%",backups:"Ошибки копий"}[ctx.filter] || ""]] : []].map(([key,label])=><button key={key} className={`pv-chip ${ctx.filter===key ? "is-on" : ""}`} aria-pressed={ctx.filter===key} onClick={()=>ctx.setFilter(key)}>{label}</button>)}</div><ViewSwitch label="Вид серверов" value={view} options={[{value:"rack",label:"Стойка"},{value:"table",label:"Таблица"},{value:"resources",label:"Ресурсы"}]} onChange={chooseView} /></div>}
  <Management host={ctx.host} hosts={ctx.hosts} enabled={configured} onRefresh={reload}>
    {section==="settings" ? <Settings host={ctx.host} onSaved={reload} /> : !configured ? <Empty title="Серверы не настроены">Добавьте узлы на странице «Настройка».</Empty> : section==="rack" ? <Rack hosts={filtered} /> : section==="table" ? <Machines hosts={filtered} /> : section==="resources" ? <Resources hosts={filtered} /> : section==="hardware" ? <Hardware hosts={filtered} /> : section==="storage" ? <Storage hosts={filtered} /> : <EventCenter host={ctx.host} service="pve" hosts={ctx.hosts} enabled />}
    <Details key={ctx.target ? `${ctx.target.host}:${ctx.target.vmid || "node"}` : "closed"} />
  </Management></>;
}
function PveModule({ host }: { host: Host }) { const { data,error,loading,reload } = useOverview(host); return <div className="hp pv-root"><div className="pve-module">{error && <div className="pv-warning" role="alert">Не удалось обновить данные: {error}</div>}{loading && !data ? <div className="pve-skeleton" /> : !data ? <Empty title="Интеграция не отвечает">{error}</Empty> : <PveProvider host={host} hosts={data.hosts || []}><Dashboard reload={reload} configured={data.configured} /></PveProvider>}</div></div>; }
export function mount(element: HTMLElement, host: Host) { if(host.protocol!==1) throw new Error("Несовместимая версия HomeNet"); const root=host.createRoot(element); root.render(<ModuleBoundary><PveModule host={host} /></ModuleBoundary>); return ()=>root.unmount(); }
