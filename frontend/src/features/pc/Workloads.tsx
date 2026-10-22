import { useState } from "react";
import { Empty } from "../pve/parts";
import { Controls } from "./Actions";
import { containersOf, contextName, outdated, stateName, type Computer } from "./model";
import { usePc, useSaved } from "./context";
import { Chip, MachineHead, PcHeading, Ports, shortImage, StatusDot, ViewSwitch } from "./parts";

type Row = ReturnType<typeof containersOf>[number];
type Filter = "all" | "running" | "stopped" | "ports" | "unlisted";
type View = "grouped" | "list" | "cards";
export function AppBadges({ row: { h, d, c } }: { row: Row }) {
  const { appsOf, appsKnown, openApplication } = usePc();
  const apps = appsOf(h, d.context, c);
  return <span className="pc-app-badges">{apps.length ? apps.map(a => <button type="button" key={a.key} className="pc-badge" onClick={() => openApplication(a)} title={`Карточка приложения «${a.title}»`}>{a.title} ↗</button>) : <span className="pc-muted">{appsKnown ? "—" : "Нет данных"}</span>}</span>;
}
export function ContainerActions({ row: { h, d, c } }: { row: Row }) {
  const { openContainer } = usePc();
  const reason = outdated(h) ? "Нет свежего состояния компьютера" : !h.current?.capabilities.docker_logs ? "Агент не поддерживает логи или доступ не разрешён" : "";
  return <div className="pc-inline-actions"><button type="button" className="hp-btn pc-icon-btn" disabled={!!reason} title={reason || "Логи контейнера"} aria-label={`Логи ${c.name}`} onClick={() => openContainer({ host: h.id, context: d.context, id: c.id, logs: true })}>≡</button><Controls target={{ h, c, context: d.context }} compact /></div>;
}
function ContainerCell({ row: { h, d, c } }: { row: Row }) {
  const { openContainer } = usePc();
  return <button type="button" className="pc-text-button" onClick={() => openContainer({ host: h.id, context: d.context, id: c.id })}>{c.name}</button>;
}
export function ContainerList({ rows, view = "grouped" }: { rows: Row[]; view?: View }) {
  if (view === "cards") return <div className="pc-containers">{rows.map(row => <article key={`${row.h.id}/${row.d.context}/${row.c.id}`} className="pc-container"><header><StatusDot state={outdated(row.h) ? "warn" : row.c.state === "running" ? "ok" : "off"} label={outdated(row.h) ? "Старые данные" : stateName(row.c.state)} /><ContainerCell row={row} /></header><small className="pc-muted">{row.h.name} · {contextName(row.d.context)}</small><span className="pc-image" title={row.c.image}>{shortImage(row.c.image)}</span><Ports value={row.c.ports} /><span className="pc-muted">{row.c.status}</span><AppBadges row={row} /><ContainerActions row={row} /></article>)}</div>;
  const groups = view === "list" ? [["", rows] as const] : [...rows.reduce((map, r) => { const key = `${r.h.id}/${r.d.context}`; map.set(key, [...(map.get(key) || []), r]); return map; }, new Map<string, Row[]>())];
  return <div className="pc-table-wrap"><table className="pc-table pc-container-table"><thead><tr><th><span className="sr-only">Состояние</span><span aria-hidden="true">●</span></th><th>Имя</th><th>Образ</th><th>Порты</th><th>Статус</th><th>Приложение</th><th>Действия</th></tr></thead>{groups.map(([key, group]) => <tbody key={key}>{key ? <tr className="pc-group-row"><th colSpan={7} scope="rowgroup"><span>{group[0].h.name} · {contextName(group[0].d.context)}</span><span>{group.length} контейнеров</span></th></tr> : null}{group.map(row => <tr key={`${row.h.id}/${row.d.context}/${row.c.id}`} className={outdated(row.h) ? "outdated" : ""}><td data-label="Состояние"><StatusDot state={outdated(row.h) ? "warn" : row.c.state === "running" ? "ok" : "off"} label={outdated(row.h) ? "Старые данные" : stateName(row.c.state)} /><span className="pc-mobile-state">{outdated(row.h) ? "Старые данные" : stateName(row.c.state)}</span></td><td data-label="Имя"><ContainerCell row={row} />{view === "list" ? <small className="pc-muted">{row.h.name} · {contextName(row.d.context)}</small> : null}</td><td data-label="Образ"><span className="pc-image" title={row.c.image}>{shortImage(row.c.image)}</span></td><td data-label="Порты"><Ports value={row.c.ports} /></td><td data-label="Статус" className="pc-muted">{row.c.status}</td><td data-label="Приложение"><AppBadges row={row} /></td><td data-label="Действия"><ContainerActions row={row} /></td></tr>)}</tbody>)}</table></div>;
}

export function Docker() {
  const { computers, environment, setEnvironment, appsOf, appsKnown } = usePc();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<Filter>("all");
  const [view, setView] = useSaved<View>("homenet.pc.containers-view", "grouped");
  const where = environment?.host || "all", context = environment?.context || "all";
  const rows = containersOf(computers);
  const contexts = [...new Set(computers.filter(h => where === "all" || h.id === where).flatMap(h => [...(h.current?.docker.map(d => d.context) || []), ...(h.current?.wsl.map(w => `wsl:${w.name}`) || [])]))].sort();
  const q = query.trim().toLowerCase();
  const visible = rows.filter(({ h, d, c }) => (where === "all" || h.id === where) && (context === "all" || d.context === context)
    && (state === "all" || state === "running" && c.state === "running" || state === "stopped" && c.state !== "running" || state === "ports" && c.ports.includes("->") || state === "unlisted" && appsKnown && !appsOf(h, d.context, c).length)
    && (!q || [h.name, h.address, c.name, c.image, c.id, c.ports, d.context].some(v => v.toLowerCase().includes(q))))
    .sort((a, b) => a.h.name.localeCompare(b.h.name) || a.d.context.localeCompare(b.d.context) || Number(b.c.state === "running") - Number(a.c.state === "running") || a.c.name.localeCompare(b.c.name));
  const unavailable = computers.filter(h => where === "all" || h.id === where).flatMap(h => (h.current?.docker || []).filter(d => !d.available && (context === "all" || d.context === context)).map(d => ({ h, d })));
  const filters: [Filter, string][] = [["all", "Все"], ["running", "Работают"], ["stopped", "Остановлены"], ["ports", "С портом"], ["unlisted", "Без приложения HomeNet"]];
  return <div className="pc-page"><PcHeading title="Контейнеры" subtitle={`${rows.length} контейнеров · Docker в системе и WSL`} query={query} setQuery={setQuery} />
    <div className="pc-toolbar"><div className="pc-chips">{filters.map(([id, label]) => <Chip key={id} active={state === id} onClick={() => setState(id)}>{label}</Chip>)}</div><ViewSwitch label="Вид контейнеров" value={view} onChange={setView} options={[{ value: "grouped", label: "По компьютерам" }, { value: "list", label: "Одним списком" }, { value: "cards", label: "Карточки" }]} /></div>
    <div className="pc-filter-extra"><label>Компьютер<select value={where} onChange={e => setEnvironment({ host: e.target.value, context: "all" })}><option value="all">Все компьютеры</option>{computers.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label><label>Окружение<select value={context} onChange={e => setEnvironment({ host: where, context: e.target.value })}><option value="all">Все окружения</option>{contexts.map(c => <option key={c} value={c}>{contextName(c)}</option>)}</select></label><span className="pc-muted">Показано: {visible.length}</span>{environment ? <button className="hp-btn is-quiet" type="button" onClick={() => setEnvironment(null)}>Сбросить окружение</button> : null}</div>
    {unavailable.length ? <details className="pc-context-errors"><summary>Docker недоступен в {unavailable.length} окружениях</summary>{unavailable.map(({ h, d }) => <p key={`${h.id}/${d.context}`}><b>{h.name} · {contextName(d.context)}</b><span>{d.error || "Docker не установлен или не запущен"}</span></p>)}</details> : null}
    {state === "unlisted" && !appsKnown ? <p className="pc-error">Не удалось получить связи с приложениями HomeNet. Фильтр будет доступен после восстановления связи.</p> : visible.length ? <ContainerList rows={visible} view={view} /> : <Empty title="Контейнеры не найдены">Измените фильтры. В остановленных WSL контейнеры появятся после запуска дистрибутива.</Empty>}
  </div>;
}

export function Wsl({ only }: { only?: Computer }) {
  const { computers, openContainer } = usePc();
  const [query, setQuery] = useState(""), [state, setState] = useState("all"), [where, setWhere] = useState("all");
  const windows = (only ? [only] : computers).filter(h => h.current?.os === "windows");
  const rows = windows.flatMap(h => (h.current?.wsl || []).map(w => ({ h, w })));
  const visible = rows.filter(({ h, w }) => (where === "all" || h.id === where) && (state === "all" || w.state === state) && `${h.name} ${w.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="pc-page">{!only ? <><PcHeading title="WSL" subtitle="Linux внутри Windows · мониторинг не запускает остановленные дистрибутивы" query={query} setQuery={setQuery} /><div className="pc-toolbar"><div className="pc-chips">{[["all", "Все"], ["running", "Работают"], ["stopped", "Остановлены"]].map(([id, label]) => <Chip key={id} active={state === id} onClick={() => setState(id)}>{label}</Chip>)}</div><label className="pc-select-label">Компьютер<select value={where} onChange={e => setWhere(e.target.value)}><option value="all">Все компьютеры</option>{windows.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label></div></> : null}
    {visible.length ? <div className="pc-distros">{visible.map(({ h, w }) => {
      const docker = h.current?.docker.find(d => d.context === `wsl:${w.name}`);
      return <article key={`${h.id}/${w.name}`} className="pc-distro"><MachineHead h={h} badge={false} /><header><h3>{w.name}</h3><span className={`pc-badge${w.state === "stopped" ? " muted" : ""}`}>{outdated(h) ? "Старые данные" : stateName(w.state)}</span><span className="pc-muted">WSL {w.version}</span></header>{w.state === "stopped" ? <p className="pc-muted">Docker будет проверен после запуска</p> : !docker?.available ? <p className="pc-warning">{docker?.error || "Docker недоступен или не установлен"}</p> : <><p className="pc-muted">Docker: {docker.containers.filter(c => c.state === "running").length} / {docker.containers.length} работают</p><div className="pc-container-chips">{docker.containers.map(c => <button type="button" key={c.id} onClick={() => openContainer({ host: h.id, context: docker.context, id: c.id })}><StatusDot state={c.state === "running" ? "ok" : "off"} label={stateName(c.state)} />{c.name}<Ports value={c.ports} /></button>)}</div></>}<Controls target={{ h, w }} /></article>;
    })}</div> : <Empty title="WSL не найден">{only?.current?.os === "linux" ? "На Linux WSL не используется." : "Измените фильтры или подключите Windows-компьютер с WSL."}</Empty>}
  </div>;
}
