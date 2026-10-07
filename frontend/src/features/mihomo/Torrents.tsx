import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { NodeName } from "../../components/ui/Flag";
import { errText } from "../../lib/format";
import { core, mihomo, type CoreDevice, type MProvider, type MProxy, type RoutingSettings, type TorrentRecord, type TorrentStep, type TorrentsReport } from "./api";
import { PathChain, pathOf } from "./Nodes";
import { useExits } from "./useExits";

/*
 * VPN → «Торренты» (NPM-60): a group of their own, switched by hand —
 * direct, through bypass nodes, any node — and the check of where one can
 * download at all: through each node an HTTP tracker, a UDP tracker and the
 * DHT (the core's /torrent, MIHOMO-17).
 */

const GROUP = "Торренты";
type Verdict = "ok" | "tcp" | "part" | "bad" | "none";
type Filter = "all" | Verdict;
const VERDICT: Record<Verdict, { label: string; tone: string }> = {
  ok: { label: "можно качать", tone: "ok" },
  tcp: { label: "только TCP: без DHT", tone: "warn" },
  part: { label: "частично", tone: "warn" },
  bad: { label: "нельзя", tone: "bad" },
  none: { label: "не проверен", tone: "idle" },
};
const when = (t?: number) => (t ? new Date(t * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

function verdictOf(r?: TorrentRecord): Verdict {
  if (!r) return "none";
  if (r.err) return "bad";
  const ok = [r.http.ok, r.udpTracker.ok, r.dht.ok];
  if (ok.every(Boolean)) return "ok";
  if (!r.udp && r.http.ok) return "tcp";
  if (ok.some(Boolean)) return "part";
  return "bad";
}

function Step({ s, udp }: { s?: TorrentStep; udp?: boolean }) {
  if (!s) return <span className="tr-step is-none">—</span>;
  if (s.ok) return <span className="tr-step is-ok" title={s.target}>✓ {s.ms} мс</span>;
  return (
    <span className="tr-step is-bad" title={[s.target, s.error].filter(Boolean).join(" · ")}>
      ✗ {udp === false ? "нет UDP" : s.error === "context deadline exceeded" ? "нет ответа" : s.error || "нет"}
    </span>
  );
}

export function Torrents() {
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [rep, setRep] = useState<TorrentsReport>({ nodes: {} });
  const [routing, setRouting] = useState<{ settings: RoutingSettings; sha?: string } | null>(null);
  const [devices, setDevices] = useState<CoreDevice[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [prov, setProv] = useState("");
  const [q, setQ] = useState("");
  const [editDevs, setEditDevs] = useState<string[] | null>(null);
  const { exits } = useExits();

  const pull = useCallback(() => {
    void mihomo
      .allProxies()
      .then((r) => {
        setProviders(r.providers);
        setProxies(r.proxies);
      })
      .catch((e) => setErr(errText(e)));
    void core
      .torrents()
      .then((r) => setRep({ ...r, nodes: r.nodes || {} }))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    pull();
    void core
      .routing()
      .then((r) => setRouting({ settings: r.settings, sha: r.sha }))
      .catch(() => undefined);
    void core
      .devices()
      .then((r) => setDevices(r.devices || []))
      .catch(() => undefined);
  }, [pull]);
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && pull(), rep.running ? 2000 : 30000);
    return () => clearInterval(t);
  }, [pull, rep.running]);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setErr("");
    setMsg("");
    try {
      await fn();
      if (done) setMsg(done);
      pull();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  const group = proxies[GROUP];
  const members = new Set(group?.all || []);
  const settings = routing?.settings;
  const applyTorrents = (on: boolean, devs: string[]) =>
    run(
      "apply",
      async () => {
        if (!routing?.sha || !settings) throw new Error("настройки маршрутизации ещё не загрузились");
        const r = await core.applyRouting({ sha: routing.sha, settings: { ...settings, torrents: on, torrent_devices: devs } });
        const fresh = await core.routing();
        setRouting({ settings: fresh.settings, sha: fresh.sha });
        setEditDevs(null);
        return r;
      },
      on ? "Группа «Торренты» и её правила применены" : "Группа «Торренты» убрана",
    );

  const nodes = useMemo(() => {
    const out: Array<{ name: string; provider: string }> = [{ name: "DIRECT", provider: "" }];
    Object.values(providers)
      .filter((p) => p.vehicleType !== "Compatible")
      .forEach((p) => p.proxies.forEach((x) => out.push({ name: x.name, provider: p.name })));
    Object.values(proxies)
      .filter((x) => x.type.toLowerCase() === "tailscale")
      .forEach((x) => out.push({ name: x.name, provider: "" }));
    return out;
  }, [providers, proxies]);
  const counts: Record<Filter, number> = { all: nodes.length, ok: 0, tcp: 0, part: 0, bad: 0, none: 0 };
  nodes.forEach((n) => counts[verdictOf(rep.nodes[n.name])]++);
  const query = q.trim().toLowerCase();
  const rank: Record<Verdict, number> = { ok: 0, tcp: 1, part: 2, none: 3, bad: 4 };
  const rows = nodes
    .filter((n) => (filter === "all" || verdictOf(rep.nodes[n.name]) === filter) && (!prov || n.provider === prov || n.name === "DIRECT") && (!query || n.name.toLowerCase().includes(query)))
    .sort((a, b) => Number(b.name === "DIRECT") - Number(a.name === "DIRECT") || rank[verdictOf(rep.nodes[a.name])] - rank[verdictOf(rep.nodes[b.name])]);
  const provs = [...new Set(nodes.map((n) => n.provider).filter(Boolean))];
  const lastCheck = Math.max(0, ...Object.values(rep.nodes).map((r) => r.t || 0));
  const devName = (ip: string) => devices.find((d) => d.ip === ip)?.name || ip;
  const quick = ["DIRECT", "Обходы", "AUTO", "ALL", "OLCRTC", "Tailscale"].filter((n) => members.has(n));

  return (
    <div className="stack vn">
      <PageHeader
        page="torrents"
        actions={
          <button type="button" className="btn btn-primary" disabled={!!rep.running || busy === "check"} onClick={() => void run("check", () => core.torrentsCheck(prov ? { provider: prov } : {}))}>
            <Icon name="bolt" size={14} /> {rep.running ? `Проверяю: ${rep.done || 0} из ${rep.total || 0}` : prov ? `Проверить ${prov}` : "Проверить все узлы"}
          </button>
        }
      />
      {err ? <p className="vn-err">{err}</p> : null}
      {msg ? <p className="su-ok">{msg}</p> : null}

      <section className="tr-now" aria-label="Куда идут торренты">
        {group ? (
          <>
            <div className="tr-now-head">
              <span className="vn-card-name">
                <span className="vn-eyebrow">Торренты идут сейчас</span>
                <b className="tr-path">
                  <PathChain path={pathOf(GROUP, proxies)} proxies={proxies} />
                </b>
              </span>
              <span className={`vn-pill vn-${verdictOf(rep.nodes[group.now || ""]) === "ok" ? "ok" : verdictOf(rep.nodes[group.now || ""]) === "none" ? "idle" : "warn"}`}>
                {group.now && rep.nodes[group.now] ? VERDICT[verdictOf(rep.nodes[group.now])].label : "выбор не проверен"}
              </span>
            </div>
            <div className="vn-chips" role="group" aria-label="Куда пустить торренты">
              {quick.map((n) => (
                <button key={n} type="button" className={`vn-chip${group.now === n ? " is-on" : ""}`} aria-pressed={group.now === n} disabled={busy === `sel:${n}`} onClick={() => void run(`sel:${n}`, () => mihomo.select(GROUP, n), `Торренты идут через ${n === "DIRECT" ? "провайдера напрямую" : n}`)}>
                  {n === "DIRECT" ? "Напрямую" : n === "Обходы" ? "Через обходы" : n}
                </button>
              ))}
              <span className="tr-hint">или узел из списка ниже — «Сюда»</span>
            </div>
            <div className="tr-rules">
              <span>
                <b>Что попадает в группу:</b> публичные трекеры (geosite), порты BitTorrent 6881–6999 и 51413
                {settings?.torrent_devices?.length ? <>, а также всё, кроме сайтов, с устройств: {settings.torrent_devices.map(devName).join(", ")}</> : null}.
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setEditDevs(editDevs ? null : settings?.torrent_devices || [])}>
                {editDevs ? "Отмена" : "Устройства-качалки"}
              </button>
            </div>
          </>
        ) : (
          <div className="tr-off">
            <span>
              <b>Группы «Торренты» пока нет.</b>
              <small>
                HomeNet добавит ручную группу (сначала «напрямую», дальше обходы, AUTO и любой узел подписки) и правила: публичные трекеры и порты BitTorrent. Конфиг проверяется mihomo -t, старый сохраняется копией.
              </small>
            </span>
            <button type="button" className="btn btn-primary" disabled={busy === "apply" || !routing} onClick={() => void applyTorrents(true, settings?.torrent_devices || [])}>
              {busy === "apply" ? "Применяю…" : "Добавить группу"}
            </button>
          </div>
        )}
        {editDevs ? (
          <div className="tr-devs">
            <small className="mh-muted">С отмеченных устройств в группу пойдёт всё, кроме сайтов (порты 80 и 443): так ловятся раздачи на любых портах. Отмечайте то, что качает — NAS, медиасервер.</small>
            <div className="tr-devlist">
              {devices
                .filter((d) => d.ip)
                .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
                .map((d) => (
                  <label key={d.ip} className="tr-dev">
                    <input type="checkbox" checked={editDevs.includes(d.ip)} onChange={(e) => setEditDevs(e.target.checked ? [...editDevs, d.ip] : editDevs.filter((x) => x !== d.ip))} />
                    <span className="truncate">{d.name}</span>
                    <small className="mono">{d.ip}</small>
                  </label>
                ))}
            </div>
            <div className="nx-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy === "apply"} onClick={() => void applyTorrents(true, editDevs)}>
                {busy === "apply" ? "Применяю…" : "Применить"}
              </button>
              {group ? (
                <button type="button" className="btn btn-sm" disabled={busy === "apply"} onClick={() => window.confirm("Убрать группу «Торренты» и её правила?") && void applyTorrents(false, [])}>
                  Убрать группу
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="su-block" aria-label="Где можно качать">
        <div className="vn-section-head">
          <h3>
            Где можно качать <span>· через каждый узел: HTTP-трекер, UDP-трекер и DHT</span>
          </h3>
        </div>
        <div className="hub-filters">
          <label className="sr-only" htmlFor="tr-q">
            Найти узел
          </label>
          <input id="tr-q" className="input" placeholder="Узел" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="sr-only" htmlFor="tr-prov">
            Подписка
          </label>
          <select id="tr-prov" className="input tr-prov" value={prov} onChange={(e) => setProv(e.target.value)}>
            <option value="">все подписки</option>
            {provs.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {(["all", "ok", "tcp", "part", "bad", "none"] as Filter[]).map((k) => (
            <button key={k} type="button" className={`vn-chip${filter === k ? " is-on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {k === "all" ? "Все" : VERDICT[k].label} <span className="vs-count">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="tr-table" role="table" aria-label="Торренты через узлы">
          <div className="tr-row tr-head" role="row">
            <span role="columnheader">Узел</span>
            <span role="columnheader">HTTP-трекер</span>
            <span role="columnheader">UDP-трекер</span>
            <span role="columnheader">DHT</span>
            <span role="columnheader">Итог</span>
            <span role="columnheader" />
          </div>
          {rows.slice(0, 300).map((n) => {
            const r = rep.nodes[n.name];
            const v = verdictOf(r);
            const canPick = !!group && members.has(n.name);
            return (
              <div key={n.name} role="row" className={`tr-row${group?.now === n.name ? " is-now" : ""}`}>
                <span role="cell" className="tr-node">
                  {n.name === "DIRECT" ? <b>Напрямую, через провайдера</b> : <NodeName name={n.name} cc={exits.nodes[n.name]?.cc} />}
                  <small>{n.provider || (n.name === "DIRECT" ? "без VPN" : "свой узел")}</small>
                </span>
                <span role="cell">
                  <Step s={r?.http} />
                </span>
                <span role="cell">
                  <Step s={r?.udpTracker} udp={r?.udp} />
                </span>
                <span role="cell">
                  <Step s={r?.dht} udp={r?.udp} />
                </span>
                <span role="cell">
                  <span className={`vn-pill vn-${VERDICT[v].tone}`} title={r?.err || (r ? `проверено ${when(r.t)}` : undefined)}>
                    {r?.err ? "не ответил" : VERDICT[v].label}
                  </span>
                </span>
                <span role="cell" className="tr-act">
                  {group?.now === n.name ? (
                    <span className="vn-pill vn-ok">сейчас</span>
                  ) : canPick ? (
                    <button type="button" className="btn btn-sm" disabled={busy === `sel:${n.name}`} onClick={() => void run(`sel:${n.name}`, () => mihomo.select(GROUP, n.name), `Торренты идут через ${n.name === "DIRECT" ? "провайдера напрямую" : n.name}`)}>
                      Сюда
                    </button>
                  ) : (
                    <button type="button" className="btn btn-sm" disabled={!!rep.running} onClick={() => void run("check", () => core.torrentsCheck({ nodes: [n.name] }))}>
                      Проверить
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          {!rows.length ? <p className="mh-muted hub-empty">Под фильтр ничего не попало.</p> : null}
        </div>
        <small className="mh-muted">
          Проверка показывает, пропускает ли узел трекеры и DHT. Сами раздачи провайдер узла может резать по содержимому — это видно только по скачиванию. Узлы без UDP (например, OLCRTC) работают лишь с HTTP-трекерами.
          {lastCheck ? ` Последняя проверка — ${when(lastCheck)}.` : " Узлы ещё не проверялись."}
        </small>
      </section>
    </div>
  );
}
