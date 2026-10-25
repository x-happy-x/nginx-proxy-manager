import { useCallback, useEffect, useState } from "react";
import { call as api } from "./api";
import { bytes, errText } from "../../lib/format";
import { Icon } from "../../components/ui/Icon";
import "./sublab.css";

type Selection = { id: string; split: boolean };
type Item = { id: string; title: string; children: { id: string; title: string }[]; split_error?: string };
type Usage = { up: number; down: number; connections: number; active_seconds: number; observed: number; working: number; exclusive: number };
type Report = {
  url: string; token_set: boolean; every: number; groups: string[]; available_groups: string[]; selected: Selection[]; imported_id?: string;
  catalog: Item[] | null; managed: { key: string; title: string; provider: string; nodes: number; expire?: number; error?: string }[];
  catalog_at: number; last_sync: number; error?: string;
  usage: { provider: string; modes: Record<string, Usage>; advice: string; reason: string }[];
};
const root = "/api/core/sublab";
const when = (s: number) => s ? new Date(s * 1000).toLocaleString("ru-RU") : "ещё не было";
const modeName: Record<string, string> = { normal: "Обычный интернет", whitelist: "Белые списки", offline: "Нет сети", unknown: "Режим неизвестен" };
const time = (seconds: number) => seconds < 60 ? `${seconds} с` : seconds < 3600 ? `${Math.round(seconds / 60)} мин` : `${(seconds / 3600).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч`;

/** Catalog and credentials stay independent from the chosen source tab. */
export function SubLab({ onSynced }: { onSynced?: () => void }) {
  const [report, setReport] = useState<Report>();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [every, setEvery] = useState(0);
  const [url, setURL] = useState("https://sub.nl.cdn6.ru");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [title, setTitle] = useState("");
  const [sourceURL, setSourceURL] = useState("");
  const [tags, setTags] = useState("");
  const [shortURL, setShortURL] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const accept = useCallback((r: Report) => {
    setReport(r); setURL(r.url); setSelected(r.selected || []); setGroups(r.groups || []); setEvery(r.every);
  }, []);
  useEffect(() => { let live = true; void api<Report>(root).then(r => { if (live) accept(r); }).catch(e => { if (live) setError(errText(e)); }); return () => { live = false; }; }, [accept]);
  const action = async (kind: string, body: object, message: string) => {
    setBusy(kind); setError(""); setNote("");
    try {
      const r = await api<Report>(`${root}/${kind}`, { method: "POST", body: JSON.stringify(body) });
      accept(r); setNote(kind === "sync" && r.error ? "Доступные источники применены. Проверьте ошибки отдельных подписок ниже." : message);
      if (kind === "connect") { setPassword(""); setToken(""); }
      if (kind === "create") { setTitle(""); setSourceURL(""); setTags(""); }
      if (kind === "import") { setShortURL(""); const item = r.catalog?.find(i => i.id === r.imported_id); if (item) setSelected(s => [...s.filter(x => x.id !== item.id), { id: item.id, split: item.children.length > 0 }]); }
      if (kind === "sync") onSynced?.();
    } catch (e) { setError(errText(e)); if (kind === "create") setUncertain(true); }
    finally { setBusy(""); }
  };
  const toggle = (id: string, checked: boolean) => setSelected(s => checked ? [...s.filter(x => x.id !== id), { id, split: false }] : s.filter(x => x.id !== id));
  const changed = report && (JSON.stringify(selected) !== JSON.stringify(report.selected || []) || JSON.stringify(groups) !== JSON.stringify(report.groups || []) || every !== report.every);
  const configured = !!report?.token_set;
  return <section className="sl vs-block" aria-label="Интеграция Sub Lab">
    <header className="vs-block-head">
      <h2>Sub Lab</h2><span className="vs-muted">{configured ? `${report.managed.length} источников · синхронизация: ${when(report.last_sync)}` : "Подписки с вашей панели"}</span><span className="vs-grow" />
      <button type="button" className="sl-toggle" aria-expanded={open} onClick={() => setOpen(x => !x)}><Icon name="plus" size={14} /> {open ? "Свернуть" : configured ? "Подписки и статистика" : "Подключить Sub Lab"}</button>
    </header>
    {error && <p className="vs-warn" role="alert">{error}</p>}
    {report?.error && <p className="vs-warn" role="alert">Последняя синхронизация: {report.error}</p>}
    {note && <p className="sl-note" role="status">{note}</p>}
    {open && <>
      <details className="sl-card" open={!configured}>
        <summary>{configured ? `Подключение · ${report.url}` : "Войти в Sub Lab"}</summary>
        <form className="sl-form" onSubmit={e => { e.preventDefault(); void action("connect", { url, username, password, token }, "Подключено, каталог загружен"); }}>
          <label>Адрес панели<input type="url" required value={url} onChange={e => setURL(e.target.value)} /></label>
          <label>Логин Account<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} /></label>
          <label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
          <details className="sl-wide"><summary>Подключить токен сессии</summary><label>Токен<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></label></details>
          <p className="vs-muted sl-wide">Пароль используется только для входа. Сессия хранится на роутере; когда истечёт, войдите снова. При ошибке остаётся последняя рабочая версия подписок.</p>
          <div className="vs-actions sl-wide"><button type="submit" className="vs-primary" disabled={!!busy}>{busy === "connect" ? "Подключаю…" : configured ? "Обновить подключение" : "Войти и загрузить каталог"}</button></div>
        </form>
      </details>
      {configured && <>
        <div className="sl-card">
          <header className="vs-block-head"><h2>Выбрать подписки</h2><span className="vs-grow" /><div className="vs-actions"><button type="button" disabled={!!busy || !!changed} onClick={() => void action("refresh", {}, "Каталог обновлён")}>{busy === "refresh" ? "Обновляю…" : "Обновить каталог"}</button></div></header>
          <p className="vs-muted">Можно выбрать несколько. У объединения выберите: один общий источник или каждый входящий отдельно. Состав выбранного объединения обновляется при синхронизации.</p>
          <form className="sl-form" onSubmit={e => { e.preventDefault(); void action("import", { url: shortURL }, "Ссылка добавлена в выбор. Для объединения выбраны отдельные подписки; нажмите синхронизацию для применения."); }}><label className="sl-wide">Короткая ссылка из Sub Lab<input type="url" required value={shortURL} onChange={e => setShortURL(e.target.value)} placeholder={`${report.url}/l/…`} /></label><div className="vs-actions sl-wide"><button type="submit" disabled={!!busy || !!changed}>{busy === "import" ? "Читаю состав…" : "Выбрать по ссылке"}</button></div></form>
          <div className="sl-list">{(report.catalog || []).map(item => {
            const sel = selected.find(x => x.id === item.id);
            return <div className="sl-item" key={item.id}>
              <label className="sl-check"><input type="checkbox" checked={!!sel} disabled={!!busy} onChange={e => toggle(item.id, e.target.checked)} /><span><b>{item.title}</b><small>{item.children.length ? `Объединение · ${item.children.length} источников` : item.split_error ? "Объединение · состав недоступен" : "Обычная подписка"}</small></span></label>
              {!!sel && item.children.length > 0 && <label className="sl-split">Добавить<select value={sel.split ? "split" : "whole"} disabled={!!busy} onChange={e => setSelected(s => s.map(x => x.id === item.id ? { ...x, split: e.target.value === "split" } : x))}><option value="whole">Объединение целиком</option><option value="split">Все подписки по отдельности</option></select></label>}
              {!!sel?.split && <ul className="sl-children">{item.children.map(c => <li key={c.id}>{c.title}</li>)}</ul>}
              {item.split_error && <small className="vs-muted">Для просмотра состава нужны права редактора в Sub Lab. Можно добавить целиком.</small>}
            </div>;
          })}</div>
          {!report.catalog?.length && <p className="vs-muted">Каталог пуст. Добавьте подписку ниже или выдайте этому аккаунту доступ в Sub Lab.</p>}
          {selected.some(x => !report.catalog?.some(i => i.id === x.id)) && <div className="vs-warn">Часть выбранных подписок исчезла. Снимите их выбор, чтобы продолжить.{selected.filter(x => !report.catalog?.some(i => i.id === x.id)).map(x => <button type="button" key={x.id} onClick={() => toggle(x.id, false)}>Убрать {x.id}</button>)}</div>}
          <fieldset className="sl-groups"><legend>Добавить узлы в группы</legend>{report.available_groups.map(g => <label className="sl-check" key={g}><input type="checkbox" disabled={!!busy} checked={groups.includes(g)} onChange={e => setGroups(s => e.target.checked ? [...s, g] : s.filter(x => x !== g))} />{g}</label>)}</fieldset>
          <label className="sl-interval">Синхронизация<select value={every} disabled={!!busy} onChange={e => setEvery(Number(e.target.value))}><option value={0}>Только вручную</option><option value={3600}>Раз в час</option><option value={21600}>Раз в 6 часов</option><option value={86400}>Раз в сутки</option></select></label>
          {report.every > 0 && <div className="vs-actions"><button type="button" disabled={!!busy || !!changed} onClick={() => void action("pause", {}, "Расписание отключено. Подписки остались в конфиге.")}>Отключить расписание</button></div>}
          <p className="vs-muted">Применение обновит выбранные источники и состав групп. Если снять выбор, созданные HomeNet провайдеры и ссылки на них будут удалены. Конфиг проверяется ядром, при ошибке возвращается предыдущий.</p>
          <div className="vs-actions"><button type="button" className="vs-primary" disabled={!!busy || (!!selected.length && !groups.length)} onClick={() => void action("sync", { selected, groups, every }, "Подписки синхронизированы, конфиг применён")}>{busy === "sync" ? "Скачиваю, проверяю и применяю…" : changed ? "Синхронизировать и применить выбор" : "Синхронизировать сейчас"}</button>{changed && <button type="button" disabled={!!busy} onClick={() => accept(report)}>Отменить выбор</button>}</div>
        </div>
        <details className="sl-card"><summary>Добавить подписку в Sub Lab</summary>
          <form className="sl-form" onSubmit={e => { e.preventDefault(); void action("create", { title, url: sourceURL, tags: tags.split(",").map(x => x.trim()).filter(Boolean) }, "Подписка добавлена в Sub Lab. Теперь её можно выбрать выше."); }}>
            <label>Название<input required maxLength={100} value={title} onChange={e => setTitle(e.target.value)} /></label>
            <label className="sl-wide">Ссылка подписки<input required type="url" autoComplete="off" value={sourceURL} onChange={e => setSourceURL(e.target.value)} /></label>
            <label>Теги через запятую<input value={tags} onChange={e => setTags(e.target.value)} placeholder="router, reserve" /></label>
            <p className="vs-muted sl-wide">Создаст короткую ссылку и добавит её в избранное текущего аккаунта Sub Lab.</p>
            <div className="vs-actions sl-wide"><button type="submit" className="vs-primary" disabled={!!busy || uncertain}>{busy === "create" ? "Добавляю…" : "Добавить в Sub Lab"}</button>{uncertain && <button type="button" onClick={() => { setUncertain(false); setError(""); }}>Проверил Sub Lab, можно добавить</button>}<a href={report.url} target="_blank" rel="noreferrer">Открыть Sub Lab</a></div>
          </form>
        </details>
        {report.managed.length > 0 && <div className="sl-card"><header className="vs-block-head"><h2>Использование и продление</h2><span className="vs-muted">последние 30 дней</span></header>
          <p className="vs-muted">Активное время — интервалы, когда был замечен трафик. Доступность — минуты с проверенными рабочими серверами. Короткие соединения между опросами могут теряться; отсутствие трафика не доказывает бесполезность резерва.</p>
          <div className="sl-list">{report.managed.map(m => {
            const row = report.usage.find(u => u.provider === m.provider);
            return <article className="sl-usage" key={m.provider}>
              <header><b>{m.title}</b><span className="vs-muted">{m.nodes} серверов{m.expire ? ` · до ${new Date(m.expire * 1000).toLocaleDateString("ru-RU")}` : ""}</span><span className="sl-advice" data-advice={row?.advice}>{row?.advice === "keep" ? "Есть основания продлить" : row?.advice === "review" ? "Пересмотреть продление" : "Нужно больше наблюдений"}</span></header>
              {m.error && <p className="vs-warn" role="alert">{m.error}{m.nodes ? " · используется последняя сохранённая версия" : " · в конфиг пока не добавлена"}</p>}
              {row && <div className="sl-table-wrap"><table><thead><tr><th>Режим</th><th>Трафик</th><th>Активность</th><th>Соединения</th><th>Доступна / наблюдали</th><th>Единственный рабочий источник</th></tr></thead><tbody>{Object.entries(row.modes).map(([mode, u]) => <tr key={mode}><th>{modeName[mode] || mode}</th><td>{bytes(u.up + u.down)}</td><td>{time(u.active_seconds)}</td><td>{u.connections}</td><td>{u.working} / {u.observed} мин</td><td>{u.exclusive} мин</td></tr>)}</tbody></table></div>}
              <p className="vs-muted">{row?.reason || "История начнёт собираться после синхронизации, даже когда интерфейс закрыт."}</p>
            </article>;
          })}</div>
        </div>}
      </>}
    </>}
  </section>;
}
