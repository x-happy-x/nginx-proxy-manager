import { useState, type ReactNode } from "react";
import { countryName, nodeCC } from "../../lib/flags";
import { Flag, useFlagMode } from "../../components/ui/Flag";
import { useStored } from "./NodeTiles";
import type { NodeRow, NodeState } from "./Nodes";

export type NodeCategory = "source" | "country" | "none";
export const useNodeCategory = () => useStored<NodeCategory>("homenet.nodes.category", "source", (v): v is NodeCategory => v === "source" || v === "country" || v === "none");

export function CategorySelect({ value, onChange, id }: { value: NodeCategory; onChange: (v: NodeCategory) => void; id: string }) {
  return <label className="nx-filter-select" htmlFor={id}>Группировка
    <select id={id} className="input input-sm" value={value} onChange={e => onChange(e.target.value as NodeCategory)}>
      <option value="source">По источникам</option><option value="country">По странам</option><option value="none">Без группировки</option>
    </select>
  </label>;
}

/** Display categories only: input order and Mihomo routing priorities remain intact. */
export function NodeCategories({ names, rows, by, scope, search, active, stateOf, limit, render }: {
  names: string[]; rows: Map<string, NodeRow>; by: NodeCategory; scope: string; search: string; active?: string;
  stateOf: (name: string) => NodeState; limit: number; render: (names: string[]) => ReactNode;
}) {
  const [flagMode] = useFlagMode();
  const [opened, setOpened] = useStored<Record<string, boolean>>(`homenet.nodes.categories.open.${scope === "nodes" ? "nodes" : "members"}`, {}, (v): v is Record<string, boolean> => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(x => typeof x === "boolean"));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const buckets = new Map<string, { key: string; title: string; cc?: string; names: string[] }>();
  names.forEach(name => {
    const r = rows.get(name);
    const cc = r ? nodeCC(name, r.country, flagMode) : "";
    const provider = r?.provider || r?.meta?.provider;
    const key = by === "none" ? "all" : !r ? "routes" : by === "country" ? cc || "unknown" : provider || "own";
    const title = by === "none" ? "Все узлы" : !r ? "Маршруты" : by === "country" ? cc ? countryName(cc) : "Страна не определена" : provider ? r.meta?.source || provider : "Свои узлы";
    if (!buckets.has(key)) buckets.set(key, { key, title, cc: by === "country" ? cc : undefined, names: [] });
    buckets.get(key)!.names.push(name);
  });
  const categories = [...buckets.values()].sort((a, b) => {
    const rank = (k: string) => k === "own" ? 0 : k === "routes" ? 1 : k === "unknown" ? 3 : 2;
    return rank(a.key) - rank(b.key) || a.title.localeCompare(b.title, "ru");
  });
  return <div className="nx-categories">{categories.map(c => {
    const key = `${scope}:${by}:${c.key}`;
    const current = !!active && c.names.includes(active);
    const open = by === "none" || !!search || (opened[key] ?? (current || c.key === "own" || categories.length === 1));
    const shown = search || expanded[key] ? c.names : c.names.slice(0, limit);
    const alive = c.names.filter(n => ["ok", "slow"].includes(stateOf(n))).length;
    return <section key={key} className={`nx-category${current ? " has-current" : ""}`}>
      {by !== "none" ? <button type="button" className="nx-category-head" aria-expanded={open} onClick={() => setOpened({ ...opened, [key]: !open })}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
        {c.cc ? <Flag cc={c.cc} /> : null}<b>{c.title}</b>
        {current ? <span className="nx-category-current">сейчас</span> : null}
        <small title="Отвечают / всего">{alive} / {c.names.length}</small>
      </button> : null}
      {open ? <div className="nx-category-body">
        {render(shown)}
        {c.names.length > limit && !search ? <button type="button" className="btn btn-sm nx-category-more" onClick={() => setExpanded({ ...expanded, [key]: !expanded[key] })}>{expanded[key] ? "Сократить список" : `Показать все ${c.names.length}`}</button> : null}
      </div> : null}
    </section>;
  })}</div>;
}
