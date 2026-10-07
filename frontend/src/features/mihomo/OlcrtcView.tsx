import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { errText } from "../../lib/format";
import { core, mihomo, type MProvider, type MProxy, type OlcCheck, type OlcJob, type OlcReport, type OlcStep } from "./api";
import { OlcrtcTab } from "./Extras";
import { useNodePrefs } from "./NodeTiles";

/*
 * VPN → «OLCRTC» (NPM-56): servers and their variants of the link (a Jitsi
 * instance × a transport), the background pick that moves the OLCRTC group to
 * a working variant, and setting up an own server over SSH step by step — or
 * by hand. Design: https://claude.ai/artifact/8w7GwGhKrK96ePPxL166SG
 */

type Tab = "servers" | "setup";
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

export function OlcrtcView({ providers, proxies, groups, onReload }: { providers: MProvider[]; proxies: Record<string, MProxy>; groups: MProxy[]; onReload: () => Promise<void> }) {
  const prefs = useNodePrefs();
  const [rep, setRep] = useState<OlcReport | null>(null);
  const [cfg, setCfg] = useState<NodeCfg[]>([]);
  const [tab, setTab] = useState<Tab>("servers");
  const [srv, setSrv] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);

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
    if (running) setTab("setup");
  }, [running]);

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
  const owned = new Map<string, string>();
  (rep?.servers || []).forEach((s) => s.variants.forEach((v) => owned.set(v.node, s.id)));
  const servers = [
    { id: NO_SERVER, name: "Без своего сервера", addr: "узлы из файла olcrtc и подписок", own: false, nodes: olcNodes.filter((n) => !owned.has(n)) },
    ...(rep?.servers || []).map((s) => ({ id: s.id, name: s.name, addr: `${s.host}${s.port !== 22 ? `:${s.port}` : ""} · ssh ${s.user}`, own: true, mode: s.mode, nodes: s.variants.map((v) => v.node) })),
  ].filter((s) => s.own || s.nodes.length);
  const cur = servers.find((s) => s.id === srv) || servers.find((s) => s.nodes.includes(rep?.selected || "")) || servers[0];
  const check = (n: string): OlcCheck | undefined => rep?.checks[n];
  const tone = (n: string) => {
    const c = check(n);
    return !c ? "none" : c.ok ? "ok" : "bad";
  };
  const cfgOf = (n: string) => cfg.find((c) => c.name === n);
  const variantOf = (n: string) => (rep?.servers || []).flatMap((s) => s.variants).find((v) => v.node === n);

  return (
    <div className="stack ol">
      <div className="ol-head">
        <p className="mh-muted">Туннель внутри видеозвонка: трафик идёт через Jitsi и выглядит как обычный созвон. Запасной путь, когда белые списки режут всё остальное.</p>
        <button type="button" className={`ol-auto${rep?.auto ? " is-on" : ""}`} aria-pressed={!!rep?.auto} disabled={!rep || busy === "auto"} onClick={() => void act("auto", { auto: !rep?.auto })}>
          <i aria-hidden="true" />
          {rep?.auto ? "Автоподбор включён" : "Автоподбор выключен"}
        </button>
      </div>
      {err ? <p className="vn-err">{err}</p> : null}
      <div className="su-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "servers"} className={tab === "servers" ? "is-on" : ""} onClick={() => setTab("servers")}>
          Серверы и варианты
        </button>
        <button type="button" role="tab" aria-selected={tab === "setup"} className={tab === "setup" ? "is-on" : ""} onClick={() => setTab("setup")}>
          {running ? "Настройка идёт…" : "Добавить свой сервер"}
        </button>
      </div>

      {tab === "servers" ? (
        <>
          <div className="vn-section-head">
            <h3>Серверы</h3>
            <div className="nx-actions">
              <button type="button" className="btn btn-sm" disabled={busy === "check-all" || !olcNodes.length} onClick={() => void act("check", {}, "check-all")}>
                <Icon name="bolt" size={13} /> {busy === "check-all" ? "Проверяю все варианты…" : "Проверить все варианты"}
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setTab("setup")}>
                <Icon name="plus" size={13} /> Свой сервер
              </button>
            </div>
          </div>
          <div className="ol-servers">
            {servers.map((s) => {
              const ok = s.nodes.filter((n) => tone(n) === "ok").length;
              const main = s.nodes.includes(rep?.selected || "") ? rep!.selected : "";
              const state = main ? (tone(main) === "bad" ? "warn" : "ok") : ok ? "idle" : s.nodes.length ? "bad" : "idle";
              return (
                <button key={s.id || "none"} type="button" className={`ol-server${cur?.id === s.id ? " is-sel" : ""}`} aria-pressed={cur?.id === s.id} onClick={() => setSrv(s.id)}>
                  <span className="ol-server-top">
                    <span className="vn-card-name">
                      <b>{s.name}</b>
                      <small className="mono">{s.addr}</small>
                    </span>
                    <span className={`vn-pill vn-${state}`}>{main ? (state === "ok" ? "используется" : "переключается") : ok ? "запасной" : s.nodes.length ? "не отвечает" : "нет вариантов"}</span>
                  </span>
                  <span className="ol-bars" aria-hidden="true">
                    {s.nodes.map((n) => (
                      <i key={n} className={`ol-bar is-${tone(n)}`} />
                    ))}
                  </span>
                  <span className="vn-card-foot">
                    <span>
                      {ok} из {s.nodes.length} вариантов работают
                    </span>
                    <span>{s.own ? ("mode" in s && s.mode === "normal" ? "свой · обычный режим" : "свой · для белых списков") : "без сервера"}</span>
                  </span>
                </button>
              );
            })}
            {!servers.length ? <p className="mh-muted">Узлов OLCRTC пока нет — настройте свой сервер или добавьте узел вручную.</p> : null}
          </div>

          <div className="ol-layout">
            <section className="ol-variants" aria-label="Варианты связи">
              <div className="vn-section-head">
                <h3>
                  Варианты связи · {cur?.name || "—"} <span>· роутер держит узел на каждый, группа OLCRTC идёт через выбранный</span>
                </h3>
              </div>
              <div className="ol-table" role="table">
                <div className="ol-row ol-thead" role="row">
                  <span role="columnheader">Площадка · комната</span>
                  <span role="columnheader" className="nx-hm">
                    Транспорт
                  </span>
                  <span role="columnheader">Состояние</span>
                  <span role="columnheader" className="nx-hm">
                    Проверка
                  </span>
                  <span role="columnheader" className="nx-hm" />
                </div>
                {(cur?.nodes || []).map((n) => {
                  const c = check(n);
                  const conf = cfgOf(n);
                  const v = variantOf(n);
                  const isMain = rep?.selected === n;
                  return (
                    <div key={n} className={`ol-row${isMain ? " is-main" : ""}`} role="row">
                      <span role="cell" className="ol-what">
                        <span className="ol-what-top">
                          <b className="truncate">{conf?.["auth-provider"] ? conf["auth-provider"][0].toUpperCase() + conf["auth-provider"].slice(1) : "Jitsi"}</b>
                          {isMain ? <span className="nx-pill nx-out">основной</span> : null}
                        </span>
                        <small className="mono truncate" title={n}>
                          {host(v?.room || conf?.["room-id"]) || n}
                          {v?.external ? ` · контейнер srv.sh ${v.external}` : ""}
                        </small>
                      </span>
                      <span role="cell" className="nx-hm mono">
                        {v?.transport || conf?.transport || "—"}
                      </span>
                      <span role="cell" className="ol-state">
                        <span className={`vn-pill vn-${c ? (c.ok ? "ok" : "bad") : "idle"}`}>{c ? (c.ok ? `${c.ms} мс` : "не работает") : "не проверялся"}</span>
                        <small className={`ol-wl is-${v?.wl || "none"}`} title={v?.wl_at ? `проверено ${ago(v.wl_at)}` : undefined}>
                          {v?.wl === "ok" ? "при белых списках работал" : v?.wl === "fail" ? "при белых списках не работал" : v ? "при белых списках ещё не проверялся" : ""}
                        </small>
                      </span>
                      <span role="cell" className="nx-hm ol-note">
                        {c ? `${ago(c.t)}${c.error ? ` · ${c.error}` : ""}` : "—"}
                      </span>
                      <span role="cell" className="nx-hm ol-acts">
                        <button type="button" className="btn btn-sm" disabled={busy === `c:${n}`} onClick={() => void act("check", { node: n }, `c:${n}`)}>
                          {busy === `c:${n}` ? "…" : "Проверить"}
                        </button>
                        <button type="button" className="btn btn-sm" disabled={isMain || busy === `m:${n}`} onClick={() => void act("main", { node: n }, `m:${n}`)}>
                          Основным
                        </button>
                      </span>
                    </div>
                  );
                })}
                {!cur?.nodes.length ? <p className="mh-muted ts-empty">У сервера нет рабочих вариантов — подберите их заново.</p> : null}
              </div>
              <div className="nx-actions">
                {cur && cur.id !== NO_SERVER ? (
                  <>
                    <button type="button" className="btn" disabled={running || busy === "repick"} onClick={() => void act("repick", { id: cur.id }, "repick").then(() => setTab("setup"))}>
                      <Icon name="refresh" size={14} /> Подобрать варианты заново
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={running || busy === "remove"}
                      onClick={() => {
                        if (window.confirm(`Убрать «${cur.name}» из HomeNet? Его узлы уйдут из olcrtc, службы на сервере остановятся.`)) void act("remove", { id: cur.id }, "remove").then(() => setSrv(null));
                      }}
                    >
                      Убрать сервер
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn" onClick={() => setEditing(!editing)}>
                    <Icon name="edit" size={14} /> {editing ? "Скрыть редактор узлов" : "Изменить узлы вручную"}
                  </button>
                )}
              </div>
              {editing ? <OlcrtcTab providers={providers.filter((p) => p.proxies.some((x) => x.type.toLowerCase() === "olcrtc"))} standalone={Object.values(proxies).filter((x) => x.type.toLowerCase() === "olcrtc" && !olcNodes.includes(x.name))} groups={groups} onReload={async () => (await onReload(), await pull())} prefs={prefs} /> : null}
            </section>

            <aside className="ol-side">
              <section className="vo-panel">
                <h3>Автоподбор</h3>
                <small className="mh-muted">
                  Раз в минуту роутер проверяет вариант, через который идёт OLCRTC, раз в 10 минут — все. Если основной не ответил 2 раза подряд, группа переключается на первый рабочий. Если не работает ни один, на своём сервере по SSH подбираются новые варианты — не чаще раза в час.
                </small>
                <button type="button" className={`btn${rep?.auto ? "" : " btn-primary"}`} disabled={!rep || busy === "auto"} onClick={() => void act("auto", { auto: !rep?.auto })}>
                  {rep?.auto ? "Выключить автоподбор" : "Включить автоподбор"}
                </button>
              </section>
              <section className="vo-panel">
                <h3>Что делал автоподбор</h3>
                <div className="ol-events">
                  {(rep?.events || []).slice(0, 12).map((e, i) => (
                    <div key={`${e.t}-${i}`}>
                      <time className="mono">{hhmm(e.t)}</time>
                      <i className={`vn-dot vn-${e.kind === "ok" ? "ok" : e.kind === "warn" ? "warn" : "bad"}`} />
                      <span>{e.text}</span>
                    </div>
                  ))}
                  {!rep?.events?.length ? <p className="mh-muted">Пока ничего — события появятся здесь.</p> : null}
                </div>
              </section>
            </aside>
          </div>
        </>
      ) : (
        <Setup rep={rep} busy={busy} act={act} />
      )}
    </div>
  );
}

const STEP_MARK: Record<OlcStep["status"], string> = { ok: "✓", run: "…", fail: "!", wait: "", skip: "–" };

function Setup({ rep, busy, act }: { rep: OlcReport | null; busy: string; act: (a: Parameters<typeof core.olcrtcDo>[0], b: Record<string, unknown>, k?: string) => Promise<void> }) {
  const [mode, setMode] = useState<Mode>("auto");
  const [auth, setAuth] = useState<"key" | "pass">("key");
  const [form, setForm] = useState({ name: "", host: "", port: "22", user: "root", password: "" });
  const [inst, setInst] = useState<Record<string, boolean>>({});
  const [tr, setTr] = useState<Record<string, boolean>>({ datachannel: true, vp8channel: true });
  const [keep, setKeep] = useState(2);
  const [mode2, setMode2] = useState<"whitelist" | "normal">("whitelist");
  const wlNow = rep?.channel === "whitelist";
  useEffect(() => setKeep(mode2 === "whitelist" && !wlNow ? 3 : 2), [mode2, wlNow]);
  const [open, setOpen] = useState<string>("");
  const [copied, setCopied] = useState("");
  const instances = rep?.instances || [];
  useEffect(() => {
    if (instances.length && !Object.keys(inst).length) setInst(Object.fromEntries(instances.slice(0, 6).map((i) => [i, true])));
  }, [instances, inst]);
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
        instances: instances.filter((i) => inst[i]),
        transports: (rep?.transports || []).filter((t) => tr[t]),
        keep,
        mode: mode2,
      },
      "setup",
    ).then(() => setForm((f) => ({ ...f, password: "" })));
  const doneSteps = job ? job.steps.filter((s) => s.status === "ok" || s.status === "skip").length : 0;
  const serverName = (rep?.servers || []).find((s) => s.id === job?.server)?.name;

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
            <small className="mh-muted">Публичные Jitsi из списка olcrtc. Сначала роутер открывает площадку напрямую, без VPN; что не открылось — не пробуется. Остальные HomeNet поднимет по очереди и оставит рабочие.</small>
            <div className="ol-checks">
              {instances.map((i) => (
                <label key={i} className="ol-check">
                  <input type="checkbox" checked={!!inst[i]} onChange={(e) => setInst({ ...inst, [i]: e.target.checked })} />
                  <span className="mono">{i}</span>
                </label>
              ))}
            </div>
            <div className="ol-row2">
              <span className="su-field">
                <span>Транспорт</span>
                <span className="vn-chips">
                  {(rep?.transports || []).map((t) => (
                    <button key={t} type="button" className={`vn-chip${tr[t] ? " is-on" : ""}`} aria-pressed={!!tr[t]} onClick={() => setTr({ ...tr, [t]: !tr[t] })}>
                      {t}
                    </button>
                  ))}
                </span>
              </span>
              <label className="su-field">
                <span>Оставить рабочих</span>
                <select className="input" value={keep} onChange={(e) => setKeep(Number(e.target.value))}>
                  <option value={1}>1</option>
                  <option value={2}>2 — рекомендуется</option>
                  <option value={3}>3</option>
                </select>
              </label>
            </div>
            <button type="button" className="btn btn-primary" disabled={!rep || !form.host.trim() || !!job?.running || busy === "setup" || (auth === "pass" && !form.password)} onClick={start}>
              {job?.running ? "Настраиваю…" : "Начать настройку"}
            </button>
          </section>

          <section className="ol-steps" aria-label="Шаги настройки">
            {job ? (
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
                {job.done ? (
                  <div className={`ol-done ${job.ok ? "is-ok" : "is-bad"}`}>
                    <b>{job.ok ? "Связь через свой сервер работает" : "Настройка не закончилась"}</b>
                    <span>{job.ok ? `${(job.result || []).filter((r) => r.ok).length} рабочих варианта · автоподбор следит за ними` : job.error}</span>
                  </div>
                ) : null}
              </div>
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
  ["Скачайте и соберите olcrtc", "Без mage — той же командой, что использует его сборка.", ["sudo git clone --depth 1 https://github.com/openlibrecommunity/olcrtc /opt/olcrtc/src", "cd /opt/olcrtc/src && sudo CGO_ENABLED=0 /usr/local/go/bin/go build -trimpath -ldflags '-s -w' -o /opt/olcrtc/olcrtc ./cmd/olcrtc"]],
  ["Создайте ключ", "Один на сервер. Тот же ключ понадобится в HomeNet.", ["sudo sh -c 'umask 077 && openssl rand -hex 32 > /opt/olcrtc/olcrtc.key' && sudo cat /opt/olcrtc/olcrtc.key"]],
  ["Опишите вариант", "Комнату Jitsi можно выдумать. Площадку выберите из списка olcrtc — такую, что открывается из дома без VPN.", ["sudo tee /opt/olcrtc/v1.yaml <<'EOF'\nmode: srv\nauth:\n  provider: jitsi\nroom:\n  id: \"https://meet.egovm.ru/homenet-ваша-комната\"\ncrypto:\n  key_file: \"/opt/olcrtc/olcrtc.key\"\nnet:\n  transport: datachannel\n  dns: \"8.8.8.8:53\"\nEOF"]],
  ["Запустите как службу", "Служба на вариант: второй вариант — v2.yaml и olcrtc@v2.", ["sudo tee /etc/systemd/system/olcrtc@.service <<'EOF'\n[Unit]\nDescription=olcrtc %i\nAfter=network-online.target\n\n[Service]\nExecStart=/opt/olcrtc/olcrtc /opt/olcrtc/%i.yaml\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\nEOF", "sudo systemctl daemon-reload && sudo systemctl enable --now olcrtc@v1 && journalctl -u olcrtc@v1 -f"]],
  ["Добавьте в HomeNet", "«Серверы и варианты» → «Без своего сервера» → «Изменить узлы вручную» → новый узел: провайдер jitsi, та же комната, транспорт и ключ. Затем «Проверить».", []],
];
const PROBLEMS: Array<[string, string]> = [
  ["Сборка обрывается словом killed", "Не хватило памяти: включите swap 4 ГБ (шаг 1) и соберите заново."],
  ["Клиент не входит в комнату", "У сервера и HomeNet должны совпадать площадка, комната, транспорт и ключ — ровно 64 шестнадцатеричных символа."],
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
