import { useEffect, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { ModuleBoundary } from "./module-base";
import type { Host } from "./sdk";
import { PveProvider, usePve } from "../features/pve/context";
import { PcProvider, usePc } from "../features/pc/context";
import { Management } from "../features/pc/Actions";
import { Settings } from "../features/pc/Settings";
import { Details } from "../features/pc/Details";
import { useComputers } from "../features/pc/model";
import { Empty } from "../features/pve/parts";
import { EventCenter } from "../features/monitoring/EventCenter";
import { Containers, Devices, MachinePage, useMachineTree } from "../features/machines/Views";
import { flatten, machineRoute } from "../features/machines/model";
import "../styles/portal-home.css";
import "../features/pve/pve.css";
import "../features/pve/redesign.css";
import "../features/pc/pc.css";
import "../features/machines/machines.css";

function Dashboard({reload}:{reload:()=>Promise<void>}) {
  const ctx=usePve(), pc=usePc(), roots=useMachineTree(), [route,setRoute]=useState(location.hash.replace(/^#\/?/,""));
  useEffect(()=>{const update=()=>setRoute(location.hash.replace(/^#\/?/,""));window.addEventListener("hashchange",update);return()=>window.removeEventListener("hashchange",update);},[]);
  const path=route.split("?")[0], target=flatten(roots).find(m=>machineRoute(m)===path), events=path==="pc/events", settings=path==="pcsettings", containers=path==="pcdocker", title=settings ? "Настройка" : events ? "События" : containers ? "Контейнеры" : "Компьютеры";
  return <>{!ctx.host.shellNav&&<nav className="pv-nav">{[["pc","Компьютеры"],["pcdocker","Контейнеры"],["pcwsl","WSL"],["pc/events","События"],["pcsettings","Настройка"]].map(([id,label])=><a href={`#/${id}`} key={id}>{label}</a>)}</nav>}
    {!target&&<header className="pv-heading"><div><h1>{title}</h1><p>Windows и Linux · {roots.length} компьютеров</p></div><div className="pv-heading-tools">{!settings&&<label className="mc-search"><Icon name="search" size={16}/><input aria-label="Поиск машины или контейнера" type="search" placeholder="Компьютер, контейнер или порт" value={ctx.query} onChange={e=>ctx.setQuery(e.target.value)}/></label>}<button className="pve-btn ghost" aria-label={ctx.hide ? "Показать адреса" : "Скрыть адреса"} onClick={()=>ctx.setHide(!ctx.hide)}><Icon name={ctx.hide ? "eyeOff" : "eye"} size={16}/></button><button className="pve-btn ghost" onClick={()=>void reload()}><Icon name="refresh" size={15}/>Обновить</button></div></header>}
    <Management host={ctx.host} computers={pc.computers} enabled reload={reload}>
      {target ? <MachinePage key={target.key} m={target} onBack={()=>ctx.setTarget(null)}/> : settings ? <Settings host={ctx.host} onSaved={reload}/> : events ? <EventCenter host={ctx.host} service="pc" hosts={pc.computers} enabled defaultExpanded/> : containers ? <Containers roots={roots} route={route}/> : <Devices roots={roots} route={path==="pcwsl" ? "pc?filter=wsl" : route}/>}
      <Details/>
    </Management>
  </>;
}
function Computers({host}:{host:Host}) {
  const pc=useComputers(host);
  return <div className="hp pv-root mc-root"><div className="pve-module">{pc.error&&<p className="pv-warning" role="alert">Данные компьютеров не обновились: {pc.error}</p>}{pc.loading&&!pc.data ? <div className="pve-skeleton"/> : !pc.data ? <Empty title="Интеграция не отвечает"/> : <PveProvider host={host} hosts={[]} standalone><PcProvider host={host} computers={pc.data.hosts || []} machinePages><Dashboard reload={pc.reload}/></PcProvider></PveProvider>}</div></div>;
}
export function mount(element:HTMLElement,host:Host){if(host.protocol!==1)throw new Error("Несовместимая версия HomeNet");const root=host.createRoot(element);root.render(<ModuleBoundary><Computers host={host}/></ModuleBoundary>);return()=>root.unmount();}
