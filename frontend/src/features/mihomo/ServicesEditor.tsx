import { useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { errText } from "../../lib/format";
import type { ServiceConfig, ServiceDef } from "./api";

/*
 * The list «Чем пользуются дома» is people's own (NPM-49): own services with
 * an address to check, built-in ones hidden or shown again, any order.
 */

type Item = ServiceDef & { visible: boolean; own: boolean };

function itemsOf(catalog: ServiceDef[], cfg: ServiceConfig): Item[] {
  const hidden = new Set(cfg.hidden);
  const own = new Set(cfg.custom.map((c) => c.id));
  const byId = new Map(catalog.map((d) => [d.id, d]));
  const ordered: ServiceDef[] = [];
  cfg.order.forEach((id) => {
    const d = byId.get(id);
    if (d && !ordered.includes(d)) ordered.push(d);
  });
  catalog.forEach((d) => !ordered.includes(d) && ordered.push(d));
  return ordered.map((d) => ({ ...d, visible: !hidden.has(d.id), own: own.has(d.id) }));
}

export function ServicesEditor({ catalog, config, onSave, onCancel }: { catalog: ServiceDef[]; config: ServiceConfig; onSave: (c: ServiceConfig) => Promise<void>; onCancel: () => void }) {
  const [items, setItems] = useState<Item[]>(() => itemsOf(catalog, config));
  const [draft, setDraft] = useState({ name: "", what: "", url: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  };
  const patch = (i: number, p: Partial<Item>) => setItems(items.map((x, k) => (k === i ? { ...x, ...p } : x)));

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      await onSave({
        custom: items.filter((x) => x.own).map(({ id, name, what, url }) => ({ id, name, what, url, group: "" })),
        hidden: items.filter((x) => !x.visible && !x.own).map((x) => x.id),
        order: items.filter((x) => x.visible).map((x) => x.id),
      });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="se">
      <p className="mh-muted">Сервисы проверяются раз в 2 минуты через те же правила, что и трафик устройств. Порядок здесь — порядок карточек на «Сейчас».</p>
      <ol className="se-list">
        {items.map((x, i) => (
          <li key={x.id} className={`se-item${x.visible ? "" : " is-off"}`}>
            <span className="se-move">
              <button className="btn btn-sm btn-ghost" aria-label={`Выше: ${x.name}`} disabled={i === 0} onClick={() => move(i, -1)}>
                <span className="se-up">
                  <Icon name="chevronDown" size={14} />
                </span>
              </button>
              <button className="btn btn-sm btn-ghost" aria-label={`Ниже: ${x.name}`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                <Icon name="chevronDown" size={14} />
              </button>
            </span>
            {x.own ? (
              <span className="se-own">
                <input aria-label="Название" value={x.name} onChange={(e) => patch(i, { name: e.target.value })} />
                <input aria-label="Подпись" value={x.what} placeholder="подпись" onChange={(e) => patch(i, { what: e.target.value })} />
                <input aria-label="Адрес проверки" className="mono" value={x.url || ""} onChange={(e) => patch(i, { url: e.target.value })} />
              </span>
            ) : (
              <span className="se-name">
                <b>{x.name}</b>
                <small>{x.what}</small>
              </span>
            )}
            {x.own ? (
              <button className="btn btn-sm btn-ghost" aria-label={`Удалить ${x.name}`} onClick={() => setItems(items.filter((_, k) => k !== i))}>
                <Icon name="trash" size={14} />
              </button>
            ) : (
              <button className={`vn-chip${x.visible ? " is-on" : ""}`} aria-pressed={x.visible} onClick={() => patch(i, { visible: !x.visible })}>
                {x.visible ? "показывать" : "скрыт"}
              </button>
            )}
          </li>
        ))}
      </ol>
      <form
        className="se-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.name.trim() || !draft.url.trim()) return;
          setItems([...items, { id: `new-${Date.now()}`, name: draft.name.trim(), what: draft.what.trim(), url: draft.url.trim(), group: "", visible: true, own: true }]);
          setDraft({ name: "", what: "", url: "" });
        }}
      >
        <b>Свой сервис</b>
        <input aria-label="Название" placeholder="Название, например Госуслуги" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input aria-label="Подпись" placeholder="Подпись (необязательно)" value={draft.what} onChange={(e) => setDraft({ ...draft, what: e.target.value })} />
        <input aria-label="Адрес проверки" className="mono" placeholder="gosuslugi.ru или https://…" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
        <button className="btn btn-sm" disabled={!draft.name.trim() || !draft.url.trim()}>
          Добавить в список
        </button>
      </form>
      {err ? <p className="vn-err">{err}</p> : null}
      <div className="se-foot">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Отмена
        </button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Сохраняю…" : "Сохранить"}
        </button>
      </div>
    </div>
  );
}
