import { useCallback, useEffect, useState } from "react";
import { core, type Board, type BoardDay } from "../api";
import { useHomeMode } from "../../../platform/module-base";
import { gb, hhmm, since } from "./VpnHome";
import "./board.css";

/*
 * VPN → Статистика (NPM-70, макеты «Как сеть работала» и «Как прошла неделя»).
 * Every chart says where its numbers come from: the core's rankings, or the
 * history HomeNet keeps (the channel by hour for 30 days, bypass by day,
 * answering servers by hour). Services by hour are not kept yet — said so.
 */

const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const WEEKDAY_LONG = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const FAIL_TEXT: Record<string, [string, string]> = {
  silent: ["Тишина", "ответа нет совсем — так выглядит блокировка по адресу сервера"],
  tls: ["Ошибка TLS", "шифрованное соединение не установилось"],
  reset: ["Сброс", "соединение оборвано — так выглядит блокировка по имени сайта"],
  http: ["Чужой ответ", "ответил не тот сайт"], body: ["Чужая страница", "страница подменена"], fail: ["Не прошёл", "без подробностей"],
};
const h = (min: number) => `${(min / 60).toFixed(min % 60 ? 1 : 0).replace(".", ",")} ч`;
const dayShort = (d: string, i: number, n: number) => (i === n - 1 ? "сегодня" : n > 7 ? String(new Date(`${d}T12:00:00`).getDate()) : WEEKDAY[new Date(`${d}T12:00:00`).getDay()]);
const dayLong = (d: string, i: number, n: number) => (i === n - 1 ? "сегодня" : n > 7 ? new Date(`${d}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : WEEKDAY_LONG[new Date(`${d}T12:00:00`).getDay()]);

function useBoardDays(days: 7 | 30) {
  const [board, setBoard] = useState<Board>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setBoard(await core.board(days)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [days]);
  useEffect(() => { void load(); }, [load]);
  return { board, error };
}

function Source({ real }: { real: boolean }) { return <span className="vb-source" data-real={real ? "yes" : undefined}>{real ? "данные роутера" : "пока не копится"}</span>; }

/** Hours a day in each channel mode: stacked columns, one per day. */
function ChannelDays({ days }: { days: BoardDay[] }) {
  const [hover, setHover] = useState<number>();
  const n = days.length;
  return <figure className="vb-fig">
    <div className="vb-cols" role="img" aria-label={days.map((d, i) => `${dayLong(d.day, i, n)}: обычный ${h(d.normal)}, белые списки ${h(d.whitelist)}, без интернета ${h(d.offline)}`).join("; ")} onPointerLeave={() => setHover(undefined)}>
      {days.map((d, i) => <div key={d.day} className="vb-col vb-col-stack" onPointerEnter={() => setHover(i)} data-active={hover === i ? "yes" : undefined}>
        <i className="vb-c-none" style={{ flexGrow: Math.max(0, 1440 - d.normal - d.whitelist - d.offline) }} /><i className="vb-c-off" style={{ flexGrow: d.offline }} /><i className="vb-c-wl" style={{ flexGrow: d.whitelist }} /><i className="vb-c-n" style={{ flexGrow: d.normal }} />
      </div>)}
    </div>
    <div className="vb-col-labels" aria-hidden="true">{days.map((d, i) => <span key={d.day}>{(n <= 7 || i % 5 === 0 || i === n - 1) ? dayShort(d.day, i, n) : ""}</span>)}</div>
    {hover !== undefined && <div className="vb-tip">{dayLong(days[hover].day, hover, n)}: обычный {h(days[hover].normal)} · белые списки {h(days[hover].whitelist)} · без интернета {h(days[hover].offline)}</div>}
    <figcaption className="vb-key"><span><i className="vb-c-n" />обычный</span><span><i className="vb-c-wl" />белые списки</span><span><i className="vb-c-off" />нет интернета</span><span><i className="vb-c-none" />нет данных</span></figcaption>
  </figure>;
}

function Columns({ values, labels, tip, unit, tone, aria }: { values: number[]; labels: string[]; tip: (i: number) => string; unit?: string; tone?: (i: number) => string; aria: string }) {
  const [hover, setHover] = useState<number>();
  const max = Math.max(1, ...values);
  return <figure className="vb-fig">
    <div className="vb-cols vb-cols-single" role="img" aria-label={aria} onPointerLeave={() => setHover(undefined)}>
      {values.map((v, i) => <div key={i} className="vb-col" onPointerEnter={() => setHover(i)} data-active={hover === i ? "yes" : undefined}><i className={tone?.(i) || "vb-c-n"} style={{ height: `${Math.max(v ? 2 : 0, v / max * 100)}%` }} /></div>)}
    </div>
    <div className="vb-col-labels" aria-hidden="true">{labels.map((l, i) => <span key={i}>{l}</span>)}</div>
    {hover !== undefined && <div className="vb-tip">{tip(hover)}{unit ? ` ${unit}` : ""}</div>}
  </figure>;
}

/** The share of successful checks per server, in tens of percent, both modes side by side. */
function Reliability({ bins }: { bins: Record<string, number[]> }) {
  const modes = [["whitelist", "При белых списках", "vb-c-wl"], ["normal", "При обычном интернете", "vb-c-n"]] as const;
  const max = Math.max(1, ...modes.flatMap(([m]) => bins[m] || []));
  return <div className="vb-rel">{modes.map(([m, title, cls]) => <figure key={m} className="vb-fig">
    <figcaption className="vb-fig-title">{title}</figcaption>
    <div className="vb-cols vb-cols-single" role="img" aria-label={`${title}: ${(bins[m] || []).map((v, i) => `${i * 10}–${i * 10 + 10}% удачных — ${v}`).join(", ")}`}>
      {(bins[m] || []).map((v, i) => <div key={i} className="vb-col" title={`${i * 10}–${i * 10 + 10}% удачных проверок: ${v} серверов`}><b>{v || ""}</b><i className={cls} style={{ height: `${v ? Math.max(3, Math.sqrt(v / max) * 100) : 0}%` }} /></div>)}
    </div>
    <div className="vb-col-labels" aria-hidden="true"><span>0%</span><span /><span /><span /><span /><span>50%</span><span /><span /><span /><span>100%</span></div>
  </figure>)}<p className="vb-muted">Высота столбцов сжата, числа над ними — точные.</p></div>;
}

function Latency({ lat, edges }: { lat: Record<string, number[]>; edges: number[] }) {
  const labels = [`< ${edges[0]} мс`, ...edges.slice(1).map((e, i) => `${edges[i]}–${e}`), `> ${(edges[edges.length - 1] / 1000).toString().replace(".", ",")} с`];
  const max = Math.max(1, ...(lat.whitelist || []), ...(lat.normal || []));
  return <div className="vb-lat" role="table" aria-label="Задержка отвечающих серверов">
    {labels.map((l, i) => <div key={l} className="vb-lat-row" role="row"><span role="rowheader">{l}</span>
      <span className="vb-lat-bars" role="cell"><i className="vb-c-wl" style={{ width: `${(lat.whitelist?.[i] || 0) / max * 100}%` }} /><i className="vb-c-n" style={{ width: `${(lat.normal?.[i] || 0) / max * 100}%` }} /></span>
      <b role="cell">{lat.whitelist?.[i] || 0} / {lat.normal?.[i] || 0}</b></div>)}
    <div className="vb-key"><span><i className="vb-c-wl" />белые списки</span><span><i className="vb-c-n" />обычный</span></div>
  </div>;
}

function SimpleStats({ b }: { b: Board }) {
  const days = b.week || [];
  const limited = days.filter(d => d.whitelist > 30).length;
  const offline = days.filter(d => d.offline > 30).length;
  const known = days.filter(d => d.normal + d.whitelist + d.offline > 0).length;
  const bypass = days.reduce((a, d) => a + d.bypass, 0);
  const bad = b.services.items.filter(s => s.checked && s.ok === false);
  const summary = !known ? "Истории пока мало — HomeNet начал её копить недавно."
    : `${offline ? `Интернета не было в ${offline} ${offline === 1 ? "день" : "дня"} из ${known}.` : "Интернет был всегда."} ${limited ? `${limited} ${limited === 1 ? "день" : limited < 5 ? "дня" : "дней"} провайдер ограничивал — работали через обход.` : "Провайдер не ограничивал."} ${bad.length ? `Сейчас не открывается: ${bad.map(s => s.name).join(", ")}.` : "Сейчас всё открывается."}`;
  return <div className="vb-simple">
    <h1 className="vb-verdict">Как прошла неделя</h1>
    <p className="vb-explain">{summary}</p>
    <section className="vb-tile"><h2>Когда провайдер ограничивал интернет</h2>
      <ul className="vb-daylist">{days.map((d, i) => { const total = d.normal + d.whitelist + d.offline; return <li key={d.day}><span>{dayLong(d.day, i, days.length)}</span>
        <span className="vb-dayline" aria-hidden="true"><i className="vb-c-n" style={{ flexGrow: d.normal }} /><i className="vb-c-wl" style={{ flexGrow: d.whitelist }} /><i className="vb-c-off" style={{ flexGrow: d.offline }} />{!total && <i className="vb-c-none" style={{ flexGrow: 1 }} />}</span>
        <small>{!total ? "нет данных" : d.whitelist + d.offline === 0 ? "весь день свободно" : d.normal === 0 && d.offline === 0 ? "весь день ограничения" : `ограничения ${h(d.whitelist)}${d.offline ? `, без интернета ${h(d.offline)}` : ""}`}</small></li>; })}</ul>
      <div className="vb-key"><span><i className="vb-c-n" />без ограничений</span><span><i className="vb-c-wl" />только разрешённые сайты — работали через обход</span><span><i className="vb-c-off" />нет интернета</span></div>
    </section>
    <section className="vb-tile"><h2>Сколько ушло через обход</h2><p className="vb-big">{gb(bypass)}</p><p className="vb-muted">за {days.length} дней</p>
      <Columns values={days.map(d => d.bypass / 2 ** 30)} labels={days.map((d, i) => dayShort(d.day, i, days.length))} tip={i => `${dayLong(days[i].day, i, days.length)}: ${gb(days[i].bypass)}`} aria={days.map((d, i) => `${dayLong(d.day, i, days.length)} ${gb(d.bypass)}`).join(", ")} /></section>
    <section className="vb-tile"><h2>Что не открывается</h2>
      {bad.length ? <ul className="vb-plain">{bad.map(s => <li key={s.id}><b>{s.name}</b> <span className="vb-muted">{since(s.since)}{s.error ? ` · ${s.error}` : ""}</span></li>)}</ul> : <p>Все {b.services.total} сервисов открываются.</p>}
      <p className="vb-muted">Историю сервисов по дням HomeNet пока не хранит — показано, что сейчас.</p></section>
  </div>;
}

function ProStats({ b, period, setPeriod }: { b: Board; period: 7 | 30; setPeriod: (p: 7 | 30) => void }) {
  const days = b.week || [];
  const hours = b.hours || [];
  const s = b.servers;
  const fails = s ? Object.entries(s.fails).sort((a, c) => c[1] - a[1]) : [];
  const failTotal = fails.reduce((a, [, v]) => a + v, 0);
  const bypass = days.reduce((a, d) => a + d.bypass, 0);
  return <div className="vb-pro">
    <header className="vb-pro-head"><h1>Как сеть работала</h1><p>Наведите на столбец — увидите значение. У каждого графика пометка, откуда данные.</p></header>
    <div className="vb-seg" role="group" aria-label="Период">{([7, 30] as const).map(p => <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}>{p === 7 ? "Неделя" : "Месяц"}</button>)}</div>
    <div className="vb-charts">
      <section className="vb-card vb-wide"><header><h2>Сколько часов в день провайдер ограничивал</h2><Source real /></header><ChannelDays days={days} /></section>
      <section className="vb-card"><header><h2>Сколько серверов отвечало · сутки</h2><Source real={hours.length > 0} /></header>
        {hours.length ? <Columns values={hours.map(x => x.working)} labels={hours.map((x, i) => (i % 6 === 0 ? hhmm(new Date(x.t * 1000).toISOString()) : ""))} tip={i => `${hhmm(new Date(hours[i].t * 1000).toISOString())} — отвечало ${hours[i].working}${hours[i].whitelist ? " · белые списки" : ""}`} tone={i => (hours[i].whitelist ? "vb-c-wl" : "vb-c-n")} aria={`Отвечающие серверы по часам: ${hours.map(x => x.working).join(", ")}`} /> : <p className="vb-muted">История копится.</p>}
        <div className="vb-key"><span><i className="vb-c-n" />обычный час</span><span><i className="vb-c-wl" />час с белыми списками</span></div></section>
      <section className="vb-card"><header><h2>Через обходы за {period === 7 ? "неделю" : "месяц"} · {gb(bypass)}</h2><Source real /></header>
        <Columns values={days.map(d => d.bypass / 2 ** 30)} labels={days.map((d, i) => ((days.length <= 7 || i % 5 === 0 || i === days.length - 1) ? dayShort(d.day, i, days.length) : ""))} tip={i => `${dayLong(days[i].day, i, days.length)}: ${gb(days[i].bypass)}`} aria={days.map((d, i) => `${dayLong(d.day, i, days.length)} ${gb(d.bypass)}`).join(", ")} /></section>
      {s && <section className="vb-card vb-wide"><header><h2>Насколько надёжны {b.provider?.total} серверов — по режимам</h2><Source real /></header>
        <p className="vb-muted">Надёжных при белых списках — {s.stable.whitelist || 0}, при обычном интернете — {s.stable.normal || 0}.</p><Reliability bins={s.bins} /></section>}
      {s && <section className="vb-card"><header><h2>Насколько быстры отвечающие серверы</h2><Source real /></header><p className="vb-muted">средняя задержка проверки; серверов при белых списках / при обычном</p><Latency lat={s.latency} edges={s.latency_edges} /></section>}
      {s && <section className="vb-card"><header><h2>Почему не отвечают остальные</h2><Source real /></header><p className="vb-muted">неудачные пробы последнего обхода · {failTotal}</p>
        <ul className="vb-fail-list">{fails.map(([k, v]) => <li key={k}><span className="vb-failbar"><i data-kind={k} style={{ width: `${v / Math.max(1, failTotal) * 100}%` }} /></span><b>{(FAIL_TEXT[k] || [k])[0]} · {v} ({Math.round(v / Math.max(1, failTotal) * 100)}%)</b><small>{(FAIL_TEXT[k] || ["", ""])[1]}</small></li>)}</ul></section>}
      <section className="vb-card"><header><h2>Когда сервисы не открывались</h2><Source real={false} /></header><p className="vb-muted">Сейчас HomeNet хранит проверки сервисов за последний час. История по часам за сутки — следующий шаг; пока смотрите раздел «Сервисы».</p></section>
    </div>
  </div>;
}

export function VpnStats() {
  const mode = useHomeMode();
  const [period, setPeriod] = useState<7 | 30>(7);
  const { board, error } = useBoardDays(mode === "simple" ? 7 : period);
  if (!board) return <div className="vb">{error ? <div className="vb-alert" role="alert">Не удалось получить данные: {error}</div> : <p className="vb-muted" role="status">Собираю статистику…</p>}</div>;
  return <div className="vb">{mode === "simple" ? <SimpleStats b={board} /> : <ProStats b={board} period={period} setPeriod={setPeriod} />}</div>;
}
