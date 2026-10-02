import { useEffect, useRef } from "react";
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, codeFolding, foldAll, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, unfoldAll } from "@codemirror/language";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";

/*
 * config.yaml editor (NPM-35): CodeMirror 6 with YAML highlighting, folding,
 * search, line errors and a band over the block HomeNet generates. Loaded
 * lazily: only the YAML tab pulls it in.
 */

export type LineError = { line: number; message: string; severity?: "error" | "warning" };
export type EditorApi = { foldAll: () => void; unfoldAll: () => void; search: () => void; gotoLine: () => void; goto: (line: number) => void };

const style = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--cm-key)" },
  { tag: [t.string, t.special(t.string)], color: "var(--cm-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--cm-number)" },
  { tag: [t.comment, t.lineComment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.atom], color: "var(--cm-atom)" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--text-3)" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--cm-bg)", color: "var(--text)" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "21px" },
    ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
    ".cm-gutters": { backgroundColor: "var(--cm-bg)", color: "var(--text-3)", border: "0", borderRight: "1px solid var(--border)" },
    ".cm-activeLine": { backgroundColor: "var(--cm-active)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--cm-active)", color: "var(--text-2)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--cm-selection) !important" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--surface-3)", border: "0", color: "var(--text-2)", padding: "0 6px" },
    ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)", borderTop: "1px solid var(--border)" },
    ".cm-panels input, .cm-panels button": { fontFamily: "inherit" },
    ".cm-searchMatch": { backgroundColor: "var(--warning-soft)", outline: "1px solid var(--warning-border)" },
    ".cm-gen": { backgroundColor: "var(--cm-gen)", boxShadow: "inset 3px 0 0 var(--accent)" },
    ".cm-errline": { backgroundColor: "var(--danger-soft)" },
    ".cm-gen-tag": { marginLeft: "18px", fontFamily: "var(--font-sans)", fontSize: "11.5px", color: "var(--accent-text)", fontStyle: "normal" },
    ".cm-err-dot": { color: "var(--danger)", fontSize: "11px", paddingLeft: "4px" },
  },
  { dark: true },
);

/* ---------- decorations: generated block and error lines ---------- */

export const setGenerated = StateEffect.define<Array<[number, number]>>();
const setErrors = StateEffect.define<LineError[]>();

class TagWidget extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-gen-tag";
    s.textContent = "▣ блок HomeNet · правится в «Маршрутизации»";
    return s;
  }
}

function buildDecos(state: EditorState, gen: Array<[number, number]>, errors: LineError[]): DecorationSet {
  const marks: Array<{ from: number; deco: Decoration }> = [];
  const lines = state.doc.lines;
  gen.forEach(([a, b], i) => {
    for (let l = Math.max(1, a); l <= Math.min(lines, b); l++) {
      const line = state.doc.line(l);
      marks.push({ from: line.from, deco: Decoration.line({ class: "cm-gen" }) });
      if (i === 0 && l === a) marks.push({ from: line.to, deco: Decoration.widget({ widget: new TagWidget(), side: 1 }) });
    }
  });
  errors.forEach((e) => {
    if (e.line >= 1 && e.line <= lines) marks.push({ from: state.doc.line(e.line).from, deco: Decoration.line({ class: "cm-errline" }) });
  });
  marks.sort((x, y) => x.from - y.from || (x.deco.startSide ?? 0) - (y.deco.startSide ?? 0));
  const b = new RangeSetBuilder<Decoration>();
  marks.forEach((m) => b.add(m.from, m.from, m.deco));
  return b.finish();
}

const decoField = StateField.define<{ gen: Array<[number, number]>; errors: LineError[]; set: DecorationSet }>({
  create: () => ({ gen: [], errors: [], set: Decoration.none }),
  update(v, tr) {
    let { gen, errors } = v;
    let changed = false;
    for (const e of tr.effects) {
      if (e.is(setGenerated)) {
        gen = e.value;
        changed = true;
      }
      if (e.is(setErrors)) {
        errors = e.value;
        changed = true;
      }
    }
    if (changed) return { gen, errors, set: buildDecos(tr.state, gen, errors) };
    if (tr.docChanged) return { gen, errors, set: v.set.map(tr.changes) };
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.set),
});

class ErrMarker extends GutterMarker {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-err-dot";
    s.textContent = "●";
    return s;
  }
}

function errorLineGutter(): Extension {
  return gutter({
    class: "cm-err-gutter",
    lineMarker(view, line) {
      const errs = view.state.field(decoField).errors;
      const n = view.state.doc.lineAt(line.from).number;
      return errs.some((e) => e.line === n) ? new ErrMarker() : null;
    },
    lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setErrors))),
  });
}

export function CodeEditor({
  value,
  onChange,
  errors,
  generated,
  onReady,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  errors: LineError[];
  generated: Array<[number, number]>;
  onReady?: (api: EditorApi) => void;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          errorLineGutter(),
          foldGutter(),
          codeFolding(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          search({ top: true }),
          lintGutter(),
          yamlLang(),
          syntaxHighlighting(style),
          theme,
          decoField,
          EditorState.tabSize.of(2),
          EditorView.contentAttributes.of({ "aria-label": label }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    onReady?.({
      foldAll: () => foldAll(v),
      unfoldAll: () => unfoldAll(v),
      search: () => openSearchPanel(v),
      gotoLine: () => gotoLine(v),
      goto: (line: number) => {
        const l = v.state.doc.line(Math.max(1, Math.min(v.state.doc.lines, line)));
        v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
        v.focus();
      },
    });
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // outside changes (reload, a version loaded into the editor)
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const diags: Diagnostic[] = errors
      .filter((e) => e.line >= 1 && e.line <= v.state.doc.lines)
      .map((e) => {
        const l = v.state.doc.line(e.line);
        return { from: l.from, to: l.to, severity: e.severity || "error", message: e.message };
      });
    v.dispatch(setDiagnostics(v.state, diags), { effects: setErrors.of(errors) });
  }, [errors, value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setGenerated.of(generated) });
  }, [generated, value]);

  return <div ref={host} className="cm-host" />;
}

export default CodeEditor;
