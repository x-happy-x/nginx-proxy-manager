import { useEffect, useRef, useState } from "react";
import { PageHeader } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { EmptyState, SearchInput, Segmented } from "../../components/ui/controls";
import { number } from "../../lib/format";
import { openStream } from "./api";

type Level = "debug" | "info" | "warning" | "error";
type Line = { seq: number; time: string; type: string; payload: string };
const LIMIT = 1000;

export function CoreLogs() {
  const [level, setLevel] = useState<Level>("info");
  const [lines, setLines] = useState<Line[]>([]);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(false);
  const seq = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(
    () =>
      openStream<{ type: string; payload: string }>(
        `/logs?level=${level}`,
        (d) => {
          if (pausedRef.current) return;
          const line: Line = { seq: ++seq.current, time: new Date().toLocaleTimeString("ru-RU"), type: d.type, payload: d.payload };
          setLines((prev) => [line, ...prev].slice(0, LIMIT));
        },
        setLive,
      ),
    [level],
  );

  const q = query.trim().toLowerCase();
  const visible = q ? lines.filter((l) => l.payload.toLowerCase().includes(q)) : lines;

  const download = () => {
    const blob = new Blob([visible.map((l) => JSON.stringify(l)).join("\n")], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mihomo-log-${new Date().toISOString().slice(0, 10)}.jsonl`;
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
              <span className={`res-live-dot${live ? "" : " is-off"}`} />
              {live ? (paused ? "на паузе" : "в реальном времени") : "нет связи"}
            </span>
            <button type="button" className="btn" onClick={() => setPaused((p) => !p)}>
              <Icon name={paused ? "play" : "pause"} />
              {paused ? "Продолжить" : "Пауза"}
            </button>
            <button type="button" className="btn" onClick={download} disabled={!visible.length}>
              <Icon name="download" />
              JSONL
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setLines([])} disabled={!lines.length}>
              Очистить
            </button>
          </>
        }
      />
      <div className="toolbar">
        <SearchInput label="Фильтр строк" placeholder="Хост, узел, правило" value={query} onChange={setQuery} />
        <Segmented<Level>
          label="Уровень"
          value={level}
          onChange={(v) => {
            setLevel(v);
            setLines([]);
          }}
          options={[
            { value: "debug", label: "debug" },
            { value: "info", label: "info" },
            { value: "warning", label: "warning" },
            { value: "error", label: "error" },
          ]}
        />
      </div>
      <section className="card card-flush">
        {visible.length ? (
          <div className="mh-log" role="log" aria-live="off">
            {visible.map((l) => (
              <div key={l.seq} className={`mh-log-line is-${l.type}`}>
                <span className="mh-log-time">{l.time}</span>
                <span className="mh-log-level">{l.type}</span>
                <span className="mh-log-text">{l.payload}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="terminal" title="Пока пусто">
            Новые строки журнала ядра появятся здесь сразу. Уровень debug показывает каждое соединение.
          </EmptyState>
        )}
        <div className="card-footer">
          Показано {number(visible.length)} из {number(lines.length)} строк, новые сверху; хранится последние {number(LIMIT)} в этой вкладке.
        </div>
      </section>
    </div>
  );
}
