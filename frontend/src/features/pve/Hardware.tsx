import { useMemo, type ReactNode } from "react";
import { TimeChart } from "../../components/charts/TimeChart";
import type { Host } from "../../platform/sdk";
import {
  bytes, celsius, chipName, cpuShort, platformName, sensorLabel, tempTone, useHistory,
  type PveDisk, type PveHost, type PveTemp,
} from "./model";
import { Bar, Empty, Pill, Section } from "./parts";

function Sensor({ t }: { t: PveTemp }) {
  const crit = t.crit || (t.chip === "nvme" ? 85 : 100);
  const warn = Math.min(crit - 10, t.max || crit - 10);
  const tone = tempTone(t.c, warn, crit - 3);
  return (
    <li className="pve-sensor">
      <span className="pve-sensor-name">{sensorLabel(t)}</span>
      <Bar value={t.c} max={Math.max(crit + 5, 100)} tone={tone} marks={[warn, crit]} />
      <strong className={`tone-text-${tone}`}>{celsius(t.c)}</strong>
    </li>
  );
}

function Temperatures({ h, host }: { h: PveHost; host: Host }) {
  const c = h.current;
  const history = useHistory(host, h.id);
  const points = useMemo(() => (history.data?.points || []).filter((p) => p.t >= Date.now() / 1000 - 86400), [history.data]);
  if (!c) return null;
  // the per-core rows repeat the package value; show them after the summary sensors
  const temps = [...c.temps].sort((a, b) => Number(a.label.startsWith("Core")) - Number(b.label.startsWith("Core")) || chipName(a.chip).localeCompare(chipName(b.chip)));
  const disks = c.disks.filter((d) => d.temp != null);
  const temp = points.map((p) => p.temp);
  const peak = Math.max(...temp.filter((v): v is number => v != null), 0);
  return (
    <div className="pve-temps card">
      <div className="pve-card-head">
        <h3>Температуры</h3>
        <Pill tone={tempTone(c.node.cpu_temp)}>процессор {celsius(c.node.cpu_temp)}</Pill>
      </div>
      <ul className="pve-sensors">
        {temps.map((t, i) => <Sensor key={`${t.chip}-${t.label}-${i}`} t={t} />)}
        {disks.map((d) => <Sensor key={d.dev} t={{ chip: "disk", label: `Диск ${d.model || d.dev}`, c: d.temp as number, crit: d.kind === "hdd" ? 60 : 80 }} />)}
      </ul>
      {c.fans.length ? (
        <div className="pve-fans">{c.fans.map((f) => <span key={f.chip + f.label}>{f.label}: <b>{f.rpm} об/мин</b></span>)}</div>
      ) : <p className="pve-muted pve-small">Датчиков вентиляторов нет — у пассивного мини-ПК это нормально.</p>}
      {points.length > 1 ? (
        <div className="pve-temps-chart">
          <div className="pve-chart-head"><span className="pve-muted">Процессор за сутки</span><span className="pve-muted">максимум {celsius(peak)}</span></div>
          <TimeChart times={points.map((p) => p.t)} series={[{ label: "°C", values: temp }]} format={celsius} height={96} label="Температура процессора за сутки" axis />
        </div>
      ) : null}
    </div>
  );
}

function Spec({ label, children }: { label: string; children: ReactNode }) {
  return <div className="pve-spec"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Passport({ h }: { h: PveHost }) {
  const hw = h.hardware;
  const c = h.current;
  if (!hw) return <div className="card pve-passport"><Empty title="Характеристики ещё не собраны">Агент обновляет их раз в 6 часов и при запуске.</Empty></div>;
  const ghz = hw.cpu.max_mhz ? `до ${(hw.cpu.max_mhz / 1000).toFixed(1)} ГГц` : "";
  return (
    <div className="card pve-passport">
      <div className="pve-card-head">
        <h3>{platformName(hw)}</h3>
        {hw.board && hw.board !== platformName(hw) ? <span className="pve-muted pve-small">{hw.board}</span> : null}
      </div>
      <dl className="pve-specs">
        <Spec label="Процессор">
          <b>{cpuShort(hw.cpu.model) || "—"}</b>
          <span className="pve-muted">{[`${hw.cpu.cores} ядер / ${hw.cpu.threads} потоков`, ghz, hw.cpu.virt].filter(Boolean).join(" · ")}</span>
        </Spec>
        <Spec label="Память">
          <b>{bytes(hw.memory.total, 0)}</b>
          <span className="pve-muted">
            {hw.memory.modules.length
              ? hw.memory.modules.map((m) => [m.size, m.type, m.speed, m.vendor, m.part].filter(Boolean).join(" ")).join("; ")
              : "модули не определены"}
            {hw.memory.slots ? ` · занято слотов ${hw.memory.modules.length} из ${hw.memory.slots}` : ""}
          </span>
        </Spec>
        <Spec label="Диски">
          {c?.disks.length ? c.disks.map((d) => <span key={d.dev}><b>{d.model || d.dev}</b> <span className="pve-muted">{bytes(d.size, 0)} · {d.kind.toUpperCase()}</span></span>) : "—"}
        </Spec>
        <Spec label="Сеть">
          {hw.nics.length ? hw.nics.map((n) => (
            <span key={n.iface}>
              <b>{n.iface}</b> <span className="pve-muted">{n.driver}{n.speed ? ` · ${n.speed >= 1000 ? `${n.speed / 1000} Гбит/с` : `${n.speed} Мбит/с`}` : ""} · {n.state === "up" ? "подключён" : "отключён"}</span>
            </span>
          )) : "—"}
        </Spec>
        {hw.gpus.length ? <Spec label="Графика">{hw.gpus.map((g) => <span key={g}>{g}</span>)}</Spec> : null}
        {hw.controllers.length ? <Spec label="Контроллеры">{hw.controllers.map((g) => <span key={g} className="pve-muted">{g}</span>)}</Spec> : null}
        <Spec label="Прошивка">{hw.bios || "—"}</Spec>
        <Spec label="Система">
          <span>Proxmox VE {c?.versions.pve || "—"}</span>
          <span className="pve-muted">ядро {c?.versions.kernel || "—"} · агент {c?.versions.agent || "—"}</span>
        </Spec>
      </dl>
    </div>
  );
}

function DiskCard({ d }: { d: PveDisk }) {
  const health = d.health == null ? <Pill>SMART нет</Pill> : d.health ? <Pill tone="ok">SMART в норме</Pill> : <Pill tone="bad">SMART: неисправность</Pill>;
  const wearTone = d.wear == null ? "idle" : d.wear >= 80 ? "bad" : d.wear >= 50 ? "warn" : "ok";
  return (
    <div className="pve-disk">
      <div className="pve-disk-head">
        <div>
          <strong>{d.model || d.dev}</strong>
          <span className="pve-muted pve-mono">/dev/{d.dev} · {d.serial || "без серийного номера"}</span>
        </div>
        {health}
      </div>
      <div className="pve-disk-grid">
        <span><small>Объём</small><b>{bytes(d.size, 0)}</b></span>
        <span><small>Тип</small><b>{d.kind.toUpperCase()}{d.transport ? ` · ${d.transport.toUpperCase()}` : ""}</b></span>
        <span><small>Температура</small><b className={`tone-text-${tempTone(d.temp, 55, 70)}`}>{celsius(d.temp)}</b></span>
        <span><small>Наработка</small><b>{d.hours == null ? "—" : `${d.hours.toLocaleString("ru-RU")} ч`}</b></span>
        <span><small>Включений</small><b>{d.cycles ?? "—"}</b></span>
        <span><small>Записано</small><b>{d.written ? bytes(d.written, 1) : "—"}</b></span>
      </div>
      {d.wear != null ? (
        <div className="pve-wear">
          <span>Израсходовано ресурса</span>
          <Bar value={d.wear} tone={wearTone} />
          <b>{d.wear} %</b>
        </div>
      ) : null}
      {(d.media_errors || d.reallocated) ? <p className="tone-text-warn pve-small">Ошибки носителя: {d.media_errors ?? 0}, переназначено секторов: {d.reallocated ?? 0}</p> : null}
      {d.firmware ? <p className="pve-muted pve-small">Прошивка {d.firmware}</p> : null}
    </div>
  );
}

export function Hardware({ host, hosts }: { host: Host; hosts: PveHost[] }) {
  if (!hosts.length) return <Empty title="Хосты не настроены" />;
  return (
    <div className="pve-page">
      {hosts.map((h) => (
        <Section key={h.id} title={h.name} hint={`${h.address}${h.online ? "" : " · нет связи, показаны последние данные"}`}>
          <div className="pve-hw-grid">
            <Passport h={h} />
            <Temperatures h={h} host={host} />
          </div>
          {h.current?.disks.length ? <div className="pve-disks">{h.current.disks.map((d) => <DiskCard key={d.dev} d={d} />)}</div> : null}
        </Section>
      ))}
    </div>
  );
}
