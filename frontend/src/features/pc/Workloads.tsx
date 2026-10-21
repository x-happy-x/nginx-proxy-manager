import { useState } from "react";
import { SearchInput, Segmented } from "../../components/ui/controls";
import { Icon } from "../../components/ui/Icon";
import { ago } from "../pve/model";
import { Dot, Empty, Pill } from "../pve/parts";
import { Controls } from "./Actions";
import { containersOf, contextName, outdated, stateName, type Computer } from "./model";

type Filter = "all" | "running" | "stopped";
function Filters({ computers, query, setQuery, state, setState, where, setWhere, placeholder, children }: {
  computers: Computer[]; query: string; setQuery: (s: string) => void; state: Filter; setState: (s: Filter) => void;
  where: string; setWhere: (s: string) => void; placeholder: string; children?: React.ReactNode;
}) {
  return <div className="pc-filters card"><div className="pc-filter-main"><Segmented label="Состояние" value={state} onChange={setState} options={[{ value: "all", label: "Все" }, { value: "running", label: "Работают" }, { value: "stopped", label: "Не работают" }]} /><SearchInput value={query} onChange={setQuery} label="Поиск" placeholder={placeholder} /></div>
    <div className="pc-filter-extra"><label>Компьютер<select value={where} onChange={(e) => setWhere(e.target.value)}><option value="all">Все компьютеры</option>{computers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>{children}</div></div>;
}

export function Docker({ computers }: { computers: Computer[] }) {
  const [query, setQuery] = useState("");
  const [where, setWhere] = useState("all");
  const [state, setState] = useState<Filter>("all");
  const [context, setContext] = useState("all");
  const rows = containersOf(computers);
  const contexts = [...new Set(rows.map(({ d }) => d.context))].sort();
  const q = query.trim().toLowerCase();
  const visible = rows.filter(({ h, d, c }) => (where === "all" || h.id === where) && (context === "all" || d.context === context)
    && (state === "all" || (state === "running") === (c.state === "running"))
    && (!q || [h.name, c.name, c.image, c.id, d.context].some((v) => v.toLowerCase().includes(q))))
    .sort((a, b) => Number(b.c.state === "running") - Number(a.c.state === "running") || a.c.name.localeCompare(b.c.name));
  const unavailable = computers.flatMap((h) => (h.current?.docker || []).filter((d) => !d.available).map((d) => ({ h, d })));
  return <div className="pc-page"><div className="pc-heading"><div><span className="pc-eyebrow">Контейнеры</span><h2>Docker на всех компьютерах</h2><p>Контейнеры Windows, Linux и запущенных дистрибутивов WSL.</p></div><span className="pc-total">{rows.length}<small>контейнеров</small></span></div>
    <Filters computers={computers} query={query} setQuery={setQuery} state={state} setState={setState} where={where} setWhere={setWhere} placeholder="Имя, образ, ID или компьютер">
      <label>Окружение<select value={context} onChange={(e) => setContext(e.target.value)}><option value="all">Все окружения</option>{contexts.map((value) => <option key={value} value={value}>{contextName(value)}</option>)}</select></label><span className="pve-muted">Показано: {visible.length}</span>
    </Filters>
    {unavailable.length ? <details className="pc-context-errors card"><summary><Icon name="info" size={14} />Docker доступен не во всех окружениях · {unavailable.length}</summary><div>{unavailable.map(({ h, d }) => <p key={`${h.id}/${d.context}`}><strong>{h.name} · {contextName(d.context)}</strong><span>{d.error || "Docker не установлен или не запущен."}</span></p>)}</div></details> : null}
    {visible.length ? <div className="pc-containers">{visible.map(({ h, d, c }) => <article className={`pc-container card${outdated(h) ? " outdated" : ""}`} key={`${h.id}/${d.context}/${c.id}`}>
      <header><span className="pc-container-icon"><Icon name="dms" size={21} /></span><div><h3>{c.name}</h3><span className="pc-container-location">{h.name} · {contextName(d.context)}</span></div><Pill tone={outdated(h) ? "warn" : c.state === "running" ? "ok" : c.state === "dead" ? "bad" : "idle"}><Dot tone={outdated(h) ? "warn" : c.state === "running" ? "ok" : "idle"} />{outdated(h) ? "Старые данные" : stateName(c.state)}</Pill></header>
      <div className="pc-container-info"><span className="pve-mono" title={c.image}>{c.image}</span><span className="pve-muted">{c.status}</span></div>
      <details className="pc-container-details"><summary>Сведения</summary><dl><dt>ID</dt><dd className="pve-mono">{c.id}</dd><dt>Порты</dt><dd className="pve-mono">{c.ports || "Не опубликованы"}</dd><dt>Снимок</dt><dd>{ago(h.current?.ts)}</dd></dl></details>
      <Controls target={{ h, c, context: d.context }} />
    </article>)}</div> : <Empty title={rows.length ? "Контейнеры не найдены" : "Контейнеров пока нет"}>{rows.length ? "Измените фильтры или строку поиска." : "Убедитесь, что Docker установлен, запущен и доступен пользователю SSH. Контейнеры в остановленных WSL появятся после запуска дистрибутива."}</Empty>}
  </div>;
}

export function Wsl({ computers }: { computers: Computer[] }) {
  const [query, setQuery] = useState("");
  const [where, setWhere] = useState("all");
  const [state, setState] = useState<Filter>("all");
  const windows = computers.filter((h) => h.current?.os === "windows");
  const rows = windows.flatMap((h) => (h.current?.wsl || []).map((w) => ({ h, w })));
  const q = query.trim().toLowerCase();
  const visible = rows.filter(({ h, w }) => (where === "all" || where === h.id) && (state === "all" || (state === "running") === (w.state === "running")) && (!q || [h.name, w.name].some((v) => v.toLowerCase().includes(q))))
    .sort((a, b) => Number(b.w.state === "running") - Number(a.w.state === "running") || a.w.name.localeCompare(b.w.name));
  return <div className="pc-page"><div className="pc-heading"><div><span className="pc-eyebrow">Linux внутри Windows</span><h2>Дистрибутивы WSL</h2><p>Окружения пользователя, под которым подключается агент.</p></div><span className="pc-total">{rows.length}<small>дистрибутивов</small></span></div>
    <Filters computers={windows} query={query} setQuery={setQuery} state={state} setState={setState} where={where} setWhere={setWhere} placeholder="Дистрибутив или компьютер" />
    <div className="pc-note"><Icon name="info" size={16} /><span>Мониторинг не запускает остановленные дистрибутивы. Docker внутри WSL опрашивается только в работающих окружениях.</span></div>
    {visible.length ? <div className="pc-distros">{visible.map(({ h, w }) => {
      const docker = h.current?.docker.find((d) => d.context === `wsl:${w.name}`);
      const containers = docker?.containers || [];
      return <article key={`${h.id}/${w.name}`} className="pc-distro card"><header><span className="pc-system-icon linux"><Icon name="terminal" size={22} /></span><div><h3>{w.name}</h3><span className="pve-muted">{h.name} · WSL {w.version}</span></div><Pill tone={outdated(h) ? "warn" : w.state === "running" ? "ok" : "idle"}>{outdated(h) ? "Старые данные" : stateName(w.state)}</Pill></header>
        <p className="pc-distro-docker"><Icon name="dms" size={15} />{w.state !== "running" ? "Docker будет проверен после запуска" : docker?.available ? `Docker: ${containers.filter((c) => c.state === "running").length} из ${containers.length} контейнеров работают` : "Docker недоступен или не установлен"}</p>
        <Controls target={{ h, w }} /><span className="pve-muted pve-small">Снимок {ago(h.current?.ts)}</span>
      </article>;
    })}</div> : <Empty title={rows.length ? "Дистрибутивы не найдены" : "WSL пока не обнаружен"}>{rows.length ? "Измените фильтры или строку поиска." : "Подключите Windows-компьютер под пользователем, у которого установлены дистрибутивы WSL."}</Empty>}
  </div>;
}
