import { useMemo, useState } from "react";
import { SearchInput, Segmented } from "../../components/ui/controls";
import type { Host } from "../../platform/sdk";
import { bits, bytes, loadTone, percent, ratio, rate, uptime, useHistory, type PveGuest, type PveHost } from "./model";
import { Bar, Dot, Empty, Pill, Spark } from "./parts";

type Filter = "all" | "running" | "stopped";

function GuestRow({ g, host, spark }: { g: PveGuest; host: PveHost; spark: number[] }) {
  const on = g.status === "running";
  const mem = ratio(g.mem, g.maxmem);
  return (
    <div className={`pve-guest${on ? "" : " off"}`} role="row">
      <div className="pve-guest-name" role="cell">
        <Dot tone={on ? "ok" : g.status === "paused" ? "warn" : "idle"} />
        <div>
          <strong>{g.name || `#${g.vmid}`}</strong>
          <span className="pve-muted pve-mono">{g.vmid} · {host.name}</span>
        </div>
        <Pill tone={g.type === "lxc" ? "accent" : "idle"}>{g.type === "lxc" ? "CT" : "VM"}</Pill>
        {g.lock ? <Pill tone="warn" title="Операция над машиной">{g.lock}</Pill> : null}
      </div>
      <div className="pve-guest-cpu" role="cell">
        <div className="pve-guest-metric"><span>{on ? percent(g.cpu) : "—"}</span><small>{g.cpus} vCPU</small></div>
        {on ? <Bar value={g.cpu} tone={loadTone(g.cpu)} thin /> : null}
      </div>
      <div className="pve-guest-spark" role="cell"><Spark values={spark} max={100} tone={loadTone(Math.max(0, ...spark))} label={`CPU ${g.name} за сутки`} /></div>
      <div className="pve-guest-mem" role="cell">
        <div className="pve-guest-metric"><span>{on ? bytes(g.mem) : "—"}</span><small>из {bytes(g.maxmem, 0)}</small></div>
        {on ? <Bar value={mem} tone={loadTone(mem)} thin /> : null}
      </div>
      <div className="pve-guest-io" role="cell">
        {on ? (
          <>
            <span title="Сеть: приём / передача">↓ {bits(g.netin_rate)} · ↑ {bits(g.netout_rate)}</span>
            <span className="pve-muted" title="Диск: чтение / запись">R {rate(g.diskread_rate)} · W {rate(g.diskwrite_rate)}</span>
          </>
        ) : <span className="pve-muted">остановлена</span>}
      </div>
      <div className="pve-guest-up" role="cell">
        <span>{on ? uptime(g.uptime) : "—"}</span>
        {g.maxdisk ? <small className="pve-muted">диск {bytes(g.maxdisk, 0)}</small> : null}
      </div>
    </div>
  );
}

function useSparks(host: Host, hosts: PveHost[]) {
  // history is per host; at most a few hosts, each fetched once a minute
  const a = useHistory(host, hosts[0]?.id || null);
  const b = useHistory(host, hosts[1]?.id || null);
  const c = useHistory(host, hosts[2]?.id || null);
  return useMemo(() => {
    const out: Record<string, number[]> = {};
    [a.data, b.data, c.data].forEach((h, i) => {
      if (!h || !hosts[i]) return;
      for (const [vmid, rows] of Object.entries(h.guests || {})) out[`${hosts[i].id}/${vmid}`] = rows.map((r) => r[1]);
    });
    return out;
  }, [a.data, b.data, c.data, hosts]);
}

export function Guests({ host, hosts }: { host: Host; hosts: PveHost[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [where, setWhere] = useState("all");
  const [query, setQuery] = useState("");
  const sparks = useSparks(host, hosts);
  const rows = hosts.flatMap((h) => (h.current?.guests || []).filter((g) => !g.template).map((g) => ({ g, h })));
  const counts = { all: rows.length, running: rows.filter((r) => r.g.status === "running").length, stopped: rows.filter((r) => r.g.status !== "running").length };
  const q = query.trim().toLowerCase();
  const shown = rows
    .filter((r) => filter === "all" || (filter === "running") === (r.g.status === "running"))
    .filter((r) => where === "all" || r.h.id === where)
    .filter((r) => !q || r.g.name.toLowerCase().includes(q) || String(r.g.vmid).includes(q) || r.g.tags.toLowerCase().includes(q))
    .sort((x, y) => Number(y.g.status === "running") - Number(x.g.status === "running") || y.g.cpu - x.g.cpu || x.g.vmid - y.g.vmid);
  const totalCPU = rows.filter((r) => r.g.status === "running").reduce((s, r) => s + r.g.cpus, 0);
  const totalMem = rows.filter((r) => r.g.status === "running").reduce((s, r) => s + r.g.maxmem, 0);
  return (
    <div className="pve-page">
      <div className="pve-toolbar">
        <Segmented label="Состояние" value={filter} onChange={setFilter} options={[
          { value: "all", label: "Все", count: counts.all }, { value: "running", label: "Работают", count: counts.running }, { value: "stopped", label: "Остановлены", count: counts.stopped },
        ]} />
        {hosts.length > 1 ? (
          <Segmented label="Хост" value={where} onChange={setWhere} options={[{ value: "all", label: "Все хосты" }, ...hosts.map((h) => ({ value: h.id, label: h.name }))]} />
        ) : null}
        <div className="pve-toolbar-search"><SearchInput value={query} onChange={setQuery} placeholder="Имя, VMID или тег" label="Поиск машины" /></div>
      </div>
      <p className="pve-muted pve-summary-line">
        Запущенным машинам выделено {totalCPU} vCPU и {bytes(totalMem, 0)} памяти. График — загрузка процессора за сутки, точка раз в 5 минут.
      </p>
      {shown.length ? (
        <div className="pve-guests card" role="table" aria-label="Виртуальные машины и контейнеры">
          <div className="pve-guest head" role="row">
            <span role="columnheader">Машина</span><span role="columnheader">Процессор</span><span role="columnheader">За сутки</span>
            <span role="columnheader">Память</span><span role="columnheader">Сеть и диск</span><span role="columnheader">Работает</span>
          </div>
          {shown.map(({ g, h }) => <GuestRow key={`${h.id}/${g.vmid}`} g={g} host={h} spark={sparks[`${h.id}/${g.vmid}`] || []} />)}
        </div>
      ) : (
        <Empty title={rows.length ? "Ничего не нашлось" : "Машин пока нет"}>{rows.length ? "Измените фильтр или строку поиска." : "Агент не прислал список гостей."}</Empty>
      )}
    </div>
  );
}
