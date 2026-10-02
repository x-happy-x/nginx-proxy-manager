import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Alert, EmptyState, Field } from "../../components/ui/controls";
import { bytes, dateTime, errText, number } from "../../lib/format";
import { core, DEFAULT_TEST_URL, mihomo, type MProvider, type MProxy, type TailscaleStatus } from "./api";
import { useMihomo } from "./context";
import { Delay, lastDelay } from "./shared";

/* ---------- Tailscale ---------- */

export function TailscaleTab({ nodes }: { nodes: MProxy[] }) {
  return (
    <div className="mh-groups mh-groups-wide">
      {nodes.map((n) => (
        <TailscaleCard key={n.name} name={n.name} />
      ))}
      {!nodes.length ? (
        <EmptyState icon="network" title="Tailscale не настроен">
          Добавьте узел типа tailscale в «Конфигурация → Свои узлы».
        </EmptyState>
      ) : null}
    </div>
  );
}

function TailscaleCard({ name }: { name: string }) {
  const { act } = useMihomo();
  const [st, setSt] = useState<TailscaleStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await mihomo.tailscale(name));
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, [name]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 20000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (title: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    await act(title, fn, done);
    setBusy(false);
    await load();
  };

  const peers = (st?.peers || []).filter((p) => !p.self);
  const exits = peers.filter((p) => p.exitNodeOption);
  const shown = showAll ? peers : peers.filter((p) => p.online || p.exitNode);
  const running = st?.backendState === "Running";

  return (
    <section className="card card-flush mh-group">
      <header className="mh-group-head">
        <span className="mh-group-toggle">
          <strong>{name}</strong>
          <span className="badge">tailscale</span>
          {st ? <span className={`badge ${running ? "badge-success" : "badge-warning"}`}>{running ? "в сети" : st.backendState}</span> : null}
        </span>
        <span className="mh-group-now cell-sub">
          {st?.self ? `${st.self.hostName} · ${(st.self.ips || []).join(", ")}` : ""}
        </span>
        <span className="mh-group-actions">
          {st?.authURL ? (
            <a className="btn btn-sm btn-primary" href={st.authURL} target="_blank" rel="noopener noreferrer">
              Подключить к tailnet
            </a>
          ) : null}
          {st ? (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(`Tailscale ${name}`, () => mihomo.tailscaleRunning(name, !st.wantRunning), st.wantRunning ? "Остановлен" : "Запущен")}>
              {st.wantRunning ? "Остановить" : "Запустить"}
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Обновить" onClick={() => void load()}>
            <Icon name="refresh" />
          </button>
        </span>
      </header>
      {error ? (
        <div className="cb-pad">
          <Alert tone="warning" title="Ядро не отдало состояние Tailscale">
            {error}
          </Alert>
        </div>
      ) : null}
      {st ? (
        <div className="mh-ts">
          <div className="mh-setrow">
            <div>
              <strong>Выход в интернет через</strong>
              <span className="cell-sub">
                {st.exitNode ? (st.exitNodeActive ? "трафик идёт через выбранный узел" : "узел выбран, но пока не активен") : "напрямую с роутера"} · действует до перечитывания конфига
              </span>
            </div>
            <div className="mh-setrow-control">
              <select
                aria-label="Exit node"
                value={st.exitNode || ""}
                disabled={busy}
                onChange={(e) => void run(`Tailscale ${name}`, () => mihomo.tailscaleExitNode(name, e.target.value), e.target.value ? `Exit node: ${e.target.value}` : "Exit node снят")}
              >
                <option value="">без exit node</option>
                {exits.map((p) => (
                  <option key={p.id} value={p.dnsName || p.hostName}>
                    {p.hostName}
                    {p.online ? "" : " (не в сети)"}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Устройство</th>
                  <th>Адреса</th>
                  <th>Состояние</th>
                  <th className="col-num">↓ / ↑</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td className="cell-primary" data-label="">
                      <strong>{p.hostName}</strong>
                      <span className="cell-sub">
                        {[p.os, p.exitNode ? "exit node" : p.exitNodeOption ? "может быть exit node" : "", p.relay ? `relay ${p.relay}` : ""].filter(Boolean).join(" · ")}
                      </span>
                    </td>
                    <td className="mono cell-sub" data-label="Адреса">{(p.ips || []).join(", ") || "—"}</td>
                    <td data-label="Состояние">
                      {p.online ? <span className="badge badge-success">в сети</span> : <span className="badge">{p.lastSeen ? `был ${dateTime(p.lastSeen)}` : "не в сети"}</span>}
                    </td>
                    <td className="col-num mono" data-label="↓ / ↑">
                      {bytes(p.rxBytes)} / {bytes(p.txBytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {peers.length > shown.length || showAll ? (
            <button type="button" className="btn btn-ghost btn-sm mh-more" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Только в сети" : `Показать все устройства (${number(peers.length)})`}
            </button>
          ) : null}
        </div>
      ) : !error ? (
        <p className="mh-muted cb-pad">Загружаю состояние…</p>
      ) : null}
    </section>
  );
}

/* ---------- OLCRTC ---------- */

type OlcEntry = Record<string, unknown> & { name: string; type?: string };

const FIELDS: Array<[string, string, string, string?]> = [
  ["auth-provider", "Провайдер конференций", "jitsi"],
  ["transport", "Транспорт", "datachannel"],
  ["room-id", "Комната", "https://meet.example.org/room"],
  ["encryption-key", "Ключ шифрования (64 hex)", "", "secret"],
  ["dns-server", "DNS", "8.8.8.8:53"],
  ["channel-id", "Канал", ""],
  ["provider-token", "Токен провайдера", "", "secret"],
  ["idle-timeout", "Тайм-аут простоя", "5m"],
];

function randomHex(n: number) {
  const b = new Uint8Array(n / 2);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function OlcrtcTab({ providers, standalone, groups, onReload }: { providers: MProvider[]; standalone: MProxy[]; groups: MProxy[]; onReload: () => Promise<void> }) {
  const [paths, setPaths] = useState<Record<string, string>>({});
  useEffect(() => {
    // Only the provider file paths, read from config.yaml (secrets stay masked server-side).
    core
      .config()
      .then((c) => {
        const pp = (c.sections["proxy-providers"] || {}) as Record<string, { path?: string }>;
        setPaths(Object.fromEntries(Object.entries(pp).map(([k, v]) => [k, v?.path || ""])));
      })
      .catch(() => undefined);
  }, []);
  const pathOf = (name: string) => paths[name];
  return (
    <div className="stack">
      {providers.map((p) => (
        <OlcProvider key={p.name} p={p} path={pathOf(p.name)} groups={groups} onReload={onReload} />
      ))}
      {standalone.length ? (
        <section className="card card-flush">
          <div className="card-header">
            <div>
              <h2 className="card-title">Узлы в config.yaml</h2>
              <p className="cell-sub">Правятся в «Конфигурация → Свои узлы».</p>
            </div>
          </div>
          <NodeGrid nodes={standalone} groups={groups} onReload={onReload} />
        </section>
      ) : null}
      {!providers.length && !standalone.length ? (
        <EmptyState icon="network" title="Узлов OLCRTC нет">
          OLCRTC передаёт трафик через комнату видеоконференции. Добавьте файловый провайдер (например ./olcrtc.yaml) в «Конфигурация → Подписки» или узел в «Свои узлы».
        </EmptyState>
      ) : null}
    </div>
  );
}

function NodeGrid({ nodes, groups, onReload }: { nodes: MProxy[]; groups: MProxy[]; onReload: () => Promise<void> }) {
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const test = async (name: string) => {
    setTesting((t) => ({ ...t, [name]: true }));
    try {
      await mihomo.delay(name, DEFAULT_TEST_URL, 10000);
    } catch {
      /* failure is recorded in history */
    }
    setTesting((t) => ({ ...t, [name]: false }));
    await onReload();
  };
  return (
    <div className="mh-nodes">
      {nodes.map((n) => {
        const inGroups = groups.filter((g) => (g.all || []).includes(n.name)).map((g) => g.name);
        return (
          <div key={n.name} className="mh-node mh-node-wide">
            <span className="mh-node-main" title={n.name}>
              <span className="mh-node-meta">
                <span>{inGroups.length ? `в группах: ${inGroups.join(", ")}` : "не в группах"}</span>
              </span>
              <span className="mh-node-name">{n.name}</span>
            </span>
            <button type="button" className="mh-node-delay" onClick={() => void test(n.name)} title="Проверить задержку">
              <Delay value={lastDelay(n)} testing={testing[n.name]} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function OlcProvider({ p, path, groups, onReload }: { p: MProvider; path?: string; groups: MProxy[]; onReload: () => Promise<void> }) {
  const { act } = useMihomo();
  const [entries, setEntries] = useState<OlcEntry[] | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<{ original: string | null; e: OlcEntry } | null>(null);
  const [remove, setRemove] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = p.vehicleType === "File";

  const load = useCallback(async () => {
    if (!editable) return;
    try {
      setEntries(((await mihomo.providerProxies(p.name)).proxies || []) as OlcEntry[]);
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, [p.name, editable]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!edit) return;
    const body: Record<string, unknown> = { ...edit.e, name: edit.e.name.trim() };
    Object.keys(body).forEach((k) => body[k] === "" && edit.original === null && delete body[k]);
    if (!body.type) body.type = "olcrtc";
    setBusy(true);
    const ok = await act(
      `OLCRTC ${p.name}`,
      () => (edit.original === null ? mihomo.addProviderProxy(p.name, body) : mihomo.updateProviderProxy(p.name, edit.original, body)),
      edit.original === null ? `Добавлен ${body.name}` : `Сохранён ${body.name}`,
    );
    setBusy(false);
    if (ok) {
      setEdit(null);
      await load();
      await onReload();
    }
  };

  const keyValue = String(edit?.e["encryption-key"] ?? "");
  const keyError = keyValue && !/^[0-9a-fA-F]{64}$/.test(keyValue) ? "нужно ровно 64 шестнадцатеричных символа" : "";
  const needKey = edit?.original === null && !keyValue;

  return (
    <section className="card card-flush">
      <div className="card-header">
        <div>
          <h2 className="card-title">
            {p.name} <span className="badge">{p.vehicleType.toLowerCase()}</span>
          </h2>
          <p className="cell-sub mono">{path || (editable ? "файл провайдера" : "")}</p>
        </div>
        <div className="button-row">
          <button type="button" className="btn btn-sm" onClick={() => void act(`OLCRTC ${p.name}`, () => mihomo.healthcheck(p.name), "Проверка запущена").then(onReload)}>
            <Icon name="bolt" />
            Проверить
          </button>
          {editable ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setEdit({ original: null, e: { name: "", type: "olcrtc", "auth-provider": "jitsi", transport: "datachannel", "dns-server": "8.8.8.8:53", "encryption-key": randomHex(64) } })}>
              <Icon name="plus" />
              Узел
            </button>
          ) : null}
        </div>
      </div>
      <NodeGrid nodes={p.proxies} groups={groups} onReload={onReload} />
      {error ? (
        <div className="cb-pad">
          <Alert tone="warning" title="Файл провайдера не читается через ядро">
            {error}. Редактор узлов есть в форке x-happy-x/mihomo для файловых провайдеров.
          </Alert>
        </div>
      ) : null}
      {entries ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Узел в файле</th>
                <th>Провайдер · транспорт</th>
                <th>Комната</th>
                <th className="col-shrink" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.name}>
                  <td className="cell-primary" data-label="">
                    <strong>{e.name}</strong>
                    <span className="cell-sub">{String(e.type || "")}</span>
                  </td>
                  <td data-label="Провайдер">
                    {String(e["auth-provider"] || "—")} · {String(e.transport || "—")}
                  </td>
                  <td className="mono cell-sub" data-label="Комната">{e["room-id"] ? String(e["room-id"]) : "скрыто ядром"}</td>
                  <td className="col-shrink" data-label="">
                    <div className="row-actions">
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Изменить ${e.name}`} onClick={() => setEdit({ original: e.name, e: { ...e } })}>
                        <Icon name="edit" />
                      </button>
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Удалить ${e.name}`} onClick={() => setRemove(e.name)}>
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="card-footer">Изменения пишутся в файл провайдера сразу и применяются ядром без перезапуска. Ключи и токены ядро не показывает: пустое поле оставляет сохранённое значение.</div>

      <Modal
        open={!!edit}
        variant="drawer"
        onClose={() => !busy && setEdit(null)}
        title={edit?.original ? `Узел ${edit.original}` : "Новый узел OLCRTC"}
        autoFocusBody
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEdit(null)} disabled={busy}>
              Отмена
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || !edit?.e.name.trim() || !!keyError || needKey} onClick={() => void save()}>
              {busy ? <span className="spinner" /> : null}
              Сохранить в {p.name}
            </button>
          </>
        }
      >
        {edit ? (
          <div className="stack">
            <Field label="Название">
              <input value={edit.e.name} onChange={(ev) => setEdit({ ...edit, e: { ...edit.e, name: ev.target.value } })} />
            </Field>
            {FIELDS.map(([k, label, ph, kind]) => (
              <Field key={k} label={label} hint={k === "encryption-key" ? keyError || (edit.original ? "Пусто — оставить сохранённый ключ. Тот же ключ указывается на сервере." : "Тот же ключ указывается на сервере.") : kind === "secret" && edit.original ? "Пусто — оставить сохранённое значение." : undefined}>
                {k === "encryption-key" ? (
                  <div className="input-with-button">
                    <input className="mono" value={String(edit.e[k] ?? "")} aria-invalid={!!keyError} onChange={(ev) => setEdit({ ...edit, e: { ...edit.e, [k]: ev.target.value.trim() } })} />
                    <button type="button" className="btn" onClick={() => setEdit({ ...edit, e: { ...edit.e, [k]: randomHex(64) } })}>
                      Сгенерировать
                    </button>
                  </div>
                ) : (
                  <input className="mono" value={String(edit.e[k] ?? "")} placeholder={ph} onChange={(ev) => setEdit({ ...edit, e: { ...edit.e, [k]: ev.target.value } })} />
                )}
              </Field>
            ))}
          </div>
        ) : null}
      </Modal>
      <ConfirmDialog
        open={!!remove}
        title={`Удалить узел ${remove}?`}
        confirmLabel="Удалить"
        onClose={() => setRemove("")}
        onConfirm={() => {
          const name = remove;
          setRemove("");
          void act(`OLCRTC ${p.name}`, () => mihomo.deleteProviderProxy(p.name, name), `Удалён ${name}`).then(async () => {
            await load();
            await onReload();
          });
        }}
      >
        Узел будет удалён из файла провайдера {path || p.name}; группы, которые его используют, выберут другой узел.
      </ConfirmDialog>
    </section>
  );
}

