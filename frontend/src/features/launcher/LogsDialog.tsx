import { useCallback, useEffect, useRef, useState } from "react";
import { containerLabel, type PlaceContainer } from "./placement";

// NPM-86: the tail of one container's log, asked from the computer's agent
// through the computer module. Read-only; administrators only.

const TAILS = [100, 300, 1000];

type Reply = { ok: boolean; error?: string; text?: string; truncated?: boolean };

export function LogsDialog({ container, onClose }: { container: PlaceContainer; onClose: () => void }) {
  const [tail, setTail] = useState(300);
  const [reply, setReply] = useState<Reply | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  const load = useCallback(async () => {
    setBusy(true);
    const q = new URLSearchParams({ host: container.host, context: container.context, id: container.id, tail: String(tail) });
    try {
      const r = await fetch("/api/integrations/pc/api/pc/logs?" + q);
      setReply(r.headers.get("content-type")?.includes("json") ? await r.json() : { ok: false, error: `Модуль ответил ${r.status}` });
    } catch {
      setReply({ ok: false, error: "Нет связи с роутером" });
    } finally {
      setBusy(false);
    }
  }, [container, tail]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [reply]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const lines = reply?.text ? reply.text.replace(/\n$/, "").split("\n").length : 0;
  return (
    <div className="hp-modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="hp-dialog" role="dialog" aria-modal="true" aria-label={`Логи ${container.name}`}>
        <header>
          <div>
            <strong>Логи · {containerLabel(container)}</strong>
            <small>
              {container.host_name} · {container.image.replace(/:[0-9a-f]{12,}$/, "")} · {container.status}
            </small>
          </div>
          <span className="hp-grow" />
          <span className="hp-view" role="radiogroup" aria-label="Сколько строк">
            {TAILS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={tail === n} className={tail === n ? "is-on" : ""} onClick={() => setTail(n)}>
                {n}
              </button>
            ))}
          </span>
          <button type="button" className="hp-btn" disabled={busy} onClick={() => void load()}>
            {busy ? "Загружаю…" : "Обновить"}
          </button>
          {reply?.text ? (
            <button type="button" className="hp-btn" onClick={() => void navigator.clipboard?.writeText(reply.text || "")}>
              Скопировать
            </button>
          ) : null}
          <button type="button" className="hp-btn is-quiet" aria-label="Закрыть" onClick={onClose}>
            ✕
          </button>
        </header>
        {reply && !reply.ok ? (
          <p className="hp-error" role="alert">
            {reply.error || "Логи не получены"}
          </p>
        ) : (
          <pre ref={box} className="hp-logs" tabIndex={0}>
            {reply ? reply.text || "Лог пуст" : "Загружаю…"}
          </pre>
        )}
        {reply?.ok ? (
          <footer>
            {lines} {lines % 10 === 1 && lines % 100 !== 11 ? "строка" : lines % 10 >= 2 && lines % 10 <= 4 && (lines % 100 < 10 || lines % 100 >= 20) ? "строки" : "строк"} · последние {tail}
            {reply.truncated ? " · обрезано до 512 КБ" : ""}
          </footer>
        ) : null}
      </section>
    </div>
  );
}
