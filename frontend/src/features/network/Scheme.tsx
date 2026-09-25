import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MeshNode, NetworkPayload, Topology, TopoSegment } from "../../api";
import { Icon, type IconName } from "../../components/ui/Icon";
import { Tag, formatMs, type Tone } from "./shared";

// «Схема»: the home network as a graph. Nodes carry an icon, a name and one
// number; the state is a ring plus a badge icon. Clicking a node opens its
// details. Traffic goes left to right (top to bottom on narrow screens): LAN
// segments → Netcraze → (mihomo) → MikroTik → the LTE operator with ТСПУ →
// the internet, directly or through a VPN node.

type Kind = "segment" | "mesh" | "pve" | "remote" | "netcraze" | "mihomo" | "mikrotik" | "operator" | "vpn" | "internet";

type GNode = {
  id: string;
  kind: Kind;
  icon: IconName;
  label: string;
  metric?: string;
  tone: Tone;
  a: number; // main axis 0..1 (direction of traffic)
  c: number; // cross axis 0..1
  small?: boolean;
  seg?: TopoSegment;
  mesh?: MeshNode;
};

type GEdge = {
  from: string;
  to: string;
  style: "lan" | "direct" | "tunnel" | "link";
  label?: string;
};

function sameNet(cidr: string, ip: string) {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw || 24);
  const toInt = (v: string) => v.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  if (!base || !ip) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(base) & mask) === (toInt(ip) & mask);
}

function shortName(name: string, max = 16) {
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

function buildGraph(topo: Topology, net: NetworkPayload | null) {
  const k = topo.keenetic;
  const mt = topo.mikrotik;
  const sig = mt.signal;
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const segs = k.segments;
  const pveSeg = topo.proxmox?.ip ? segs.find((s) => sameNet(s.cidr, topo.proxmox!.ip)) : undefined;

  segs.forEach((seg, i) => {
    const c = (i + 0.5) / segs.length;
    nodes.push({
      id: seg.id,
      kind: "segment",
      icon: seg.id === "Bridge0" ? "home" : seg.name.toLowerCase().includes("guest") ? "lock" : seg.name.toLowerCase().includes("iot") ? "bolt" : "route",
      label: seg.name.replace(/ network$/i, ""),
      metric: `${seg.active} устр.`,
      tone: "neutral",
      a: 0.2,
      c,
      seg,
    });
    edges.push({ from: seg.id, to: "netcraze", style: "lan" });
    // Satellites: what hangs off this segment.
    const sats: GNode[] = [];
    if (seg.id === "Bridge0") {
      for (const m of topo.mesh) {
        sats.push({
          id: "mesh:" + (m.cid || m.ip),
          kind: "mesh",
          icon: "activity",
          label: shortName(m.name.replace(/^Keenetic\s+/i, "").replace(/\s+\S*\*+\S*$/, ""), 12),
          metric: m.uplink_wifi ? `Wi-Fi ${m.rssi ?? ""}` : "кабель",
          tone: m.internet ? (m.update_available ? "info" : "good") : "critical",
          a: 0.04,
          c: 0,
          small: true,
          mesh: m,
        });
      }
    }
    if (pveSeg?.id === seg.id && topo.proxmox) {
      sats.push({ id: "pve", kind: "pve", icon: "layers", label: `Proxmox ${topo.proxmox.nodes.join(", ")}`, metric: `${topo.proxmox.guests_running}/${topo.proxmox.guests} ВМ`, tone: "good", a: 0.04, c: 0, small: true });
    }
    for (const r of k.routes.filter((r) => sameNet(seg.cidr, r.via))) {
      sats.push({ id: "route:" + r.dst, kind: "remote", icon: "globe", label: r.dst, metric: `через ${r.via}`, tone: "neutral", a: 0.04, c: 0, small: true });
    }
    const spread = Math.min(1 / segs.length, 0.26);
    sats.forEach((s, j) => {
      s.c = c + (sats.length === 1 ? 0 : (j / (sats.length - 1) - 0.5) * spread);
      nodes.push(s);
      edges.push({ from: s.id, to: seg.id, style: "link" });
    });
  });

  const proxyTone = availTone(net, "proxy");
  const directTone = availTone(net, "nc-internet");
  const groups = topo.mihomo.groups || [];
  const exits = Array.from(new Set(groups.map((g) => g.leaf).filter((v) => v && v !== "DIRECT" && v !== "REJECT")));
  const wan = net?.keenetic.interfaces?.find((i) => i.wan);
  const lte = mt.system?.interfaces.find((i) => i.type === "lte");
  const quality = sig?.quality;

  nodes.push(
    { id: "netcraze", kind: "netcraze", icon: "route", label: "Netcraze", metric: "192.168.1.1", tone: "good", a: 0.36, c: 0.5 },
    {
      id: "mihomo",
      kind: "mihomo",
      icon: "bolt",
      label: "mihomo",
      metric: topo.mihomo.error ? "недоступен" : `${groups.length} групп`,
      tone: topo.mihomo.error ? "critical" : proxyTone === "neutral" ? "good" : proxyTone,
      a: 0.49,
      c: 0.2,
    },
    {
      id: "mikrotik",
      kind: "mikrotik",
      icon: "activity",
      label: "MikroTik",
      metric: "192.168.188.1",
      tone: mt.online === false || (!mt.system && mt.error) ? "critical" : mt.error ? "warning" : "good",
      a: 0.6,
      c: 0.5,
    },
    {
      id: "operator",
      kind: "operator",
      icon: "lock",
      label: sig?.operator ? `${sig.operator} · ТСПУ` : "Оператор · ТСПУ",
      metric: quality != null ? `LTE ${quality}%` : "LTE",
      tone: quality == null ? "neutral" : quality >= 60 ? "good" : quality >= 35 ? "warning" : "critical",
      a: 0.8,
      c: 0.5,
    },
    {
      id: "vpn",
      kind: "vpn",
      icon: "external",
      label: "VPN-узлы",
      metric: exits.length ? `${exits.length} в работе` : "—",
      tone: proxyTone,
      a: 0.96,
      c: 0.2,
    },
    {
      id: "internet",
      kind: "internet",
      icon: "globe",
      label: "Интернет",
      metric: net?.current ? formatMs(net.current.nc["google-dns"]?.ms) : undefined,
      tone: directTone,
      a: 0.96,
      c: 0.72,
    },
  );
  edges.push(
    { from: "netcraze", to: "mihomo", style: "tunnel" },
    { from: "mihomo", to: "mikrotik", style: "tunnel" },
    { from: "netcraze", to: "mikrotik", style: "direct", label: wan ? rates(wan.rx_bps, wan.tx_bps) : undefined },
    { from: "mikrotik", to: "operator", style: "direct", label: lte ? rates(lte.rx_bps, lte.tx_bps) : undefined },
    { from: "operator", to: "vpn", style: "tunnel" },
    { from: "operator", to: "internet", style: "direct" },
    { from: "vpn", to: "internet", style: "link" },
  );
  return { nodes, edges, exits };
}

// A single lost check should not paint the graph red: the last two buckets
// decide (both failed: critical, some failures: warning).
function availTone(net: NetworkPayload | null, id: string): Tone {
  const item = net?.availability.find((a) => a.id === id);
  if (!item || !item.valid) return "neutral";
  const b = item.buckets.filter((v) => v >= 0).slice(-2);
  if (b.length && b.every((v) => v === 0)) return "critical";
  if (b.some((v) => v < 100) || !item.ok) return "warning";
  return "good";
}

function mbit(bps: number) {
  const v = bps / 1e6;
  return v >= 10 ? Math.round(v).toString() : v >= 0.1 ? v.toFixed(1) : v > 0 ? "<0.1" : "0";
}

function rates(rx: number, tx: number) {
  return `↓${mbit(rx)} ↑${mbit(tx)} Мбит/с`;
}

const TONE_ICON: Record<Tone, IconName | null> = { good: null, neutral: null, info: "info", warning: "alert", critical: "error" };

export function NetworkScheme({ topo, net }: { topo: Topology | null; net: NetworkPayload | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [vertical, setVertical] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setVertical(entry.contentRect.width < 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, [topo]);

  const graph = useMemo(() => (topo ? buildGraph(topo, net) : null), [topo, net]);
  const detail = useRef<HTMLElement>(null);
  useEffect(() => {
    // Bring the panel into view if it opened below the fold.
    const el = detail.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top > window.innerHeight - 80) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selected]);
  if (!topo || !graph) return <div className="launcher-loading">Собираю схему…</div>;

  const rows = Math.max(4, topo.keenetic.segments.length);
  const MAIN = vertical ? 900 : 1000;
  const CROSS = vertical ? 420 : Math.max(380, rows * 105);
  const W = vertical ? CROSS : MAIN;
  const H = vertical ? MAIN : CROSS;
  const pad = 40;
  const pos = (n: GNode) => {
    const main = pad + n.a * (MAIN - 2 * pad);
    const cross = pad + n.c * (CROSS - 2 * pad);
    return vertical ? { x: cross, y: main } : { x: main, y: cross };
  };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const sel = selected ? byId.get(selected) : undefined;

  const path = (e: GEdge) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return "";
    const p = pos(a);
    const q = pos(b);
    if (vertical) {
      const d = (q.y - p.y) / 2;
      return `M${p.x},${p.y} C${p.x},${p.y + d} ${q.x},${q.y - d} ${q.x},${q.y}`;
    }
    const d = (q.x - p.x) / 2;
    return `M${p.x},${p.y} C${p.x + d},${p.y} ${q.x - d},${q.y} ${q.x},${q.y}`;
  };

  return (
    <div className={`net-graph-layout${sel ? " has-selection" : ""}`}>
      <div className="card net-graph-card" ref={wrap}>
        <div className="net-graph-legend">
          <span>
            <i className="net-leg-direct" /> напрямую
          </span>
          <span>
            <i className="net-leg-tunnel" /> через прокси
          </span>
          <span className="muted">Нажмите на узел — подробности</span>
        </div>
        <svg className="net-graph" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Схема сети">
          {graph.edges.map((e) => {
            const d = path(e);
            const a = byId.get(e.from)!;
            const b = byId.get(e.to)!;
            const hot = selected && (e.from === selected || e.to === selected);
            const mid = { x: (pos(a).x + pos(b).x) / 2, y: (pos(a).y + pos(b).y) / 2 };
            return (
              <g key={e.from + e.to} className={`net-edge net-edge-${e.style}${hot ? " is-hot" : ""}`}>
                <path d={d} className="net-edge-base" />
                {e.style !== "link" ? <path d={d} className="net-edge-flow" /> : null}
                {e.label ? (
                  <g transform={`translate(${mid.x},${mid.y + (vertical ? 0 : 16)})`}>
                    <rect className="net-edge-pill" x={-(e.label.length * 3.1 + 10)} y={-10} width={e.label.length * 6.2 + 20} height={20} rx={10} />
                    <text className="net-edge-label" textAnchor="middle" dy="4">
                      {e.label}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
          {graph.nodes.map((n) => {
            const p = pos(n);
            const r = n.small ? 17 : 24;
            const badge = TONE_ICON[n.tone];
            const isSel = selected === n.id;
            return (
              <g
                key={n.id}
                className={`net-gnode net-gnode-${n.tone}${isSel ? " is-selected" : ""}${n.small ? " is-small" : ""}`}
                transform={`translate(${p.x},${p.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${n.label}${n.metric ? `, ${n.metric}` : ""}`}
                aria-pressed={isSel}
                onClick={() => setSelected(isSel ? null : n.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSelected(isSel ? null : n.id);
                  }
                }}
              >
                <circle className="net-gnode-hit" r={r + 14} />
                <circle className="net-gnode-halo" r={r + 6} />
                <circle className="net-gnode-disc" r={r} />
                <svg x={n.small ? -8 : -11} y={n.small ? -8 : -11} width={n.small ? 16 : 22} height={n.small ? 16 : 22} viewBox="0 0 24 24" className="net-gnode-icon">
                  <Icon name={n.icon} size={24} />
                </svg>
                {badge ? (
                  <g transform={`translate(${r * 0.72},${-r * 0.72})`} className="net-gnode-badge">
                    <circle r={8} />
                    <svg x={-6} y={-6} width={12} height={12} viewBox="0 0 24 24">
                      <Icon name={badge} size={24} strokeWidth={2.4} />
                    </svg>
                  </g>
                ) : null}
                <text className="net-gnode-label" y={r + 16} textAnchor="middle">
                  {shortName(n.label, n.small ? 14 : 18)}
                </text>
                {n.metric ? (
                  <text className="net-gnode-metric" y={r + 30} textAnchor="middle">
                    {n.metric}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      {sel ? (
        <aside className="card net-detail" aria-live="polite" ref={detail}>
          <header className="net-detail-head">
            <span className={`net-detail-icon net-gnode-${sel.tone}`}>
              <Icon name={sel.icon} size={18} />
            </span>
            <div>
              <h3>{sel.label}</h3>
              {sel.metric ? <p>{sel.metric}</p> : null}
            </div>
            <button type="button" className="btn btn-icon btn-ghost" aria-label="Закрыть" onClick={() => setSelected(null)}>
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="net-detail-body">
            <Details node={sel} topo={topo} net={net} exits={graph.exits} />
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="net-kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Details({ node, topo, net, exits }: { node: GNode; topo: Topology; net: NetworkPayload | null; exits: string[] }) {
  const k = topo.keenetic;
  const mt = topo.mikrotik;
  const sig = mt.signal;
  switch (node.kind) {
    case "segment": {
      const seg = node.seg!;
      return (
        <>
          <dl className="net-kvs">
            <Row k="Сеть">
              <span className="mono">{seg.cidr}</span>
            </Row>
            <Row k="Устройств в сети">{seg.active}</Row>
            <Row k="DNS">{seg.dns_to_mihomo ? "перехватывается mihomo (:1053)" : "DNS роутера, без mihomo"}</Row>
            <Row k="Мимо прокси">{seg.hosts.filter((h) => h.bypass).length || "нет"}</Row>
          </dl>
          <h4>Устройства</h4>
          <ul className="net-hosts">
            {seg.hosts.map((h) => (
              <li key={h.ip + h.name}>
                <Icon name={h.link === "wifi" ? "activity" : "route"} size={12} />
                <span className="net-host-name">{h.name}</span>
                <span className="mono muted">{h.ip}</span>
                {h.mesh ? <span className="badge badge-accent">mesh-узел</span> : h.bypass ? <span className="badge badge-warning">мимо прокси</span> : h.via_mesh ? <span className="badge">через mesh</span> : <span />}
              </li>
            ))}
            {seg.hosts.length === 0 ? <li className="muted">активных устройств нет</li> : null}
          </ul>
        </>
      );
    }
    case "mesh": {
      const m = node.mesh!;
      return (
        <dl className="net-kvs">
          <Row k="Модель">{m.model}</Row>
          <Row k="Адрес">
            <span className="mono">{m.ip}</span>
          </Row>
          <Row k="Связь с роутером">{m.uplink_wifi ? `Wi-Fi, ${m.rssi ?? "—"} дБм${m.txrate ? `, ${m.txrate} Мбит/с` : ""}` : "кабель"}</Row>
          <Row k="Клиентов Wi-Fi">{m.clients}</Row>
          <Row k="Интернет">{m.internet ? <Tag tone="good">есть</Tag> : <Tag tone="critical">нет</Tag>}</Row>
          <Row k="Прошивка">
            {m.firmware}
            {m.update_available && m.firmware_next ? <Tag tone="info">доступна {m.firmware_next}</Tag> : null}
          </Row>
          <Row k="Нагрузка">Подробно — в «Ресурсах», вкладка «Mesh-узлы»</Row>
        </dl>
      );
    }
    case "pve": {
      const p = topo.proxmox!;
      return (
        <dl className="net-kvs">
          <Row k="Адрес">
            <span className="mono">{p.ip}:8006</span>
          </Row>
          <Row k="Узлы">{p.nodes.join(", ")}</Row>
          <Row k="Виртуальные машины">
            запущено {p.guests_running} из {p.guests}
          </Row>
          <Row k="Нагрузка">Подробно — в «Ресурсах», вкладка «Proxmox»</Row>
        </dl>
      );
    }
    case "remote":
      return (
        <dl className="net-kvs">
          <Row k="Сеть">
            <span className="mono">{node.label}</span>
          </Row>
          <Row k="Маршрут">статический, {node.metric}</Row>
        </dl>
      );
    case "netcraze":
      return (
        <>
          <dl className="net-kvs">
            <Row k="Модель">{k.model || "—"}</Row>
            <Row k="Прошивка">{k.firmware || "—"}</Row>
            <Row k="WAN">
              {k.wan.name || "—"} · <span className="mono">{k.wan.ip || "—"}</span> → 192.168.188.1
            </Row>
          </dl>
          <h4>Что происходит с трафиком</h4>
          <ol className="net-steps">
            <li>
              <b>DNS.</b> Запросы к 192.168.1.1:53 из {k.segments.filter((s) => s.dns_to_mihomo).map((s) => s.name).join(", ") || "—"} уходят в mihomo.
            </li>
            <li>
              <b>XKeen.</b> Весь TCP/UDP клиентов перенаправляется в mihomo, кроме локальных сетей, списков исключений (geo {fmt(topo.xkeen.geo_exclude)}, свои{" "}
              {fmt(topo.xkeen.user_exclude)}, внешние {fmt(topo.xkeen.ext_exclude)}) и MAC-исключений ({topo.xkeen.deny_mac}).
            </li>
            <li>
              <b>Выход.</b> mihomo выпускает свои соединения с меткой 255 — мимо XKeen, прямо в WAN к MikroTik.
            </li>
          </ol>
        </>
      );
    case "mihomo": {
      const groups = (topo.mihomo.groups || []).filter((g) => g.size > 1);
      return topo.mihomo.error ? (
        <p>Контроллер недоступен: {topo.mihomo.error}</p>
      ) : (
        <>
          <dl className="net-kvs">
            <Row k="Версия">{topo.mihomo.version}</Row>
            <Row k="Режим">{topo.mihomo.mode}</Row>
            <Row k="DNS наружу">
              <span className="mono">{(topo.mihomo.nameservers || []).join(", ")}</span> — обычный UDP через оператора
            </Row>
            <Row k="Проверка через прокси">
              {net?.current ? net.current.proxy.ok ? <Tag tone="good">{formatMs(net.current.proxy.ms)}</Tag> : <Tag tone="critical">не проходит</Tag> : "—"}
            </Row>
          </dl>
          <h4>Группы → узел</h4>
          <ul className="net-groups">
            {groups.map((g) => (
              <li key={g.name}>
                <span>{g.name}</span>
                <Icon name="external" size={11} />
                <span className={g.leaf === "DIRECT" ? "net-direct" : ""} title={g.now !== g.leaf ? `${g.now} → ${g.leaf}` : undefined}>
                  {g.leaf === "DIRECT" ? "напрямую" : g.leaf}
                </span>
              </li>
            ))}
          </ul>
        </>
      );
    }
    case "mikrotik":
      return (
        <dl className="net-kvs">
          {mt.error ? <Row k="Ошибка">{mt.error}</Row> : null}
          <Row k="Модель">{mt.system?.board || "—"}</Row>
          <Row k="RouterOS">{mt.system?.version || "—"}</Row>
          <Row k="LAN">
            <span className="mono">192.168.188.1</span>
          </Row>
          <Row k="DNS (оператора)">
            <span className="mono">{(mt.system?.dns_servers || []).join(", ") || "—"}</span>
          </Row>
          <Row k="Роль">NAT: трафик Netcraze и прокси-туннели уходят в LTE без изменений</Row>
          <Row k="Интерфейсы">
            {(mt.system?.interfaces || [])
              .filter((i) => i.running && i.type !== "loopback")
              .map((i) => i.name)
              .join(", ") || "—"}
          </Row>
        </dl>
      );
    case "operator":
      return (
        <>
          <dl className="net-kvs">
            <Row k="Оператор">{sig?.operator || "—"}</Row>
            <Row k="Диапазон">{sig?.band || "—"}</Row>
            <Row k="Сигнал">{sig ? `качество ${sig.quality}% · RSRP ${sig.rsrp} · RSRQ ${sig.rsrq} · SINR ${sig.sinr}` : "—"}</Row>
          </dl>
          <h4>ТСПУ</h4>
          <p className="net-detail-text">
            Стоит у оператора и видит каждый пакет: режет по имени сайта (SNI), по IP, подменяет DNS, глушит зарубежные хостинги после 16–20 КБ. Прокси-туннель для него — один
            зашифрованный поток к VPN-узлу. Что именно режется у конкретного сайта — покажет «Анализатор».
          </p>
        </>
      );
    case "vpn":
      return (
        <>
          <p className="net-detail-text">Узлы, через которые сейчас выходят группы mihomo. Дальше сайт открывается уже из другой страны.</p>
          <ul className="net-groups">
            {exits.map((x) => (
              <li key={x}>
                <span>{x}</span>
                <span />
                <span className="muted">
                  {(topo.mihomo.groups || [])
                    .filter((g) => g.leaf === x && g.size > 1)
                    .map((g) => g.name)
                    .slice(0, 3)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </>
      );
    case "internet":
      return (
        <dl className="net-kvs">
          {(net?.targets || []).map((t) => (
            <Row key={t.id} k={t.name}>
              {net?.current?.nc[t.id]?.ok ? <Tag tone="good">{formatMs(net.current.nc[t.id].ms)}</Tag> : <Tag tone="critical">нет ответа</Tag>}
            </Row>
          ))}
          <Row k="Подробно">Доступность и сбои — во вкладке «Обзор»</Row>
        </dl>
      );
  }
  return null;
}

function fmt(n: number) {
  return n < 0 ? "—" : String(n);
}
