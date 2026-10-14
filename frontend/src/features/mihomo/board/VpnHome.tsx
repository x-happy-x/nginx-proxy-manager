import { useCallback, useEffect, useState } from "react";
import { core, type Board, type BoardDay, type BoardServer, type BoardService } from "../api";
import { useHomeMode } from "../../../platform/module-base";
import "./board.css";

/*
 * VPN → главная по макетам «Переработка» (NPM-70). «Просто»: одно предложение
 * о том, всё ли работает, три плитки с неделей и главная проблема с действием.
 * «Подробно»: плитки-вопросы — канал, проверка, серверы, группы, подписки,
 * сервисы; по клику — свой раздел.
 */

type Tone = "ok" | "warn" | "bad" | "none";
const TONE_TEXT: Record<Tone, string> = { ok: "работало весь день", warn: "были перебои", bad: "не работало", none: "нет данных" };
const MODE_TEXT: Record<string, string> = { normal: "Обычный интернет", whitelist: "Белые списки", offline: "Нет интернета", unknown: "Режим не определён" };
const FAIL_TEXT: Record<string, string> = { silent: "тишина", tls: "ошибка TLS", reset: "сброс", http: "чужой ответ", body: "чужая страница", fail: "не прошёл", skipped: "не проверялся", unknown: "нет данных" };
const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const hhmm = (iso?: string) => { if (!iso) return ""; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
export function since(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  const t = hhmm(iso);
  if (d.toDateString() === today.toDateString()) return `с ${t}`;
  if (d.toDateString() === y.toDateString()) return `с ${t} вчера`;
  return `с ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`;
}
export function ago(iso?: string) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(m)) return "";
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  return `в ${hhmm(iso)}`;
}
export const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(bytes >= 100 * 2 ** 30 ? 0 : 1).replace(".", ",")} ГБ`;
const dayLabel = (day: string, i: number, n: number) => (i === n - 1 ? "сегодня" : WEEKDAY[new Date(`${day}T12:00:00`).getDay()]);

export function useBoard() {
  const [board, setBoard] = useState<Board>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setBoard(await core.board()); setError(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60000);
    return () => clearInterval(timer);
  }, [load]);
  return { board, error, reload: load };
}

// a day of the channel: limited for a while — warn; offline — bad
function channelDay(d: BoardDay): Tone {
  const total = d.normal + d.whitelist + d.offline;
  if (!total) return "none";
  if (d.offline > 30) return "bad";
  return d.whitelist > 0 || d.offline > 0 ? "warn" : "ok";
}
function bypassDay(d: BoardDay): Tone {
  if (!d.working && !(d.normal + d.whitelist + d.offline)) return "none";
  return d.working >= 1 ? "ok" : "bad";
}

function Week({ days, tone, label }: { days: BoardDay[]; tone: (d: BoardDay) => Tone; label: string }) {
  return <div className="vb-week" role="img" aria-label={`${label}: ${days.map((d, i) => `${dayLabel(d.day, i, days.length)} — ${TONE_TEXT[tone(d)]}`).join(", ")}`}>
    <div className="vb-week-cells">{days.map((d, i) => <i key={d.day} data-tone={tone(d)} title={`${dayLabel(d.day, i, days.length)}: ${TONE_TEXT[tone(d)]}`} />)}</div>
    <div className="vb-week-days" aria-hidden="true">{days.map((d, i) => <span key={d.day}>{dayLabel(d.day, i, days.length)}</span>)}</div>
  </div>;
}

function Legend() {
  return <div className="vb-legend">{(["ok", "warn", "bad", "none"] as Tone[]).map(t => <span key={t}><i data-tone={t} />{TONE_TEXT[t]}</span>)}</div>;
}

const failing = (b: Board) => b.services.items.filter(s => s.checked && s.ok === false);
const currentNode = (b: Board): BoardServer | undefined => {
  const rows = b.servers?.rows[b.channel.mode === "whitelist" ? "whitelist" : "normal"] || [];
  return rows.find(r => r.selected?.includes("AUTO")) || rows.find(r => r.selected?.includes("Обходы")) || rows.find(r => r.selected?.length);
};

function Simple({ b, navigate, reload }: { b: Board; navigate: (p: string) => void; reload: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  const bad = failing(b);
  const mode = b.channel.mode;
  const stableNow = b.servers?.stable[mode === "whitelist" ? "whitelist" : "normal"] || 0;
  const node = currentNode(b);
  const verdict = mode === "offline" ? "Интернета нет" : !b.servers?.answering && mode === "whitelist" ? "Обход не работает" : bad.length === 0 ? "Всё работает" : bad.length <= 2 ? "Почти всё работает" : "Многое не открывается";
  const explain = mode === "whitelist"
    ? `Провайдер сейчас пускает только на разрешённые сайты, поэтому остальное идёт через серверы обхода.${bad.length ? " Вам ничего делать не нужно — кроме пунктов ниже." : " Вам ничего делать не нужно."}`
    : mode === "offline" ? "Провайдер не пускает в интернет совсем. HomeNet ждёт и переключится сам, как только связь вернётся."
      : `Интернет обычный, заблокированные сайты идут через серверы обхода.${bad.length ? " Ниже — что не открывается." : ""}`;
  const days = b.week || [];
  const check = async () => { setChecking(true); try { await core.checkServices(); await reload(); } finally { setChecking(false); } };
  const tiles = [
    { title: "Интернет", tone: (mode === "normal" ? "ok" : mode === "offline" ? "bad" : "warn") as Tone, state: mode === "whitelist" ? "Ограничен провайдером" : mode === "offline" ? "Нет связи" : mode === "normal" ? "Без ограничений" : "Не определён",
      text: mode === "whitelist" ? `${since(b.channel.since)} открываются только разрешённые сайты. Остальное — через обход.`.replace(/^с/, "С") : mode === "normal" ? `Провайдер пускает на любые сайты${b.channel.since ? `, ${since(b.channel.since)}` : ""}.` : b.channel.error || "Провайдер не отвечает.",
      week: <Week days={days} tone={channelDay} label="Интернет за неделю" /> },
    { title: "Обход блокировок", tone: (b.servers?.answering ? (stableNow ? "ok" : "warn") : "bad") as Tone, state: b.servers?.answering ? "Работает" : "Не работает",
      text: b.servers?.answering ? `${node ? `Сейчас через сервер «${node.name}». ` : ""}Надёжных серверов в запасе — ${stableNow}.` : "Ни один сервер обхода сейчас не отвечает. HomeNet перебирает их сам.",
      week: <Week days={days} tone={bypassDay} label="Обход за неделю" /> },
    { title: "Ваши сервисы", tone: (!b.services.total ? "none" : bad.length === 0 ? "ok" : bad.length > b.services.total / 2 ? "bad" : "warn") as Tone, state: !b.services.total ? "Нет данных" : bad.length ? `${b.services.ok} из ${b.services.total} открываются` : "Открываются",
      text: bad.length ? `Не открывается: ${bad.map(s => s.name).join(", ")}.` : b.services.total ? `Все ${b.services.total} сайтов, которыми вы пользуетесь, открываются.` : "Проверка сервисов ещё не запускалась.",
      week: <p className="vb-muted">История по дням появится, когда HomeNet начнёт её копить.</p> },
  ];
  const main = bad[0];
  return <div className="vb-simple">
    <p className="vb-checked">{b.services.checked_at ? `Проверено ${ago(b.services.checked_at)} · ` : "Сервисы ещё не проверялись · "}<button type="button" className="vb-link" disabled={checking} onClick={() => void check()}>{checking ? "проверяю…" : "проверить ещё раз"}</button></p>
    <h1 className="vb-verdict">{verdict}</h1>
    <p className="vb-explain">{explain}</p>
    <div className="vb-tiles">{tiles.map(t => <section className="vb-tile" key={t.title} aria-label={t.title}>
      <h2>{t.title}</h2>
      <p className="vb-state"><i className="vb-dot" data-tone={t.tone} aria-hidden="true" />{t.state}</p>
      <p>{t.text}</p>
      {t.week}
    </section>)}</div>
    <Legend />
    {main && <section className="vb-problem" aria-label="Главная проблема">
      <h2>Не открывается {main.name}</h2>
      <p>{main.error ? `${main.error}. ` : ""}{main.since ? `${since(main.since).replace(/^с/, "С")}. ` : ""}HomeNet пробует серверы по очереди сам. Если срочно — разберите путь запроса: где именно он обрывается.</p>
      <div className="vb-actions"><button type="button" className="btn btn-primary" onClick={() => navigate("why")}>Почему не открывается</button><button type="button" className="btn" onClick={() => navigate("vpnsvc")}>Все сервисы</button></div>
    </section>}
  </div>;
}

function Tile({ q, title, tone, children, onOpen }: { q: string; title: string; tone: Tone; children: React.ReactNode; onOpen: () => void }) {
  return <button type="button" className="vb-q" data-tone={tone} onClick={onOpen}>
    <span className="vb-q-head">{q}</span>
    <span className="vb-q-title"><i className="vb-dot" data-tone={tone} aria-hidden="true" />{title}</span>
    <span className="vb-q-body">{children}</span>
  </button>;
}

function Pro({ b, navigate }: { b: Board; navigate: (p: string) => void }) {
  const s = b.servers;
  const mode = b.channel.mode === "whitelist" ? "whitelist" : "normal";
  const other = mode === "whitelist" ? "normal" : "whitelist";
  const best = (s?.rows[mode] || []).filter(r => r.stable).slice(0, 3);
  const bad = failing(b);
  const direct = b.channel.direct || [];
  const upd = b.provider_updates?.[b.provider_updates.length - 1];
  const fails = s ? Object.entries(s.fails).sort((a, c) => c[1] - a[1]) : [];
  return <div className="vb-pro">
    <header className="vb-pro-head"><h1>Где сейчас проблема</h1><p>Каждая плитка — один раздел: сверху её вопрос, ниже короткий ответ, по клику — подробности.</p></header>
    {b.core_error && <div className="vb-alert" role="alert">{b.core_error}</div>}
    <div className="vb-qgrid">
      <Tile q="Канал · что пускает провайдер?" title={`${MODE_TEXT[b.channel.mode] || b.channel.mode} ${since(b.channel.since)}`} tone={b.channel.mode === "normal" ? "ok" : b.channel.mode === "offline" ? "bad" : "warn"} onOpen={() => navigate("checks")}>
        {direct.length ? <>напрямую: {direct.map((d, i) => <span key={i} className="vb-probe" data-ok={d.ok ? "yes" : "no"}>{d.host} {d.ok ? `✓ ${d.ms} мс` : `✗ ${FAIL_TEXT[d.fail] || "нет"}`}</span>)}</> : b.channel.error || "нет прямых проб"}
      </Tile>
      <Tile q="Проверка · когда смотрели серверы?" title={b.provider?.checked_at ? `Последний обход ${ago(b.provider.checked_at)}` : "Нет данных"} tone={b.provider ? "ok" : "none"} onOpen={() => navigate("checks")}>
        {b.provider ? <>подписка {b.provider.name} · отложено {b.provider.pending} · ядро проверяет само, без кнопки</> : "ядро не отдало отчёт adaptive-проверки"}
      </Tile>
      <Tile q="Серверы · на кого можно положиться?" title={s ? `${s.answering} отвечают · ${s.stable[mode] || 0} надёжных` : "Нет данных"} tone={!s ? "none" : !s.answering ? "bad" : (s.stable[mode] || 0) < 3 ? "warn" : "ok"} onOpen={() => navigate("vservers")}>
        {best.length ? <>лучшие {mode === "whitelist" ? "при белых списках" : "сейчас"}: {best.map(r => `${r.name} ${pct(r.rate)}`).join(" · ")}</> : "надёжных нет"}
        {s && <><br />{other === "normal" ? "при обычном интернете" : "при белых списках"} надёжных {s.stable[other] || 0}{fails.length ? ` · молчат: ${fails.map(([k, v]) => `${FAIL_TEXT[k] || k} ${v}`).join(", ")}` : ""}</>}
      </Tile>
      <Tile q="Группы · кто не может выбрать сервер?" title={bad.length ? bad.map(x => x.group || x.name).filter((v, i, a) => a.indexOf(v) === i).join(", ") : "Все группы нашли рабочий сервер"} tone={bad.length ? "bad" : "ok"} onOpen={() => navigate("proxies")}>
        {bad.length ? bad.map(x => `${x.name}: ${x.path?.length ? `через ${x.path.slice(1).join(" → ")}` : "путь неизвестен"}${x.error ? ` — ${x.error}` : ""}`).join("; ") : "сервисы открываются через свои группы"}
      </Tile>
      <Tile q="Подписки · всё ли загрузилось?" title={b.provider ? `${b.provider.name}: ${b.provider.total} серверов` : "Нет данных"} tone={b.provider ? "ok" : "none"} onOpen={() => navigate("subs")}>
        {upd ? <>обновлена {ago(new Date(upd.t * 1000).toISOString())}{upd.added ? ` · новых ${upd.added}` : ""}{upd.via ? ` · через ${upd.via}` : ""}</> : "история обновлений пока пуста"}
      </Tile>
      <Tile q="Сервисы · что у меня открывается?" title={`${b.services.ok} из ${b.services.total}`} tone={bad.length ? (bad.length > b.services.total / 2 ? "bad" : "warn") : "ok"} onOpen={() => navigate("vpnsvc")}>
        <span className="vb-svc" aria-hidden="true">{b.services.items.map(x => <i key={x.id} data-tone={!x.checked ? "none" : x.ok ? "ok" : "bad"} title={x.name} />)}</span>
        {bad.length ? `не открывается: ${bad.map(x => x.name).join(", ")}` : "все открываются"}
      </Tile>
    </div>
    <p className="vb-muted">Маршруты и журнал — в разделах <a href="#/vroute">«Маршруты»</a> и <a href="#/corelog">«Журнал»</a>.</p>
  </div>;
}

export function VpnHome({ onNavigate }: { onNavigate: (page: string) => void }) {
  const mode = useHomeMode();
  const { board, error, reload } = useBoard();
  if (!board) return <div className="vb">{error ? <div className="vb-alert" role="alert">Не удалось получить данные: {error}</div> : <p className="vb-muted" role="status">Собираю состояние сети…</p>}</div>;
  return <div className="vb">{mode === "simple" ? <Simple b={board} navigate={onNavigate} reload={reload} /> : <Pro b={board} navigate={onNavigate} />}</div>;
}

export type { BoardService };
