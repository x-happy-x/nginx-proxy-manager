import { useEffect, useMemo, useRef, useState } from "react";
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node as YNode } from "yaml";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { Alert } from "../../components/ui/controls";
import { dateTime, errText, number } from "../../lib/format";
import { core, type CoreConfig } from "./api";
import { useMihomo } from "./context";
import { CodeEditor, type EditorApi, type LineError } from "./CodeEditor";
import { DiffView, ReviewModal, type ReviewState } from "./Review";
import { ROUTING_MANAGED } from "./Routing";

/*
 * «VPN → Настройка → YAML» (NPM-35): the whole config.yaml in a code editor
 * with an outline of its sections, errors on their lines, the block HomeNet
 * generates marked, the versions kept on the router, and a line diff before
 * applying.
 */

type Outline = { key: string; line: number; count?: number; generated?: boolean; error?: boolean };

const SECTION_LABEL: Record<string, string> = { "proxy-providers": "proxy-providers", "proxy-groups": "proxy-groups", rules: "rules" };

function analyze(text: string) {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, keepSourceTokens: false, uniqueKeys: false });
  const lineOf = (offset?: number) => (offset == null ? 1 : lc.linePos(offset).line);
  const errors: LineError[] = [
    ...doc.errors.map((e) => ({ line: e.linePos?.[0].line || 1, message: e.message.split("\n")[0] })),
    ...doc.warnings.map((e) => ({ line: e.linePos?.[0].line || 1, message: e.message.split("\n")[0], severity: "warning" as const })),
  ];
  const outline: Outline[] = [];
  const generated: Array<[number, number]> = [];
  let firstPorts = -1;
  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      const key = isScalar(item.key) ? String(item.key.value) : "";
      const line = lineOf((item.key as YNode)?.range?.[0]);
      const v = item.value as YNode | null;
      const count = isSeq(v) ? v.items.length : isMap(v) ? v.items.length : undefined;
      if (key === "proxy-groups" || key === "proxy-providers" || key === "rules" || key === "dns" || key === "sniffer" || key === "proxies" || key === "rule-providers" || key === "hosts" || key === "tun") {
        outline.push({ key: SECTION_LABEL[key] || key, line, count });
      } else if (firstPorts < 0) {
        firstPorts = line;
      }
      if (key === "proxy-groups" && isSeq(v)) {
        let run: [number, number] | null = null;
        for (const g of v.items) {
          const name = isMap(g) ? String((g.get("name") as string) ?? "") : "";
          const r = (g as YNode).range;
          if (!r) continue;
          const a = lineOf(r[0]);
          const b = Math.max(a, lineOf(Math.max(r[0], r[1] - 1)));
          if (ROUTING_MANAGED.has(name)) {
            if (run && a <= run[1] + 2) run[1] = b;
            else {
              if (run) generated.push(run);
              run = [a, b];
            }
          }
        }
        if (run) generated.push(run);
      }
      if (key === "proxy-providers" && isMap(v)) {
        for (const p of v.items) {
          const pk = isScalar(p.key) ? String(p.key.value) : "";
          if (pk === "AI" || pk === "CHAIN") {
            outline.push({ key: "↳ AI, CHAIN (HomeNet)", line: lineOf((p.key as YNode)?.range?.[0]), generated: true });
            break;
          }
        }
      }
    }
  }
  if (firstPorts > 0) outline.unshift({ key: "Порты и режим", line: firstPorts });
  outline.sort((x, y) => x.line - y.line);
  for (let i = 0; i < outline.length; i++) {
    const end = outline[i + 1]?.line ?? Infinity;
    outline[i].error = errors.some((e) => e.severity !== "warning" && e.line >= outline[i].line && e.line < end);
  }
  return { errors, outline, generated };
}

/** The line a mihomo -t reason points at: the first quoted name it mentions. */
function lineOfDetail(text: string, detail: string): number {
  const names = [...detail.matchAll(/'([^']{1,80})'|\[([^\]]{1,80})\]/g)].map((m) => m[1] || m[2]);
  const lines = text.split("\n");
  for (const n of names) {
    const at = lines.findIndex((l) => l.includes(n) && !/^\s*-?\s*name:/.test(l));
    if (at >= 0) return at + 1;
    const def = lines.findIndex((l) => l.includes(n));
    if (def >= 0) return def + 1;
  }
  return 0;
}

export default function YamlTab({ cfg, configDirty, onApplied }: { cfg: CoreConfig; configDirty: boolean; onApplied: () => Promise<void> }) {
  const { log, refreshStatus } = useMihomo();
  const [text, setText] = useState(cfg.yaml);
  const [deferred, setDeferred] = useState(cfg.yaml);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [serverError, setServerError] = useState<LineError | null>(null);
  const [compare, setCompare] = useState<{ title: string; before: string; after: string } | null>(null);
  const [loaded, setLoaded] = useState("");
  const api = useRef<EditorApi | null>(null);

  useEffect(() => {
    setText(cfg.yaml);
    setLoaded("");
  }, [cfg.yaml]);
  // parse a moment after typing stops
  useEffect(() => {
    const t = setTimeout(() => setDeferred(text), 300);
    return () => clearTimeout(t);
  }, [text]);

  const info = useMemo(() => analyze(deferred), [deferred]);
  const errors = useMemo(() => (serverError ? [...info.errors, serverError] : info.errors), [info.errors, serverError]);
  const dirty = text !== cfg.yaml;
  const changedLines = useMemo(() => {
    if (!dirty) return 0;
    const a = cfg.yaml.split("\n");
    const b = text.split("\n");
    let n = Math.abs(a.length - b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
    return n;
  }, [dirty, cfg.yaml, text]);
  const hardErrors = info.errors.filter((e) => e.severity !== "warning");

  const check = async () => {
    setBusy(true);
    setServerError(null);
    try {
      const r = await core.checkConfig({ sha: cfg.sha, yaml: text });
      const line = r.detail ? lineOfDetail(text, r.detail) : 0;
      if (line) setServerError({ line, message: `mihomo -t: ${r.detail}` });
      setReview({ valid: r.valid, changes: r.changes || [], message: r.message, detail: r.detail, before: cfg.yaml, after: r.yaml ?? text, parsed: true });
    } catch (err) {
      setReview({ valid: false, changes: [], message: errText(err), parsed: !hardErrors.length });
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await core.applyConfig({ sha: cfg.sha, yaml: text });
      log("Конфигурация mihomo", r.message || "Применено", "success");
      setReview(null);
      await onApplied();
      void refreshStatus();
    } catch (err) {
      log("Конфигурация mihomo", errText(err), "error");
      setReview((rv) => (rv ? { ...rv, valid: false, message: errText(err) } : rv));
    } finally {
      setBusy(false);
    }
  };
  const openVersion = async (name: string, mode: "compare" | "load") => {
    try {
      const v = await core.configVersion(name);
      if (mode === "compare") setCompare({ title: `${name} → сейчас на роутере`, before: v.yaml, after: cfg.yaml });
      else {
        setText(v.yaml);
        setLoaded(name);
      }
    } catch (err) {
      log("Версия config.yaml", errText(err), "error");
    }
  };

  return (
    <div className="yt">
      <aside className="card yt-side">
        <div className="yt-h">Разделы файла</div>
        {info.outline.map((o) => (
          <button key={o.key + o.line} type="button" className={`yt-ol${o.generated ? " is-gen" : ""}${o.error ? " is-err" : ""}`} onClick={() => api.current?.goto(o.line)}>
            <span className="truncate">{o.key}</span>
            <small>{o.error ? "ошибка" : o.count != null ? number(o.count) : o.line}</small>
          </button>
        ))}
        <div className="yt-h">Версии на роутере</div>
        <div className="yt-ver yt-ver-cur">
          <span>
            <b>Сейчас</b>
            <small>{cfg.target.split(/[\\/]/).pop()}</small>
          </span>
        </div>
        {cfg.backups.slice(0, 12).map((b) => (
          <div key={b.name} className={`yt-ver${loaded === b.name ? " is-loaded" : ""}`}>
            <span title={b.name}>
              <b className="truncate">{b.kind === "auto" ? "Копия перед применением" : b.name.replace(/^config\.yaml\./, "")}</b>
              <small>{dateTime(b.time)}</small>
            </span>
            <span className="yt-ver-act">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openVersion(b.name, "compare")}>
                Сравнить
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openVersion(b.name, "load")} title="Загрузить в редактор; применится после проверки">
                Вернуть
              </button>
            </span>
          </div>
        ))}
        {!cfg.backups.length ? <p className="mh-muted yt-pad">Копий пока нет: они появляются перед каждым применением.</p> : null}
        {cfg.backups.length > 12 ? <p className="mh-muted yt-pad">и ещё {cfg.backups.length - 12}</p> : null}
      </aside>
      <section className="card card-flush yt-main">
        <div className="yt-tb">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.current?.search()}>
            <Icon name="search" />
            Найти и заменить
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.current?.foldAll()}>
            Свернуть всё
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.current?.unfoldAll()}>
            Развернуть
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.current?.gotoLine()}>
            Перейти к строке
          </button>
          <span className="yt-grow" />
          <span className="cell-sub">
            {number(text.split("\n").length)} строк{dirty ? ` · изменено ${number(changedLines)}` : ""}
            {loaded ? ` · загружена версия ${loaded}` : ""}
          </span>
        </div>
        {configDirty ? (
          <div className="cb-pad">
            <Alert tone="warning">В других вкладках есть несохранённые правки. Примените или отмените их, прежде чем править YAML целиком.</Alert>
          </div>
        ) : null}
        <div className="yt-ed">
          <CodeEditor
            value={text}
            onChange={(v) => {
              setText(v);
              setServerError(null);
            }}
            errors={errors}
            generated={info.generated}
            label="config.yaml"
            onReady={(a) => {
              api.current = a;
            }}
          />
        </div>
        <div className="yt-foot">
          {hardErrors.length ? (
            <button type="button" className="badge badge-danger yt-badge" onClick={() => api.current?.goto(hardErrors[0].line)}>
              ● {hardErrors.length} {hardErrors.length === 1 ? "ошибка" : "ошибки"} · строка {hardErrors[0].line}
            </button>
          ) : serverError ? (
            <button type="button" className="badge badge-danger yt-badge" onClick={() => api.current?.goto(serverError.line)}>
              ● mihomo -t · строка {serverError.line}
            </button>
          ) : (
            <span className="badge badge-success">YAML разбирается</span>
          )}
          <span className="badge">secret скрыт и сохранится как был</span>
          <span className="yt-grow" />
          <button
            type="button"
            className="btn"
            disabled={!dirty}
            onClick={() => {
              setText(cfg.yaml);
              setLoaded("");
              setServerError(null);
            }}
          >
            Отменить правки
          </button>
          <button type="button" className="btn" disabled={!dirty} onClick={() => setCompare({ title: "сейчас на роутере → в редакторе", before: cfg.yaml, after: text })}>
            Показать изменения
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !dirty || configDirty || !cfg.can_validate || hardErrors.length > 0} onClick={() => void check()}>
            {busy ? <span className="spinner" /> : <Icon name="test" />}
            Проверить и применить
          </button>
        </div>
      </section>
      <ReviewModal review={review} busy={busy} onClose={() => setReview(null)} onApply={() => void apply()} applyLabel="Применить на роутере" />
      <Modal open={!!compare} onClose={() => setCompare(null)} size="lg" title="Сравнение версий" description={compare?.title}>
        {compare ? <DiffView before={compare.before} after={compare.after} caption={compare.title} /> : null}
      </Modal>
    </div>
  );
}
