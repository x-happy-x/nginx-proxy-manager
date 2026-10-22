import { Icon } from "../../components/ui/Icon";
import { useState } from "react";
import { plural } from "../../lib/format";
import { bytes, percent, ratio, uptime, ago } from "../pve/model";
import { Empty } from "../pve/parts";
import { containersOf, outdated, type Computer, type History } from "./model";
import { diskOf, matchesComputer, usePc, useSaved } from "./context";
import { Chip, MachineHead, Meter, PcHeading, Ports, Ring, Spark, StatusDot, ViewSwitch } from "./parts";

type View = "tiles" | "table" | "scheme";
type Filter = "all" | "windows" | "linux" | "vm" | "docker";
type Metric = "" | "online" | "containers" | "wsl" | "cpu" | "disk";
type Sort = "name" | "cpu" | "memory" | "disk" | "docker" | "wsl" | "uptime";
const running = (h: Computer) => containersOf([h]).filter(({ c }) => c.state === "running").length;
const mem = (h: Computer) => h.current?.memory.total ? ratio(h.current.memory.used, h.current.memory.total) : null;
const disk = (h: Computer) => { const d = diskOf(h); return d ? ratio(d.used, d.total) : null; };

function ComputerCard({ h }: { h: Computer }) {
  const { history, openComputer, openEnvironment, appsOf } = usePc();
  const s = h.current, d = diskOf(h), total = containersOf([h]).length;
  const apps = new Set(containersOf([h]).flatMap(({ d, c }) => appsOf(h, d.context, c).map(a => a.key))).size;
  return <article className={`pc-computer${outdated(h) ? " outdated" : ""}`}>
    <MachineHead h={h} />
    {outdated(h) ? <p className="pc-error">{h.error || "Нет свежих данных"}{s ? ` · снимок ${ago(s.ts)}` : ""}</p> : null}
    <div className="pc-gauges"><Ring value={s?.cpu.percent ?? null} label="CPU" detail={s?.cpu.model} /><Ring value={mem(h)} label={s ? `${bytes(s.memory.used, 0)} / ${bytes(s.memory.total, 0)}` : "Память"} detail="Память" /><Ring value={disk(h)} label={d ? `диск ${d.path}` : "Диск"} /></div>
    <Spark points={history.data[h.id]?.points || []} />
    {history.errors[h.id] ? <small className="pc-muted">История не обновлена</small> : null}
    <div className="pc-counts"><button type="button" onClick={() => openEnvironment({ host: h.id, context: "all" })}><Icon name="dms" size={14} />Docker <b>{running(h)}</b> / {total}</button>{s?.os === "windows" ? <button type="button" onClick={() => openComputer(h.id)}><Icon name="terminal" size={14} />WSL <b>{s.wsl.filter(w => w.state === "running").length}</b> / {s.wsl.length}</button> : null}<span><Icon name="clock" size={14} />{s ? uptime(s.uptime) : "—"}</span>{apps > 0 ? <span><Icon name="overview" size={14} />{apps} {plural(apps, ["приложение", "приложения", "приложений"])} HomeNet</span> : null}</div>
    {s?.errors.length ? <details className="pc-diagnostics"><summary>Часть данных недоступна · {s.errors.length}</summary>{s.errors.map((e, i) => <p key={i}>{e}</p>)}</details> : null}
    <footer><span>Обновлено {ago(s?.ts || h.last_ok)}</span><button type="button" className="hp-btn" onClick={() => openComputer(h.id)}>Подробнее</button></footer>
  </article>;
}

function ComputerTable({ computers, sort, setSort, desc, setDesc }: { computers: Computer[]; sort: Sort; setSort: (s: Sort) => void; desc: boolean; setDesc: (b: boolean) => void }) {
  const { history, openComputer } = usePc();
  const columns: [Sort, string][] = [["name", "Компьютер"], ["cpu", "CPU"], ["memory", "Память"], ["disk", "Диск"], ["docker", "Docker"], ["wsl", "WSL"], ["uptime", "Работает"]];
  return <div className="pc-table-wrap"><table className="pc-table pc-host-table"><thead><tr>{columns.map(([key, title]) => <th key={key} scope="col" aria-sort={sort === key ? desc ? "descending" : "ascending" : "none"}><button type="button" onClick={() => { setSort(key); setDesc(sort === key ? !desc : key !== "name"); }}>{title}{sort === key ? desc ? " ↓" : " ↑" : ""}</button></th>)}<th><span className="sr-only">Подробнее</span></th></tr></thead><tbody>{computers.map(h => <tr key={h.id} className={outdated(h) ? "outdated" : ""}>
    <td data-label="Компьютер"><MachineHead h={h} compact />{outdated(h) ? <small className="pc-warning">{h.error || "Старые данные"}</small> : null}</td>
    <td data-label="CPU"><strong>{percent(h.current?.cpu.percent ?? null)}</strong><Spark points={history.data[h.id]?.points || []} label="CPU за час" /></td>
    <td data-label="Память"><Meter value={mem(h)}>{h.current ? `${bytes(h.current.memory.used, 0)} / ${bytes(h.current.memory.total, 0)}` : "—"}</Meter></td>
    <td data-label="Диск"><Meter value={disk(h)} /></td><td data-label="Docker">{running(h)} / {containersOf([h]).length}</td>
    <td data-label="WSL">{h.current?.os === "windows" ? `${h.current.wsl.filter(w => w.state === "running").length} / ${h.current.wsl.length}` : "—"}</td>
    <td data-label="Работает">{h.current ? uptime(h.current.uptime) : "—"}</td><td><button type="button" className="hp-btn is-quiet" aria-label={`Подробнее о ${h.name}`} onClick={() => openComputer(h.id)}><Icon name="arrowRight" /></button></td>
  </tr>)}</tbody></table></div>;
}

export function Scheme({ computers }: { computers: Computer[] }) {
  const { openEnvironment, openContainer } = usePc();
  return <div className="pc-topology">{computers.map(h => {
    const environments = [...new Set([...(h.current?.docker.map(d => d.context) || []), ...(h.current?.wsl.map(w => `wsl:${w.name}`) || [])])];
    // NPM-92: stopped WSL distributions share one quiet line, as in the mock-up
    const stopped = h.current?.wsl.filter(w => w.state === "stopped").map(w => w.name) || [];
    return <article className="pc-topology-host" key={h.id}><MachineHead h={h} />{outdated(h) ? <p className="pc-warning">{h.error || "Нет свежих данных"}</p> : null}{environments.filter(context => !stopped.includes(context.replace("wsl:", "")) || !context.startsWith("wsl:")).map(context => {
      const d = h.current?.docker.find(d => d.context === context), w = h.current?.wsl.find(w => context === `wsl:${w.name}`);
      const name = context === "native" ? "Docker системы" : context.replace("wsl:", "WSL · ");
      if (context === "native" && d && !d.available && /executable file not found|not found in|command not found/i.test(d.error || "")) return <section className="pc-environment stopped" key={context}><h3><span>{name}</span><span className="pc-badge muted">не установлен</span></h3></section>;
      return <section className="pc-environment" key={context}><h3><button type="button" onClick={() => openEnvironment({ host: h.id, context })}>{name}<Icon name="arrowRight" size={14} /></button><span className={`pc-badge${d?.available ? "" : " muted"}`}>{d?.available ? `${d.containers.filter(c => c.state === "running").length} / ${d.containers.length}` : "недоступен"}</span></h3>{d?.available ? d.containers.length ? <div className="pc-container-chips">{d.containers.slice(0, d.containers.length > 14 ? 7 : 14).map(c => <button type="button" key={c.id} className={c.state === "running" ? "" : "stopped"} onClick={() => openContainer({ host: h.id, context, id: c.id })}><StatusDot state={outdated(h) ? "warn" : c.state === "running" ? "ok" : "off"} label={c.state} /><span className="pc-container-chip-name" title={c.name}>{c.name}</span><Ports value={c.ports} limit={2} /></button>)}{d.containers.length > 14 ? <button type="button" className="pc-more-containers" onClick={() => openEnvironment({ host: h.id, context })}>Ещё {d.containers.length - 7}<Icon name="arrowRight" size={13} /></button> : null}</div> : <p className="pc-muted">Контейнеров нет</p> : <p className="pc-muted">{d?.error || "Docker недоступен в этом окружении"}</p>}</section>;
    })}{stopped.length ? <section className="pc-environment stopped" key="stopped"><h3><span>WSL · {stopped.join(", ")}</span><span className="pc-badge muted">{stopped.length === 1 ? "остановлен" : "остановлены"}</span></h3><p className="pc-muted">Мониторинг не запускает WSL — контейнеры появятся после запуска.</p></section> : null}{!environments.length ? <p className="pc-muted">Окружения не обнаружены</p> : null}</article>;
  })}</div>;
}

export function Overview({ reload, refreshing }: { reload: () => void; refreshing: boolean }) {
  const { computers, host, vmOf, history } = usePc();
  const [query, setQuery] = useState("");
  const [view, setView] = useSaved<View>("homenet.pc.view", "tiles");
  const [filter, setFilter] = useState<Filter>("all");
  const [metric, setMetric] = useState<Metric>("");
  const [sort, setSort] = useState<Sort>("name"), [desc, setDesc] = useState(false);
  const fresh = computers.filter(h => !outdated(h));
  const rows = containersOf(fresh), wsl = fresh.flatMap(h => h.current?.wsl || []);
  const cpus = fresh.flatMap(h => h.current?.cpu.percent == null ? [] : [h.current.cpu.percent]);
  const average = cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null;
  const disks = fresh.filter(h => (disk(h) ?? 0) >= 85);
  const filters: [Filter, string][] = [["all", "Все"], ["windows", "Windows"], ["linux", "Linux"], ["vm", "Виртуальные машины"], ["docker", "С Docker"]];
  const accepts = (h: Computer, f: Filter) => f === "all" || (f === "vm" ? !!vmOf(h) : f === "docker" ? h.current?.docker.some(d => d.available) : h.current?.os === f);
  const value = (h: Computer, s: Sort): number | string => s === "name" ? h.name : s === "cpu" ? h.current?.cpu.percent ?? -1 : s === "memory" ? mem(h) ?? -1 : s === "disk" ? disk(h) ?? -1 : s === "docker" ? running(h) : s === "wsl" ? h.current?.wsl.filter(w => w.state === "running").length || 0 : h.current?.uptime ?? -1;
  const visible = computers.filter(h => accepts(h, filter) && matchesComputer(h, query) && (!metric || !outdated(h) && (metric === "online" || metric === "containers" && running(h) > 0 || metric === "wsl" && h.current?.wsl.some(w => w.state === "running") || metric === "cpu" && (h.current?.cpu.percent ?? -1) >= (average ?? 0) || metric === "disk" && (disk(h) ?? 0) >= 85)))
    .sort((a, b) => { if (view !== "table") return 0; const av = value(a, sort), bv = value(b, sort); return (typeof av === "string" ? av.localeCompare(String(bv), "ru", { numeric: true }) : Number(av) - Number(bv)) * (desc ? -1 : 1); });
  const buckets = new Map<number, number[]>();
  fresh.forEach(h => history.data[h.id]?.points.forEach(p => { if (p.cpu !== null) { const t = Math.floor(p.t / 60) * 60; buckets.set(t, [...(buckets.get(t) || []), p.cpu]); } }));
  const averagePoints = [...buckets].sort(([a], [b]) => a - b).map(([t, values]) => ({ t, cpu: values.reduce((a, b) => a + b, 0) / values.length })) as History["points"];
  const summary: { id: Metric; value: string; label: string; hint?: string }[] = [
    { id: "online", value: `${fresh.length} / ${computers.length}`, label: "на связи" },
    { id: "containers", value: `${rows.filter(({ c }) => c.state === "running").length} / ${rows.length}`, label: "контейнеров работает" },
    { id: "wsl", value: `${wsl.filter(w => w.state === "running").length} / ${wsl.length}`, label: "WSL запущено" },
    { id: "cpu", value: percent(average), label: "средняя загрузка CPU", hint: "Показать компьютеры с CPU не ниже среднего" },
    { id: "disk", value: String(disks.length), label: "диск занят от 85 %", hint: disks.map(h => `${h.name} ${diskOf(h)?.path}`).join(", ") },
  ];
  return <div className="pc-page"><PcHeading title="Компьютеры" subtitle={`${fresh.length} на связи · ${computers.filter(h => h.current?.os === "windows").length} Windows · ${computers.filter(h => h.current?.os === "linux").length} Linux`} query={query} setQuery={setQuery}><button type="button" className="hp-btn" disabled={refreshing} onClick={reload}><Icon name="refresh" size={15} />{refreshing ? "Обновляю…" : "Обновить"}</button><button type="button" className="hp-btn is-primary" onClick={() => host.navigate("pcsettings")}><Icon name="plus" size={15} />Добавить</button></PcHeading>
    {view === "tiles" ? <div className="pc-summary">{summary.map(s => <button type="button" key={s.id} className={`pc-summary-tile${metric === s.id ? " selected" : ""}${s.id === "disk" && disks.length ? " warning" : ""}`} aria-pressed={metric === s.id} title={s.hint} onClick={() => setMetric(metric === s.id ? "" : s.id)}><b>{s.value.split(" / ")[0]}{s.value.includes(" / ") ? <small> / {s.value.split(" / ")[1]}</small> : null}</b><span>{s.label}</span>{s.id === "cpu" ? <Spark points={averagePoints} label="Средний CPU за час" /> : null}</button>)}</div> : null}
    <div className="pc-toolbar"><div className="pc-chips">{filters.map(([id, title]) => <Chip key={id} active={filter === id} onClick={() => setFilter(id)}>{title} <span>{computers.filter(h => accepts(h, id)).length}</span></Chip>)}</div><ViewSwitch label="Вид компьютеров" value={view} onChange={setView} options={[{ value: "tiles", label: "Плитки" }, { value: "table", label: "Таблица" }, { value: "scheme", label: "Схема" }]} /></div>
    {view === "table" ? <label className="pc-mobile-sort">Сортировать<select value={sort} onChange={e => setSort(e.target.value as Sort)}>{[["name", "Компьютер"], ["cpu", "CPU"], ["memory", "Память"], ["disk", "Диск"], ["docker", "Docker"], ["wsl", "WSL"], ["uptime", "Время работы"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><button type="button" className="hp-btn" aria-label="Изменить направление сортировки" onClick={() => setDesc(!desc)}>{desc ? "↓" : "↑"}</button></label> : null}
    {metric ? <div className="pc-filter-note">Фильтр: {summary.find(s => s.id === metric)?.label}{metric === "cpu" ? " не ниже среднего" : ""}<button type="button" className="hp-btn is-quiet" onClick={() => setMetric("")}>Сбросить ×</button></div> : null}
    {visible.length ? view === "table" ? <ComputerTable computers={visible} sort={sort} setSort={setSort} desc={desc} setDesc={setDesc} /> : view === "scheme" ? <Scheme computers={visible} /> : <div className="pc-computers">{visible.map(h => <ComputerCard key={h.id} h={h} />)}</div> : <Empty title="Компьютеры не найдены">Измените поиск или сбросьте фильтры.</Empty>}
  </div>;
}
