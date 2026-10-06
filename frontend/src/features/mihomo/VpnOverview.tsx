import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PageHeader, type PageKey } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { errText, number } from "../../lib/format";
import { core, mihomo, type HealthPoint, type MProvider, type MProxy, type ServiceState, type ServicesReport } from "./api";
import { useMihomo } from "./context";
import { useTailscaleIssues } from "./Extras";
import { useBypassStatus } from "./BypassTraffic";
import { lastDelay } from "./shared";
import { ServicesEditor } from "./ServicesEditor";
import { Usage } from "./Usage";
import { DayChart } from "./VpnDay";
import { Connectivity } from "./Connectivity";

/*
 * VPN → «Сейчас» (NPM-47): does the internet work, and do the services people
 * use open. The state first, in plain words; nodes and delays live on their own
 * pages. Design: https://claude.ai/artifact/5YUqVHy44gRdfhKD2MSxWz
 */

export type Tone = "ok" | "warn" | "bad" | "idle";
type Mode = "normal" | "whitelist" | "offline" | "unknown";

const MODE_TEXT: Record<Mode, string> = { normal: "обычный", whitelist: "белый список", offline: "без интернета", unknown: "не определён" };

function modeOf(p: HealthPoint): Mode {
  const m = Math.max(p.normal, p.whitelist, p.offline);
  if (!m) return "unknown";
  return p.offline === m ? "offline" : p.whitelist === m ? "whitelist" : "normal";
}

const FAIL_TEXT: Record<string, string> = { silent: "тишина", reset: "сброс", tls: "ошибка TLS", http: "чужой ответ", body: "чужая страница" };
function probeName(url: string) {
  try {
    const h = new URL(url).hostname;
    return h.includes("yandex") ? "Яндекс" : h === "ya.ru" ? "ya.ru" : h.includes("gstatic") ? "gstatic" : h.includes("cloudflare") ? "Cloudflare" : h.includes("google") ? "Google" : h;
  } catch {
    return url;
  }
}

export const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const ago = (sec: number) => (sec < 90 ? "только что" : sec < 3600 ? `${Math.round(sec / 60)} мин` : `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`);

/** Service state from its last results: a single miss is «медленно», two in a row «не открывается». */
export function serviceTone(s: ServiceState, slow: number): { tone: Tone; text: string; downFor: number } {
  const h = s.history;
  if (!h.length) return { tone: "idle", text: "проверяется", downFor: 0 };
  const last = h[h.length - 1];
  let fails = 0;
  for (let i = h.length - 1; i >= 0 && !h[i].ok; i--) fails++;
  if (fails >= 2) return { tone: "bad", text: "не открывается", downFor: last.t - h[h.length - fails].t + 120 };
  if (!last.ok || last.ms > slow) return { tone: "warn", text: last.ok ? "медленно" : "сбой", downFor: 0 };
  return { tone: "ok", text: "открывается", downFor: 0 };
}

export const leafName = (path?: string[]) => (path && path.length ? path[path.length - 1] : "");
export function pathText(s: ServiceState) {
  const p = s.path || [];
  const leaf = leafName(p);
  if (s.kind === "dns") return "DNS роутера, без узлов";
  if (!leaf) return s.group;
  if (leaf === "DIRECT") return p.length > 2 ? `напрямую · через «${p[1]}»` : "напрямую";
  return p.length > 2 ? `${p[p.length - 2]} → ${leaf}` : leaf;
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`vn-pill vn-${tone}`}>{children}</span>;
}

export function Bars({ s, slow }: { s: ServiceState; slow: number }) {
  const cells = Array.from({ length: 30 }, (_, i) => s.history[s.history.length - 30 + i]);
  return (
    <span className="vn-bars" aria-label="Последний час">
      {cells.map((r, i) => (
        <i key={i} className={!r ? "" : !r.ok ? "vn-bar-bad" : r.ms > slow ? "vn-bar-warn" : "vn-bar-ok"} title={r ? `${hhmm(r.t)} · ${r.ok ? `${r.ms} мс` : r.error || "не открылся"}` : undefined} />
      ))}
    </span>
  );
}

export function VpnOverview({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const { status } = useMihomo();
  const live = !!status?.controller_ok;
  const tsIssues = useTailscaleIssues(live);
  const bypass = useBypassStatus(live);
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [day, setDay] = useState<HealthPoint[]>([]);
  const [svc, setSvc] = useState<ServicesReport | null>(null);
  const [open, setOpen] = useState<string>("");
  const [seg, setSeg] = useState(-1);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const pull = useCallback(() => {
    void mihomo
      .allProxies()
      .then((r) => {
        setProxies(r.proxies);
        setProviders(r.providers);
      })
      .catch(() => undefined);
    void core
      .health("", "24h")
      .then((r) => {
        setDay(r.series);
      })
      .catch(() => undefined);
    void core.services().then(setSvc).catch(() => undefined);
  }, []);
  useEffect(() => {
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), 30000);
    return () => clearInterval(t);
  }, [pull]);

  const check = async (id = "") => {
    setBusy(id || "all");
    setErr("");
    try {
      setSvc(await core.checkServices(id));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  const slow = svc?.slow_ms || 1000;
  const list = svc?.services || [];
  const tones = useMemo(() => Object.fromEntries(list.map((s) => [s.id, serviceTone(s, slow)])), [list, slow]);
  const working = list.filter((s) => tones[s.id]?.tone === "ok" || tones[s.id]?.tone === "warn").length;
  const down = list.filter((s) => tones[s.id]?.tone === "bad");

  // channel mode now and since when (by minute), the day strip by quarter-hour
  const modes = day.map(modeOf);
  const strip = useMemo(() => {
    const out: Array<{ t: number; end: number; mode: Mode; n: number }> = [];
    day.forEach((p) => {
      const mode = modeOf(p);
      const last = out[out.length - 1];
      if (last && last.mode === mode) {
        last.n++;
        last.end = p.t;
      } else out.push({ t: p.t, end: p.t, mode, n: 1 });
    });
    // runs under ten minutes (a missed sample, a short flap) join the neighbour
    for (let i = 0; i < out.length; i++) {
      if (out.length > 1 && out[i].n < 10) {
        const into = i > 0 ? out[i - 1] : out[i + 1];
        into.n += out[i].n;
        into.t = Math.min(into.t, out[i].t);
        into.end = Math.max(into.end, out[i].end);
        out.splice(i, 1);
        i = Math.max(-1, i - 2);
      } else if (i > 0 && out[i].mode === out[i - 1].mode) {
        out[i - 1].n += out[i].n;
        out[i - 1].end = out[i].end;
        out.splice(i, 1);
        i -= 1;
      }
    }
    return out;
  }, [day]);
  const mode: Mode = modes.length ? modes[modes.length - 1] : "unknown";
  let since = day.length ? day[day.length - 1].t : 0;
  for (let i = modes.length - 1; i >= 0 && modes[i] === mode; i--) since = day[i].t;
  const lastPoint = day[day.length - 1];
  // the core's own direct probes that decide the mode (NPM-53): Yandex from
  // the whitelist, Google and Cloudflare from outside it
  const mainAdaptive = Object.values(providers)
    .filter((p) => p.adaptive)
    .sort((a, b) => b.proxies.length - a.proxies.length)[0]?.adaptive;
  const directProbes = [
    ...(mainAdaptive?.directAllowed || []).map((p) => ({ ...p, allowed: true })),
    ...(mainAdaptive?.directGlobal || []).map((p) => ({ ...p, allowed: false })),
  ];
  const probedAt = mainAdaptive?.checkedAt ? new Date(mainAdaptive.checkedAt).getTime() / 1000 : 0;

  // VPN: what AUTO uses now. A node known only to its provider may be absent
  // from the map: then its name is all there is.
  const leaf = (name: string): MProxy | undefined => {
    let cur = proxies[name];
    for (let i = 0; cur && cur.now && i < 10; i++) {
      const next: MProxy | undefined = proxies[cur.now];
      if (!next) return { name: cur.now } as MProxy;
      cur = next;
    }
    return cur;
  };
  const autoLeaf = leaf("AUTO");
  const autoDelay = autoLeaf ? lastDelay(autoLeaf, proxies.AUTO?.testUrl) : null;
  // The services are the real evidence: one that opens through a node proves
  // the VPN works; without them, the last check of AUTO's node decides.
  const throughNode = list.filter((s) => s.kind !== "dns" && leafName(s.path) && leafName(s.path) !== "DIRECT" && s.history.length);
  const vpnOK = throughNode.length
    ? throughNode.some((s) => s.history[s.history.length - 1].ok)
    : !!autoLeaf && autoLeaf.name !== "COMPATIBLE" && (autoDelay ?? 1) > 0;
  const usedGroups = [proxies.AUTO?.now, proxies.AUTO?.now ? proxies[proxies.AUTO.now]?.now : ""].filter(Boolean) as string[];

  // the whole picture in one line
  const hero: { tone: Tone; eyebrow: string; title: string; text: string; icon: "check" | "alert" | "error" } =
    mode === "offline"
      ? { tone: "bad", icon: "error", eyebrow: `Нет интернета · с ${hhmm(since)}`, title: "Провайдер не пропускает даже российские сайты", text: "Проверьте кабель или модем. Пока канала нет, VPN тоже не работает." }
      : !vpnOK && live
        ? { tone: "bad", icon: "error", eyebrow: "VPN не работает", title: mode === "whitelist" ? "Открываются только российские сайты из белого списка" : "Узлы VPN не отвечают", text: "HomeNet проверяет узлы и переключится сам, как только какой-то ответит." }
        : mode === "whitelist"
          ? { tone: "warn", icon: "alert", eyebrow: `Ограниченный режим · с ${hhmm(since)}`, title: "Интернет работает, но провайдер пропускает только белый список", text: `Российские сайты из списка открываются напрямую, остальное идёт через обходы.${list.length ? ` Открываются ${working} из ${list.length} сервисов, которыми вы пользуетесь.` : ""}` }
          : down.length
            ? { tone: "warn", icon: "alert", eyebrow: "Почти всё работает", title: `Не открываются: ${down.map((s) => s.name).join(", ")}`, text: "Остальное в порядке. Ниже — что именно не так и что можно сделать." }
            : { tone: "ok", icon: "check", eyebrow: "Всё работает", title: "Интернет и VPN в порядке", text: list.length ? `Открываются все ${list.length} сервисов, которыми вы пользуетесь.` : "Канал без ограничений, VPN отвечает." };

  // what needs attention
  type Issue = { key: string; tone: Tone; title: string; sub: string; action?: ReactNode };
  const issues: Issue[] = [];
  down.forEach((s) =>
    issues.push({
      key: s.id,
      tone: "bad",
      title: `${s.name} не открывается ${ago(tones[s.id].downFor)}`,
      sub: `${pathText(s)} · ${s.history[s.history.length - 1]?.error || "нет ответа"}`,
      action: s.url ? (
        <a className="btn btn-sm" href={`#/why/${new URL(s.url).hostname}`}>
          Почему не открывается
        </a>
      ) : (
        <button className="btn btn-sm" onClick={() => setOpen(s.id)}>
          Подробнее
        </button>
      ),
    }),
  );
  Object.values(providers)
    .filter((p) => p.vehicleType === "HTTP" && p.updatedAt)
    .forEach((p) => {
      const age = (Date.now() - new Date(p.updatedAt!).getTime()) / 1000;
      if (age > 3 * 3600)
        issues.push({
          key: `sub-${p.name}`,
          tone: "warn",
          title: `Подписка ${p.name} не обновлялась ${ago(age)}`,
          sub: "Новые серверы не скачаны. Обновление идёт через группу «Подписки».",
          action: (
            <button
              className="btn btn-sm"
              disabled={busy === `sub-${p.name}`}
              onClick={async () => {
                setBusy(`sub-${p.name}`);
                try {
                  await mihomo.updateProvider(p.name);
                  pull();
                } catch (e) {
                  setErr(errText(e));
                } finally {
                  setBusy("");
                }
              }}
            >
              Обновить
            </button>
          ),
        });
    });
  tsIssues.forEach((t) =>
    issues.push({
      key: `ts-${t.name}`,
      tone: "bad",
      title: `${t.title} (${t.name})`,
      sub: t.text,
      action: t.authURL ? (
        <a className="btn btn-sm btn-primary" href={t.authURL} target="_blank" rel="noopener noreferrer">
          Войти в tailnet
        </a>
      ) : (
        <a className="btn btn-sm" href="#/proxies/tailscale">
          Открыть Tailscale
        </a>
      ),
    }),
  );
  if (bypass.limitPct != null && bypass.limitPct >= 75)
    issues.push({
      key: "limit",
      tone: bypass.limitPct >= 90 ? "bad" : "warn",
      title: `Обходы: использовано ${Math.round(bypass.limitPct)}% месячного лимита (${bypass.gb} ГБ)`,
      sub: "Посмотрите, какие устройства и сайты тратят обходы.",
      action: (
        <a className="btn btn-sm" href="#/traffic/bypass">
          Что тратит
        </a>
      ),
    });

  const knownSites = useMemo(() => {
    const out = new Set<string>();
    (svc?.catalog || []).forEach((d) => {
      if (!d.url) return;
      try {
        const host = new URL(d.url).hostname;
        out.add(host);
        out.add(host.split(".").slice(-2).join("."));
      } catch {
        /* a broken address is shown as is */
      }
    });
    return out;
  }, [svc]);
  const addSite = async (site: string) => {
    if (!svc) return;
    const cfg = svc.config;
    setSvc(await core.saveServicesConfig({ ...cfg, custom: [...cfg.custom, { id: "", name: site, what: "добавлен из «Что открывают чаще»", url: `https://${site}/`, group: "" }] }));
  };
  // the home page shows what is broken first, then the list's own order
  const rank: Record<Tone, number> = { bad: 0, warn: 1, idle: 2, ok: 3 };
  const shown = list
    .map((s, k) => ({ s, k }))
    .sort((a, b) => rank[tones[a.s.id]?.tone || "idle"] - rank[tones[b.s.id]?.tone || "idle"] || a.k - b.k)
    .slice(0, 8)
    .map((x) => x.s);
  const current = list.find((s) => s.id === open);

  const modeTone: Tone = mode === "normal" ? "ok" : mode === "whitelist" ? "warn" : mode === "offline" ? "bad" : "idle";
  const selSeg = seg >= 0 && seg < strip.length ? seg : strip.length - 1;
  const normalShare = day.length ? day.reduce((a, p) => a + p.normal, 0) / Math.max(1, day.reduce((a, p) => a + p.normal + p.whitelist + p.offline + p.unknown, 0)) : 0;
  const whitelistMin = day.reduce((a, p) => a + p.whitelist, 0);
  const tiles: Array<{ key: string; title: string; value: string; unit: string; note: ReactNode; pct: number; tone: Tone; onClick: () => void }> = [
    {
      key: "channel",
      title: "Канал провайдера",
      value: MODE_TEXT[mode][0].toUpperCase() + MODE_TEXT[mode].slice(1),
      unit: since ? `с ${hhmm(since)}` : "",
      pct: normalShare * 100,
      tone: modeTone,
      note: directProbes.length ? (
        <span className="vn-probes" aria-label="Прямые проверки ядра">
          {directProbes.map((p) => (
            <span key={p.url} className={`vn-probe ${p.ok ? "is-ok" : "is-bad"}`} title={`${p.url} · ${p.allowed ? "из белого списка" : "зарубежный"}${p.error ? ` · ${p.error}` : ""}`}>
              <i aria-hidden="true">{p.ok ? "✓" : "×"}</i>
              {probeName(p.url)} {p.ok ? `${p.ms} мс` : FAIL_TEXT[p.fail || ""] || "нет ответа"}
            </span>
          ))}
        </span>
      ) : whitelistMin ? (
        `белые списки за сутки — ${ago(whitelistMin * 60)}`
      ) : (
        "за сутки без ограничений"
      ),
      onClick: () => setSeg(strip.length - 1),
    },
    {
      key: "nodes",
      title: "VPN-узлы",
      value: lastPoint ? number(lastPoint.working) : "—",
      unit: lastPoint ? `из ${number(lastPoint.total)} живы` : "",
      pct: lastPoint && lastPoint.total ? (lastPoint.working / lastPoint.total) * 100 : 0,
      tone: vpnOK ? "ok" : "bad",
      note: autoLeaf ? `сейчас ${autoLeaf.name === "DIRECT" ? "напрямую" : autoLeaf.name}${autoDelay && autoDelay > 0 ? ` · ${autoDelay} мс` : ""}` : "нет данных",
      onClick: () => onNavigate("proxies"),
    },
    {
      key: "services",
      title: "Сервисы",
      value: list.length ? String(working) : "—",
      unit: list.length ? `из ${list.length} открываются` : "",
      pct: list.length ? (working / list.length) * 100 : 0,
      tone: !list.length ? "idle" : down.length ? "warn" : "ok",
      note: !list.length ? "проверка ещё не прошла" : down.length ? `не открываются: ${down.map((s) => s.name).join(", ")}` : "все открываются",
      onClick: () => onNavigate("vpnsvc"),
    },
    {
      key: "bypass",
      title: "Обходы за месяц",
      value: (bypass.used / 1024 ** 3).toFixed(1).replace(".", ","),
      unit: bypass.gb ? `из ${bypass.gb} ГБ` : "ГБ",
      pct: bypass.gb ? Math.min(100, bypass.limitPct || 0) : 0,
      tone: bypass.limitPct != null && bypass.limitPct >= 90 ? "bad" : bypass.limitPct != null && bypass.limitPct >= 75 ? "warn" : "ok",
      note: bypass.gb ? "лимит обходов · что тратит →" : "лимит не задан · что тратит →",
      onClick: () => {
        location.hash = "#/traffic/bypass";
      },
    },
  ];
  const sel = strip[selSeg];
  const axis = day.length ? [day[0].t, day[Math.floor(day.length / 3)].t, day[Math.floor((day.length * 2) / 3)].t] : [];

  return (
    <div className="stack vn">
      <PageHeader page="vpn" />
      {err ? <p className="vn-err">{err}</p> : null}

      <section className={`vo-hero vo-${hero.tone}`} aria-label="Состояние интернета">
        <div className="vo-hero-top">
          <div className="vo-hero-text">
            <span className="vo-eyebrow">
              <i className="vo-pulse" aria-hidden="true" />
              {hero.eyebrow}
            </span>
            <h2>{hero.title}</h2>
            <p>{hero.text}</p>
          </div>
          <div className="vo-hero-actions">
            <a className="btn" href="#/why">
              Почему не открывается…
            </a>
            <button className="btn btn-primary" disabled={!!busy} onClick={() => void check()}>
              <Icon name="refresh" size={14} /> {busy === "all" ? "Проверяю…" : "Проверить всё"}
            </button>
          </div>
        </div>

        <div className="vo-tiles">
          {tiles.map((t) => (
            <button key={t.key} type="button" className="vo-tile" onClick={t.onClick}>
              <span className="vo-tile-title">{t.title}</span>
              <span className="vo-tile-value">
                <b>{t.value}</b>
                <span>{t.unit}</span>
              </span>
              <span className="vo-tile-bar">
                <span className={`vo-fill vo-fill-${t.tone}`} style={{ width: `${Math.max(t.pct ? 3 : 0, t.pct)}%` }} />
              </span>
              <span className="vo-tile-note">{t.note}</span>
            </button>
          ))}
        </div>

        {strip.length ? (
          <div className="vo-strip">
            <div className="vo-strip-head">
              <span className="vo-tile-title">Канал провайдера за сутки</span>
              <span className="vn-legend">
                <span>
                  <i className="vn-sq vn-m-normal" />
                  обычный
                </span>
                <span>
                  <i className="vn-sq vn-m-whitelist" />
                  белые списки
                </span>
                <span>
                  <i className="vn-sq vn-m-offline" />
                  без интернета
                </span>
              </span>
            </div>
            <div className="vo-segs">
              {strip.map((p, k) => (
                <button
                  key={p.t}
                  type="button"
                  className={`vn-m-${p.mode}${k === selSeg ? " is-sel" : ""}`}
                  style={{ flexGrow: p.n }}
                  aria-pressed={k === selSeg}
                  aria-label={`${hhmm(p.t)}–${k === strip.length - 1 ? "сейчас" : hhmm(p.end + 60)}, ${MODE_TEXT[p.mode]}`}
                  onClick={() => setSeg(k)}
                />
              ))}
            </div>
            <div className="vo-axis" aria-hidden="true">
              {axis.map((t) => (
                <span key={t}>{hhmm(t)}</span>
              ))}
              <span>сейчас {hhmm(day[day.length - 1].t)}</span>
            </div>
            {sel ? (
              <div className="vo-strip-sel">
                <b>
                  {hhmm(sel.t)}–{selSeg === strip.length - 1 ? "сейчас" : hhmm(sel.end + 60)}
                </b>
                <Pill tone={sel.mode === "normal" ? "ok" : sel.mode === "whitelist" ? "warn" : sel.mode === "offline" ? "bad" : "idle"}>{MODE_TEXT[sel.mode]}</Pill>
                <span>
                  {ago(sel.n * 60)}
                  {sel.mode === "whitelist" ? " — прямые узлы молчали, работали обходы" : sel.mode === "offline" ? " — канала не было" : sel.mode === "normal" ? " — без ограничений" : ""}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <DayChart proxies={proxies} main={day} />

      <div className="vo-cols">
        <section className="vo-panel vo-main" aria-label="Сервисы">
          <div className="vn-section-head">
            <h3>Чем пользуются дома</h3>
            <div className="vn-chips">
              <button className="vn-chip" onClick={() => setEditing(true)} disabled={!svc}>
                <Icon name="edit" size={13} /> Настроить
              </button>
              <a className="vn-chip" href="#/vpnsvc" onClick={(e) => (e.preventDefault(), onNavigate("vpnsvc"))}>
                Все {list.length} →
              </a>
            </div>
          </div>
          <div className="vo-grid">
            {shown.map((s) => {
              const t = tones[s.id];
              const last = s.history[s.history.length - 1];
              return (
                <button key={s.id} className={`vn-card${t.tone === "bad" ? " is-bad" : ""}`} onClick={() => setOpen(s.id)}>
                  <span className="vn-card-top">
                    <span className="vn-mono" aria-hidden="true">
                      {s.name.slice(0, 2)}
                    </span>
                    <span className="vn-card-name" title={`${s.name} — ${pathText(s)}`}>
                      <b>{s.name}</b>
                      <small>{pathText(s)}</small>
                    </span>
                  </span>
                  <span className="vn-card-foot">
                    <Pill tone={t.tone}>{t.text}</Pill>
                    <span>{last?.ok ? `${last.ms} мс` : "—"}</span>
                  </span>
                </button>
              );
            })}
            {!list.length ? <p className="mh-muted">Первая проверка сервисов пройдёт через минуту после запуска HomeNet.</p> : null}
          </div>
        </section>

        <aside className="vo-side">
          <section className="vo-panel" aria-label="Требует внимания">
            <h3>Требует внимания</h3>
            {issues.length ? (
              <div className="vo-issues">
                {issues.map((it) => (
                  <div key={it.key} className="vo-issue">
                    <i className={`vn-dot vn-${it.tone}`} />
                    <span>
                      <b>{it.title}</b>
                      <small>{it.sub}</small>
                      <span className="vo-issue-act">{it.action}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mh-muted">Ничего — всё работает.</p>
            )}
          </section>
          <section className="vo-panel" aria-label="Как идёт трафик">
            <div className="vn-section-head">
              <h3>Как идёт остальной трафик</h3>
              <a href="#/vroute" onClick={(e) => (e.preventDefault(), onNavigate("vroute"))}>
                Маршрутизация
              </a>
            </div>
            <ol className="vo-path">
              {(proxies.AUTO?.all || []).map((name, i) => {
                const g = proxies[name];
                const l = leaf(name);
                const d = l ? lastDelay(l, proxies.AUTO?.testUrl) : null;
                const cur = usedGroups.includes(name);
                const dead = d === 0;
                return (
                  <li key={name} className={cur ? "is-cur" : dead ? "is-dead" : ""}>
                    <span className="vo-path-no">{i + 1}</span>
                    <span className="vn-card-name">
                      <b>{name}</b>
                      <small>{cur && l ? `${l.name}${d && d > 0 ? ` · ${d} мс` : ""}` : dead ? "не отвечает" : g?.all ? `${g.all.length} узлов` : ""}</small>
                    </span>
                    {cur ? <Pill tone="ok">сейчас</Pill> : null}
                  </li>
                );
              })}
            </ol>
            <small className="mh-muted">Следующий вариант берётся, когда предыдущий не отвечает.</small>
          </section>
        </aside>
      </div>

      <Connectivity report={svc} onReport={setSvc} />

      <Usage known={knownSites} onAdd={addSite} />
      <Modal open={editing} onClose={() => setEditing(false)} size="lg" title="Чем пользуются дома" description="Свои сервисы, скрытые и порядок карточек">
        {editing && svc ? (
          <ServicesEditor
            catalog={svc.catalog}
            config={svc.config}
            onCancel={() => setEditing(false)}
            onSave={async (c) => {
              setSvc(await core.saveServicesConfig(c));
              setEditing(false);
            }}
          />
        ) : null}
      </Modal>
      <Modal open={!!current} onClose={() => setOpen("")} variant="drawer" size="md" title={current?.name || ""} description={current ? `${current.what}${current.url ? ` · ${current.url}` : ""}` : ""}>
        {current ? <ServiceDetail s={current} slow={slow} busy={busy === current.id} onCheck={() => void check(current.id)} onNodes={() => onNavigate("proxies")} /> : null}
      </Modal>
    </div>
  );
}

export function ServiceDetail({ s, slow, busy, onCheck, onNodes }: { s: ServiceState; slow: number; busy: boolean; onCheck: () => void; onNodes: () => void }) {
  const t = serviceTone(s, slow);
  const last = s.history[s.history.length - 1];
  const okShare = s.history.length ? Math.round((s.history.filter((r) => r.ok).length / s.history.length) * 100) : 0;
  // changes between results, newest first
  const events: Array<{ t: number; text: string }> = [];
  for (let i = s.history.length - 1; i > 0; i--) {
    const a = s.history[i - 1];
    const b = s.history[i];
    if (a.ok !== b.ok) events.push({ t: b.t, text: b.ok ? `Снова открывается · ${b.ms} мс` : `Перестал открываться: ${b.error || "нет ответа"}` });
  }
  const path = s.path || [];
  return (
    <div className="vn-detail">
      <div className={`vn-detail-state vn-${t.tone}-soft`}>
        <i className={`vn-dot vn-${t.tone}`} />
        <span>
          <b>
            {t.text}
            {last?.ok ? ` · ${last.ms} мс` : ""}
          </b>
          <small>{last ? `проверено в ${hhmm(last.t)}${last.error ? ` · ${last.error}` : ""}` : "ещё не проверялся"}</small>
        </span>
        <button className="btn btn-sm" disabled={busy} onClick={onCheck}>
          {busy ? "Проверяю…" : "Проверить"}
        </button>
      </div>
      <section>
        <h4>Как идёт трафик</h4>
        {s.kind === "dns" ? (
          <p className="mh-muted">Запросы устройств к публичным DNS отвечает DNS роутера (перехват DNS), узлы VPN для этого не нужны.</p>
        ) : (
          <ol className="vn-chain">
            {path.map((n, i) => (
              <li key={`${n}-${i}`} className={i === path.length - 1 ? "is-cur" : ""}>
                <span className="vn-chain-no">{i + 1}</span>
                <span>
                  <b>{n === "DIRECT" ? "Напрямую" : n}</b>
                  <small>{i === 0 ? "группа сервиса" : i === path.length - 1 ? "используется сейчас" : "выбрана группой выше"}</small>
                </span>
              </li>
            ))}
          </ol>
        )}
        {s.kind !== "dns" ? (
          <span className="vn-actions">
            {s.url ? (
              <a className="btn btn-sm" href={`#/why/${new URL(s.url).hostname}`}>
                Почему не открывается
              </a>
            ) : null}
            <button className="btn btn-sm" onClick={onNodes}>
              Узлы и ручной выбор
            </button>
          </span>
        ) : null}
      </section>
      <section>
        <h4>
          Последний час <span className="mh-muted">· открывался {okShare}% проверок</span>
        </h4>
        <span className="vn-bars vn-bars-tall">
          {Array.from({ length: 30 }, (_, i) => s.history[s.history.length - 30 + i]).map((r, i) => (
            <i
              key={i}
              className={!r ? "" : !r.ok ? "vn-bar-bad" : r.ms > slow ? "vn-bar-warn" : "vn-bar-ok"}
              style={r?.ok ? { height: `${Math.max(18, Math.min(100, r.ms / 15))}%` } : undefined}
              title={r ? `${hhmm(r.t)} · ${r.ok ? `${r.ms} мс` : r.error || "не открылся"}` : undefined}
            />
          ))}
        </span>
        <small className="mh-muted">Высота столбика — время ответа, красный — не открылся.</small>
      </section>
      <section>
        <h4>События</h4>
        {events.length ? (
          <div className="vn-events">
            {events.slice(0, 8).map((e) => (
              <span key={e.t}>
                <time>{hhmm(e.t)}</time>
                {e.text}
              </span>
            ))}
          </div>
        ) : (
          <p className="mh-muted">За последний час без перемен.</p>
        )}
      </section>
    </div>
  );
}
