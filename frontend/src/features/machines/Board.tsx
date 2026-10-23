import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { useSaved } from "../pve/context";
import { hardwareForMachine, type HardwarePart, type HardwareView } from "./hardware-model.js";
import { BoardDrawing } from "./BoardDrawing";
import type { Machine } from "./model";
import "./hardware.css";

type Labels = Record<string, { name: string; kind: string }>;
function Inspector({ part: p, view, choose, labels, save }: { part: HardwarePart; view: HardwareView; choose: (id: string) => void; labels: Labels; save: (next: Labels) => void }) {
  const custom=labels[p.id], [name,setName]=useState(custom?.name||""), [kind,setKind]=useState(custom?.kind||"Устройство");
  const prefix=({ram:"slot:",gpu:"gpu:",nic:"nic:",disk:"disk:"} as Record<string,string>)[p.id], related=prefix?view.parts.filter(v=>v.id.startsWith(prefix)):[];
  return <section className="mc-hw-inspector" aria-label="Подробности компонента" aria-live="polite"><div>
    <div className="mc-hw-eyebrow"><Icon name="system" size={15}/>{custom?.kind||p.kind}</div><h3>{custom?.name||p.name}</h3><span className={`mc-hw-tag ${p.unknown?"amber":p.status==="Определён"?"green":""}`}>{p.status}</span>
    {p.note&&<p>{p.note}</p>}<dl className="mc-hw-facts">{p.facts.map(([key,value],i)=><div key={`${key}/${i}`}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    {p.unknown&&<div className="mc-hw-callout"><b>{p.problemCode?`ОС: код проблемы ${p.problemCode}`:"Определение и здоровье — отдельно"}</b>{p.problemCode?"ОС сообщает об ошибке устройства. Код PnP сохранён в инвентаре.":"Неопознанная модель сама по себе не указывает на неисправность."}</div>}
    {!!related.length&&<div className="mc-hw-related">{related.map(item=><button key={item.id} onClick={()=>choose(item.id)}>{labels[item.id]?.name||item.name}<small>{item.kind}</small></button>)}</div>}
  </div><div>{p.raw&&<details><summary>Исходные сведения</summary><pre>{p.raw}</pre></details>}<div className="mc-hw-source">Источник<span>{p.source||view.source||"Агент"}</span></div>
    {p.unknown&&<details className="mc-hw-custom"><summary>Задать название и вид на схеме</summary><label>Название<input value={name} maxLength={100} onChange={e=>setName(e.target.value)} placeholder="Например, плата расширения"/></label><label>Отображать как<select value={kind} onChange={e=>setKind(e.target.value)}>{["Устройство","Контроллер","Сеть","Графика"].map(v=><option key={v}>{v}</option>)}</select></label><p>Оформление сохраняется в этом браузере. Исходные ID и определение не меняются.</p><button className="pve-btn" onClick={()=>save({...labels,[p.id]:{name:name.trim()||p.name,kind}})}>Сохранить</button>{custom&&<button className="pve-btn ghost" onClick={()=>{const next={...labels};delete next[p.id];save(next);setName("");setKind("Устройство");}}>Сбросить</button>}</details>}
  </div></section>;
}

export function Board({machine}:{machine:Machine}) {
  const view=useMemo(()=>hardwareForMachine(machine),[machine]);
  const [selected,setSelected]=useState("cpu"),[zoom,setZoom]=useState(false),[query,setQuery]=useState(""),[filter,setFilter]=useState("all");
  const [labels,saveLabels]=useSaved<Labels>(`homenet.machines.hardware-labels:${machine.key}`,{});
  const part=view.parts.find(p=>p.id===selected)||view.parts[0];
  useEffect(()=>{if(!view.parts.some(p=>p.id===selected))setSelected("cpu");},[view,selected]);
  const unknownPart=view.parts.find(p=>p.id==="unknown"), sourcePart=view.parts.find(p=>p.id!=="unknown"&&p.rawId&&p.rawId===unknownPart?.rawId);
  const drawingView=sourcePart&&labels[sourcePart.id]?{...view,unknownLabel:labels[sourcePart.id].name.slice(0,27)}:view;
  const selectable=view.parts.filter(p=>!p.groupOnly&&(!view.hidePeripheralUnknown||!p.rawId&&!p.unknown||p.id===part.id));
  const inventory=view.parts.filter(p=>!p.groupOnly).filter(p=>(!query||JSON.stringify(p).toLowerCase().includes(query.toLowerCase()))&&(filter==="all"||filter==="unknown"&&p.unknown||(filter==="pci"||filter==="usb")&&p.rawId?.startsWith(`${filter}:`)));
  return <div className="mc-hw-view">
    {view.offline&&<p className="mc-source-note">Машина недоступна. Показан последний полученный инвентарь{view.timestamp?` от ${new Date(view.timestamp*1000).toLocaleString("ru-RU")}`:""}.</p>}
    <div className="mc-hw-grid"><div className="mc-hw-diagram"><div className={`mc-hw-pcb${zoom?" zoomed":""}`}><div className="mc-hw-board-top"><b>{view.board||machine.name}</b><span>ЛОГИЧЕСКАЯ СХЕМА</span></div><div className="mc-hw-board-scroll"><BoardDrawing view={drawingView} selected={part.id} choose={setSelected}/></div></div>
      <button className="mc-hw-zoom pve-btn ghost" aria-pressed={zoom} onClick={()=>setZoom(!zoom)}>{zoom?"Схема целиком":"Увеличить схему"}</button><div className="mc-hw-legend"><span><i/>Выбран</span><span><i className="is-empty"/>Пустой слот</span><span><i className="is-none"/>Нет данных</span></div><p className="mc-hw-hint">Нажмите на компонент. Расположение условное; подписи слотов — из DMI/SMBIOS.</p>
      <label className="mc-hw-picker">Выбрать компонент<select value={part.groupOnly?"cpu":part.id} onChange={e=>setSelected(e.target.value)}>{selectable.map(p=><option key={p.id} value={p.id}>{labels[p.id]?.name||p.name} · {p.status}</option>)}</select></label>
      {!view.hidePeripheralUnknown&&view.extras.length>0&&<details className="mc-hw-peripherals"><summary>Другие устройства · {view.extras.length}</summary><div className="mc-hw-extra-grid">{view.extras.map(([id,,name,address])=><button key={id} onClick={()=>setSelected(id)} aria-pressed={part.id===id}><b>{labels[id]?.name||name}</b><small>{address}</small></button>)}</div></details>}
      {view.sensors.length>0&&<details className="mc-hw-sensors" open><summary>Датчики и показания драйверов · {view.sensors.length}</summary><div>{view.sensors.map((s,i)=><section key={`${s.name}/${i}`} title={s.source}><span>{s.name}</span><b>{s.value}</b></section>)}</div></details>}
    </div><Inspector key={part.id} part={part} view={view} choose={setSelected} labels={labels} save={saveLabels}/></div>
    <details className="mc-hw-inventory"><summary>Полный инвентарь{view.deviceCount!=null?` · ${view.deviceCount} PCI/USB + компоненты`:""}</summary><div className="mc-hw-inventory-tools"><input type="search" placeholder="Название, ID или драйвер" aria-label="Поиск в инвентаре" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Фильтр инвентаря" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Все компоненты</option><option value="unknown">Не распознаны</option><option value="pci">PCI</option><option value="usb">USB</option></select></div><div className="mc-hw-table-scroll"><table><thead><tr><th>Компонент</th><th>Определение</th><th>Источник</th><th>Идентификатор</th></tr></thead><tbody>{inventory.map(p=><tr key={p.id}><td><button onClick={()=>setSelected(p.id)} aria-pressed={part.id===p.id}>{labels[p.id]?.name||p.name}</button></td><td>{p.status}</td><td>{p.source}</td><td>{p.rawId||"—"}</td></tr>)}</tbody></table></div>{!inventory.length&&<p className="mc-muted">По этому фильтру компонентов нет.</p>}</details>
    <div className="mc-hw-missing"><Icon name="info" size={18}/><div><b>Полнота аппаратных данных</b><p>{view.missing}</p>{view.timestamp&&<small>Инвентарь от {new Date(view.timestamp*1000).toLocaleString("ru-RU")}{view.agent?` · агент ${view.agent}`:""}</small>}</div></div>
  </div>;
}
