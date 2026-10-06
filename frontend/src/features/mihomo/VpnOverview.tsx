import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PageHeader, type PageKey } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { errText, number } from "../../lib/format";
import { core, mihomo, type HealthPoint, type MProvider, type MProxy, type ServiceState, type ServicesReport } from "./api";
import { useMihomo } from "./context";
import { HealthHistory } from "./HealthHistory";
import { useTailscaleIssues } from "./Extras";
import { useBypassStatus } from "./BypassTraffic";
import { lastDelay } from "./shared";

/*
 * VPN → «Сейчас» (NPM-47): does the internet work, and do the services people
 * use open. The state first, in plain words; nodes and delays live on their own
 * pages. Design: https://claude.ai/artifact/5YUqVHy44gRdfhKD2MSxWz
 */

type Tone = "ok" | "warn" | "bad" | "idle";
type Mode = "normal" | "whitelist" | "offline" | "unknown";

const MODE_TEXT: Record<Mode, string> = { normal: "обычный", whitelist: "белый список", offline: "без интернета", unknown: "не определён" };

function modeOf(p: HealthPoint): Mode {
  const m = Math.max(p.normal, p.whitelist, p.offline);
  if (!m) return "unknown";
  return p.offline === m ? "offline" : p.whitelist === m ? "whitelist" : "normal";
}

const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const ago = (sec: number) => (sec < 90 ? "только что" : sec < 3600 ? `${Math.round(sec / 60)} мин` : `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`);

/** Service state from its last results: a single miss is «медленно», two in a row «не открывается». */
function serviceTone(s: ServiceState, slow: number): { tone: Tone; text: string; downFor: number } {
  const h = s.history;
  if (!h.length) return { tone: "idle", text: "проверяется", downFor: 0 };
  const last = h[h.length - 1];
  let fails = 0;
  for (let i = h.length - 1; i >= 0 && !h[i].ok; i--) fails++;
  if (fails >= 2) return { tone: "bad", text: "не открывается", downFor: last.t - h[h.length - fails].t + 120 };
  if (!last.ok || last.ms > slow) return { tone: "warn", text: last.ok ? "медленно" : "сбой", downFor: 0 };
  return { tone: "ok", text: "открывается", downFor: 0 };
}

const leafName = (path?: string[]) => (path && path.length ? path[path.length - 1] : "");
function pathText(s: ServiceState) {
  const p = s.path || [];
  const leaf = leafName(p);
  if (s.kind === "dns") return "DNS роутера, без узлов";
  if (!leaf) return s.group;
  if (leaf === "DIRECT") return p.length > 2 ? `напрямую · через «${p[1]}»` : "напрямую";
  return p.length > 2 ? `${p[p.length - 2]} → ${leaf}` : leaf;
}

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`vn-pill vn-${tone}`}>{children}</span>;
}

function Bars({ s, slow }: { s: ServiceState; slow: number }) {
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
  const [main, setMain] = useState("");
  const [svc, setSvc] = useState<ServicesReport | null>(null);
  const [filter, setFilter] = useState<"all" | "bad" | "bypass">("all");
  const [open, setOpen] = useState<string>("");
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
        setMain(r.provider);
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

  // channel mode now and since when
  const modes = day.map(modeOf);
  const mode: Mode = modes.length ? modes[modes.length - 1] : "unknown";
  let since = day.length ? day[day.length - 1].t : 0;
  for (let i = modes.length - 1; i >= 0 && modes[i] === mode; i--) since = day[i].t;
  const lastPoint = day[day.length - 1];

  // VPN: what AUTO uses now
  const leaf = (name: string) => {
    let cur = proxies[name];
    for (let i = 0; cur && cur.now && i < 10; i++) cur = proxies[cur.now];
    return cur;
  };
  const autoLeaf = leaf("AUTO");
  const autoDelay = autoLeaf ? lastDelay(autoLeaf, proxies.AUTO?.testUrl) : null;
  const vpnOK = !!autoLeaf && autoLeaf.name !== "COMPATIBLE" && (autoDelay ?? 1) > 0;
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
      action: (
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

  const viaBypass = (s: ServiceState) => (s.path || []).some((n) => n === "Обходы" || n === "Каскад" || /обход/i.test(n));
  const shown = list.filter((s) => (filter === "bad" ? tones[s.id]?.tone === "bad" : filter === "bypass" ? viaBypass(s) : true));
  const current = list.find((s) => s.id === open);

  return (
    <div className="stack vn">
      <PageHeader
        page="vpn"
        actions={
          <button className="btn btn-sm" disabled={!!busy} onClick={() => void check()}>
            <Icon name="refresh" size={14} /> {busy === "all" ? "Проверяю…" : "Проверить всё"}
          </button>
        }
      />
      {err ? <p className="vn-err">{err}</p> : null}

      <section className={`vn-hero vn-hero-${hero.tone}`} aria-label="Состояние интернета">
        <div className="vn-hero-main">
          <span className="vn-hero-ic">
            <Icon name={hero.icon} size={26} />
          </span>
          <div className="vn-hero-text">
            <span className="vn-eyebrow">{hero.eyebrow}</span>
            <h2>{hero.title}</h2>
            <p>{hero.text}</p>
          </div>
        </div>
        <div className="vn-layers">
          <div className="vn-layer">
            <i className={`vn-dot vn-${mode === "normal" ? "ok" : mode === "whitelist" ? "warn" : mode === "offline" ? "bad" : "idle"}`} />
            <span>
              <b>Канал провайдера</b>
              <small>{mode === "whitelist" ? "напрямую — только белый список" : mode === "normal" ? "без ограничений" : mode === "offline" ? "нет связи" : "режим ещё определяется"}</small>
            </span>
            <Pill tone={mode === "normal" ? "ok" : mode === "whitelist" ? "warn" : mode === "offline" ? "bad" : "idle"}>{MODE_TEXT[mode]}</Pill>
          </div>
          <div className="vn-layer">
            <i className={`vn-dot vn-${vpnOK ? "ok" : "bad"}`} />
            <span>
              <b>VPN</b>
              <small>
                {lastPoint ? `${number(lastPoint.working)} из ${number(lastPoint.total)} узлов · ` : ""}
                {autoLeaf ? `сейчас ${autoLeaf.name === "DIRECT" ? "напрямую" : autoLeaf.name}${autoDelay && autoDelay > 0 ? `, ${autoDelay} мс` : ""}` : "нет данных"}
              </small>
            </span>
            <Pill tone={vpnOK ? "ok" : "bad"}>{vpnOK ? "работает" : "не отвечает"}</Pill>
          </div>
          <div className="vn-layer">
            <i className={`vn-dot vn-${!list.length ? "idle" : down.length ? "bad" : "ok"}`} />
            <span>
              <b>Ваши сервисы</b>
              <small>{!list.length ? "проверка ещё не прошла" : down.length ? `не открываются ${down.map((s) => s.name).join(", ")}` : "все открываются"}</small>
            </span>
            <Pill tone={!list.length ? "idle" : down.length ? "bad" : "ok"}>{list.length ? `${working} из ${list.length}` : "—"}</Pill>
          </div>
        </div>
        {day.length ? (
          <div className="vn-strip">
            <div className="vn-strip-head">
              <span>Режим канала за сутки</span>
              <span className="vn-legend">
                <span><i className="vn-sq vn-m-normal" />обычный</span>
                <span><i className="vn-sq vn-m-whitelist" />белый список</span>
                <span><i className="vn-sq vn-m-offline" />без интернета</span>
              </span>
            </div>
            <div className="vn-strip-cells">
              {day.map((p, i) => (
                <i key={p.t} className={`vn-m-${modes[i]}`} title={`${hhmm(p.t)} · ${MODE_TEXT[modes[i]]}`} />
              ))}
            </div>
            <div className="vn-strip-axis">
              <span>{hhmm(day[0].t)}</span>
              <span>{hhmm(day[Math.floor(day.length / 2)].t)}</span>
              <span>сейчас</span>
            </div>
          </div>
        ) : null}
      </section>

      {issues.length ? (
        <section aria-label="Требует внимания" className="vn-section">
          <h3>Требует внимания</h3>
          <div className="vn-issues">
            {issues.map((it) => (
              <div key={it.key} className="vn-issue">
                <i className={`vn-dot vn-${it.tone}`} />
                <span>
                  <b>{it.title}</b>
                  <small>{it.sub}</small>
                </span>
                {it.action}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-label="Сервисы" className="vn-section">
        <div className="vn-section-head">
          <h3>
            Чем пользуются дома <span>· проверка раз в 2 минуты через те же правила, что у устройств</span>
          </h3>
          <div className="vn-chips" role="group" aria-label="Фильтр">
            <button className={`vn-chip${filter === "all" ? " is-on" : ""}`} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              Все {list.length}
            </button>
            <button className={`vn-chip${filter === "bad" ? " is-on" : ""}`} aria-pressed={filter === "bad"} onClick={() => setFilter("bad")}>
              Не открываются {down.length}
            </button>
            <button className={`vn-chip${filter === "bypass" ? " is-on" : ""}`} aria-pressed={filter === "bypass"} onClick={() => setFilter("bypass")}>
              Через обходы {list.filter(viaBypass).length}
            </button>
          </div>
        </div>
        <div className="vn-grid">
          {shown.map((s) => {
            const t = tones[s.id];
            const last = s.history[s.history.length - 1];
            return (
              <button key={s.id} className={`vn-card${t.tone === "bad" ? " is-bad" : ""}`} onClick={() => setOpen(s.id)}>
                <span className="vn-card-top">
                  <span className="vn-mono" aria-hidden="true">{s.name.slice(0, 2)}</span>
                  <span className="vn-card-name">
                    <b>{s.name}</b>
                    <small>{s.what}</small>
                  </span>
                  <Pill tone={t.tone}>{t.text}</Pill>
                </span>
                <Bars s={s} slow={slow} />
                <span className="vn-card-foot">
                  <span className="truncate">{pathText(s)}</span>
                  <span>{last?.ok ? `${last.ms} мс` : "—"}</span>
                </span>
              </button>
            );
          })}
          {!list.length ? <p className="mh-muted">Первая проверка сервисов пройдёт через минуту после запуска HomeNet.</p> : null}
        </div>
      </section>

      <div className="vn-row">
        <section className="vn-flow" aria-label="Как идёт трафик">
          <div className="vn-section-head">
            <h3>Как сейчас идёт трафик</h3>
            <a href="#/coreconfig/routing" onClick={(e) => (e.preventDefault(), onNavigate("coreconfig"))}>
              Настройка
            </a>
          </div>
          <div className="vn-path">
            {(proxies.AUTO?.all || []).map((name, i) => {
              const g = proxies[name];
              const l = leaf(name);
              const d = l ? lastDelay(l, proxies.AUTO?.testUrl) : null;
              const cur = usedGroups.includes(name);
              const dead = d === 0;
              return (
                <span key={name} className="vn-path-step">
                  {i ? <span className="vn-arrow">→</span> : null}
                  <span className={`vn-step${cur ? " is-cur" : dead ? " is-dead" : ""}`}>
                    <b>
                      {i + 1} · {name}
                    </b>
                    <small>{cur && l ? `${l.name}${d && d > 0 ? ` · ${d} мс` : ""}` : dead ? "не отвечает" : g?.all ? `${g.all.length} узлов` : ""}</small>
                  </span>
                </span>
              );
            })}
          </div>
          <p className="mh-muted">Следующий вариант берётся, когда предыдущий не отвечает. Прямые серверы быстрее и не тратят лимит обходов.</p>
        </section>
        <section className="vn-limit" aria-label="Лимит обходов">
          <h3>Лимит обходов</h3>
          {bypass.gb ? (
            <>
              <div className="vn-big">
                {(bypass.used / 1024 ** 3).toFixed(1).replace(".", ",")} <span>из {bypass.gb} ГБ</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${Math.min(100, bypass.limitPct || 0)}%` }} />
              </div>
            </>
          ) : (
            <p className="mh-muted">Лимит не задан.</p>
          )}
          <a href="#/traffic/bypass">Что тратит обходы</a>
        </section>
      </div>

      {main ? <HealthHistory provider={main} /> : null}

      <Modal open={!!current} onClose={() => setOpen("")} variant="drawer" size="md" title={current?.name || ""} description={current ? `${current.what}${current.url ? ` · ${current.url}` : ""}` : ""}>
        {current ? <ServiceDetail s={current} slow={slow} busy={busy === current.id} onCheck={() => void check(current.id)} onNodes={() => onNavigate("proxies")} /> : null}
      </Modal>
    </div>
  );
}

function ServiceDetail({ s, slow, busy, onCheck, onNodes }: { s: ServiceState; slow: number; busy: boolean; onCheck: () => void; onNodes: () => void }) {
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
          <button className="btn btn-sm" onClick={onNodes}>
            Узлы и ручной выбор
          </button>
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
