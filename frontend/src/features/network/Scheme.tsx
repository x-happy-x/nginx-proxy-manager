import { useState } from "react";
import type { NetworkPayload, Topology, TopoSegment } from "../../api";
import { Icon, type IconName } from "../../components/ui/Icon";
import { Alert } from "../../components/ui/controls";
import { formatBps } from "../../pages/Resources";
import { Tag } from "./shared";

// «Схема»: who is connected where and what a request from the LAN passes on
// its way out — DNS redirect, XKeen ipsets, mihomo groups, the Netcraze WAN,
// the MikroTik and its LTE operator (where ТСПУ sits).

export function NetworkScheme({ topo, net }: { topo: Topology | null; net: NetworkPayload | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!topo) return <div className="launcher-loading">Собираю схему…</div>;
  const k = topo.keenetic;
  const mt = topo.mikrotik;
  const wan = net?.keenetic.interfaces?.find((i) => i.wan);
  const lte = mt.system?.interfaces.find((i) => i.type === "lte");
  const sig = mt.signal;
  const groups = topo.mihomo.groups || [];
  const main = groups.filter((g) => g.type === "Selector" && g.size > 1 && !/^(QUIC|OLCRTC|Tailscale)$/i.test(g.name));
  const pveSegment = topo.proxmox?.ip ? k.segments.find((s) => sameNet(s.cidr, topo.proxmox!.ip)) : undefined;

  return (
    <div className="net-stack">
      <p className="muted net-lead">
        Запрос клиента идёт слева направо. У каждого узла — что с трафиком там происходит. Анализатор рисует тот же путь для конкретного сайта и отмечает шаг, где его режут.
      </p>
      <div className="net-scheme">
        {/* LAN */}
        <div className="net-col">
          <ColTitle icon="home" title="Домашние сети" sub={`${k.segments.reduce((s, x) => s + x.active, 0)} активных устройств`} />
          {k.segments.map((seg) => (
            <SegmentCard
              key={seg.id}
              seg={seg}
              open={open === seg.id}
              onToggle={() => setOpen(open === seg.id ? null : seg.id)}
              mesh={seg.id === "Bridge0" ? topo.mesh : []}
              proxmox={pveSegment?.id === seg.id ? topo.proxmox : undefined}
              routes={k.routes.filter((r) => sameNet(seg.cidr, r.via))}
            />
          ))}
        </div>

        <Arrow label={wan ? `↓ ${formatBps(wan.rx_bps)} · ↑ ${formatBps(wan.tx_bps)}` : ""} />

        {/* Netcraze */}
        <div className="net-col net-col-main">
          <ColTitle icon="route" title={`Netcraze ${k.model || ""}`} sub={`192.168.1.1 · прошивка ${k.firmware || "—"}`} />
          <Stage icon="dns" title="DNS" tone="info">
            Запросы клиентов к 192.168.1.1:53 уходят в mihomo :1053 ({k.segments.filter((s) => s.dns_to_mihomo).map((s) => s.name).join(", ") || "ни одна сеть"}). Дальше mihomo спрашивает{" "}
            <span className="mono">{(topo.mihomo.nameservers || []).join(", ") || "—"}</span> обычным UDP — через оператора, без шифрования.
          </Stage>
          <Stage icon="layers" title="XKeen · iptables" tone="info">
            TCP и UDP клиентов перенаправляются в mihomo. Мимо прокси идут: локальные сети, IP из списков исключений
            (geo {fmtCount(topo.xkeen.geo_exclude)}, свои {fmtCount(topo.xkeen.user_exclude)}, внешние {fmtCount(topo.xkeen.ext_exclude)}) и
            устройства из списка MAC-исключений ({topo.xkeen.deny_mac}).
          </Stage>
          <Stage icon="bolt" title={`mihomo ${topo.mihomo.version || ""}`} tone={topo.mihomo.error ? "critical" : "info"}>
            {topo.mihomo.error ? (
              <>Контроллер недоступен: {topo.mihomo.error}</>
            ) : (
              <>
                Режим <b>{topo.mihomo.mode || "—"}</b>: правило выбирает группу, группа — узел.
                <ul className="net-groups">
                  {main.map((g) => (
                    <li key={g.name}>
                      <span>{g.name}</span>
                      <Icon name="external" size={11} />
                      <span className={g.leaf === "DIRECT" ? "net-direct" : ""} title={g.now !== g.leaf ? `${g.now} → ${g.leaf}` : g.now}>
                        {g.leaf === "DIRECT" ? "напрямую" : g.leaf}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Stage>
          <Stage icon="globe" title="WAN" tone="neutral">
            {k.wan.name || "Ethernet"} · <span className="mono">{k.wan.ip || "—"}</span> → шлюз 192.168.188.1. Свой трафик mihomo помечает меткой 255 и выпускает мимо XKeen.
          </Stage>
        </div>

        <Arrow label={lte ? `↓ ${formatBps(lte.rx_bps)} · ↑ ${formatBps(lte.tx_bps)}` : ""} />

        {/* MikroTik */}
        <div className="net-col">
          <ColTitle icon="activity" title={`MikroTik ${mt.system?.board || ""}`} sub={`192.168.188.1${mt.system ? ` · RouterOS ${mt.system.version}` : ""}`} />
          {mt.error ? <Alert tone="warning" title="MikroTik">{mt.error}</Alert> : null}
          <Stage icon="bolt" title="LTE-модем" tone={sig?.status === "running" ? "good" : "warning"}>
            {sig ? (
              <>
                {sig.operator || "оператор"} · {sig.band || "—"} · качество {sig.quality}%
                <br />
                RSRP {sig.rsrp} · SINR {sig.sinr}
              </>
            ) : (
              "нет данных сигнала"
            )}
          </Stage>
          <Stage icon="dns" title="DNS MikroTik" tone="neutral">
            Серверы оператора: <span className="mono">{(mt.system?.dns_servers || []).join(", ") || "—"}</span>
          </Stage>
          <Stage icon="route" title="NAT" tone="neutral">
            Весь трафик Netcraze и прокси-туннели уходят в LTE без изменений.
          </Stage>
        </div>

        <Arrow label="" />

        {/* Operator & internet */}
        <div className="net-col">
          <ColTitle icon="globe" title={sig?.operator ? `Оператор ${sig.operator}` : "Оператор LTE"} sub="мобильный интернет" />
          <Stage icon="lock" title="ТСПУ" tone="warning">
            Видит каждый пакет. Режет по имени сайта (SNI), по IP, подменяет DNS, глушит зарубежные хостинги после 16–20 КБ. Прокси-туннель для него — один зашифрованный поток к VPN-узлу.
          </Stage>
          <Stage icon="globe" title="Интернет" tone="good">
            Сайты напрямую — то, что пропустил ТСПУ.
          </Stage>
          <Stage icon="external" title="VPN-узлы" tone="info">
            {main
              .map((g) => g.leaf)
              .filter((v, i, a) => v !== "DIRECT" && v !== "REJECT" && a.indexOf(v) === i)
              .join(" · ") || "—"}
            <br />
            <span className="muted">дальше сайт открывается уже из другой страны</span>
          </Stage>
        </div>
      </div>
    </div>
  );
}

function fmtCount(n: number) {
  return n < 0 ? "—" : String(n);
}

function sameNet(cidr: string, ip: string) {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw || 24);
  const toInt = (v: string) => v.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  if (!base || !ip) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(base) & mask) === (toInt(ip) & mask);
}

function ColTitle({ icon, title, sub }: { icon: IconName; title: string; sub: string }) {
  return (
    <header className="net-col-head">
      <span className="net-col-icon">
        <Icon name={icon} size={18} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{sub}</p>
      </div>
    </header>
  );
}

function Stage({ icon, title, tone, children }: { icon: IconName; title: string; tone: "good" | "warning" | "critical" | "info" | "neutral"; children: React.ReactNode }) {
  return (
    <div className={`net-stage net-stage-${tone}`}>
      <div className="net-stage-head">
        <Icon name={icon} size={14} />
        <b>{title}</b>
      </div>
      <div className="net-stage-body">{children}</div>
    </div>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="net-arrow" aria-hidden="true">
      <span className="net-arrow-line" />
      {label ? <span className="net-arrow-label">{label}</span> : null}
    </div>
  );
}

function SegmentCard({
  seg,
  open,
  onToggle,
  mesh,
  proxmox,
  routes,
}: {
  seg: TopoSegment;
  open: boolean;
  onToggle: () => void;
  mesh: Topology["mesh"];
  proxmox?: Topology["proxmox"];
  routes: Array<{ dst: string; via: string }>;
}) {
  const bypass = seg.hosts.filter((h) => h.bypass).length;
  return (
    <div className="net-seg">
      <button type="button" className="net-seg-head" onClick={onToggle} aria-expanded={open}>
        <span>
          <b>{seg.name}</b>
          <span className="mono muted"> {seg.cidr}</span>
        </span>
        <span className="net-seg-count">{seg.active}</span>
      </button>
      <div className="net-seg-tags">
        {seg.dns_to_mihomo ? <Tag tone="info">DNS → mihomo</Tag> : <Tag tone="neutral">DNS роутера</Tag>}
        {bypass ? <Tag tone="warning">{bypass} мимо прокси</Tag> : null}
      </div>
      {mesh.length ? (
        <div className="net-seg-sub">
          Mesh: {mesh.map((n) => `${n.name} (${n.ip}, ${n.uplink_wifi ? "Wi-Fi" : "кабель"})`).join(" · ")}
        </div>
      ) : null}
      {proxmox ? (
        <div className="net-seg-sub">
          Proxmox {proxmox.nodes.join(", ")} ({proxmox.ip}): запущено {proxmox.guests_running} из {proxmox.guests} ВМ
        </div>
      ) : null}
      {routes.map((r) => (
        <div key={r.dst} className="net-seg-sub">
          Сеть <span className="mono">{r.dst}</span> через <span className="mono">{r.via}</span>
        </div>
      ))}
      {open ? (
        <ul className="net-hosts">
          {seg.hosts.map((h) => (
            <li key={h.ip + h.name}>
              <Icon name={h.link === "wifi" ? "activity" : "route"} size={12} />
              <span className="net-host-name">{h.name}</span>
              <span className="mono muted">{h.ip}</span>
              {h.mesh ? <span className="badge">mesh</span> : null}
              {h.bypass ? <span className="badge badge-warning">мимо прокси</span> : null}
            </li>
          ))}
          {seg.hosts.length === 0 ? <li className="muted">активных устройств нет</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
