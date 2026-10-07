import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { errText } from "../../lib/format";
import { Flag, FlagText, NodeName } from "../../components/ui/Flag";
import { countryName } from "../../lib/flags";
import { core, mihomo, type MProvider, type MProxy, type OlcCheck, type OlcJob, type OlcReport, type OlcStep, type OlcVariant } from "./api";
import { useExits } from "./useExits";
import { OlcrtcTab } from "./Extras";
import { useNodePrefs } from "./NodeTiles";

/*
 * VPN → «OLCRTC» (NPM-56): servers and their variants of the link (a Jitsi
 * instance × a transport), the background pick that moves the OLCRTC group to
 * a working variant, and setting up an own server over SSH step by step — or
 * by hand. Design: https://claude.ai/artifact/8w7GwGhKrK96ePPxL166SG (v2 of NPM-59:
 * the route now, servers with their exit country, variants by call service,
 * the setup in a side panel)
 */

type Mode = "auto" | "manual";
const NO_SERVER = "";
const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const ago = (t: number) => {
  const s = Date.now() / 1000 - t;
  return s < 90 ? "только что" : s < 3600 ? `${Math.round(s / 60)} мин назад` : s < 86400 ? `${Math.round(s / 3600)} ч назад` : new Date(t * 1000).toLocaleDateString("ru-RU");
};
const host = (room?: string) => {
  try {
    return room ? new URL(room.includes("://") ? room : `https://${room}`).host : "";
  } catch {
    return room || "";
  }
};

type NodeCfg = { name: string; "auth-provider"?: string; transport?: string; "room-id"?: string };

const PLATFORMS: Array<{ id: string; label: string; note: string; empty: string }> = [
  { id: "jitsi", label: "Jitsi", note: "публичные Jitsi из списка и свои · datachannel — самый быстрый", empty: "Вариантов на Jitsi нет." },
  { id: "telemost", label: "Яндекс Телемост", note: "в белых списках · комнату создаёте вы · vp8channel, videochannel", empty: "Телемоста пока нет. Создайте встречу на telemost.yandex.ru и добавьте ссылку в «Изменить варианты» — сервер зайдёт в неё сам." },
  { id: "wbstream", label: "WB Stream", note: "комнату создаёте вы · vp8channel, seichannel, videochannel", empty: "WB Stream пока нет. Создайте комнату на stream.wb.ru и добавьте ссылку в «Изменить варианты»." },
];
const platformOf = (p?: string) => (p === "telemost" || p === "wbstream" ? p : "jitsi");
const platformLabel = (p?: string) => PLATFORMS.find((x) => x.id === platformOf(p))?.label || "Jitsi";
const channelText = (c?: string) => (c === "whitelist" ? "белые списки" : c === "normal" ? "без ограничений" : c === "offline" ? "без интернета" : "не определён");

export function OlcrtcView({ providers, proxies, groups, onReload }: { providers: MProvider[]; proxies: Record<string, MProxy>; groups: MProxy[]; onReload: () => Promise<void> }) {
  const prefs = useNodePrefs();
  const { exits } = useExits();
  const [rep, setRep] = useState<OlcReport | null>(null);
  const [cfg, setCfg] = useState<NodeCfg[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [srv, setSrv] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [reconf, setReconf] = useState<string | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const pull = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([core.olcrtc(), mihomo.providerProxies("olcrtc").catch(() => ({ proxies: [] }))]);
      setRep({ ...r, servers: (r.servers || []).map((x) => ({ ...x, variants: x.variants || [] })), events: r.events || [], checks: r.checks || {}, instances: r.instances || [], transports: r.transports || [] });
      setCfg((p.proxies || []) as NodeCfg[]);
      setErr("");
    } catch (e) {
      setErr(errText(e));
    }
  }, []);
  const running = !!rep?.job?.running;
  useEffect(() => {
    void pull();
    const t = setInterval(() => document.visibilityState === "visible" && void pull(), running ? 1500 : 15000);
    return () => clearInterval(t);
  }, [pull, running]);
  useEffect(() => {
    if (running && rep?.job?.kind === "setup") setDrawer(true);
  }, [running, rep?.job?.kind]);

  const act = async (action: Parameters<typeof core.olcrtcDo>[0], body: Record<string, unknown>, key: string = action) => {
    setBusy(key);
    setErr("");
    try {
      const r = await core.olcrtcDo(action, body);
      setRep({ ...r, servers: (r.servers || []).map((x) => ({ ...x, variants: x.variants || [] })), events: r.events || [], checks: r.checks || {}, instances: r.instances || [], transports: r.transports || [] });
      await onReload();
      void pull();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  const olcNodes = providers.flatMap((p) => p.proxies.filter((x) => x.type.toLowerCase() === "olcrtc").map((x) => x.name));
  const inCore = new Set(olcNodes);
  const owned = new Map<string, string>();
  (rep?.servers || []).forEach((s) => s.variants.forEach((v) => owned.set(v.node, s.id)));
  const own = rep?.servers || [];
  const loose = olcNodes.filter((n) => !owned.has(n));
  const curId = srv ?? (own.find((s) => s.variants.some((v) => v.node === rep?.selected))?.id || (loose.includes(rep?.selected || "") ? NO_SERVER : own[0]?.id ?? NO_SERVER));
  const cur = own.find((s) => s.id === curId);
  const reconfServer = cur && reconf === cur.id ? cur : undefined;
  const check = (n: string): OlcCheck | undefined => rep?.checks[n];
  const cfgOf = (n: string) => cfg.find((c) => c.name === n);
  const variantOf = (n: string) => own.flatMap((s) => s.variants).find((v) => v.node === n);
  const serverOf = (n: string) => own.find((s) => s.variants.some((v) => v.node === n));
  const ccOf = (n: string) => serverOf(n)?.country || exits.nodes[n]?.cc || "";

  // what OLCRTC goes through right now: home → call service → server → internet
  const sel = rep?.selected || "";
  const selV = variantOf(sel);
  const selSrv = serverOf(sel);
  const selC = check(sel);
  const selRoom = selV?.room || cfgOf(sel)?.["room-id"];
  const selCC = ccOf(sel);
  const selExit = exits.nodes[sel];
  const okNow = !!selC?.ok;

  const rows = cur
    ? cur.variants.map((v) => ({ node: v.node, platform: platformOf(v.provider), room: v.room, transport: v.transport, v, missing: !inCore.has(v.node) && !v.external }))
    : loose.map((n) => ({ node: n, platform: platformOf(cfgOf(n)?.["auth-provider"]), room: cfgOf(n)?.["room-id"] || "", transport: cfgOf(n)?.transport || "", v: undefined as OlcVariant | undefined, missing: false }));
  const okCount = (nodes: string[]) => nodes.filter((n) => check(n)?.ok).length;

  return (
    <div className="stack ol">
      <div className="ol-head">
        <p className="mh-muted">Туннель внутри видеозвонка. Площадка звонка должна открываться из дома без VPN — тогда это настоящий запасной путь, когда белые списки режут всё остальное.</p>
        <div className="nx-actions">
          <button type="button" className="btn btn-sm" disabled={busy === "check-all" || !olcNodes.length} onClick={() => void act("check", {}, "check-all")}>
            <Icon name="bolt" size={13} /> {busy === "check-all" ? "Проверяю…" : "Проверить все варианты"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              setPreset(null);
              setDrawer(true);
            }}
          >
            <Icon name="plus" size={13} /> Свой сервер
          </button>
        </div>
      </div>
      {err ? <p className="vn-err">{err}</p> : null}

      <section className={`ol-now${sel ? (okNow ? " is-ok" : " is-bad") : ""}`} aria-label="Сейчас">
        <div className="ol-now-top">
          <span className="ol-now-tag">
            <i />
            {!sel ? "Узел не выбран" : okNow ? "Работает · группа OLCRTC" : "Основной не отвечает"}
          </span>
          <span className="ol-now-auto">
            <span>Автоподбор</span>
            <button type="button" className={`ol-switch${rep?.auto ? " is-on" : ""}`} role="switch" aria-checked={!!rep?.auto} aria-label="Автоподбор" disabled={!rep || busy === "auto"} onClick={() => void act("auto", { auto: !rep?.auto })}>
              <i />
            </button>
          </span>
        </div>
        <h3 className="ol-now-title">
          {!sel ? "Выберите вариант основным или настройте свой сервер" : okNow ? `Сейчас через ${host(selRoom) || sel} · ${selC?.ms} мс` : rep?.auto ? "Автоподбор ищет рабочий вариант…" : "Основной не отвечает, автоподбор выключен"}
        </h3>
        {sel ? (
          <div className="ol-hops">
            <div className="ol-hop">
              <small>Дом</small>
              <b>Роутер</b>
              <span>канал: {channelText(rep?.channel)}</span>
              <em className="is-ok">сокеты мимо правил</em>
            </div>
            <div className="ol-hop">
              <small>Площадка звонка</small>
              <b className="truncate">{host(selRoom) || "—"}</b>
              <span>
                {platformLabel(selV?.provider || cfgOf(sel)?.["auth-provider"])} · {selV?.transport || cfgOf(sel)?.transport || "—"}
              </span>
              <em className={okNow ? "is-ok" : "is-bad"}>{okNow ? "открывается напрямую" : selC?.error || "не отвечает"}</em>
            </div>
            <div className="ol-hop">
              <small>Сервер</small>
              <b className="node-name">
                {selCC ? <Flag cc={selCC} /> : null}
                <span className="truncate">{selSrv?.name || "чужой сервер"}</span>
              </b>
              <span className="mono truncate">{selSrv ? selSrv.host : "из файла olcrtc"}</span>
              <em>{selV?.unit ? `olcrtc@${selV.transport}` : selV?.external ? "контейнер srv.sh" : "узел вручную"}</em>
            </div>
            <div className="ol-hop">
              <small>Выход в интернет</small>
              <b className="node-name">
                {selCC ? <Flag cc={selCC} /> : <Flag />}
                <span className="truncate">{selCC ? countryName(selCC) : "не проверен"}</span>
              </b>
              <span className="truncate">{[selSrv?.city || selExit?.city, selSrv?.exit_ip || selExit?.ip].filter(Boolean).join(" · ") || "—"}</span>
              <em>{selSrv?.country_at ? `проверено ${ago(selSrv.country_at)}` : selExit?.t ? `проверено ${ago(selExit.t)}` : "проверится сам"}</em>
            </div>
          </div>
        ) : null}
      </section>

      <div className="vn-section-head">
        <h3>
          Серверы <span>· флаг — по стране выхода, проверяется через туннель</span>
        </h3>
      </div>
      <div className="ol-servers">
        {own.map((s) => {
          const nodes = s.variants.map((v) => v.node);
          const ok = okCount(nodes);
          const on = curId === s.id;
          return (
            <div key={s.id} className={`ol-server${on ? " is-sel" : ""}`}>
              <button type="button" className="ol-server-pick" aria-pressed={on} onClick={() => setSrv(s.id)}>
                <span className="ol-server-top">
                  <span className="vn-card-name">
                    <b className="node-name">
                      {s.country ? <Flag cc={s.country} /> : <Flag />}
                      <span className="truncate">{s.name}</span>
                    </b>
                    <small className="mono truncate">
                      {s.host}
                      {s.port !== 22 ? `:${s.port}` : ""} · ssh {s.user}
                      {s.arch ? ` · ${s.arch}` : ""}
                    </small>
                  </span>
                  <span className={`vn-pill vn-${s.mode === "normal" ? "idle" : "ok"}`}>{s.mode === "normal" ? "обычный режим" : "для белых списков"}</span>
                </span>
                <span className="ol-server-stats">
                  <span>
                    <small>Выход</small>
                    <b className="truncate">{s.country ? countryName(s.country) : "не проверен"}</b>
                    <em className="truncate">{s.city || ""}</em>
                  </span>
                  <span>
                    <small>Варианты</small>
                    <b>
                      {ok} из {nodes.length}
                    </b>
                    <em>работают</em>
                  </span>
                  <span>
                    <small>Связь</small>
                    <b>{nodes.includes(sel) ? (okNow ? "используется" : "переключается") : ok ? "запасной" : "молчит"}</b>
                    <em>{nodes.some((n) => !inCore.has(n)) ? "есть потерянный узел" : ""}</em>
                  </span>
                </span>
                <span className="ol-bars" aria-hidden="true">
                  {nodes.map((n) => (
                    <i key={n} className={`ol-bar is-${!check(n) ? "none" : check(n)!.ok ? "ok" : "bad"}`} />
                  ))}
                </span>
              </button>
              <span className="ol-server-acts">
                <button type="button" className={`btn btn-sm${reconf === s.id ? " btn-primary" : ""}`} aria-expanded={reconf === s.id} onClick={() => (setSrv(s.id), setReconf(reconf === s.id ? null : s.id))}>
                  <Icon name="edit" size={13} /> Изменить варианты
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={running}
                  onClick={() => {
                    setPreset({ name: s.name, host: s.host, port: s.port, user: s.user, mode: s.mode });
                    setDrawer(true);
                  }}
                >
                  Переустановить
                </button>
                <button
                  type="button"
                  className="btn btn-sm ol-danger"
                  disabled={running || busy === "remove"}
                  onClick={() => {
                    if (window.confirm(`Убрать «${s.name}» из HomeNet? Его узлы уйдут из olcrtc, службы на сервере остановятся.`)) void act("remove", { id: s.id }, "remove").then(() => setSrv(null));
                  }}
                >
                  Убрать
                </button>
              </span>
            </div>
          );
        })}
        {loose.length ? (
          <div className={`ol-server${curId === NO_SERVER ? " is-sel" : ""}`}>
            <button type="button" className="ol-server-pick" aria-pressed={curId === NO_SERVER} onClick={() => setSrv(NO_SERVER)}>
              <span className="ol-server-top">
                <span className="vn-card-name">
                  <b>Без своего сервера</b>
                  <small>узлы из файла olcrtc и подписок</small>
                </span>
                <span className="vn-pill vn-idle">{loose.includes(sel) ? "используется" : "запас"}</span>
              </span>
              <span className="ol-bars" aria-hidden="true">
                {loose.map((n) => (
                  <i key={n} className={`ol-bar is-${!check(n) ? "none" : check(n)!.ok ? "ok" : "bad"}`} />
                ))}
              </span>
              <span className="vn-card-foot">
                <span>
                  {okCount(loose)} из {loose.length} работают
                </span>
              </span>
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="ol-server ol-server-add"
          onClick={() => {
            setPreset(null);
            setDrawer(true);
          }}
        >
          <Icon name="plus" size={18} />
          <b>Добавить сервер</b>
          <small>второй сервер в другой стране — запас, если первый заблокируют</small>
        </button>
      </div>

      {reconfServer ? <Reconfigure key={reconfServer.id} server={reconfServer} rep={rep} busy={busy} act={act} /> : null}

      <div className="ol-layout">
        <section className="ol-variants" aria-label="Варианты связи">
          <div className="vn-section-head">
            <h3>
              Варианты связи · {cur?.name || "без своего сервера"} <span>· по площадкам звонков, кружок — основной</span>
            </h3>
          </div>
          {PLATFORMS.map((pl) => {
            const list = rows.filter((r) => r.platform === pl.id);
            if (!list.length && !cur) return null;
            const ok = okCount(list.map((r) => r.node));
            const open = !closed[pl.id] && (list.length > 0 || pl.id !== "jitsi");
            return (
              <div key={pl.id} className="ol-pgroup">
                <button type="button" className="ol-pgroup-head" aria-expanded={open} onClick={() => setClosed({ ...closed, [pl.id]: open })}>
                  <span className="vn-card-name">
                    <b>{pl.label}</b>
                    <small>{pl.note}</small>
                  </span>
                  <span className={`vn-pill vn-${!list.length ? "idle" : ok === list.length ? "ok" : ok ? "warn" : "bad"}`}>{list.length ? `${ok} из ${list.length} работают` : "нет комнаты"}</span>
                  <Icon name="chevronDown" size={14} />
                </button>
                {open ? (
                  list.length ? (
                    <div className="ol-vlist" role="table" aria-label={pl.label}>
                      {list.map((r) => {
                        const c = check(r.node);
                        const isMain = sel === r.node;
                        return (
                          <div key={r.node} className={`ol-vrow${isMain ? " is-main" : ""}${r.missing ? " is-missing" : ""}`} role="row">
                            <button type="button" role="cell" className={`ol-radio${isMain ? " is-on" : ""}`} aria-label={`Сделать основным: ${r.node}`} disabled={isMain || r.missing || busy === `m:${r.node}`} onClick={() => void act("main", { node: r.node }, `m:${r.node}`)} />
                            <span role="cell" className="ol-vname">
                              <NodeName name={r.node} cc={ccOf(r.node)} />
                              <small className="mono truncate">
                                {host(r.room) || r.room}
                                {r.v?.external ? ` · контейнер srv.sh ${r.v.external}` : ""}
                              </small>
                            </span>
                            <span role="cell" className="nx-hm">
                              <span className="ol-tr mono">{r.transport || "—"}</span>
                            </span>
                            <span role="cell" className="nx-hm ol-wlcell" title={r.v?.wl_at ? `проверено ${ago(r.v.wl_at)}` : undefined}>
                              <i className={`ol-wldot is-${r.v?.wl || "none"}`} />
                              {r.v?.wl === "ok" ? "при белых списках работает" : r.v?.wl === "fail" ? "при белых списках не работает" : "белые списки — не проверен"}
                            </span>
                            <span role="cell" className="ol-vstate">
                              {r.missing ? <span className="vn-pill vn-warn">нет узла</span> : <span className={`vn-pill vn-${c ? (c.ok ? "ok" : "bad") : "idle"}`}>{c ? (c.ok ? `${c.ms} мс` : "не отвечает") : "не проверялся"}</span>}
                              <small>{r.missing ? "mihomo 404" : c ? `${ago(c.t)}${!c.ok && c.error ? ` · ${c.error}` : ""}` : ""}</small>
                            </span>
                            <span role="cell" className="ol-vacts">
                              {r.missing ? (
                                <button type="button" className="btn btn-sm btn-primary" disabled={busy === "tidy"} onClick={() => void act("tidy", {}, "tidy")}>
                                  Вернуть узел
                                </button>
                              ) : (
                                <button type="button" className="btn btn-sm" disabled={busy === `c:${r.node}`} onClick={() => void act("check", { node: r.node }, `c:${r.node}`)}>
                                  {busy === `c:${r.node}` ? "…" : "Проверить"}
                                </button>
                              )}
                            </span>
                            {r.missing ? <p className="ol-vnote">Комната на сервере есть, а узла в файле olcrtc на роутере нет — проверка получает 404. «Вернуть узел» допишет его заново.</p> : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="ol-pempty">
                      <span>{pl.empty}</span>
                      {cur ? (
                        <button type="button" className="btn btn-sm" onClick={() => setReconf(cur.id)}>
                          Изменить варианты
                        </button>
                      ) : null}
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
          {!rows.length && !cur ? <p className="mh-muted">Узлов OLCRTC пока нет — настройте свой сервер или добавьте узел вручную.</p> : null}
          {!cur ? (
            <div className="nx-actions">
              <button type="button" className="btn btn-sm" onClick={() => setEditing(!editing)}>
                <Icon name="edit" size={13} /> {editing ? "Скрыть редактор узлов" : "Изменить узлы вручную"}
              </button>
            </div>
          ) : null}
          {editing && !cur ? <OlcrtcTab providers={providers.filter((p) => p.proxies.some((x) => x.type.toLowerCase() === "olcrtc"))} standalone={Object.values(proxies).filter((x) => x.type.toLowerCase() === "olcrtc" && !olcNodes.includes(x.name))} groups={groups} onReload={async () => (await onReload(), await pull())} prefs={prefs} /> : null}
        </section>

        <aside className="ol-side">
          <section className="vo-panel">
            <h3>Как работает автоподбор</h3>
            <ul className="ol-rules">
              <li>Основной проверяется раз в минуту, все — раз в 10 минут</li>
              <li>После 2 неудач подряд — на следующий рабочий</li>
              <li>При белых списках остаются варианты с отметкой «работает»</li>
              <li>Ни одного рабочего — новые на своём сервере по SSH, не чаще раза в час</li>
              <li>Узел пропал с роутера — возвращается сам</li>
            </ul>
            <small className="mh-muted">{rep?.auto ? "Включён." : "Выключен — переключение только вручную."}</small>
          </section>
          <section className="vo-panel">
            <h3>Что происходило</h3>
            <div className="ol-events">
              {(rep?.events || []).slice(0, 12).map((e, i) => (
                <div key={`${e.t}-${i}`}>
                  <time className="mono">{hhmm(e.t)}</time>
                  <i className={`vn-dot vn-${e.kind === "ok" ? "ok" : e.kind === "warn" ? "warn" : "bad"}`} />
                  <span>
                    <FlagText text={e.text} />
                  </span>
                </div>
              ))}
              {!rep?.events?.length ? <p className="mh-muted">Пока ничего — события появятся здесь.</p> : null}
            </div>
          </section>
        </aside>
      </div>

      {drawer ? (
        <div className="ol-drawer-back" onClick={(e) => e.target === e.currentTarget && !running && setDrawer(false)}>
          <section className="ol-drawer" role="dialog" aria-modal="true" aria-label="Свой сервер OLCRTC">
            <div className="ol-drawer-head">
              <b>{preset ? `Переустановить · ${preset.name}` : "Свой сервер OLCRTC"}</b>
              <button type="button" className="btn btn-sm btn-icon" aria-label="Закрыть" onClick={() => setDrawer(false)}>
                <Icon name="close" size={14} />
              </button>
            </div>
            <Setup rep={rep} busy={busy} act={act} preset={preset} />
          </section>
        </div>
      ) : null}
    </div>
  );
}

const STEP_MARK: Record<OlcStep["status"], string> = { ok: "✓", run: "…", fail: "!", wait: "", skip: "–" };

// what works where, from olcrtc's docs/settings.ru.md
const ROOM_KINDS: Array<{ id: string; label: string; note: string; site: string; hint: string; transports: string[]; steps: string[]; transportNote: string }> = [
  {
    id: "telemost",
    label: "Яндекс Телемост",
    note: "в белом списке; комнату создаёте вы",
    site: "https://telemost.yandex.ru/",
    hint: "https://telemost.yandex.ru/j/…",
    transports: ["vp8channel", "videochannel"],
    steps: ["Откройте telemost.yandex.ru и войдите в Яндекс ID.", "«Создать видеовстречу» и скопируйте ссылку вида https://telemost.yandex.ru/j/…", "Вставьте ссылку ниже. Вкладку со встречей можно закрыть — сервер зайдёт в неё сам."],
    transportNote: "vp8channel — стабильный; videochannel — самый медленный, запасной. datachannel Телемост убрал, seichannel не поддерживает.",
  },
  {
    id: "wbstream",
    label: "WB Stream",
    note: "комнату создаёте вы на stream.wb.ru",
    site: "https://stream.wb.ru/",
    hint: "ссылка на комнату или её ID",
    transports: ["vp8channel", "seichannel", "videochannel"],
    steps: ["Откройте stream.wb.ru и войдите.", "Создайте комнату и скопируйте её ссылку или ID.", "Вставьте ниже и выберите транспорт."],
    transportNote: "vp8channel — рекомендуется; seichannel медленнее, но с меньшим пингом; videochannel — самый медленный, запасной. datachannel у гостей WB Stream не передаёт данные, поэтому его нет.",
  },
  {
    id: "jitsi",
    label: "Свой Jitsi",
    note: "любой Jitsi Meet, которого нет в списке",
    site: "",
    hint: "https://ваш-jitsi/имя-комнаты",
    transports: ["datachannel", "vp8channel", "seichannel", "videochannel"],
    steps: ["Укажите адрес Jitsi Meet и любое имя комнаты: https://host/имя.", "Проверьте, что адрес открывается из дома без VPN — иначе вариант не пройдёт проверку."],
    transportNote: "datachannel — самый быстрый; vp8channel и seichannel — если datachannel на этом Jitsi не идёт.",
  },
];
type RoomRow = { provider: string; room: string; transport: string };

type Act = (a: Parameters<typeof core.olcrtcDo>[0], b: Record<string, unknown>, k?: string) => Promise<void>;
export type Preset = { name: string; host: string; port: number; user: string; mode?: "whitelist" | "normal" };

/** The variants to pick: shared by a new server's setup and «Изменить варианты». */
function useVariants(rep: OlcReport | null, initialMode: "whitelist" | "normal" = "whitelist") {
  const [inst, setInst] = useState<Record<string, boolean>>({});
  const [tr, setTr] = useState<Record<string, boolean>>({ datachannel: true, vp8channel: true });
  const [keep, setKeep] = useState(2);
  const [mode2, setMode2] = useState<"whitelist" | "normal">(initialMode);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [openGroup, setOpenGroup] = useState("jitsi");
  const kindOf = (id: string) => ROOM_KINDS.find((k) => k.id === id) || ROOM_KINDS[0];
  const setRoom = (i: number, patch: Partial<RoomRow>) => setRooms(rooms.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const wlNow = rep?.channel === "whitelist";
  useEffect(() => setKeep(mode2 === "whitelist" && !wlNow ? 3 : 2), [mode2, wlNow]);
  const instances = rep?.instances || [];
  useEffect(() => {
    if (instances.length && !Object.keys(inst).length) setInst(Object.fromEntries(instances.slice(0, 6).map((i) => [i, true])));
  }, [instances, inst]);
  const jitsiCount = instances.filter((i) => inst[i]).length;
  const jitsiTr = (rep?.transports || []).filter((t) => tr[t]);
  const body = () => ({
    instances: instances.filter((i) => inst[i]),
    transports: (rep?.transports || []).filter((t) => tr[t]),
    keep,
    mode: mode2,
    rooms: rooms.filter((r) => r.room.trim()),
  });
  return { inst, setInst, tr, setTr, keep, setKeep, mode2, setMode2, rooms, setRooms, openGroup, setOpenGroup, kindOf, setRoom, wlNow, instances, jitsiCount, jitsiTr, body };
}

function VariantPicker({ v, rep }: { v: ReturnType<typeof useVariants>; rep: OlcReport | null }) {
  const { inst, setInst, tr, setTr, keep, setKeep, mode2, setMode2, rooms, setRooms, openGroup, setOpenGroup, kindOf, setRoom, wlNow, instances, jitsiCount, jitsiTr } = v;
  return (
    <>
            <span className="vn-eyebrow">Для какого случая</span>
            <div className="ol-modes" role="radiogroup" aria-label="Режим">
              <button type="button" role="radio" aria-checked={mode2 === "whitelist"} className={`ol-mode${mode2 === "whitelist" ? " is-on" : ""}`} onClick={() => setMode2("whitelist")}>
                <b>Для белых списков</b>
                <small>Варианты должны открываться из дома без VPN, когда провайдер пропускает только белый список. Это главный случай для OLCRTC.</small>
              </button>
              <button type="button" role="radio" aria-checked={mode2 === "normal"} className={`ol-mode${mode2 === "normal" ? " is-on" : ""}`} onClick={() => setMode2("normal")}>
                <b>Обычный</b>
                <small>Достаточно, чтобы вариант работал напрямую сейчас — когда интернет без ограничений, а режут протоколы VPN.</small>
              </button>
            </div>
            <p className={`ol-channel${wlNow ? " is-wl" : ""}`}>
              Канал сейчас: <b>{wlNow ? "белые списки" : rep?.channel === "normal" ? "без ограничений" : rep?.channel === "offline" ? "без интернета" : "не определён"}</b>.{" "}
              {mode2 === "whitelist"
                ? wlNow
                  ? "Проверка честная: что заработает сейчас, работает при белых списках."
                  : "Что варианты работают при белых списках, станет ясно, когда они включатся: роутер проверит сам и заменит нерабочие. Поэтому оставим больше вариантов."
                : "Каждый вариант сначала открывается с роутера напрямую, без VPN."}
            </p>
            <span className="vn-eyebrow">Варианты связи</span>
            <small className="mh-muted">
              Вариант — это площадка видеозвонков, комната на ней и транспорт. На сервере у каждого варианта своя служба, на роутере — свой узел в группе OLCRTC. Перед каждым вариантом роутер открывает площадку напрямую, без VPN: что не открылось, не пробуется.
            </small>
            <div className="ol-groups">
              <details className="ol-group" open={openGroup === "jitsi"} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && setOpenGroup("jitsi")}>
                <summary>
                  <span className="ol-group-title">
                    <b>Jitsi из списка olcrtc</b>
                    <small>комнаты придумываются сами, регистрация не нужна</small>
                  </span>
                  <span className="ol-group-sum">
                    {jitsiCount ? `${jitsiCount} из ${instances.length} · ${jitsiTr.join(", ") || "нет транспорта"}` : "не выбрано"}
                  </span>
                </summary>
                <div className="ol-group-body">
                  <div className="vn-chips">
                    <button type="button" className="vn-chip" onClick={() => setInst(Object.fromEntries(instances.map((i) => [i, true])))}>
                      Все
                    </button>
                    <button type="button" className="vn-chip" onClick={() => setInst(Object.fromEntries(instances.slice(0, 6).map((i) => [i, true])))}>
                      Первые 6
                    </button>
                    <button type="button" className="vn-chip" onClick={() => setInst({})}>
                      Ничего
                    </button>
                  </div>
                  <div className="ol-checks">
                    {instances.map((i) => (
                      <label key={i} className="ol-check">
                        <input type="checkbox" checked={!!inst[i]} onChange={(e) => setInst({ ...inst, [i]: e.target.checked })} />
                        <span className="mono">{i}</span>
                      </label>
                    ))}
                  </div>
                  <span className="su-field">
                    <span>Транспорт</span>
                    <span className="vn-chips">
                      {(rep?.transports || []).map((t) => (
                        <button key={t} type="button" className={`vn-chip${tr[t] ? " is-on" : ""}`} aria-pressed={!!tr[t]} onClick={() => setTr({ ...tr, [t]: !tr[t] })}>
                          {t}
                        </button>
                      ))}
                    </span>
                    <small className="mh-muted">По скорости: datachannel → vp8channel → seichannel → videochannel. Сначала пробуется первый выбранный транспорт на всех площадках, потом следующий.</small>
                  </span>
                  <label className="su-field">
                    <span>Оставить рабочих из этого списка</span>
                    <select className="input" value={keep} onChange={(e) => setKeep(Number(e.target.value))}>
                      <option value={1}>1</option>
                      <option value={2}>2 — рекомендуется</option>
                      <option value={3}>3</option>
                    </select>
                  </label>
                </div>
              </details>

              {ROOM_KINDS.map((k) => {
                const mine = rooms.map((r, i) => ({ r, i })).filter((x) => x.r.provider === k.id);
                const filled = mine.filter((x) => x.r.room.trim()).length;
                return (
                  <details key={k.id} className="ol-group" open={openGroup === k.id} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && setOpenGroup(k.id)}>
                    <summary>
                      <span className="ol-group-title">
                        <b>{k.label}</b>
                        <small>{k.note}</small>
                      </span>
                      <span className="ol-group-sum">{filled ? `комнат: ${filled} · ${[...new Set(mine.map((x) => x.r.transport))].join(", ")}` : "нет комнат"}</span>
                    </summary>
                    <div className="ol-group-body">
                      <ol className="ol-howto">
                        {k.steps.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ol>
                      {mine.map(({ r, i }) => (
                        <div key={i} className="ol-room">
                          <label className="sr-only" htmlFor={`ol-rr-${i}`}>
                            Ссылка на комнату
                          </label>
                          <input id={`ol-rr-${i}`} className="input mono" placeholder={k.hint} value={r.room} onChange={(e) => setRoom(i, { room: e.target.value })} />
                          {k.transports.length > 1 ? (
                            <>
                              <label className="sr-only" htmlFor={`ol-rt-${i}`}>
                                Транспорт
                              </label>
                              <select id={`ol-rt-${i}`} className="input" value={r.transport} onChange={(e) => setRoom(i, { transport: e.target.value })}>
                                {k.transports.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </>
                          ) : (
                            <span className="ol-fixed-tr mono">{k.transports[0]}</span>
                          )}
                          <button type="button" className="btn btn-icon" aria-label="Убрать комнату" onClick={() => setRooms(rooms.filter((_, n) => n !== i))}>
                            <Icon name="close" size={13} />
                          </button>
                        </div>
                      ))}
                      <div className="nx-actions">
                        <button type="button" className="btn btn-sm" onClick={() => setRooms([...rooms, { provider: k.id, room: "", transport: k.transports[0] }])}>
                          <Icon name="plus" size={12} /> Добавить комнату
                        </button>
                        {k.site ? (
                          <a className="btn btn-sm" href={k.site} target="_blank" rel="noopener noreferrer">
                            Открыть {k.site.replace(/^https:\/\//, "").replace(/\/$/, "")}
                          </a>
                        ) : null}
                      </div>
                      <small className="mh-muted">{k.transportNote}</small>
                    </div>
                  </details>
                );
              })}
            </div>
            <small className="mh-muted">Свои комнаты остаются, если заработали, — в дополнение к подобранным Jitsi.</small>
    </>
  );
}

/** One job: its steps, decisions, tries and the whole log folded under them. */
function JobView({ job, rep, busy, act }: { job: OlcJob; rep: OlcReport | null; busy: string; act: Act }) {
  const [open, setOpen] = useState<string>("");
  const doneSteps = job.steps.filter((s) => s.status === "ok" || s.status === "skip").length;
  const serverName = (rep?.servers || []).find((s) => s.id === job.server)?.name;
  const lines = job.steps.flatMap((s) => (s.log || []).map((l) => `[${s.title}] ${l}`));
  return (
              <div className="vo-panel">
                <div className="vn-section-head">
                  <h3>
                    {job.kind === "repick" ? "Подбор вариантов" : "Настройка"}
                    {serverName ? ` · ${serverName}` : ""}
                  </h3>
                  <span className="nx-summary">{job.running ? (job.waiting ? "ждёт решения" : `шаг ${doneSteps + 1} из ${job.steps.length}`) : job.ok ? `готово за ${Math.max(1, Math.round(((job.ended || job.started) - job.started) / 60))} мин` : "остановлено"}</span>
                </div>
                <div className="ol-progress">
                  <span className={job.waiting ? "is-warn" : job.done && job.ok ? "is-ok" : job.done ? "is-bad" : ""} style={{ width: `${(doneSteps / job.steps.length) * 100}%` }} />
                </div>
                <div className="ol-steplist">
                  {(job.steps || []).map((s, i) => (
                    <div key={s.id} className={`ol-step is-${s.status}`}>
                      <button type="button" className="ol-step-head" onClick={() => setOpen(open === s.id ? "" : s.id)} aria-expanded={open === s.id}>
                        <span className="ol-mark">{STEP_MARK[s.status] || i + 1}</span>
                        <span className="ol-step-text">
                          <span>
                            <b>{s.title}</b>
                            <small className="mono">{s.ms && s.status !== "run" ? `${(s.ms / 1000).toFixed(s.ms < 10000 ? 1 : 0).replace(".", ",")} с` : ""}</small>
                          </span>
                          <small>{s.status === "run" ? "выполняется…" : s.status === "wait" ? "ждёт" : s.detail}</small>
                        </span>
                      </button>
                      {job.waiting === s.id ? (
                        <div className="ol-fix">
                          <span>
                            {s.fix === "migrate"
                              ? "Уже работающий olcrtc запущен из /tmp: после очистки /tmp он не поднимется. HomeNet может перенести его в свою службу — та же комната и ключ, узел на роутере менять не нужно."
                              : s.id === "swap"
                                ? "Создать файл подкачки 4 ГБ, включить и прописать в /etc/fstab — так советуют авторы olcrtc для серверов с малой памятью."
                                : "Шаг ждёт решения."}
                          </span>
                          <button type="button" className="btn btn-sm btn-primary" disabled={busy === "resume"} onClick={() => void act("resume", { action: "fix" }, "resume")}>
                            {s.fix_label || "Исправить"}
                          </button>
                          <button type="button" className="btn btn-sm" disabled={busy === "resume"} onClick={() => void act("resume", { action: "skip" }, "resume")}>
                            {s.fix === "migrate" ? "Оставить как есть" : "Продолжить без этого"}
                          </button>
                          <button type="button" className="btn btn-sm" disabled={busy === "resume"} onClick={() => void act("resume", { action: "cancel" }, "resume")}>
                            Отменить
                          </button>
                        </div>
                      ) : null}
                      {s.id === "existing" && (job.found || []).length ? (
                        <div className="ol-tries">
                          {(job.found || []).map((f) => (
                            <div key={f.container}>
                              <i className={`nx-dot ${f.status === "running" ? "nx-ok" : "nx-silent"}`} />
                              <span className="mono truncate">
                                {f.container} · {host(f.room)} · {f.transport}
                              </span>
                              <small>{f.node ? `узел «${f.node}»` : "узла на роутере нет — добавим"}{f.in_tmp ? " · в /tmp" : ""}</small>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {s.id === "pick" && (job.tries || []).length && (s.status !== "wait" || open === s.id) ? (
                        <div className="ol-tries">
                          {(job.tries || []).map((t) => (
                            <div key={t.label} className={`is-${t.state}`}>
                              <i className={`nx-dot ${t.state === "ok" ? "nx-ok" : t.state === "fail" ? "nx-reset" : t.state === "run" ? "nx-out" : ""}`} />
                              <span className="mono truncate">{t.label}</span>
                              <small>{t.result || (t.state === "wait" ? "в очереди" : "")}</small>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {open === s.id && s.log?.length ? (
                        <div className="ol-code">
                          <pre>{s.log.join("\n")}</pre>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                <details className="ol-log">
                  <summary>
                    Журнал настройки <span className="vs-count">{lines.length} строк</span>
                  </summary>
                  <pre>{lines.length ? lines.join("\n") : "пока пусто"}</pre>
                </details>
                {job.done ? (
                  <div className={`ol-done ${job.ok ? "is-ok" : "is-bad"}`}>
                    <b>{job.ok ? "Связь через свой сервер работает" : "Настройка не закончилась"}</b>
                    <span>{job.ok ? `${(job.result || []).filter((r) => r.ok).length} рабочих варианта · автоподбор следит за ними` : job.error}</span>
                  </div>
                ) : null}
              </div>
  );
}

function Setup({ rep, busy, act, preset }: { rep: OlcReport | null; busy: string; act: Act; preset?: Preset | null }) {
  const [mode, setMode] = useState<Mode>("auto");
  const [auth, setAuth] = useState<"key" | "pass">("key");
  const [form, setForm] = useState({ name: "", host: "", port: "22", user: "root", password: "" });
  const v = useVariants(rep, preset?.mode || "whitelist");
  useEffect(() => {
    if (preset) {
      setForm({ name: preset.name, host: preset.host, port: String(preset.port), user: preset.user, password: "" });
      v.setMode2(preset.mode || "whitelist");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);
  const [copied, setCopied] = useState("");
  const job: OlcJob | null | undefined = rep?.job;
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(key));
  };
  const start = () =>
    void act(
      "setup",
      {
        name: form.name,
        host: form.host,
        port: Number(form.port) || 22,
        user: form.user,
        password: auth === "pass" ? form.password : "",
        ...v.body(),
      },
      "setup",
    ).then(() => setForm((f) => ({ ...f, password: "" })));

  return (
    <div className="stack">
      <div className="ol-modebar">
        <div className="nx-views" role="group" aria-label="Способ">
          <button type="button" className={mode === "auto" ? "is-on" : ""} aria-pressed={mode === "auto"} onClick={() => setMode("auto")}>
            Автоматически по SSH
          </button>
          <button type="button" className={mode === "manual" ? "is-on" : ""} aria-pressed={mode === "manual"} onClick={() => setMode("manual")}>
            Вручную
          </button>
        </div>
        <small className="mh-muted">Нужен VPS вне России с Debian, Ubuntu, Fedora или Arch и systemd: 1 ядро, от 1 ГБ памяти (меньше 4 ГБ — добавим swap).</small>
      </div>

      {mode === "auto" ? (
        <div className="ol-layout">
          <section className="vo-panel ol-form" aria-label="Сервер">
            <span className="vn-eyebrow">Сервер</span>
            <label className="su-field">
              <span>Название</span>
              <input className="input" placeholder="например, VPS Хельсинки" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <div className="ol-addr">
              <label className="su-field">
                <span>Адрес</span>
                <input className="input mono" placeholder="203.0.113.40" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              </label>
              <label className="su-field">
                <span>Порт</span>
                <input className="input mono" inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </label>
            </div>
            <label className="su-field">
              <span>Пользователь</span>
              <input className="input mono" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
            </label>
            <span className="su-field">
              <span>Вход</span>
            </span>
            <div className="nx-views ol-auth" role="group" aria-label="Вход">
              <button type="button" className={auth === "key" ? "is-on" : ""} aria-pressed={auth === "key"} onClick={() => setAuth("key")}>
                Ключ HomeNet
              </button>
              <button type="button" className={auth === "pass" ? "is-on" : ""} aria-pressed={auth === "pass"} onClick={() => setAuth("pass")}>
                Пароль один раз
              </button>
            </div>
            {auth === "key" ? (
              <div className="su-field">
                <span>
                  Добавьте ключ на сервер в <span className="mono">~/.ssh/authorized_keys</span>:
                </span>
                <div className="ol-code">
                  <pre>{rep?.pubkey || "…"}</pre>
                  <button type="button" className="btn btn-sm" disabled={!rep?.pubkey} onClick={() => copy("key", rep?.pubkey || "")}>
                    {copied === "key" ? "Скопировано" : "Копировать"}
                  </button>
                </div>
              </div>
            ) : (
              <label className="su-field">
                <span>Пароль</span>
                <input className="input" type="password" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                <small className="mh-muted">Нужен один раз: HomeNet войдёт и положит на сервер свой ключ. Пароль нигде не сохраняется.</small>
              </label>
            )}
            <VariantPicker v={v} rep={rep} />
            <button type="button" className="btn btn-primary" disabled={!rep || !form.host.trim() || !!job?.running || busy === "setup" || (auth === "pass" && !form.password)} onClick={start}>
              {job?.running ? "Настраиваю…" : "Начать настройку"}
            </button>
          </section>

          <section className="ol-steps" aria-label="Шаги настройки">
            {job ? (
              <JobView job={job} rep={rep} busy={busy} act={act} />
            ) : (
              <div className="vo-panel">
                <h3>Шаги настройки</h3>
                <ol className="ol-plan">
                  <li>SSH-подключение — ключом HomeNet или паролем один раз</li>
                  <li>Проверка сервера: система, память, systemd</li>
                  <li>Swap 4 ГБ, если памяти мало для сборки</li>
                  <li>git, curl, openssl и Go {"1.26"}</li>
                  <li>Исходники olcrtc и сборка</li>
                  <li>Ключ шифрования и служба olcrtc@</li>
                  <li>Подбор вариантов: Jitsi × транспорт, рабочие остаются</li>
                  <li>Проверка связи через новый узел</li>
                </ol>
                <small className="mh-muted">Если шаг падает, здесь появится причина и кнопка, чтобы исправить и продолжить.</small>
              </div>
            )}
          </section>
        </div>
      ) : (
        <Manual />
      )}
    </div>
  );
}

const MANUAL: Array<[string, string, string[]]> = [
  ["Подготовьте сервер", "Debian 12, Ubuntu 22.04 и новее, Fedora или Arch — вне России. Если памяти меньше 4 ГБ, добавьте swap, иначе сборка оборвётся.", ["sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile", "echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab"]],
  ["Поставьте git, curl и Go 1.26", "В Debian и Ubuntu Go из пакетов старый — берите архив с go.dev.", ["sudo apt update && sudo apt install -y git curl openssl", "curl -fsSL https://go.dev/dl/go1.26.3.linux-amd64.tar.gz | sudo tar -C /usr/local -xz && /usr/local/go/bin/go version"]],
  ["Скачайте и соберите olcrtc той же версии, что в роутере", "Сборки с разным форматом шифрования не соединяются, поэтому нужна версия 92b2332 — её встроено в ядро HomeNet. Без mage — той же командой, что использует его сборка.", ["sudo git init -q /opt/olcrtc/src && cd /opt/olcrtc/src && sudo git fetch -q --depth 1 https://github.com/openlibrecommunity/olcrtc 92b2332769c3dd5000584366201572efc448065f && sudo git checkout -q FETCH_HEAD", "cd /opt/olcrtc/src && sudo CGO_ENABLED=0 /usr/local/go/bin/go build -trimpath -ldflags '-s -w' -o /opt/olcrtc/olcrtc ./cmd/olcrtc"]],
  ["Создайте ключ", "Один на сервер. Тот же ключ понадобится в HomeNet.", ["sudo sh -c 'umask 077 && openssl rand -hex 32 > /opt/olcrtc/olcrtc.key' && sudo cat /opt/olcrtc/olcrtc.key"]],
  ["Опишите вариант", "Комнату Jitsi можно выдумать; площадку возьмите из списка olcrtc — такую, что открывается из дома без VPN. Для Телемоста: provider: telemost, transport: vp8channel, id — номер из ссылки встречи. Для WB Stream: provider: wbstream, transport: vp8channel или seichannel, id комнаты с stream.wb.ru.", ["sudo tee /opt/olcrtc/v1.yaml <<'EOF'\nmode: srv\nauth:\n  provider: jitsi\nroom:\n  id: \"https://meet.egovm.ru/homenet-ваша-комната\"\ncrypto:\n  key_file: \"/opt/olcrtc/olcrtc.key\"\nnet:\n  transport: datachannel\n  dns: \"8.8.8.8:53\"\nEOF"]],
  ["Запустите как службу", "Служба на вариант: второй вариант — v2.yaml и olcrtc@v2.", ["sudo tee /etc/systemd/system/olcrtc@.service <<'EOF'\n[Unit]\nDescription=olcrtc %i\nAfter=network-online.target\n\n[Service]\nExecStart=/opt/olcrtc/olcrtc /opt/olcrtc/%i.yaml\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\nEOF", "sudo systemctl daemon-reload && sudo systemctl enable --now olcrtc@v1 && journalctl -u olcrtc@v1 -f"]],
  ["Добавьте в HomeNet", "«Серверы и варианты» → «Без своего сервера» → «Изменить узлы вручную» → новый узел: провайдер jitsi, та же комната, транспорт и ключ. Затем «Проверить».", []],
];
const PROBLEMS: Array<[string, string]> = [
  ["Сборка обрывается словом killed", "Не хватило памяти: включите swap 4 ГБ (шаг 1) и соберите заново."],
  ["Клиент не входит в комнату", "У сервера и HomeNet должны совпадать площадка, комната, транспорт и ключ — ровно 64 шестнадцатеричных символа."],
  ["Комната есть, но данные не идут", "Версии olcrtc на сервере и в ядре роутера разные: соберите версию 92b2332 (шаг 3)."],
  ["Телемост не соединяется", "У Телемоста работает только vp8channel — datachannel он убрал."],
  ["При белых списках не работает", "Площадка должна открываться из дома без VPN: берите Jitsi на российском адресе. Держите хотя бы два варианта."],
  ["WB Stream и datachannel", "Эта пара не работает — для WB Stream нужен vp8channel."],
  ["После перезагрузки сервера пропал", "Служба не включена: systemctl enable --now olcrtc@v1."],
];

function Manual() {
  const [copied, setCopied] = useState("");
  const copy = (k: string, t: string) => void navigator.clipboard?.writeText(t).then(() => setCopied(k));
  const steps = useMemo(() => MANUAL, []);
  return (
    <div className="ol-layout">
      <section className="ol-manual">
        {steps.map(([title, text, cmds], i) => (
          <div key={title} className="vo-panel">
            <span className="ol-mtitle">
              <span className="ol-mark">{i + 1}</span>
              <b>{title}</b>
            </span>
            <small className="mh-muted">{text}</small>
            {cmds.map((c, k) => (
              <div key={k} className="ol-code">
                <pre>{c}</pre>
                <button type="button" className="btn btn-sm" onClick={() => copy(`${i}-${k}`, c)}>
                  {copied === `${i}-${k}` ? "Скопировано" : "Копировать"}
                </button>
              </div>
            ))}
          </div>
        ))}
      </section>
      <aside className="ol-side">
        <section className="vo-panel">
          <h3>Если что-то не так</h3>
          {PROBLEMS.map(([q, a]) => (
            <div key={q} className="ol-problem">
              <b>{q}</b>
              <small>{a}</small>
            </div>
          ))}
        </section>
        <section className="vo-panel">
          <h3>Источник</h3>
          <small className="mh-muted">
            Инструкция по документации olcrtc:{" "}
            <a href="https://github.com/openlibrecommunity/olcrtc/blob/master/docs/manual.ru.md" target="_blank" rel="noopener noreferrer">
              docs/manual.ru.md
            </a>
            . Официальный скрипт ./script/srv.sh делает то же через Podman и задаёт вопросы.
          </small>
        </section>
      </aside>
    </div>
  );
}

/** «Изменить варианты» of a server HomeNet has set up: no address, no password, no install — only the pick. */
function Reconfigure({ server, rep, busy, act }: { server: OlcReport["servers"][number]; rep: OlcReport | null; busy: string; act: Act }) {
  const v = useVariants(rep, server.mode || "whitelist");
  const job = rep?.job && rep.job.server === server.id ? rep.job : null;
  return (
    <section className="vo-panel ol-reconf" aria-label={`Варианты ${server.name}`}>
      <div className="vn-section-head">
        <h3>Изменить варианты · {server.name}</h3>
        <small className="mh-muted">Без установки: HomeNet зайдёт по SSH, проверит, что olcrtc на месте, и подберёт варианты. Рабочие остаются.</small>
      </div>
      <VariantPicker v={v} rep={rep} />
      <button type="button" className="btn btn-primary" disabled={!!rep?.job?.running || busy === "repick"} onClick={() => void act("repick", { id: server.id, ...v.body() }, "repick")}>
        {job?.running ? "Подбираю…" : "Подобрать варианты"}
      </button>
      {job ? <JobView job={job} rep={rep} busy={busy} act={act} /> : null}
    </section>
  );
}
