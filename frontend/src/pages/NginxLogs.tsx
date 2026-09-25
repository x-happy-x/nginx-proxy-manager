import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { EmptyState, SearchInput, Segmented } from "../components/ui/controls";
import { number } from "../lib/format";
import { PageHeader } from "../navigation";

function lineTone(line: string): string {
  if (/\[(emerg|alert|crit|error)\]|" 5\d\d /.test(line)) return "log-error";
  if (/\[warn\]|" 4\d\d /.test(line)) return "log-warn";
  return "";
}

export function NginxLogs({
  busy,
  type,
  filter,
  limit,
  lines,
  onType,
  onFilter,
  onLimit,
  onRefresh,
}: {
  busy: boolean;
  type: "access" | "error";
  filter: string;
  limit: number;
  lines: string[];
  onType: (value: "access" | "error") => void;
  onFilter: (value: string) => void;
  onLimit: (value: number) => void;
  onRefresh: () => void;
}) {
  const [wrap, setWrap] = useState(false);
  const viewer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Newest lines are at the end; keep them in view after each load.
    if (viewer.current) viewer.current.scrollTop = viewer.current.scrollHeight;
  }, [lines]);

  return (
    <div className="stack">
      <PageHeader
        page="routing"
        actions={
          <button type="button" className="btn" onClick={onRefresh} disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="refresh" />}
            Обновить
          </button>
        }
      />
      <div className="toolbar">
        <Segmented
          label="Журнал"
          value={type}
          onChange={onType}
          options={[
            { value: "access", label: "Доступ" },
            { value: "error", label: "Ошибки" },
          ]}
        />
        <SearchInput
          label="Фильтр строк"
          placeholder="Подстрока — Enter для поиска"
          value={filter}
          onChange={onFilter}
          onSubmit={onRefresh}
        />
        <select aria-label="Количество строк" value={limit} onChange={(e) => onLimit(Number(e.target.value))}>
          {[100, 200, 500, 1000, 2000].map((n) => (
            <option key={n} value={n}>
              {n} строк
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost"
          aria-pressed={wrap}
          onClick={() => setWrap((v) => !v)}
          title="Переносить длинные строки"
        >
          <Icon name="wrap" />
          {wrap ? "Без переноса" : "Переносить"}
        </button>
      </div>
      <section className="card card-flush">
        {lines.length ? (
          <div ref={viewer} className={`log-viewer${wrap ? " wrap" : ""}`} role="log" aria-label="Строки журнала">
            {lines.map((line, i) => (
              <div key={i} className={`log-line ${lineTone(line)}`}>
                <span className="log-no" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="log-text">{line}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="terminal" title="Журнал пуст">
            {filter ? "По фильтру ничего не найдено." : "nginx ещё ничего не записал или журнал недоступен."}
          </EmptyState>
        )}
        <div className="card-footer">
          {number(lines.length)} строк · последние записи внизу
        </div>
      </section>
    </div>
  );
}
