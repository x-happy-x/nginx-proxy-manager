import { useId } from "react";
import { Icon } from "../../components/ui/Icon";
import { bytes, cpuShort, sensorLabel, sensorThreshold } from "../pve/model";
import { Inventory } from "../pve/Hardware";
import type { Machine } from "./model";

const color = (t: number | null | undefined, warn = 65, bad = 80) => t == null ? "#4a5650" : t >= bad ? "#ef6a6a" : t >= warn ? "#e5a54b" : "#3fcf8e";
const short = (s: string, n = 23) => s.length > n ? s.slice(0, n - 1) + "…" : s;

/** Same zones and wiring as board() in machines-unified.html; all values are agent data. */
export function Board({ machine: m }: { machine: Machine }) {
  const uid = useId().replace(/:/g, ""), hw = m.pve?.hardware, c = m.pve?.current, pc = m.pc?.current;
  const cpu = cpuShort(hw?.cpu.model || pc?.cpu.model) || "Модель неизвестна";
  const temp = c?.node.cpu_temp, cpuSensor = c?.temps.find(t => /coretemp|k10temp|zenpower|cpu_thermal/.test(t.chip));
  const bounds = sensorThreshold(cpuSensor), cpuColor = color(temp, bounds.warn, bounds.bad);
  const modules = hw?.memory.modules || [], slots = hw?.memory.slots || 0;
  // DMI Locator is retained. Unrecognised locator naming is shown in inventory,
  // never guessed as a particular physical slot on the board.
  const located = modules.map(v => ({ ...v, index: v.slot.match(/(?:DIMM[_ -]?[AB]?|Channel[AB]-DIMM)(\d+)$/i)?.[1] }));
  const numbered = located.every(v => v.index !== undefined) && new Set(located.map(v => v.index)).size === modules.length;
  const zeroBased = located.some(v => v.index === "0");
  const slotAt = (i: number) => numbered ? located.find(v => Number(v.index) === i + (zeroBased ? 0 : 1)) : modules[i];
  const nics = hw?.nics.length ? hw.nics.map(n => ({ name: n.iface, up: n.state === "up", speed: n.speed })) : (c?.net || []).filter(n => !n.bridge).map(n => ({ name: n.iface, up: n.state === "up", speed: n.speed }));
  const pcNics = pc?.network.filter(n => !n.aggregate) || [];
  const ports = nics.length ? nics : pcNics.map(n => ({ name: n.name, up: null, speed: null }));
  const disks = c?.disks.map(d => ({ name: d.model || d.dev, kind: d.kind, temp: d.temp, info: `${d.wear == null ? "износ —" : `износ ${d.wear} %`} · ${d.temp == null ? "—°" : `${d.temp}°`}`, fill: null as number | null })) || pc?.disks.map(d => ({ name: d.path, kind: "unknown", temp: null, info: d.total ? `${Math.round(d.used / d.total * 100)} % занято` : "объём неизвестен", fill: d.total ? d.used / d.total * 100 : null })) || [];
  const gpuNames=(hw?.gpus || []).map(raw => (raw.match(/\[([^\]]*(?:GeForce|Radeon|Graphics|UHD)[^\]]*)\]/i)?.[1] || raw.replace(/^(Intel Corporation|NVIDIA Corporation|Advanced Micro Devices, Inc\. \[AMD\/ATI\])\s*/i, "").replace(/\s*\(rev [^)]+\)/g, "")).replace(/HD Graphics /g,"HD "));
  const gpu=gpuNames.join(" + ");
  const text = (x: number, y: number, value: string, size = 11.5, fill = "#a7b3ad", middle = false, bold = false) => <text x={x} y={y} fontSize={size} fill={fill} textAnchor={middle ? "middle" : undefined} fontWeight={bold ? 700 : undefined}>{value}</text>;
  return <div className="mc-board-wrap"><svg className="mc-board" viewBox="0 0 600 350" role="img" aria-label={`Схема платы ${m.name}`}>
    <defs><pattern id={`${uid}-pcb`} width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".6" fill="#2c4a3b" opacity=".35" /></pattern><linearGradient id={`${uid}-die`} x2="1" y2="1"><stop stopColor="#334251" /><stop offset="1" stopColor="#18232e" /></linearGradient><linearGradient id={`${uid}-ram`}><stop stopColor="#a78bfa" /><stop offset="1" stopColor="#6b4ed1" /></linearGradient><linearGradient id={`${uid}-m2`}><stop stopColor="#1e6b96" /><stop offset="1" stopColor="#14405b" /></linearGradient></defs>
    <rect x="2" y="2" width="596" height="346" rx="18" fill="#0d1613" stroke="#1f3a30" /><rect x="2" y="2" width="596" height="346" rx="18" fill={`url(#${uid}-pcb)`} />
    {[[16,16],[584,16],[16,334],[584,334]].map(([x,y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="5" fill="#0b0e0d" stroke="#2b3d35" />)}
    <g fill="none" stroke="#25624a" strokeWidth="2" strokeLinejoin="round"><path d="M176 100H214M105 36V22H316V135H330M365 110V92M400 124H470V78H508M400 146H480V154H508M365 160V234H120V244" /></g>
    <rect x="34" y="36" width="142" height="142" rx="10" fill="#0a0f0d" stroke={cpuColor} strokeWidth="2" strokeDasharray="3 5" /><rect x="48" y="50" width="114" height="114" rx="8" fill={`url(#${uid}-die)`} stroke="#4a5866" />
    <title>{cpu}</title>{text(105, 90, cpu.includes("AMD") ? "AMD" : cpu.includes("Intel") ? "Intel" : "CPU", 11.5, undefined, true)}{text(105, 113, short(cpu.replace(/^(Intel|AMD)\s*/, ""), 17), 12, "#e9efec", true, true)}
    <circle cx="176" cy="36" r="19" fill={cpuColor} />{text(176, 41, temp == null ? "—°" : `${Math.round(temp)}°`, 12.5, temp == null ? "#a7b3ad" : "#06140e", true, true)}
    {text(34, 200, hw ? `${hw.cpu.cores} ядер · ${hw.cpu.threads} потоков` : `${pc?.cpu.cores ?? "—"} потоков`, 12, "#e9efec", false, true)}{text(34, 217, hw ? `${hw.cpu.max_mhz ? `до ${hw.cpu.max_mhz / 1000} ГГц · ` : ""}${hw.cpu.virt}` : "ядра и датчики неизвестны", 10.5)}
    {slots ? <>{Array.from({length: Math.min(slots, 4)}, (_, i) => { const mod = slotAt(i), x = 214 + i * 22; return <g key={i}><title>{mod ? `${mod.slot}: ${mod.size} ${mod.type}` : "Пустой слот"}</title><rect x={x} y="36" width="15" height="142" rx="3" fill={mod ? `url(#${uid}-ram)` : "none"} stroke={mod ? "none" : "#3a4741"} strokeDasharray={mod ? undefined : "4 4"} />{mod && [0,1,2,3].map(k => <rect key={k} x={x+3} y={50+k*30} width="9" height="18" rx="1.5" fill="#2c2266" />)}</g>; })}{text(214, 200, `${bytes(hw?.memory.total)} · ${modules[0]?.type || "тип —"}`, 12, "#e9efec", false, true)}{text(214, 217, `${modules.length} из ${slots} слотов${!numbered && modules.length ? " · порядок DMI" : ""}`, 10)}</> : <><rect x="214" y="36" width="88" height="142" rx="8" fill="#171f1c" stroke="#3a4741" strokeDasharray="4 4" />{text(258,104,bytes(hw?.memory.total || pc?.memory.total),16,"#e9efec",true,true)}{text(258,122,"ОЗУ",10.5,undefined,true)}{text(214,200,"модули неизвестны",11)}</>}
    <rect x="330" y="30" width="160" height="62" rx="10" fill={gpu ? "#15202a" : "none"} stroke={gpu ? "#2c4a66" : "#3a4741"} strokeDasharray={gpu ? undefined : "4 4"} />{gpu ? <><circle cx="356" cy="61" r="14" fill="none" stroke="#7fb0ff" strokeWidth="2" /><path d="M356 47v28M342 61h28M346 51l20 20M366 51l-20 20" stroke="#7fb0ff" opacity=".55" />{text(378,gpuNames.length>1?47:56,"Видео",11.5,"#e9efec",false,true)}{gpuNames.slice(0,2).map((name,i)=><g key={i}>{text(378,gpuNames.length>1?63+i*15:74,short(name,22),9.5)}</g>)}</> : text(410,66,"видео неизвестно",11,"#6f7b75",true)}
    <rect x="330" y="110" width="70" height="50" rx="8" fill="#1b2420" stroke="#3a5a4c" />{text(365,132,"чипсет",9.5,undefined,true)}{text(365,148,short(hw?.board.match(/\b[ABHXYZ]\d{3}/)?.[0] || hw?.controllers.find(s => /ISA bridge|SMBus|Host bridge|chipset/i.test(s)) || "неизвестен",10),10.5,"#e9efec",true,true)}
    {ports.slice(0,2).map((n,i) => { const y=56+i*76, col = n.up === null ? "#4a5650" : n.up ? n.speed && n.speed < 1000 ? "#e5a54b" : "#3fcf8e" : "#4a5650"; return <g key={n.name}><title>{n.name}</title><rect x="508" y={y} width="60" height="44" rx="8" fill="#141b18" stroke={col} /><path d={`M523 ${y+11}h30v17h-6v6h-18v-6h-6z`} fill="none" stroke={col} strokeWidth="1.8" />{text(538,y+60,n.up === false ? "выкл" : n.speed ? n.speed >= 1000 ? `${n.speed/1000} Гбит/с` : `${n.speed} Мбит/с` : short(n.name,13),10,n.up ? "#e9efec" : "#6f7b75",true)}</g>; })}
    {!ports.length && text(538,78,"сеть —",11,"#6f7b75",true)}
    {disks.slice(0,3).map((d,i) => { const x=34+i*174, col = d.fill != null ? color(d.fill,85,95) : color(d.temp); return <g key={i}><title>{d.name}</title>{d.kind === "nvme" ? <><rect x={x} y="246" width="160" height="30" rx="4" fill={`url(#${uid}-m2)`} /><rect x={x+8} y="253" width="34" height="16" rx="2" fill="#123e66" /><rect x={x+48} y="253" width="42" height="16" rx="2" fill="#123e66" /><circle cx={x+152} cy="261" r="4" fill="#0d1613" /><rect x={x} y="251" width="4" height="20" fill={col} /></> : <><rect x={x} y="240" width="80" height="44" rx="6" fill="#1a2420" stroke={col} />{d.kind === "hdd" ? <><circle cx={x+30} cy="262" r="14" fill="none" stroke="#6f7b75" /><circle cx={x+30} cy="262" r="3" fill="#6f7b75" /></> : text(x+40,267,d.kind === "unknown" ? "Диск" : "SSD",11,undefined,true,true)}</>}{text(x,302,short(d.name,21),11,"#e9efec",false,true)}{text(x,319,`${d.kind === "nvme" ? "M.2 · " : ""}${d.info}`,10,col)}</g>; })}
    {!disks.length && text(34,266,"Данные о дисках не передаются",12)}
  </svg>
  <div className="mc-legend"><span><Icon name="system" size={14} />{cpu}</span><span>{bytes(hw?.memory.total || pc?.memory.total)}</span><span>{disks.length} дисков</span></div>
  {c?.temps.length ? <details className="mc-more"><summary>Все датчики ({c.temps.length})</summary><div className="mc-sensors">{c.temps.map((t,i) => { const limits=sensorThreshold(t); return <div key={i}>{sensorLabel(t)}<b style={{color:color(t.c,limits.warn,limits.bad)}}>{Math.round(t.c)}°</b></div>; })}{c.fans.map((f,i) => <div key={`fan-${i}`}>{f.label}<b>{f.rpm} об/мин</b></div>)}</div></details> : <p className="mc-muted">Агент не передаёт датчики{pc?.os === "windows" ? " и модули памяти Windows" : ""}.</p>}
  {disks.length > 3 && <details className="mc-more"><summary>Ещё {disks.length-3} дисков</summary>{disks.slice(3).map((d,i) => <p key={i}>{d.name} · {d.info}</p>)}</details>}
  {hw && m.pve ? <Inventory h={m.pve} /> : <details className="mc-more"><summary>Инвентарь</summary><dl className="pv-kv"><dt>Агент</dt><dd>pc-agent {pc?.agent || "—"}</dd><dt>Система</dt><dd>{pc?.os} · {pc?.arch}</dd><dt>Видео, чипсет, SMART</dt><dd>Агент не передаёт эти сведения. Тип дисков неизвестен.</dd></dl></details>}
  </div>;
}
