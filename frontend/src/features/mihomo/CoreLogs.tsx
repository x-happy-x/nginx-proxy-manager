import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { EmptyState, SearchInput, Segmented } from "../../components/ui/controls";
import { number } from "../../lib/format";
import { logStore, useLogs, type LogLevel } from "./stores";

const LEVELS: Array<[LogLevel, string, string]> = [
  ["debug", "debug", "всё, включая проверки узлов и служебные строки"],
  ["info", "info", "соединения и события"],
  ["warning", "warning", "предупреждения и ошибки"],
  ["error", "error", "только ошибки"],
];
const LEVEL_ORDER = ["debug", "info", "warning", "error"];
const LIMITS = [500, 2000, 5000, 10000];

export function CoreLogs() {
  const { lines, level, limit, paused, live } = useLogs();
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [kind, setKind] = useState("");
  const [style, setStyle] = useState<"table" | "list">("table");

  useEffect(() => logStore.start(), []);

  const counts = useMemo(() => {
    const byLevel: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    lines.forEach((l) => {
      byLevel[l.type] = (byLevel[l.type] || 0) + 1;
      byKind[l.kind] = (byKind[l.kind] || 0) + 1;
    });
    return { byLevel, byKind };
  }, [lines]);

  let matcher: (s: string) => boolean = () => true;
  let regexError = "";
  const q = query.trim();
  if (q) {
    if (regex) {
      try {
        const re = new RegExp(q, "i");
        matcher = (s) => re.test(s);
      } catch {
        regexError = "регулярное выражение не разбирается";
      }
    } else {
      const lq = q.toLowerCase();
      matcher = (s) => s.toLowerCase().includes(lq);
    }
  }
  const visible = lines.filter((l) => shown[l.type] !== false && (!kind || l.kind === kind) && matcher(l.payload));
  const levels = Object.keys(counts.byLevel).sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
  const kinds = Object.entries(counts.byKind).sort((a, b) => b[1] - a[1]);

  const download = () => {
    const text = visible.map((l) => [String(l.seq).padEnd(6), l.time, l.type.padEnd(8), l.payload].join("\t")).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `mihomo-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <PageHeader
        page="corelog"
        actions={
          <>
            <span className="res-live">
              <span className={`res-live-dot${live && !paused ? "" : " is-off"}`} />
              {!live ? "нет связи" : paused ? "на паузе" : "в реальном времени"}
            </span>
            <button type="button" className="btn" onClick={() => logStore.setPaused(!paused)}>
              <Icon name={paused ? "play" : "pause"} />
              {paused ? "Продолжить" : "Пауза"}
            </button>
            <button type="button" className="btn" onClick={download} disabled={!visible.length}>
              <Icon name="download" />
              .log
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => logStore.clear()} disabled={!lines.length}>
              Очистить
            </button>
          </>
        }
      >
        Журнал собирается, пока открыта консоль. Уровень потока задаёт, что ядро присылает; ниже можно скрыть лишнее среди полученного.
      </PageHeader>

      <div className="toolbar">
        <Segmented<LogLevel>
          label="Уровень потока"
          value={level}
          onChange={(v) => logStore.setLevel(v)}
          options={LEVELS.map(([value, label]) => ({ value, label }))}
        />
        <span className="cell-sub">{LEVELS.find(([v]) => v === level)?.[2]}</span>
      </div>
      <div className="toolbar">
        <SearchInput label="Поиск по журналу" placeholder={regex ? "Регулярное выражение, например TCP.*youtube" : "Хост, узел, правило"} value={query} onChange={setQuery} />
        <label className="mh-check">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
          Regex
        </label>
        <select aria-label="Тип строк" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Все типы</option>
          {kinds.map(([k, n]) => (
            <option key={k} value={k}>
              {k} · {number(n)}
            </option>
          ))}
        </select>
        <select aria-label="Хранить строк" value={limit} onChange={(e) => logStore.setLimit(Number(e.target.value))}>
          {LIMITS.map((n) => (
            <option key={n} value={n}>
              хранить {number(n)}
            </option>
          ))}
        </select>
        <Segmented<"table" | "list">
          label="Вид"
          value={style}
          onChange={setStyle}
          options={[
            { value: "table", label: "Таблица" },
            { value: "list", label: "Строки" },
          ]}
        />
      </div>
      {levels.length ? (
        <div className="mh-levels" role="group" aria-label="Показывать уровни">
          {levels.map((l) => (
            <button key={l} type="button" aria-pressed={shown[l] !== false} className={`mh-level is-${l}${shown[l] === false ? " is-off" : ""}`} onClick={() => setShown({ ...shown, [l]: shown[l] === false })}>
              {l} <span>{number(counts.byLevel[l])}</span>
            </button>
          ))}
          {regexError ? <span className="mh-warn-text">{regexError}</span> : null}
        </div>
      ) : null}

      <section className="card card-flush">
        {visible.length ? (
          style === "table" ? (
            <div className="mh-log" role="log" aria-live="off">
              {visible.slice(0, 1500).map((l) => (
                <div key={l.seq} className={`mh-log-line is-${l.type}`}>
                  <span className="mh-log-time">{l.time}</span>
                  <span className="mh-log-level">{l.type}</span>
                  <span className="mh-log-text">
                    <span className="mh-log-kind">{l.kind}</span> {l.payload}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mh-log mh-log-list" role="log" aria-live="off">
              {visible.slice(0, 1500).map((l) => (
                <div key={l.seq} className={`mh-log-card is-${l.type}`}>
                  <div>
                    <span className="mh-log-level">{l.type}</span> <span className="mh-log-time">{l.time} · #{l.seq}</span>
                  </div>
                  <div className="mh-log-text">{l.payload}</div>
                </div>
              ))}
            </div>
          )
        ) : (
          <EmptyState icon="terminal" title={lines.length ? "Под фильтр ничего не попало" : "Пока пусто"}>
            {lines.length ? "Измените поиск, тип или включите скрытые уровни." : "Новые строки появятся сразу. Уровень debug показывает каждую проверку узла и служебные события."}
          </EmptyState>
        )}
        <div className="card-footer">
          Показано {number(Math.min(visible.length, 1500))} из {number(visible.length)} подходящих · всего {number(lines.length)} строк, хранится не больше {number(limit)}. Новые сверху.
        </div>
      </section>
    </div>
  );
}
