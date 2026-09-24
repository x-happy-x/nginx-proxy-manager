import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { RoutesDocument } from "../types";
import { fetchLauncher, fetchLauncherStatus, saveLauncher, type LauncherConfig, type LauncherDevice } from "../api";
import { Icon } from "../components/ui/Icon";
import { Modal } from "../components/ui/Modal";
import { Alert, EmptyState, Field, SearchInput, Segmented } from "../components/ui/controls";
import { PageHeader } from "../navigation";
import { errText } from "../lib/format";
import { ART_KEYS, artFor, CardArt, deviceArt, ServiceIcon } from "../features/launcher/art";
import { buildItems, defaultLauncher, OTHER_DEVICE, slug, type LauncherItem } from "../features/launcher/model";

type View = "cards" | "tiles";
type Probe = { ok: boolean; ms: number };

const VIEW_KEY = "homenet.launcher.view";

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "tiles" ? "tiles" : "cards";
  } catch {
    return "cards";
  }
}

export function Launcher({ doc }: { doc: RoutesDocument | null }) {
  const [cfg, setCfg] = useState<LauncherConfig | null>(null);
  const [saved, setSaved] = useState("");
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(readView);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Record<string, Probe>>({});
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [editItem, setEditItem] = useState<LauncherItem | "new" | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const dragKey = useRef<string | null>(null);
  const [dropHint, setDropHint] = useState<string>("");

  useEffect(() => {
    fetchLauncher()
      .then((loaded) => {
        const value = loaded || defaultLauncher();
        value.apps ||= {};
        value.links ||= [];
        value.order ||= [];
        setCfg(value);
        setSaved(loaded ? JSON.stringify(value) : "");
        setFresh(!loaded);
      })
      .catch((err) => {
        setError(errText(err));
        setCfg(defaultLauncher());
      });
  }, []);

  const items = useMemo(() => (cfg ? buildItems(doc, cfg) : []), [doc, cfg]);

  const probeTargets = useMemo(() => [...new Set(items.map((i) => i.probe).filter(Boolean) as string[])], [items]);
  const refreshStatus = useCallback(() => {
    if (!probeTargets.length) return;
    fetchLauncherStatus(probeTargets)
      .then((next) => {
        setStatus(next);
        setStatusLoaded(true);
      })
      .catch(() => {});
  }, [probeTargets]);
  useEffect(() => {
    refreshStatus();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshStatus();
    }, 30000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const dirty = cfg !== null && JSON.stringify(cfg) !== saved;
  const update = (fn: (draft: LauncherConfig) => void) => {
    setCfg((current) => {
      if (!current) return current;
      const next = JSON.parse(JSON.stringify(current)) as LauncherConfig;
      fn(next);
      return next;
    });
  };

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setError("");
    try {
      await saveLauncher(cfg);
      setSaved(JSON.stringify(cfg));
      setFresh(false);
      setEditing(false);
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const changeView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* per-browser preference only */
    }
  };

  if (!cfg) {
    return (
      <>
        <PageHeader page="apps" />
        <div className="launcher-loading">Загрузка…</div>
      </>
    );
  }

  const q = query.trim().toLowerCase();
  const visible = items.filter((item) => (editing || !item.hidden) && (!q || [item.title, item.description, ...item.hints].join(" ").toLowerCase().includes(q)));
  const groups: Array<{ device: LauncherDevice; items: LauncherItem[] }> = [
    ...cfg.devices.map((device) => ({ device, items: visible.filter((i) => i.device === device.id) })),
    { device: { id: OTHER_DEVICE, name: "Другое", kind: "server", addresses: [] }, items: visible.filter((i) => i.device === OTHER_DEVICE) },
  ].filter((g) => g.items.length || (g.device.id !== OTHER_DEVICE && !q));

  const moveTo = (key: string, device: string, beforeKey: string | null) => {
    update((draft) => {
      const all = buildItems(doc, draft).map((i) => i.key);
      const order = all.filter((k) => k !== key);
      const at = beforeKey ? order.indexOf(beforeKey) : -1;
      order.splice(at < 0 ? order.length : at, 0, key);
      draft.order = order;
      setItemDevice(draft, key, device);
    });
  };

  const onDragStart = (key: string) => (event: DragEvent) => {
    dragKey.current = key;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
  };
  const onDropOn = (device: string, beforeKey: string | null) => (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const key = dragKey.current;
    dragKey.current = null;
    setDropHint("");
    if (key && key !== beforeKey) moveTo(key, device, beforeKey);
  };

  const onlineCount = (list: LauncherItem[]) => list.filter((i) => i.probe && status[i.probe]?.ok).length;

  return (
    <>
      <PageHeader
        page="apps"
        actions={
          <>
            <SearchInput value={query} onChange={setQuery} placeholder="Найти сервис" label="Поиск по приложениям" />
            <Segmented<View>
              label="Вид"
              value={view}
              onChange={changeView}
              options={[
                { value: "cards", label: <><Icon name="image" /> Карточки</> },
                { value: "tiles", label: <><Icon name="apps" /> Плитки</> },
              ]}
            />
            {editing ? (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => setEditItem("new")}>
                  <Icon name="plus" /> Ссылка
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setDevicesOpen(true)}>
                  <Icon name="servers" /> Устройства
                </button>
                <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
                  <Icon name="check" /> {saving ? "Сохраняю…" : "Готово"}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
                <Icon name="edit" /> Править
              </button>
            )}
          </>
        }
      />
      {error ? <Alert tone="danger" title="Не удалось сохранить">{error}</Alert> : null}
      {fresh && !editing ? (
        <Alert tone="info" title="Группы по умолчанию" action={<button type="button" className="btn btn-sm btn-secondary" onClick={save}>Сохранить</button>}>
          Устройства и ссылки собраны из сети роутера; приложения из маршрутов разложены по адресам. Сохраните, чтобы закрепить, или поправьте в режиме «Править».
        </Alert>
      ) : null}
      {editing ? (
        <Alert tone="neutral">
          Перетаскивайте плитки между группами и внутри них. Приложения из маршрутов можно скрыть или переименовать — маршруты это не меняет.{dirty ? " Есть несохранённые изменения." : ""}
        </Alert>
      ) : null}

      {!groups.length ? (
        <EmptyState icon="apps" title={q ? "Ничего не найдено" : "Пусто"}>{q ? "Попробуйте другое название или адрес." : "Добавьте ссылку в режиме «Править»."}</EmptyState>
      ) : null}

      <div className={`launcher launcher-${view}${editing ? " is-editing" : ""}`}>
        {groups.map(({ device, items: list }) => {
          const art = deviceArt(device.kind);
          return (
            <section
              key={device.id}
              className={`launcher-group${dropHint === device.id ? " is-drop" : ""}`}
              onDragOver={editing ? (e) => { e.preventDefault(); setDropHint(device.id); } : undefined}
              onDragLeave={editing ? () => setDropHint("") : undefined}
              onDrop={editing ? onDropOn(device.id, null) : undefined}
            >
              <header className="launcher-group-head">
                <ServiceIcon spec={art} size={34} />
                <div className="launcher-group-title">
                  <h2>{device.name}</h2>
                  {device.note ? <span>{device.note}</span> : null}
                </div>
                <span className="launcher-group-count">
                  {list.filter((i) => !i.hidden).length}
                  {list.some((i) => i.probe) ? <small> · в сети {onlineCount(list)}</small> : null}
                </span>
              </header>
              {list.length ? (
                <div className="launcher-grid">
                  {list.map((item) => (
                    <LauncherTile
                      key={item.key}
                      item={item}
                      view={view}
                      probe={item.probe ? status[item.probe] : undefined}
                      probeKnown={!statusLoaded || !item.probe || item.probe in status}
                      editing={editing}
                      onEdit={() => setEditItem(item)}
                      onToggleHidden={() => update((d) => toggleHidden(d, item))}
                      onDelete={() => update((d) => { d.links = d.links.filter((l) => "link:" + l.id !== item.key); })}
                      dragProps={editing ? { draggable: true, onDragStart: onDragStart(item.key), onDragOver: (e: DragEvent) => e.preventDefault(), onDrop: onDropOn(device.id, item.key) } : {}}
                    />
                  ))}
                </div>
              ) : (
                <div className="launcher-empty">
                  {editing ? "Перетащите сюда плитку или добавьте ссылку" : "Пока пусто — добавьте ссылку в режиме «Править»"}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {editItem ? (
        <ItemEditor
          item={editItem === "new" ? null : editItem}
          cfg={cfg}
          onClose={() => setEditItem(null)}
          onSave={(patch) => {
            update((d) => applyItemPatch(d, editItem === "new" ? null : editItem, patch));
            setEditItem(null);
          }}
        />
      ) : null}
      {devicesOpen ? (
        <DevicesEditor
          devices={cfg.devices}
          onClose={() => setDevicesOpen(false)}
          onSave={(devices) => {
            update((d) => {
              d.devices = devices;
            });
            setDevicesOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function setItemDevice(cfg: LauncherConfig, key: string, device: string) {
  const [kind, id] = splitKey(key);
  if (kind === "link") {
    const link = cfg.links.find((l) => l.id === id);
    if (link) link.device = device;
  } else {
    cfg.apps[id] = { ...cfg.apps[id], device };
  }
}

function splitKey(key: string): ["app" | "link", string] {
  const i = key.indexOf(":");
  return [key.slice(0, i) as "app" | "link", key.slice(i + 1)];
}

function toggleHidden(cfg: LauncherConfig, item: LauncherItem) {
  const [, id] = splitKey(item.key);
  cfg.apps[id] = { ...cfg.apps[id], hidden: !item.hidden };
}

type Patch = { title: string; description: string; device: string; art: string; url: string };

function applyItemPatch(cfg: LauncherConfig, item: LauncherItem | null, patch: Patch) {
  if (!item) {
    cfg.links.push({ id: slug(patch.title), title: patch.title, url: patch.url, device: patch.device, description: patch.description || undefined, art: patch.art || undefined });
    return;
  }
  const [kind, id] = splitKey(item.key);
  if (kind === "link") {
    const link = cfg.links.find((l) => l.id === id);
    if (link) Object.assign(link, { title: patch.title, url: patch.url, device: patch.device, description: patch.description || undefined, art: patch.art || undefined });
  } else {
    cfg.apps[id] = { ...cfg.apps[id], title: patch.title || undefined, description: patch.description || undefined, device: patch.device, art: patch.art || undefined };
  }
}

function LauncherTile({
  item, view, probe, probeKnown, editing, onEdit, onToggleHidden, onDelete, dragProps,
}: {
  item: LauncherItem;
  view: View;
  probe?: Probe;
  probeKnown: boolean;
  editing: boolean;
  onEdit: () => void;
  onToggleHidden: () => void;
  onDelete: () => void;
  dragProps: Record<string, unknown>;
}) {
  const spec = artFor(item.art, ...item.hints);
  const open = () => {
    if (!editing && item.primary !== "#") window.open(item.primary, "_blank", "noopener");
  };
  // Public addresses are not probed from the router; they stay without a dot.
  const state = !item.probe || !probeKnown ? "unknown" : !probe ? "pending" : probe.ok ? "up" : "down";
  const stateTitle = state === "up" ? `Доступен · ${probe!.ms} мс` : state === "down" ? "Не отвечает" : state === "pending" ? "Проверяю…" : "";
  const links = [
    item.local ? { label: "Дом", href: item.local, icon: "home" as const } : null,
    item.public ? { label: "Извне", href: item.public, icon: "globe" as const } : null,
    item.direct ? { label: "IP", href: item.direct, icon: "route" as const } : null,
  ].filter(Boolean) as Array<{ label: string; href: string; icon: "home" | "globe" | "route" }>;

  return (
    <article
      className={`lt lt-${view}${item.hidden ? " is-hidden" : ""}`}
      style={{ ["--hue" as string]: String(spec.hue) }}
      role={editing ? undefined : "link"}
      tabIndex={editing ? undefined : 0}
      aria-label={item.title}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter") open(); }}
      {...dragProps}
    >
      {view === "cards" ? <CardArt spec={spec} seed={item.key} /> : null}
      <div className="lt-body">
        <ServiceIcon spec={spec} size={view === "cards" ? 46 : 38} />
        <div className="lt-text">
          <strong>{item.title}</strong>
          <span>{item.description}</span>
        </div>
        <span className={`lt-state lt-${state}`} title={stateTitle} />
      </div>
      {view === "cards" && links.length ? (
        <div className="lt-links">
          {links.map((link) => (
            <a key={link.label} href={link.href} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} title={link.href}>
              <Icon name={link.icon} size={13} /> {link.label}
            </a>
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className="lt-edit" onClick={(e) => e.stopPropagation()}>
          <span className="lt-grip" title="Перетащить"><Icon name="grip" size={14} /></span>
          <button type="button" className="btn btn-sm btn-icon btn-secondary" title="Изменить" aria-label="Изменить" onClick={onEdit}><Icon name="edit" /></button>
          {item.source === "routes" ? (
            <button type="button" className="btn btn-sm btn-icon btn-secondary" title={item.hidden ? "Показать" : "Скрыть"} aria-label={item.hidden ? "Показать" : "Скрыть"} onClick={onToggleHidden}>
              <Icon name={item.hidden ? "eye" : "eyeOff"} />
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-icon btn-secondary" title="Удалить" aria-label="Удалить" onClick={onDelete}><Icon name="trash" /></button>
          )}
        </div>
      ) : null}
    </article>
  );
}

function ItemEditor({ item, cfg, onClose, onSave }: { item: LauncherItem | null; cfg: LauncherConfig; onClose: () => void; onSave: (patch: Patch) => void }) {
  const manual = !item || item.source === "manual";
  const [patch, setPatch] = useState<Patch>({
    title: item?.title || "",
    description: item && item.source === "manual" ? cfg.links.find((l) => "link:" + l.id === item.key)?.description || "" : item ? cfg.apps[item.key.slice(4)]?.description || "" : "",
    device: item?.device && item.device !== OTHER_DEVICE ? item.device : cfg.devices[0]?.id || "",
    art: item?.art || "",
    url: item?.primary && item.source === "manual" ? item.primary : "",
  });
  const [problem, setProblem] = useState("");
  const set = (key: keyof Patch, value: string) => setPatch((p) => ({ ...p, [key]: value }));
  const preview = artFor(patch.art || undefined, ...(item?.hints || []), patch.title, patch.url);
  const submit = () => {
    if (manual && (!patch.title.trim() || !/^https?:\/\/\S+$/i.test(patch.url.trim()))) {
      setProblem("Нужны название и адрес вида http(s)://…");
      return;
    }
    onSave({ ...patch, title: patch.title.trim(), url: patch.url.trim(), description: patch.description.trim() });
  };
  return (
    <Modal
      open
      onClose={onClose}
      autoFocusBody
      size="lg"
      title={item ? item.title : "Новая ссылка"}
      description={item?.source === "routes" ? "Приложение из маршрутов: здесь меняется только плитка." : "Ссылка на любой адрес в сети или снаружи."}
      footer={<>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
        <button type="button" className="btn btn-primary" onClick={submit}>{item ? "Готово" : "Добавить"}</button>
      </>}
    >
      <div className="launcher-editor">
        <div className="launcher-editor-preview" style={{ ["--hue" as string]: String(preview.hue) }}>
          <CardArt spec={preview} seed={item?.key || patch.title || "new"} />
          <div className="lt-body">
            <ServiceIcon spec={preview} size={46} />
            <div className="lt-text"><strong>{patch.title || "Название"}</strong><span>{patch.description || patch.url}</span></div>
          </div>
        </div>
        <div className="form-grid">
          <Field label="Название"><input className="input" value={patch.title} placeholder={item?.source === "routes" ? item.title : ""} onChange={(e) => set("title", e.target.value)} /></Field>
          <Field label="Устройство">
            <select className="input" value={patch.device} onChange={(e) => set("device", e.target.value)}>
              {cfg.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          {manual ? <Field label="Адрес" className="span-2"><input className="input mono" value={patch.url} placeholder="http://192.168.1.10:8080/" onChange={(e) => set("url", e.target.value)} /></Field> : null}
          <Field label="Подпись" className="span-2"><input className="input" value={patch.description} onChange={(e) => set("description", e.target.value)} /></Field>
        </div>
        <Field label="Иконка и фон" group>
          <div className="art-picker">
            <button type="button" className={`art-option${!patch.art ? " is-active" : ""}`} onClick={() => set("art", "")}>
              <ServiceIcon spec={artFor(undefined, ...(item?.hints || []), patch.title, patch.url)} size={34} />
              <span>Авто</span>
            </button>
            {ART_KEYS.map((a) => (
              <button type="button" key={a.key} className={`art-option${patch.art === a.key ? " is-active" : ""}`} onClick={() => set("art", a.key)}>
                <ServiceIcon spec={artFor(a.key)} size={34} />
                <span>{a.label}</span>
              </button>
            ))}
          </div>
        </Field>
        {problem ? <Alert tone="danger">{problem}</Alert> : null}
      </div>
    </Modal>
  );
}

function DevicesEditor({ devices, onClose, onSave }: { devices: LauncherDevice[]; onClose: () => void; onSave: (devices: LauncherDevice[]) => void }) {
  const [list, setList] = useState<Array<LauncherDevice & { addressText: string }>>(devices.map((d) => ({ ...d, addressText: d.addresses.join(", ") })));
  const change = (i: number, patch: Partial<LauncherDevice & { addressText: string }>) => setList((l) => l.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i: number, delta: number) => setList((l) => {
    const next = [...l];
    const j = i + delta;
    if (j < 0 || j >= next.length) return l;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Устройства"
      description="Группы лаунчера. Приложение попадает в группу, если адрес его upstream есть в списке адресов устройства."
      footer={<>
        <button type="button" className="btn btn-secondary" onClick={() => setList((l) => [...l, { id: slug("device"), name: "Новое устройство", kind: "server", note: "", addresses: [], addressText: "" }])}><Icon name="plus" /> Устройство</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
        <button type="button" className="btn btn-primary" onClick={() => onSave(list.filter((d) => d.name.trim()).map(({ addressText, ...d }) => ({ ...d, name: d.name.trim(), addresses: addressText.split(/[\s,]+/).filter(Boolean) })))}>Готово</button>
      </>}
    >
      <div className="device-list">
        {list.map((d, i) => (
          <div className="device-row" key={d.id}>
            <ServiceIcon spec={deviceArt(d.kind)} size={34} />
            <input className="input" value={d.name} aria-label="Название" onChange={(e) => change(i, { name: e.target.value })} />
            <select className="input" value={d.kind} aria-label="Тип" onChange={(e) => change(i, { kind: e.target.value })}>
              <option value="router">Роутер</option>
              <option value="server">Сервер</option>
              <option value="vm">Виртуалка</option>
              <option value="pc">Компьютер</option>
            </select>
            <input className="input" value={d.note || ""} placeholder="Подпись" aria-label="Подпись" onChange={(e) => change(i, { note: e.target.value })} />
            <input className="input mono" value={d.addressText} placeholder="192.168.1.10, 192.168.1.11" aria-label="Адреса" onChange={(e) => change(i, { addressText: e.target.value })} />
            <div className="device-row-tools">
              <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label="Выше" onClick={() => move(i, -1)}><Icon name="chevronDown" className="flip" /></button>
              <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label="Ниже" onClick={() => move(i, 1)}><Icon name="chevronDown" /></button>
              <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label="Удалить" onClick={() => setList((l) => l.filter((_, j) => j !== i))}><Icon name="trash" /></button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
