import { useState } from "react";
import { Modal } from "../../components/ui/Modal";
import { Icon } from "../../components/ui/Icon";
import { NodeName } from "../../components/ui/Flag";
import { errText } from "../../lib/format";
import type { GroupFolder } from "./api";
import type { NodeRow } from "./Nodes";

export function GroupFolderEditor({ folder, folders, rows, onSave, onDelete, onClose }: {
 folder: GroupFolder | null; folders: GroupFolder[]; rows: Map<string,NodeRow>;
 onSave: (f:GroupFolder)=>Promise<void>; onDelete:(id:string)=>Promise<void>;onClose:()=>void;
}) {
 const [name,setName]=useState(folder?.name||"");
 const [selected,setSelected]=useState(()=>new Set(folder?.groups||[]));
 const [q,setQ]=useState("");const [all,setAll]=useState(false);
 const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [removing,setRemoving]=useState(false);
 const names=[...new Set([...selected,...rows.keys()])].sort((a,b)=>a.localeCompare(b,"ru",{numeric:true}));
 const query=q.trim().toLowerCase();
 const found=names.filter(n=>!query||`${n} ${rows.get(n)?.meta?.source||""}`.toLowerCase().includes(query));
 const shown=all||query?found:found.slice(0,100);
 const invalid=!name.trim()||folders.some(f=>f.id!==folder?.id&&f.name.toLocaleLowerCase()===name.trim().toLocaleLowerCase());
 const toggle=(n:string)=>{const next=new Set(selected);next.has(n)?next.delete(n):next.add(n);setSelected(next)};
 const save=async()=>{
  setBusy(true);setError("");
  try {await onSave({id:folder?.id||`folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`,name:name.trim(),groups:[...selected]});}
  catch(e){setError(errText(e));}finally{setBusy(false)}
 };
 const remove=async()=>{if(!folder)return;setBusy(true);setError("");try{await onDelete(folder.id)}catch(e){setError(errText(e))}finally{setBusy(false)}};
 return <Modal open onClose={onClose} locked={busy} autoFocusBody title={folder?"Изменить папку":"Новая папка групп"} description="Выберите группы маршрутизации. Каждая группа находится в одной папке." size="lg" footer={<>
  {folder?<button type="button" className="btn btn-sm" disabled={busy} onClick={()=>setRemoving(!removing)}><Icon name="trash" size={14}/>Удалить папку</button>:null}
  <span className="nf-spacer"/>
  <button type="button" className="btn" disabled={busy} onClick={onClose}>Отмена</button>
  <button type="button" className="btn btn-primary" disabled={busy||invalid||removing} onClick={()=>void save()}>{busy?"Сохраняю…":"Сохранить папку"}</button>
 </>}>
  <div className="nf-editor">
   <label className="nf-field">Название<input className="input" maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="Например, Для игр"/></label>
   {name.trim()&&invalid?<p className="vn-err">Папка с таким названием уже существует.</p>:null}
   {removing?<div className="nf-delete"><p>Удалить папку «{folder?.name}»? Группы окажутся в разделе «Без папки».</p><button type="button" className="btn" disabled={busy} onClick={()=>void remove()}>Да, удалить папку</button></div>:null}
   <label className="nf-field">Найти группу<input className="input" value={q} onChange={e=>setQ(e.target.value)} placeholder="Название группы"/></label>
   <div className="nf-selection"><b>Выбрано {selected.size}</b><span className="mh-muted">Найдено {found.length}</span>
    <button type="button" className="btn btn-sm" disabled={busy||new Set([...selected,...found]).size>2000} onClick={()=>setSelected(new Set([...selected,...found]))}>Добавить найденные</button>
    <button type="button" className="btn btn-sm" disabled={busy} onClick={()=>setSelected(new Set([...selected].filter(n=>!found.includes(n))))}>Убрать найденные</button>
   </div>
   <div className="nf-list" role="group" aria-label="Группы папки">
    {shown.map(n=><label key={n} className={`nf-node${selected.has(n)?" is-selected":""}`}>
     <input type="checkbox" checked={selected.has(n)} disabled={busy||selected.size>=2000&&!selected.has(n)} onChange={()=>toggle(n)}/>
     <span><NodeName name={n}/><small>{rows.has(n)?rows.get(n)?.meta?.source||"Группа маршрутизации":"Группа сейчас отсутствует"}</small></span>
     {rows.get(n)?.delay!=null&&rows.get(n)!.delay!>0?<small className="mono">{rows.get(n)!.delay} мс</small>:null}
    </label>)}
    {!shown.length?<p className="mh-muted">Нет подходящих групп.</p>:null}
   </div>
   {found.length>shown.length?<button type="button" className="btn btn-sm" onClick={()=>setAll(true)}>Показать все {found.length}</button>:null}
   {error?<p role="alert" className="vn-err">{error}</p>:null}
  </div>
 </Modal>;
}
