import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Alert, EmptyState, Field, SearchInput, Segmented } from "../../components/ui/controls";
import { bytes, dateTime, errText, number } from "../../lib/format";
import { core, DEFAULT_TEST_URL, mihomo, type MProvider, type MProxy, type TailscalePeer, type TailscaleStatus } from "./api";
import { useMihomo } from "./context";
import { Delay, lastDelay } from "./shared";
import { HealthDots, NodeControls, NodeTiles, arrange, useStored, type NodePrefs } from "./NodeTiles";

/* ---------- Tailscale ---------- */

const peerName = (p: TailscalePeer) => p.hostName || p.dnsName.replace(/\.$/, "").split(".")[0] || p.id;

/** The peer the core uses as exit node: by flag, else by the configured IP or name. */
export function currentExit(st: TailscaleStatus): TailscalePeer | undefined {
  const peers = st.peers || [];
  const flagged = peers.find((p) => p.exitNode);
  if (flagged || !st.exitNode) return flagged;
  const want = st.exitNode.replace(/\.$/, "").toLowerCase();
  return peers.find((p) => (p.ips || []).includes(st.exitNode) || p.dnsName.replace(/\.$/, "").toLowerCase() === want || p.hostName.toLowerCase() === want || peerName(p).toLowerCase() === want);
}

/** What is wrong with the tailnet login, or null when it is fine (NPM-31). */
export function tailscaleProblem(st: TailscaleStatus): { title: string; text: string } | null {
  switch (st.backendState) {
    case "NeedsLogin":
      return { title: "Tailscale: нужен вход в tailnet", text: st.authURL ? "Вход потерян или истёк. Откройте ссылку и подтвердите устройство — трафик Tailscale до этого не идёт." : "Вход потерян или истёк. Запросите новую ссылку для входа." };
    case "NeedsMachineAuth":
      return { title: "Tailscale: устройство ждёт подтверждения", text: "Администратор tailnet (headscale) должен одобрить это устройство." };
    case "Stopped":
      return st.wantRunning ? { title: "Tailscale остановлен", text: "Узел не подключён к tailnet." } : null;
    default:
      return null;
  }
}

export type TailscaleIssue = { name: string; title: string; text: string; authURL?: string };

/** Tailscale nodes whose tailnet login is lost or pending; polled once a minute. */
export function useTailscaleIssues(enabled: boolean): TailscaleIssue[] {
  const [issues, setIssues] = useState<TailscaleIssue[]>([]);
  useEffect(() => {
    if (!enabled) {
      setIssues([]);
      return;
    }
    let alive = true;
    const pull = async () => {
      try {
        const { proxies } = await mihomo.proxies();
        const names = Object.values(proxies)
          .filter((p) => p.type.toLowerCase() === "tailscale")
          .map((p) => p.name);
        const out: TailscaleIssue[] = [];
        for (const name of names) {
          try {
            const st = await mihomo.tailscale(name);
            const pr = tailscaleProblem(st);
            if (pr) out.push({ name, ...pr, authURL: st.authURL });
          } catch {
            /* the card shows the error */
          }
        }
        if (alive) setIssues(out);
      } catch {
        if (alive) setIssues([]);
      }
    };
    void pull();
    const t = setInterval(() => document.visibilityState === "visible" && void pull(), 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return issues;
}

export function TailscaleTab({ nodes, prefs }: { nodes: MProxy[]; prefs: NodePrefs }) {
  return (
    <div className="stack">
      {nodes.length ? <NodeControls prefs={prefs} delayLabel="Сначала в сети" /> : null}
      {nodes.map((n) => (
        <TailscaleCard key={n.name} name={n.name} prefs={prefs} />
      ))}
      {!nodes.length ? (
        <EmptyState icon="network" title="Tailscale не настроен">
          Добавьте узел типа tailscale в «Конфигурация → Свои узлы».
        </EmptyState>
      ) : null}
    </div>
  );
}

type PeerFilter = "online" | "all" | "exit";

const isText = (v: unknown): v is string => typeof v === "string";

/** «Проверка доступа»: a request through the Tailscale node to a tailnet address (NPM-38). */
function AccessCheck({ name }: { name: string }) {
  // no default address: the tailnet's own names live only in this browser (NPM-41)
  const [url, setUrl] = useStored("homenet.tailscale.checkUrl", "", isText);
  const [text, setText] = useState(url);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; text: string; at: Date } | null>(null);
  const run = async () => {
    let target = text.trim();
    if (!/^https?:\/\//i.test(target)) target = `http://${target}`;
    setText(target);
    setUrl(target);
    setBusy(true);
    try {
      const r = await mihomo.delay(name, target, 10000);
      setRes({ ok: true, text: `доступ есть · ${r.delay} мс`, at: new Date() });
    } catch (err) {
      setRes({ ok: false, text: `нет доступа: ${errText(err)}`, at: new Date() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mh-ts-check">
      <div className="mh-ts-head">
        <strong>Проверка доступа</strong>
        <span className="cell-sub">запрос к адресу внутри tailnet через {name}; любой HTTP-ответ — доступ есть</span>
      </div>
      <form
        className="mh-ts-check-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label className="grow">
          <span className="sr-only">Адрес для проверки</span>
          <input className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="http://адрес-внутри-tailnet" />
        </label>
        <button type="submit" className="btn btn-sm" disabled={busy || !text.trim()}>
          {busy ? <span className="spinner" /> : <Icon name="test" />}
          Проверить
        </button>
        {res ? (
          <span className={`badge ${res.ok ? "badge-success" : "badge-danger"}`} title={res.at.toLocaleTimeString("ru-RU")}>
            {res.text}
          </span>
        ) : null}
      </form>
    </div>
  );
}

function TailscaleCard({ name, prefs }: { name: string; prefs: NodePrefs }) {
  const { view, sort, hideDead } = prefs;
  const { act } = useMihomo();
  const [st, setSt] = useState<TailscaleStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [devOpen, setDevOpen] = useState(false);
  const [filter, setFilter] = useState<PeerFilter>("online");
  const [query, setQuery] = useState("");

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

  const run = async (what: string, title: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    await act(title, fn, done);
    setBusy("");
    await load();
  };

  const peers = (st?.peers || []).filter((p) => !p.self);
  const exit = st ? currentExit(st) : undefined;
  const exits = peers.filter((p) => p.exitNodeOption || p === exit).sort((a, b) => Number(b.online) - Number(a.online) || peerName(a).localeCompare(peerName(b)));
  const running = st?.backendState === "Running";
  const problem = st ? tailscaleProblem(st) : null;
  const online = peers.filter((p) => p.online).length;
  const q = query.trim().toLowerCase();
  const shown = peers
    .filter((p) => (filter === "online" ? p.online : filter === "exit" ? p.exitNodeOption : true))
    .filter((p) => !q || peerName(p).toLowerCase().includes(q) || p.dnsName.toLowerCase().includes(q) || (p.ips || []).some((ip) => ip.includes(q)) || (p.os || "").toLowerCase().includes(q))
    .sort((a, b) => Number(b.online) - Number(a.online) || peerName(a).localeCompare(peerName(b)));
  const setExit = (value: string, label: string) => void run("exit", `Tailscale ${name}`, () => mihomo.tailscaleExitNode(name, value), value ? `Выход через ${label}` : "Выход напрямую");

  return (
    <section className="card card-flush mh-group">
      <header className="mh-ghead">
        <span className="mh-ghead-main">
          <span className="mh-ghead-title">
            <strong>{name}</strong>
            <span className="mh-ghead-type">tailscale</span>
            {st ? <span className={`badge ${running ? "badge-success" : "badge-warning"}`}>{running ? "в сети" : st.backendState}</span> : null}
          </span>
          <span className="mh-ghead-now">
            {st?.self ? `${st.self.hostName || peerName(st.self)} · ${(st.self.ips || []).join(", ")}` : ""}
            {exit ? ` · выход через ${peerName(exit)}${st?.exitNodeActive ? "" : " (не активен)"}` : st ? " · выход напрямую" : ""}
          </span>
        </span>
        <span className="mh-ghead-side">
          {st ? (
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void run("run", `Tailscale ${name}`, () => mihomo.tailscaleRunning(name, !st.wantRunning), st.wantRunning ? "Остановлен" : "Запущен")}>
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
      {problem ? (
        <div className="cb-pad">
          <Alert
            tone="danger"
            title={problem.title}
            action={
              st?.authURL ? (
                <a className="btn btn-sm btn-primary" href={st.authURL} target="_blank" rel="noopener noreferrer">
                  Войти в tailnet
                </a>
              ) : st?.backendState === "NeedsLogin" ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      "login",
                      `Tailscale ${name}`,
                      async () => {
                        await mihomo.tailscaleRunning(name, false);
                        await mihomo.tailscaleRunning(name, true);
                      },
                      "Вход запрошен — ссылка появится здесь",
                    )
                  }
                >
                  Получить ссылку для входа
                </button>
              ) : null
            }
          >
            {problem.text}
          </Alert>
        </div>
      ) : null}
      {st ? (
        <>
          <AccessCheck name={name} />
          <div className="mh-ts-head">
            <strong>Выход в интернет</strong>
            <span className="cell-sub">{busy === "exit" ? "переключаю…" : "выбор действует до перечитывания конфига; постоянный — exit-node в «Своих узлах»"}</span>
          </div>
          <NodeTiles
            view={view}
            disabled={!!busy}
            items={arrange([
              { key: "", name: "Напрямую", meta: "без exit node", status: null, active: !exit && !st.exitNode, onSelect: () => setExit("", "") },
              ...exits.map((p) => ({
                key: p.id,
                name: peerName(p),
                meta: [(p.ips || [])[0], p.os].filter(Boolean).join(" · "),
                status: <span className={`mh-delay is-${p.online ? "good" : "none"}`}>{p.online ? "в сети" : "не в сети"}</span>,
                active: p === exit,
                dead: !p.online,
                title: `${p.dnsName}${p.relay ? ` · relay ${p.relay}` : ""}`,
                onSelect: () => setExit((p.ips || [])[0] || p.dnsName.replace(/\.$/, ""), peerName(p)),
              })),
            ], sort, hideDead, 1)}
          />
          <div className="mh-ts-head">
            <strong>Устройства tailnet</strong>
            <span className="cell-sub">
              {number(online)} в сети из {number(peers.length)}
            </span>
          </div>
          <HealthDots
            dots={[...peers]
              .sort((a, b) => Number(b.online) - Number(a.online))
              .map((p) => ({ key: p.id, tone: p.online ? "good" : "none", title: `${peerName(p)}: ${p.online ? "в сети" : p.lastSeen ? `был ${dateTime(p.lastSeen)}` : "не в сети"}` }))}
            open={devOpen}
            onToggle={() => setDevOpen(!devOpen)}
            label={`Устройства (${number(peers.length)})`}
          />
          {devOpen ? (
            <>
              <div className="toolbar cb-pad mh-ts-tools">
                <SearchInput label="Поиск устройства" placeholder="Имя, адрес или ОС" value={query} onChange={setQuery} />
                <Segmented<PeerFilter>
                  label="Какие устройства"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "online", label: "В сети", count: online },
                    { value: "exit", label: "Выходы", count: peers.filter((p) => p.exitNodeOption).length },
                    { value: "all", label: "Все", count: peers.length },
                  ]}
                />
              </div>
              <NodeTiles
                view={view}
                empty="Нет устройств под фильтр."
                items={arrange(shown.map((p) => ({
                  key: p.id,
                  name: peerName(p),
                  meta: [(p.ips || [])[0], p.os, p.rxBytes || p.txBytes ? `↓${bytes(p.rxBytes)} ↑${bytes(p.txBytes)}` : ""].filter(Boolean).join(" · "),
                  status: p.online ? <span className="mh-delay is-good">в сети</span> : <span className="mh-delay">{p.lastSeen ? dateTime(p.lastSeen).split(",")[0] : "нет"}</span>,
                  active: p === exit,
                  dead: !p.online,
                  title: `${p.dnsName}${(p.ips || []).length ? ` · ${(p.ips || []).join(", ")}` : ""}${p.relay ? ` · relay ${p.relay}` : ""}${p.exitNodeOption ? " · может быть exit node" : ""}`,
                })), sort, hideDead).slice(0, 600)}
              />
              {shown.length > 600 ? <p className="mh-muted cb-pad">Показаны первые 600 — уточните поиск.</p> : null}
            </>
          ) : null}
        </>
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

export function OlcrtcTab({ providers, standalone, groups, onReload, prefs }: { providers: MProvider[]; standalone: MProxy[]; groups: MProxy[]; onReload: () => Promise<void>; prefs: NodePrefs }) {
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
      {providers.length || standalone.length ? <NodeControls prefs={prefs} /> : null}
      {providers.map((p) => (
        <OlcProvider key={p.name} p={p} path={pathOf(p.name)} groups={groups} onReload={onReload} prefs={prefs} />
      ))}
      {standalone.length ? (
        <section className="card card-flush">
          <div className="card-header">
            <div>
              <h2 className="card-title">Узлы в config.yaml</h2>
              <p className="cell-sub">Правятся в «Конфигурация → Свои узлы».</p>
            </div>
          </div>
          <NodeGrid nodes={standalone} groups={groups} onReload={onReload} prefs={prefs} />
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

function NodeGrid({ nodes, groups, onReload, prefs }: { nodes: MProxy[]; groups: MProxy[]; onReload: () => Promise<void>; prefs: NodePrefs }) {
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
    <NodeTiles
      view={prefs.view}
      empty={prefs.hideDead ? "Все узлы сейчас недоступны." : "Узлов нет."}
      items={arrange(
        nodes.map((n) => {
          const inGroups = groups.filter((g) => (g.all || []).includes(n.name)).map((g) => g.name);
          const d = lastDelay(n);
          return {
            key: n.name,
            name: n.name,
            meta: inGroups.length ? `в группах: ${inGroups.join(", ")}` : "не в группах",
            delay: d,
            dead: d === 0,
            testing: testing[n.name],
            onTest: () => void test(n.name),
          };
        }),
        prefs.sort,
        prefs.hideDead,
      )}
    />
  );
}

function OlcProvider({ p, path, groups, onReload, prefs }: { p: MProvider; path?: string; groups: MProxy[]; onReload: () => Promise<void>; prefs: NodePrefs }) {
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
      <NodeGrid nodes={p.proxies} groups={groups} onReload={onReload} prefs={prefs} />
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

