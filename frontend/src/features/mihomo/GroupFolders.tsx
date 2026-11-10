import { useEffect, type ReactNode } from "react";
import { Icon } from "../../components/ui/Icon";
import { useStored } from "./NodeTiles";
import type { GroupFolder, MProxy } from "./api";

export function GroupFolders({ folders, groups, active, query, filtered, onEdit, render }: {
 folders:GroupFolder[];groups:MProxy[];active?:string;query:string;filtered:boolean;
 onEdit:(folder:GroupFolder)=>void;render:(group:MProxy)=>ReactNode;
}) {
 const [open,setOpen]=useStored<Record<string,boolean>>("homenet.groups.folders.open",{},(v):v is Record<string,boolean>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.values(v).every(x=>typeof x==="boolean"));
 const assigned=new Set(folders.flatMap(f=>f.groups));
 const sections:Array<{folder?:GroupFolder;id:string;name:string;groups:MProxy[];missing:number}>=folders.map(f=>({folder:f,id:f.id,name:f.name,groups:groups.filter(g=>f.groups.includes(g.name)),missing:f.groups.filter(n=>!groups.some(g=>g.name===n)).length}));
 const rest=groups.filter(g=>!assigned.has(g.name));
 if(rest.length)sections.push({id:"unassigned",name:"Без папки",groups:rest,missing:0});
 useEffect(()=>{
  const section=sections.find(s=>s.groups.some(g=>g.name===active));
  if(section&&open[section.id]===false)setOpen({...open,[section.id]:true});
 },[active]);
 return <div className="gf-sections">{sections.map(s=>{
  const matches=s.name.toLowerCase().includes(query);
  const members=s.groups.filter(g=>!query||matches||`${g.name} ${(g.all||[]).join(" ")}`.toLowerCase().includes(query));
  if((query||filtered)&&!members.length)return null;
  const expanded=!!query||filtered||(open[s.id]??(s.name==="ИИ"||s.groups.some(g=>g.name===active)));
  return <section key={s.id} className="nx-category gf-section">
   <div className="nx-category-title"><button type="button" className="nx-category-head" aria-expanded={expanded} onClick={()=>setOpen({...open,[s.id]:!expanded})}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={expanded?"m6 15 6-6 6 6":"m6 9 6 6 6-6"}/></svg>
    <b>{s.name}</b><small>{s.groups.length} {s.groups.length%100>=11&&s.groups.length%100<=14?"групп":s.groups.length%10===1?"группа":s.groups.length%10>=2&&s.groups.length%10<=4?"группы":"групп"}</small>
   </button>{s.folder?<button type="button" className="btn btn-sm btn-icon nx-category-edit" aria-label={`Изменить папку групп ${s.name}`} onClick={()=>onEdit(s.folder!)}><Icon name="edit" size={14}/></button>:null}</div>
   {expanded?<div className="nx-category-body"><div className="nx-groups">{members.map(render)}</div>{!members.length?<p className="mh-muted">В папке пока нет групп.</p>:null}{s.missing&&!filtered?<small className="mh-muted">Групп сейчас нет в конфиге: {s.missing}. Состав папки сохранён.</small>:null}</div>:null}
  </section>;
 })}</div>;
}
