import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { Alert, Switch } from "../../components/ui/controls";
import { errText, number } from "../../lib/format";
import { core, mihomo, type ConfigChange, type CoreConfig, type MProvider, type MProxy, type RoutingSettings } from "./api";
import { useMihomo } from "./context";
import { lastDelay } from "./shared";

/*
 * «VPN → Настройка → Маршрутизация» (NPM-34): how mihomo picks a server for
 * each kind of traffic, drawn from the live groups, and the few settings the
 * manager builds the groups from.
 */

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*");
export const wordsMatcher = (words: string[]) => (words.length ? new RegExp(`(${words.map(esc).join("|")})`, "i") : null);
const flagOf = (cc: string) => String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
function countryOf(name: string): string {
  const m = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  if (!m) return "";
  return [...m[0]].map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1f1e6 + 65)).join("");
}
const splitWords = (v: string) => v.split(",").map((w) => w.trim()).filter(Boolean);
const COUNTRY: Record<string, string> = { US: "США", CA: "Канада", JP: "Япония", KR: "Корея", SG: "Сингапур", AU: "Австралия", KZ: "Казахстан", TR: "Турция", AE: "ОАЭ", IL: "Израиль", UA: "Украина", IN: "Индия", MY: "Малайзия", BR: "Бразилия", AR: "Аргентина", MX: "Мексика", CO: "Колумбия", PE: "Перу", ZA: "ЮАР", NG: "Нигерия", RU: "Россия", BY: "Беларусь", HK: "Гонконг", CN: "Китай", GB: "Великобритания", CH: "Швейцария", NO: "Норвегия" };

type Ctx = {
  proxies: Record<string, MProxy>;
  available: Record<string, boolean>;
};

function leaf(proxies: Record<string, MProxy>, name: string) {
  let cur = proxies[name];
  for (let i = 0; cur && cur.now && i < 10; i++) cur = proxies[cur.now];
  return cur;
}

/** "51 из 59" for a group over a provider, by the adaptive admission. */
function stat(c: Ctx, name: string): string {
  const g = c.proxies[name];
  if (!g?.all) return "";
  const all = g.all.filter((n) => n !== "COMPATIBLE");
  if (!all.length) return "нет узлов";
  const known = all.filter((n) => n in c.available);
  if (!known.length) {
    const alive = all.filter((n) => (lastDelay(c.proxies[n], g.testUrl) ?? 0) > 0).length;
    return `${alive} из ${all.length}`;
  }
  return `${known.filter((n) => c.available[n]).length} из ${all.length}`;
}

function Node({ n, title, sub, cur }: { n: ReactNode; title: string; sub: string; cur: boolean }) {
  return (
    <div className={`rt-node${cur ? " is-cur" : ""}`} title={`${title}${sub ? ` · ${sub}` : ""}`}>
      <span className="rt-no">{n}</span>
      <b>{title}</b>
      <small>{sub || "—"}</small>
    </div>
  );
}

const Cn = () => <span className="rt-cn" aria-hidden="true" />;

function nowText(c: Ctx, group: string) {
  const l = leaf(c.proxies, group);
  if (!l) return "нет данных";
  if (l.name === "COMPATIBLE") return "нет подходящих узлов";
  const d = lastDelay(l, c.proxies[group]?.testUrl);
  return (
    <>
      сейчас {l.name === "DIRECT" ? "напрямую" : l.name}
      {d != null ? <b className={d > 0 ? "rt-ok" : "rt-bad"}>{d > 0 ? `${d} мс` : "нет ответа"}</b> : null}
    </>
  );
}

function Row({ icon, title, sub, now, children }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; sub: string; now: ReactNode; children: ReactNode }) {
  return (
    <div className="rt-row">
      <div className="rt-head">
        <span className="rt-ic">
          <Icon name={icon} size={18} />
        </span>
        <span className="rt-title">
          <b>{title}</b>
          <small>{sub}</small>
        </span>
        <span className="rt-now">{now}</span>
      </div>
      <div className="rt-pipe">{children}</div>
    </div>
  );
}

/** A fallback group as numbered steps; the step in use is highlighted. */
function Steps({ c, group, sub, start = 1 }: { c: Ctx; group: string; sub?: (name: string) => string; start?: number }) {
  const g = c.proxies[group];
  if (!g?.all) return <span className="cell-sub">группы «{group}» нет в ядре</span>;
  return (
    <>
      {g.all.map((name, i) => (
        <span key={name} className="rt-step">
          {i ? <Cn /> : null}
          <Node n={start + i} title={name === "DIRECT" ? "Напрямую" : name} sub={sub ? sub(name) : stat(c, name)} cur={g.now === name} />
        </span>
      ))}
    </>
  );
}

function Flow({ c, s }: { c: Ctx; s: RoutingSettings }) {
  const auto = c.proxies.AUTO;
  const fast = c.proxies["Быстрые"];
  const pick = (name: string) => c.proxies[name]?.now || "";
  const loc = (name: string) => {
    const l = leaf(c.proxies, name);
    const d = l ? lastDelay(l, c.proxies[name]?.testUrl) : null;
    return d && d > 0 ? `${d} мс` : d === 0 ? "нет ответа" : "";
  };
  return (
    <div className="rt-flow">
      <Row icon="globe" title="Всё остальное" sub="AUTO · заблокированные, остальное, GLOBAL" now={nowText(c, "AUTO")}>
        {fast?.all ? (
          <div className="rt-box">
            <span className="rt-box-l">
              Быстрые · не медленнее <em>{s.fast_ms} мс</em>
            </span>
            {fast.all.map((name, i) => (
              <span key={name} className="rt-step">
                {i ? <Cn /> : null}
                <Node n={i + 1} title={name} sub={stat(c, name)} cur={auto?.now === "Быстрые" && fast.now === name} />
              </span>
            ))}
          </div>
        ) : null}
        {(auto?.all || [])
          .filter((n) => n !== "Быстрые")
          .map((name, i) => (
            <span key={name} className="rt-step">
              <Cn />
              <Node n={(fast?.all?.length || 0) + i + 1} title={name} sub={name === "Каскад" ? "⛓ через обход" : "без порога"} cur={auto?.now === name} />
            </span>
          ))}
      </Row>
      <Row icon="bolt" title="ИИ" sub={`category-ai · ${s.ai.length} стран${s.ai_service_check ? " · проверка страны и OpenAI API" : ""}`} now={nowText(c, "ИИ")}>
        <Steps c={c} group="ИИ" sub={(n) => (n === "Каскад" ? "⛓ через обход" : stat(c, n))} />
      </Row>
      <Row icon="home" title="РФ" sub=".ru, .рф, GeoIP RU · кроме белых списков" now={nowText(c, "РФ")}>
        <Steps c={c} group="РФ" sub={(n) => (n === "DIRECT" ? loc("РФ") || "проверка" : n === "RU" ? stat(c, "RU") : "любой")} />
      </Row>
      <Row icon="list" title="Белые списки" sub="ru_whitelist_domains" now={pick("Белые списки") === "DIRECT" ? "всегда напрямую" : nowText(c, "Белые списки")}>
        <Node n="✓" title={pick("Белые списки") === "DIRECT" ? "Напрямую" : pick("Белые списки") || "—"} sub="выбрано" cur />
        <span className="rt-side">вручную: {(c.proxies["Белые списки"]?.all || []).filter((n) => n !== pick("Белые списки")).slice(0, 4).join(" · ")}</span>
      </Row>
      <Row
        icon="key"
        title="Tailnt: вход в Tailscale"
        sub="headscale.tailnt.ru · keycloak.tailnt.ru"
        now={
          <>
            headscale <b className={loc("Headscale") && loc("Headscale") !== "нет ответа" ? "rt-ok" : "rt-bad"}>{loc("Headscale") || "—"}</b> · keycloak{" "}
            <b className={loc("Keycloak") && loc("Keycloak") !== "нет ответа" ? "rt-ok" : "rt-bad"}>{loc("Keycloak") || "—"}</b>
          </>
        }
      >
        <Steps c={c} group="Headscale" sub={(n) => (n === "DIRECT" ? "напрямую" : n === "RU" ? "🇷🇺" : "любой")} />
      </Row>
      <Row icon="layers" title="Игры" sub="ручной выбор" now="выбрано вручную">
        <Node n="✓" title={pick("Игры") === "DIRECT" ? "Напрямую" : pick("Игры") || "—"} sub="выбрано" cur />
        <span className="rt-side">{(c.proxies["Игры"]?.all || []).filter((n) => n !== pick("Игры")).slice(0, 5).join(" · ")}</span>
      </Row>
      <div className="rt-legend">
        <span>
          <i className="rt-lg-cur" />
          используется сейчас
        </span>
        <span>
          <i className="rt-lg-line" />
          запасной путь, если предыдущий не работает
        </span>
        <span>1, 2, 3 — порядок выбора</span>
      </div>
    </div>
  );
}

function WordsField({ label, value, onChange, hint, count }: { label: string; value: string[]; onChange: (v: string[]) => void; hint?: ReactNode; count?: ReactNode }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    if (splitWords(text).join(",") !== value.join(",")) setText(value.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="rt-field">
      <span className="rt-lab">
        <span>{label}</span>
        {count ? <small>{count}</small> : null}
      </span>
      <input
        className="mono"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(splitWords(e.target.value));
        }}
      />
      {hint}
    </label>
  );
}

export function Routing({ cfg, onApplied }: { cfg: CoreConfig; onApplied: () => Promise<void> }) {
  const { log, refreshStatus } = useMihomo();
  const [saved, setSaved] = useState<RoutingSettings | null>(null);
  const [s, setS] = useState<RoutingSettings | null>(null);
  const [meta, setMeta] = useState<{ managed?: boolean; saved?: boolean }>({});
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ valid: boolean; changes: ConfigChange[]; message?: string; detail?: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    core
      .routing()
      .then((r) => {
        setSaved(r.settings);
        setS(r.settings);
        setMeta({ managed: r.managed, saved: r.saved });
      })
      .catch((e) => setError(errText(e)));
  }, []);

  const loadLive = useCallback(async () => {
    try {
      const all = await mihomo.allProxies();
      setProxies(all.proxies);
      setProviders(all.providers);
    } catch {
      /* the flow shows "нет данных" */
    }
  }, []);
  useEffect(() => {
    void loadLive();
    const t = setInterval(() => document.visibilityState === "visible" && void loadLive(), 15000);
    return () => clearInterval(t);
  }, [loadLive]);

  const available = useMemo(() => {
    const out: Record<string, boolean> = {};
    Object.values(providers).forEach((p) => {
      Object.entries(p.adaptive?.results || {}).forEach(([n, r]) => {
        out[n] = !!r.available;
      });
    });
    return out;
  }, [providers]);

  const nodes = useMemo(() => (s ? (providers[s.base]?.proxies || []).map((p) => p.name) : []), [providers, s]);
  const bypassRE = useMemo(() => wordsMatcher(s?.bypass || []), [s?.bypass]);
  const junkRE = useMemo(() => wordsMatcher(s?.junk || []), [s?.junk]);
  const usable = nodes.filter((n) => !junkRE?.test(n));
  const bypassNodes = usable.filter((n) => bypassRE?.test(n));
  const plainNodes = usable.filter((n) => !bypassRE?.test(n));
  const junkNodes = nodes.filter((n) => junkRE?.test(n));

  const countries = useMemo(() => {
    const m = new Map<string, number>();
    usable.forEach((n) => {
      const c = countryOf(n);
      if (c) m.set(c, (m.get(c) || 0) + 1);
    });
    return m;
  }, [usable]);

  if (!s || !saved) {
    return error ? <Alert tone="danger" title="Настройки маршрутизации недоступны">{error}</Alert> : <div className="launcher-loading">Читаю настройки…</div>;
  }

  const set = <K extends keyof RoutingSettings>(k: K, v: RoutingSettings[K]) => setS({ ...s, [k]: v });
  const dirtyKeys = (Object.keys(s) as Array<keyof RoutingSettings>).filter((k) => JSON.stringify(s[k]) !== JSON.stringify(saved[k]));
  const euSet = new Set(s.eu);
  const euOn = s.eu.every((c) => s.ai.includes(c));
  const euCount = [...countries].filter(([c]) => euSet.has(c)).reduce((a, [, n]) => a + n, 0);
  const others = [...countries].filter(([c]) => !euSet.has(c)).sort((a, b) => b[1] - a[1]);
  const aiNodes = usable.filter((n) => s.ai.includes(countryOf(n))).length;
  const toggleAI = (codes: string[], on: boolean) => set("ai", on ? [...new Set([...s.ai, ...codes])] : s.ai.filter((c) => !codes.includes(c)));
  const c: Ctx = { proxies, available };
  const groupHealth = (name: string) => {
    const g = proxies[name];
    const l = g ? leaf(proxies, name) : undefined;
    const d = l ? lastDelay(l, g?.testUrl) : null;
    return d == null ? <span className="badge">нет данных</span> : d > 0 ? <span className="badge badge-success">{d} мс</span> : <span className="badge badge-danger">нет ответа</span>;
  };

  const check = async (thenApply: boolean) => {
    setBusy(true);
    try {
      const r = await core.checkRouting({ sha: cfg.sha, settings: s });
      setReview({ valid: r.valid, changes: r.changes || [], message: r.message, detail: r.detail });
      if (thenApply && r.valid && !(r.changes || []).length) await apply();
    } catch (err) {
      setReview({ valid: false, changes: [], message: errText(err) });
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await core.applyRouting({ sha: cfg.sha, settings: s });
      log("Маршрутизация", r.warning || r.message, r.warning ? "warning" : "success");
      setSaved(s);
      setMeta({ ...meta, managed: true, saved: true });
      setReview(null);
      await onApplied();
      void refreshStatus();
      void loadLive();
    } catch (err) {
      log("Маршрутизация", errText(err), "error");
      setReview((rv) => (rv ? { ...rv, valid: false, message: errText(err) } : rv));
    } finally {
      setBusy(false);
    }
  };

  const shown = showAll ? usable : [...bypassNodes.slice(0, 6), ...plainNodes.slice(0, 3)];

  return (
    <div className="stack">
      {!meta.managed ? (
        <Alert tone="info" title="Группы ещё не собраны HomeNet">
          Первое применение заменит группы из списка ниже на сгенерированные. Группы, которых HomeNet не знает (OLCRTC, Tailscale, свои), останутся как есть; правила не меняются, кроме двух правил Tailnt.
        </Alert>
      ) : null}
      <div className="rt-cols">
        <section className="card card-flush">
          <div className="card-header">
            <div>
              <h2 className="card-title">Как идёт трафик</h2>
              <p className="cell-sub">Синяя рамка — что используется сейчас. Обновляется каждые 15 секунд.</p>
            </div>
            {providers[s.base]?.adaptive ? (
              <span className={`badge ${providers[s.base].adaptive!.mode === "whitelist" ? "badge-warning" : providers[s.base].adaptive!.mode === "normal" ? "badge-success" : ""}`}>
                {providers[s.base].adaptive!.mode === "whitelist" ? "белые списки" : providers[s.base].adaptive!.mode === "normal" ? "сеть без ограничений" : providers[s.base].adaptive!.mode}
              </span>
            ) : null}
          </div>
          <Flow c={c} s={saved} />
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Настройки</h2>
              <p className="cell-sub">Меняют только группы HomeNet в config.yaml.</p>
            </div>
          </div>
          <div className="card-body rt-form">
            <WordsField
              label="Какие узлы — обходы"
              value={s.bypass}
              onChange={(v) => set("bypass", v)}
              count={nodes.length ? `${bypassNodes.length} из ${nodes.length}` : ""}
              hint={
                <>
                  <span className="rt-prev">
                    {shown.map((n) => (
                      <span key={n} className={`rt-nd${bypassRE?.test(n) ? " is-hit" : ""}`}>
                        {n}
                      </span>
                    ))}
                    {usable.length > shown.length || showAll ? (
                      <button type="button" className="rt-nd rt-more" onClick={() => setShowAll(!showAll)}>
                        {showAll ? "свернуть" : `все ${usable.length} →`}
                      </button>
                    ) : null}
                  </span>
                  <span className="rt-hint">Слова через запятую, без учёта регистра. Жёлтым — что попало в обходы. На обходах лимит трафика: они берутся, только когда прямые не подходят.</span>
                </>
              }
            />
            <WordsField label="Не использовать никогда" value={s.junk} onChange={(v) => set("junk", v)} count={`${junkNodes.length} ${junkNodes.length === 1 ? "узел" : "узлов"}`} hint={junkNodes.length ? <span className="rt-hint">{junkNodes.join(", ")}</span> : null} />
            <label className="rt-field">
              <span className="rt-lab">
                <span>Прямые не медленнее</span>
                <small>иначе — обход</small>
              </span>
              <span className="rt-range">
                <input type="range" min={200} max={2000} step={50} value={s.fast_ms} onChange={(e) => set("fast_ms", Number(e.target.value))} />
                <b className="mono">{s.fast_ms} мс</b>
              </span>
            </label>
            <div className="rt-field">
              <span className="rt-lab">
                <span>Страны для ИИ</span>
                <small>{number(aiNodes)} узлов</small>
              </span>
              <div className="mh-chips">
                <button type="button" className="mh-chip" aria-pressed={euOn} onClick={() => toggleAI(s.eu, !euOn)} title={s.eu.join(" ")}>
                  {flagOf("EU")} ЕС, GB, CH, NO <span className="count">{euCount}</span>
                </button>
                {others.map(([cc, n]) => {
                  const never = s.never.includes(cc);
                  const on = s.ai.includes(cc);
                  return (
                    <button key={cc} type="button" className={`mh-chip${never ? " is-never" : ""}`} aria-pressed={on} disabled={never} onClick={() => toggleAI([cc], !on)} title={never ? "сервисы ИИ здесь не работают" : COUNTRY[cc] || cc}>
                      {flagOf(cc)} {cc} <span className="count">{n}</span>
                    </button>
                  );
                })}
              </div>
              <span className="rt-hint">Зачёркнутые сервисы ИИ не поддерживают. Узлы дополнительно проверяются: страна выхода и ответ OpenAI API.</span>
            </div>
            <div className="rt-field">
              <span className="rt-lab">
                <span>Проверочные адреса</span>
              </span>
              <div className="rt-urls">
                <span>РФ вне белых</span>
                <input className="mono" aria-label="Проверка РФ" value={s.ru_check} onChange={(e) => set("ru_check", e.target.value)} />
                {groupHealth("РФ")}
                <span>Headscale</span>
                <input className="mono" aria-label="Проверка headscale" value={s.headscale_check} onChange={(e) => set("headscale_check", e.target.value)} />
                {groupHealth("Headscale")}
                <span>Keycloak</span>
                <input className="mono" aria-label="Проверка keycloak" value={s.keycloak_check} onChange={(e) => set("keycloak_check", e.target.value)} />
                {groupHealth("Keycloak")}
              </div>
              <span className="rt-hint">Справа — последняя проверка группы через выбранный путь.</span>
            </div>
            <Switch checked={s.cascade} onChange={(v) => set("cascade", v)} label="Каскад через обходы" hint="Если зарубежный сервер напрямую недоступен, соединение к нему идёт через обход. Последний вариант: тратит трафик обхода, задержка примерно вдвое больше." />
            <Switch checked={s.ai_service_check} onChange={(v) => set("ai_service_check", v)} label="Проверять узлы для ИИ" hint="Страна выхода по Cloudflare и ответ OpenAI API; узел из неподходящей страны не выбирается." />
          </div>
        </section>
      </div>

      {dirtyKeys.length || !meta.managed ? (
        <div className="changes-bar" role="region" aria-label="Несохранённые настройки маршрутизации">
          <div className="changes-row">
            <Icon name="alert" size={18} />
            <div className="changes-text">
              <strong>{dirtyKeys.length ? `Изменено настроек: ${dirtyKeys.length}` : "Группы можно собрать по этим настройкам"}</strong>
              <span>Перед применением — проверка mihomo -t и список изменений.</span>
            </div>
            <div className="button-row">
              {dirtyKeys.length ? (
                <button type="button" className="btn btn-ghost" onClick={() => setS(saved)} disabled={busy}>
                  Отменить
                </button>
              ) : null}
              <button type="button" className="btn btn-primary" onClick={() => void check(false)} disabled={busy || !cfg.can_validate}>
                {busy ? <span className="spinner" /> : <Icon name="test" />}
                Проверить и применить
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        open={!!review}
        onClose={() => !busy && setReview(null)}
        locked={busy}
        size="lg"
        title={review?.valid ? (review.changes.length ? "Изменения прошли проверку" : "Конфиг уже такой") : "Проверка не пройдена"}
        description={review?.message}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setReview(null)} disabled={busy}>
              Вернуться
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void apply()} disabled={busy || !review?.valid}>
              {busy ? <span className="spinner" /> : <Icon name="bolt" />}
              {review?.changes.length ? "Применить на роутере" : "Сохранить настройки"}
            </button>
          </>
        }
      >
        <div className="stack">
          {review?.detail ? <Alert tone="danger" title="Ответ mihomo -t">{review.detail}</Alert> : null}
          <ul className="mh-changes">
            {(review?.changes || []).map((ch, i) => (
              <li key={i} className={`is-${ch.kind}`}>
                <span className="mh-change-kind">{ch.kind === "added" ? "+" : ch.kind === "removed" ? "−" : "~"}</span>
                <span className="mono">{ch.section}</span>
                {ch.item ? <span className="mono truncate">{ch.item}</span> : null}
              </li>
            ))}
            {!review?.changes.length ? <li>Изменений в config.yaml нет.</li> : null}
          </ul>
          <p className="cell-sub">При применении: копия текущего файла → замена config.yaml → перечитывание через контроллер. Если ядро не примет конфиг, старый файл вернётся автоматически.</p>
        </div>
      </Modal>
    </div>
  );
}
