import { useMemo, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { Alert } from "../../components/ui/controls";
import type { ConfigChange } from "./api";

/*
 * «Применить изменения config.yaml?» (NPM-35): the checks the file passed,
 * a summary by section and a line diff of the file before and after.
 */

export type ReviewState = {
  valid: boolean;
  changes: ConfigChange[];
  message?: string;
  detail?: string;
  before?: string;
  after?: string;
  parsed?: boolean;
};

type Op = { kind: " " | "+" | "-"; text: string; a?: number; b?: number };

/** Line diff by longest common subsequence; config.yaml is a few hundred lines. */
export function lineDiff(before: string, after: string): Op[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // trim the common head and tail so the table stays small
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const n = A.length;
  const m = B.length;
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: " ", text: a[i], a: i + 1, b: i + 1 });
  if (n * m > 4_000_000) {
    A.forEach((text, i) => ops.push({ kind: "-", text, a: head + i + 1 }));
    B.forEach((text, j) => ops.push({ kind: "+", text, b: head + j + 1 }));
  } else {
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        ops.push({ kind: " ", text: A[i], a: head + i + 1, b: head + j + 1 });
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
        ops.push({ kind: "+", text: B[j], b: head + j + 1 });
        j++;
      } else {
        ops.push({ kind: "-", text: A[i], a: head + i + 1 });
        i++;
      }
    }
  }
  for (let k = 0; k < tail; k++) ops.push({ kind: " ", text: a[a.length - tail + k], a: a.length - tail + k + 1, b: b.length - tail + k + 1 });
  return ops;
}

type Hunk = { title: string; ops: Op[] };

/** Changed lines with 2 lines of context, titled by the nearest top-level key. */
function hunks(ops: Op[]): Hunk[] {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.kind !== " ") for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) keep[k] = true;
  });
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let section = "";
  let item = "";
  ops.forEach((o, i) => {
    const top = o.text.match(/^([A-Za-z][\w-]*):/);
    if (top) {
      section = top[1];
      item = "";
    }
    const nm = o.text.match(/^\s*-\s+name:\s*['"]?([^'"]+)['"]?/);
    if (nm) item = nm[1];
    if (!keep[i]) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { title: section ? `${section}${item ? ` — ${item}` : ""}` : "начало файла", ops: [] };
      out.push(cur);
    }
    cur.ops.push(o);
  });
  return out;
}

function summary(changes: ConfigChange[]) {
  const by = (section: string) => {
    const c = changes.filter((x) => x.section === section);
    return { add: c.filter((x) => x.kind === "added"), del: c.filter((x) => x.kind === "removed"), mod: c.filter((x) => x.kind === "changed") };
  };
  return [
    { key: "proxy-groups", label: "группы" },
    { key: "proxy-providers", label: "подписки" },
    { key: "rules", label: "правила" },
  ]
    .map(({ key, label }) => ({ label, ...by(key) }))
    .filter((s) => s.add.length + s.del.length + s.mod.length > 0);
}

export function DiffView({ before, after, max = 400, caption = "config.yaml · сейчас → после применения" }: { before: string; after: string; max?: number; caption?: string }) {
  const [all, setAll] = useState(false);
  const ops = useMemo(() => lineDiff(before, after), [before, after]);
  const hs = useMemo(() => hunks(ops), [ops]);
  const changed = ops.filter((o) => o.kind !== " ").length;
  let shown = 0;
  return (
    <div className="mh-diff">
      <div className="mh-diff-head">
        <span>{caption}</span>
        <span>{changed} изменённых строк</span>
      </div>
      <div className="mh-diff-body">
        {hs.map((h, i) => {
          if (!all && shown > max) return null;
          shown += h.ops.length;
          return (
            <div key={i}>
              <div className="mh-diff-hunk">@@ {h.title}</div>
              {h.ops.map((o, k) => (
                <div key={k} className={`mh-diff-row${o.kind === "+" ? " is-add" : o.kind === "-" ? " is-del" : ""}`}>
                  <span>{o.a ?? ""}</span>
                  <span>{o.b ?? ""}</span>
                  <i>{o.kind}</i>
                  <code>{o.text || " "}</code>
                </div>
              ))}
            </div>
          );
        })}
        {!hs.length ? <p className="mh-muted cb-pad">Строки не изменились.</p> : null}
        {!all && shown > max ? (
          <button type="button" className="btn btn-ghost btn-sm mh-more" onClick={() => setAll(true)}>
            Показать все изменения
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ReviewModal({
  review,
  busy,
  onClose,
  onApply,
  applyLabel = "Применить",
}: {
  review: ReviewState | null;
  busy: boolean;
  onClose: () => void;
  onApply: () => void;
  applyLabel?: string;
}) {
  const sum = review ? summary(review.changes) : [];
  const nothing = !!review && review.valid && !review.changes.length;
  return (
    <Modal
      open={!!review}
      onClose={() => !busy && onClose()}
      locked={busy}
      size="lg"
      title={review?.valid ? (nothing ? "Конфиг уже такой" : "Применить изменения config.yaml?") : "Проверка не пройдена"}
      description={review?.valid ? "Перед заменой сохранится копия. Если ядро не примет файл, вернётся прежний." : review?.message}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Вернуться
          </button>
          <button type="button" className="btn btn-primary" onClick={onApply} disabled={busy || !review?.valid}>
            {busy ? <span className="spinner" /> : <Icon name="bolt" />}
            {applyLabel}
          </button>
        </>
      }
    >
      {review ? (
        <div className="stack">
          <div className="mh-steps">
            <span className={`badge ${review.parsed === false ? "badge-danger" : "badge-success"}`}>{review.parsed === false ? "✕" : "✓"} YAML разобран</span>
            <span className={`badge ${review.valid ? "badge-success" : "badge-danger"}`}>{review.valid ? "✓" : "✕"} mihomo -t на роутере</span>
            <span className="badge">после применения ядро перечитает файл без перезапуска</span>
          </div>
          {review.detail ? (
            <Alert tone="danger" title="Ответ mihomo -t">
              {review.detail}
            </Alert>
          ) : null}
          {sum.length ? (
            <div className="mh-sum">
              {sum.map((s) => (
                <div key={s.label} className="mh-sum-card">
                  <b>
                    {s.add.length ? `+${s.add.length}` : ""}
                    {s.add.length && (s.del.length || s.mod.length) ? " / " : ""}
                    {s.del.length ? `−${s.del.length}` : ""}
                    {s.del.length && s.mod.length ? " / " : ""}
                    {s.mod.length ? `~${s.mod.length}` : ""}
                  </b>
                  <small>
                    {s.label}
                    {s.add.length ? `: добавлены ${s.add.slice(0, 3).map((x) => x.item).filter(Boolean).join(", ")}${s.add.length > 3 ? "…" : ""}` : ""}
                    {s.del.length ? `; убраны ${s.del.slice(0, 3).map((x) => x.item).filter(Boolean).join(", ")}${s.del.length > 3 ? "…" : ""}` : ""}
                  </small>
                </div>
              ))}
            </div>
          ) : null}
          {review.before != null && review.after != null ? (
            <DiffView before={review.before} after={review.after} />
          ) : (
            <ul className="mh-changes">
              {review.changes.map((c, i) => (
                <li key={i} className={`is-${c.kind}`}>
                  <span className="mh-change-kind">{c.kind === "added" ? "+" : c.kind === "removed" ? "−" : "~"}</span>
                  <span className="mono">{c.section}</span>
                  {c.item ? <span className="mono truncate">{c.item}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <p className="cell-sub">Соединения через изменённые группы переподключатся. Процесс mihomo не перезапускается.</p>
        </div>
      ) : null}
    </Modal>
  );
}
