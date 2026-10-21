import { useCallback, useEffect, useState } from "react";
import { SearchInput, Segmented } from "../../components/ui/controls";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import type { Host } from "../../platform/sdk";
import { ActionButtons } from "./Actions";
import { ago, bits, bytes, guestStatus, guestTags, guestTone, loadTone, percent, proxmoxURL, ratio, rate, stale, uptime, useHistory, type PveGuest, type PveHistory, type PveHost } from "./model";
import { Bar, Dot, Empty, Pill, Spark, Stat } from "./parts";

type Filter = "all" | "running" | "stopped" | "paused";
type Kind = "all" | "qemu" | "lxc" | "template";
type Sort = "load" | "name" | "memory" | "id";
type Row = { g: PveGuest; h: PveHost };

// One child per configured host keeps hooks stable and supports any host count.
function HostHistory({ host, id, onData }: { host: Host; id: string; onData: (id: string, data: PveHistory) => void }) {
  const { data } = useHistory(host, id);
  useEffect(() => { if (data) onData(id, data); }, [data, id, onData]);
  return null;
}

function GuestRow({ g, h, spark, onOpen }: Row & { spark: number[]; onOpen: () => void }) {
  const fresh = !stale(h);
  const on = g.status === "running";
  const mem = ratio(g.mem, g.maxmem);
  return <div className={`pve-guest${on ? "" : " off"}${fresh ? "" : " stale"}`} role="row">
    <div className="pve-guest-name" role="cell">
      <span className={`pve-guest-icon ${g.type}`}><Icon name={g.type === "lxc" ? "dms" : "layers"} size={19} /></span>
      <div><button type="button" className="pve-guest-link" onClick={onOpen}>{g.name || `#${g.vmid}`}</button>
        <span className="pve-muted pve-mono">{g.type === "lxc" ? "CT" : "VM"} {g.vmid} · {h.name}</span>
        <span className="pve-guest-state"><Dot tone={fresh ? guestTone(g) : "warn"} />{fresh ? guestStatus(g) : "Последнее состояние"}{g.lock ? <Icon name="lock" size={12} /> : null}</span>
      </div>
    </div>
    <div className="pve-guest-cpu" role="cell"><div className="pve-guest-metric"><span>{on ? percent(g.cpu) : "—"}</span><small>{g.cpus} vCPU</small></div>
      {on ? <Bar value={g.cpu} tone={fresh ? loadTone(g.cpu) : "idle"} thin /> : null}
      <Spark values={spark} max={100} tone={fresh ? "ok" : "idle"} label={`CPU ${g.name} за сутки`} />
    </div>
    <div className="pve-guest-mem" role="cell"><div className="pve-guest-metric"><span>{on ? bytes(g.mem) : "—"}</span><small>из {bytes(g.maxmem, 0)}</small></div>
      {on ? <Bar value={mem} tone={fresh ? loadTone(mem) : "idle"} thin /> : null}
    </div>
    <div className="pve-guest-io" role="cell">{on ? <><span title="Сеть: приём / передача">↓ {bits(g.netin_rate)} · ↑ {bits(g.netout_rate)}</span><span className="pve-muted" title="Диск: чтение / запись">R {rate(g.diskread_rate)} · W {rate(g.diskwrite_rate)}</span></> : <span className="pve-muted">{guestStatus(g)}</span>}</div>
    <div className="pve-guest-up" role="cell"><span>{on ? uptime(g.uptime) : "—"}</span>{g.maxdisk ? <small className="pve-muted">диск {bytes(g.maxdisk, 0)}</small> : null}</div>
    <div className="pve-guest-actions" role="cell"><button type="button" className="pve-btn" onClick={onOpen} aria-label={`Управление ${g.name || g.vmid}`}>Открыть<Icon name="chevronRight" size={13} /></button></div>
  </div>;
}

function GuestDetails({ row, spark, close }: { row: Row | null; spark: number[]; close: () => void }) {
  const g = row?.g;
  const h = row?.h;
  return <Modal open={!!row} title={g?.name || (g ? `Машина ${g.vmid}` : "Машина")} description={g && h ? `${g.type === "lxc" ? "Контейнер LXC" : "Виртуальная машина"} ${g.vmid} · ${h.name}` : undefined} variant="drawer" onClose={close}>
    {g && h ? <div className="pve-guest-detail">
      <div className="pve-detail-status"><Pill tone={guestTone(g)}><Dot tone={guestTone(g)} />{guestStatus(g)}</Pill>{g.lock ? <Pill tone="warn">Занята: {g.lock}</Pill> : null}
        <a href={proxmoxURL(h, g)} target="_blank" rel="noopener noreferrer" className="pve-btn ghost">В Proxmox<Icon name="external" size={13} /></a></div>
      {stale(h) ? <div className="pve-task-error">Данные на {ago(h.current?.ts)}. Текущее состояние машины неизвестно.</div> : null}
      <div className="pve-detail-metrics">
        <Stat label="Процессор" value={g.status === "running" ? percent(g.cpu) : "—"} sub={`${g.cpus} vCPU`} />
        <Stat label="Память" value={g.status === "running" ? bytes(g.mem) : "—"} sub={`выделено ${bytes(g.maxmem)}`} />
        <Stat label="Диск" value={bytes(g.maxdisk)} sub={g.disk > 0 ? `занято ${bytes(g.disk)}` : "выделенный объём"} />
        <Stat label="Работает" value={g.status === "running" ? uptime(g.uptime) : "—"} />
      </div>
      <div className="pve-detail-history"><h3>Процессор за сутки</h3><Spark values={spark} max={100} label="Загрузка процессора машины за сутки" /><p className="pve-muted pve-small">{spark.length > 1 ? "Точка — среднее за 5 минут." : "История появится после нескольких замеров агента."}</p></div>
      <dl className="pve-specs"><div className="pve-spec"><dt>Сеть</dt><dd>↓ {bits(g.netin_rate)} · ↑ {bits(g.netout_rate)}</dd></div><div className="pve-spec"><dt>Дисковый ввод-вывод</dt><dd>R {rate(g.diskread_rate)} · W {rate(g.diskwrite_rate)}</dd></div><div className="pve-spec"><dt>Теги</dt><dd><div className="pve-tags">{guestTags(g).length ? guestTags(g).map((tag) => <Pill key={tag} tone="accent">{tag}</Pill>) : "Нет тегов"}</div></dd></div></dl>
      <section className="pve-detail-controls"><h3>Управление машиной</h3><ActionButtons h={h} g={g} onAction={close} /></section>
    </div> : null}
  </Modal>;
}

export function Guests({ host, hosts }: { host: Host; hosts: PveHost[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [where, setWhere] = useState("all");
  const [kind, setKind] = useState<Kind>("all");
  const [sort, setSort] = useState<Sort>("load");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [history, setHistory] = useState<Record<string, PveHistory>>({});
  const onHistory = useCallback((id: string, data: PveHistory) => setHistory((old) => ({ ...old, [id]: data })), []);
  const rows = hosts.flatMap((h) => (h.current?.guests || []).map((g) => ({ g, h })));
  const machines = rows.filter(({ g }) => !g.template);
  const counts = { all: machines.length, running: machines.filter(({ g }) => g.status === "running").length, stopped: machines.filter(({ g }) => g.status === "stopped").length, paused: machines.filter(({ g }) => g.status === "paused" || g.status === "suspended").length };
  const q = query.trim().toLowerCase();
  const shown = rows.filter(({ g, h }) => (kind === "template" ? g.template : !g.template && (kind === "all" || kind === g.type))
    && (filter === "all" || (filter === "paused" ? g.status === "paused" || g.status === "suspended" : g.status === filter))
    && (where === "all" || h.id === where)
    && (!q || [g.name, String(g.vmid), g.tags, h.name].some((v) => v?.toLowerCase().includes(q))))
    .sort((a, b) => sort === "name" ? (a.g.name || "").localeCompare(b.g.name || "", "ru") : sort === "id" ? a.g.vmid - b.g.vmid : sort === "memory" ? b.g.mem - a.g.mem : Number(b.g.status === "running") - Number(a.g.status === "running") || b.g.cpu - a.g.cpu || a.g.vmid - b.g.vmid);
  const selectedRow = rows.find(({ g, h }) => `${h.id}/${g.type}/${g.vmid}` === selected) || null;
  const spark = (h: PveHost, g: PveGuest) => (history[h.id]?.guests?.[String(g.vmid)] || []).map((r) => r[1]);
  const totalCPU = machines.filter(({ g }) => g.status === "running").reduce((s, { g }) => s + g.cpus, 0);
  const totalMem = machines.filter(({ g }) => g.status === "running").reduce((s, { g }) => s + g.maxmem, 0);
  const oldHosts = hosts.filter(stale);
  return <div className="pve-page">
    {hosts.map((h) => <HostHistory key={h.id} host={host} id={h.id} onData={onHistory} />)}
    <div className="pve-guest-heading"><div><span className="pve-eyebrow">Виртуальная инфраструктура</span><h2>Машины и контейнеры</h2><p>Выберите машину, чтобы посмотреть детали и управлять питанием.</p></div><span className="pve-guest-total">{machines.length}<small>машин</small></span></div>
    <div className="pve-filters card">
      <div className="pve-toolbar"><Segmented label="Состояние" value={filter} onChange={setFilter} options={[
        { value: "all", label: "Все", count: counts.all }, { value: "running", label: "Работают", count: counts.running }, { value: "stopped", label: "Остановлены", count: counts.stopped },
        ...(counts.paused ? [{ value: "paused" as const, label: "Пауза", count: counts.paused }] : []),
      ]} /><div className="pve-toolbar-search"><SearchInput value={query} onChange={setQuery} placeholder="Имя, VMID, сервер или тег" label="Поиск машины" /></div></div>
      <div className="pve-filter-selects">
        <label>Тип<select value={kind} onChange={(e) => setKind(e.target.value as Kind)}><option value="all">VM и контейнеры</option><option value="qemu">Виртуальные машины</option><option value="lxc">Контейнеры LXC</option><option value="template">Шаблоны</option></select></label>
        <label>Сервер<select value={where} onChange={(e) => setWhere(e.target.value)}><option value="all">Все серверы</option>{hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
        <label>Сортировка<select value={sort} onChange={(e) => setSort(e.target.value as Sort)}><option value="load">По загрузке CPU</option><option value="name">По имени</option><option value="memory">По занятой памяти</option><option value="id">По VMID</option></select></label>
        <span className="pve-filter-count">Показано: {shown.length}</span>
      </div>
    </div>
    <p className="pve-muted pve-summary-line">Запущенным машинам выделено {totalCPU} vCPU и {bytes(totalMem, 0)} памяти.{oldHosts.length ? ` Есть старые данные: ${oldHosts.map((h) => h.name).join(", ")}.` : " График CPU — за сутки."}</p>
    {shown.length ? <div className="pve-guests card" role="table" aria-label="Виртуальные машины и контейнеры">
      <div className="pve-guest head" role="row"><span role="columnheader">Машина</span><span role="columnheader">Процессор / сутки</span><span role="columnheader">Память</span><span role="columnheader">Сеть и диск</span><span role="columnheader">Работает</span><span role="columnheader">Управление</span></div>
      {shown.map(({ g, h }) => <GuestRow key={`${h.id}/${g.type}/${g.vmid}`} g={g} h={h} spark={spark(h, g)} onOpen={() => setSelected(`${h.id}/${g.type}/${g.vmid}`)} />)}
    </div> : <Empty title={rows.length ? "Ничего не нашлось" : "Машин пока нет"}>{rows.length ? "Измените фильтры или строку поиска." : "Агент ещё не прислал список машин."}</Empty>}
    <GuestDetails row={selectedRow} spark={selectedRow ? spark(selectedRow.h, selectedRow.g) : []} close={() => setSelected("")} />
  </div>;
}
