import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PageHeader, useHashTab } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Alert, EmptyState, Field, Segmented, Switch } from "../../components/ui/controls";
import { dateTime, errText, number } from "../../lib/format";
import { core, mihomo, type ConfigChange, type CoreDevice } from "./api";
import { useMihomo } from "./context";
import { TabCount, Tabs } from "./shared";

type Tab = "subs" | "rules" | "groups" | "nodes" | "devices" | "net" | "yaml";
type Obj = Record<string, unknown>;
type Provider = Obj & { type?: string; url?: string; path?: string; interval?: number; filter?: string; "exclude-filter"?: string; header?: Record<string, string[]>; "health-check"?: Obj };
type Group = Obj & { name: string; type: string; proxies?: string[]; use?: string[]; url?: string; interval?: number; filter?: string };
type Node = Obj & { name: string; type: string; server?: string; port?: number };

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const asArr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const lines = (v: string) => v.split("\n").map((s) => s.trim()).filter(Boolean);

const RULE_TYPES = ["DOMAIN-SUFFIX", "DOMAIN", "DOMAIN-KEYWORD", "DOMAIN-REGEX", "GEOSITE", "GEOIP", "IP-CIDR", "IP-CIDR6", "SRC-IP-CIDR", "IP-ASN", "DST-PORT", "SRC-PORT", "PROCESS-NAME", "NETWORK", "RULE-SET", "MATCH"];
const GROUP_TYPES = ["select", "url-test", "fallback", "load-balance"];
const NODE_TYPES = ["vless", "vmess", "trojan", "ss", "hysteria2", "tuic", "wireguard", "socks5", "http", "olcrtc"];
const HOURS = [1, 6, 12, 24];

function adaptiveBlock(): Obj {
  return {
    enable: true,
    url: "https://www.gstatic.com/generate_204",
    "expected-status": "204",
    interval: 60,
    timeout: 5000,
    lazy: false,
    adaptive: {
      enable: true,
      "network-key": "home-uplink",
      confirmations: 2,
      concurrency: 4,
      "direct-allowed": [{ url: "https://ya.ru", "expected-status": "200-399" }],
      "direct-global": [
        { url: "https://www.gstatic.com/generate_204", "expected-status": "204" },
        { url: "https://cp.cloudflare.com/generate_204", "expected-status": "204" },
      ],
      targets: [
        { url: "https://www.google.com/", "expected-status": "200", "min-bytes": 1024 },
        { url: "https://www.cloudflare.com/cdn-cgi/trace", "expected-status": "200", "min-bytes": 64 },
      ],
    },
  };
}
const headBlock = (): Obj => ({ enable: true, url: "https://www.gstatic.com/generate_204", interval: 300, timeout: 5000, lazy: true });

type Target = { url: string; "expected-status"?: string; "min-bytes"?: number; timeout?: number; "content-type"?: string; "body-regex"?: string; "body-not-regex"?: string };

const URL_RE = /^https?:\/\/\S+$/;

function validRegex(re: string) {
  if (!re) return true;
  try {
    // RE2 differs from JS in details, but (?i) and plain syntax match; the core has the final word.
    new RegExp(re.replace(/^\(\?i\)/, ""));
    return re.length <= 4096;
  } catch {
    return false;
  }
}

/** One adaptive target list (targets, direct-allowed, direct-global): 1–4 GET checks. */
function TargetsEditor({ label, hint, value, onChange, full }: { label: string; hint?: string; value: unknown; onChange: (t: Target[]) => void; full?: boolean }) {
  const list = asArr<Target>(value);
  const set = (i: number, patch: Partial<Target>) =>
    onChange(
      list.map((t, j) => {
        if (j !== i) return t;
        const next = { ...t, ...patch } as Record<string, unknown>;
        Object.keys(next).forEach((k) => {
          if (k !== "url" && (next[k] === "" || next[k] === undefined || next[k] === 0)) delete next[k];
        });
        return next as Target;
      }),
    );
  return (
    <div className="mh-targets">
      <div className="mh-targets-head">
        <span className="field-label">{label}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={list.length >= 4} onClick={() => onChange([...list, { url: "https://", "expected-status": "200" }])}>
          <Icon name="plus" />
          Адрес
        </button>
      </div>
      {hint ? <span className="field-hint">{hint}</span> : null}
      {list.map((t, i) => {
        const badUrl = !URL_RE.test(t.url);
        const summary = [t.timeout ? `${t.timeout} мс` : "", t["min-bytes"] ? `≥${t["min-bytes"]} Б` : "", t["content-type"] || "", t["body-regex"] ? "текст" : "", t["body-not-regex"] ? "признаки блокировки" : ""].filter(Boolean);
        return (
          <div key={i} className="mh-target">
            <div className="mh-target-row">
              <input className="mono" aria-label="Адрес" value={t.url} aria-invalid={badUrl} onChange={(e) => set(i, { url: e.target.value.trim() })} />
              <input className="mono mh-target-status" aria-label="Ожидаемый статус" placeholder="200" title="Статус или диапазон: 200, 204, 200-399" value={t["expected-status"] || ""} onChange={(e) => set(i, { "expected-status": e.target.value.trim() })} />
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Убрать адрес" disabled={list.length <= 1} onClick={() => onChange(list.filter((_, j) => j !== i))}>
                <Icon name="trash" />
              </button>
            </div>
            <details className="mh-target-more" open={full && summary.length > 0}>
              <summary>Условия ответа{summary.map((x) => ` · ${x}`).join("")}</summary>
              <div className="form-grid">
                <Field label="Таймаут, мс" hint="0 — как у провайдера; до 60000">
                  <input type="number" min={0} max={60000} value={t.timeout || ""} onChange={(e) => set(i, { timeout: Number(e.target.value) || undefined })} />
                </Field>
                <Field label="Минимум байт" hint="Например 32768, чтобы поймать обрыв на 16–20 КБ">
                  <input type="number" min={0} value={t["min-bytes"] || ""} onChange={(e) => set(i, { "min-bytes": Number(e.target.value) || undefined })} />
                </Field>
                <Field label="Тип ответа" hint="Точный MIME без charset">
                  <input className="mono" placeholder="text/html" value={t["content-type"] || ""} onChange={(e) => set(i, { "content-type": e.target.value.trim() })} />
                </Field>
              </div>
              <Field label="Обязательный текст (body-regex)" hint={validRegex(t["body-regex"] || "") ? "RE2, проверяются первые 64 КБ; (?i) — без учёта регистра" : "шаблон не разбирается"}>
                <input className="mono" placeholder="(?i)chatgpt" value={t["body-regex"] || ""} aria-invalid={!validRegex(t["body-regex"] || "")} onChange={(e) => set(i, { "body-regex": e.target.value })} />
              </Field>
              <Field label="Признаки блокировки (body-not-regex)" hint={validRegex(t["body-not-regex"] || "") ? "Любое совпадение — провал, даже если обязательный текст найден" : "шаблон не разбирается"}>
                <input className="mono" placeholder="(?i)(just a moment|access denied)" value={t["body-not-regex"] || ""} aria-invalid={!validRegex(t["body-not-regex"] || "")} onChange={(e) => set(i, { "body-not-regex": e.target.value })} />
              </Field>
            </details>
          </div>
        );
      })}
    </div>
  );
}

const targetsValid = (v: unknown) => {
  const l = asArr<Target>(v);
  return l.length >= 1 && l.length <= 4 && l.every((t) => URL_RE.test(t.url) && validRegex(t["body-regex"] || "") && validRegex(t["body-not-regex"] || ""));
};

/** Templates after mihomo docs/adaptive-ai.example.yaml: a dedicated provider and fallback group per service. */
const SERVICE_PRESETS: Record<string, { title: string; domains: string[]; target: Target }> = {
  chatgpt: {
    title: "ChatGPT",
    domains: ["chatgpt.com", "openai.com"],
    target: { url: "https://chatgpt.com/", timeout: 8000, "expected-status": "200", "content-type": "text/html", "min-bytes": 1024, "body-regex": "(?i)chatgpt", "body-not-regex": "(?i)(cf-chl-|just a moment|unsupported_country|access denied)" },
  },
  claude: {
    title: "Claude",
    domains: ["claude.ai", "anthropic.com"],
    target: { url: "https://claude.ai/login", timeout: 8000, "expected-status": "200-399", "content-type": "text/html", "min-bytes": 1024, "body-regex": "(?i)claude", "body-not-regex": "(?i)(cf-chl-|just a moment|access denied)" },
  },
  gemini: {
    title: "Gemini",
    domains: ["gemini.google.com"],
    target: { url: "https://gemini.google.com/", timeout: 8000, "expected-status": "200-399", "content-type": "text/html", "min-bytes": 1024, "body-regex": "(?i)gemini", "body-not-regex": "(?i)(not available in your country|access denied)" },
  },
};

function randomHex(n: number) {
  const b = new Uint8Array(n / 2);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function Config() {
  const { cfg, setCfg, draft, setDraft, configDirty, log, refreshStatus } = useMihomo();
  const [tab, setTab] = useHashTab<Tab>("coreconfig", "subs");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [yamlText, setYamlText] = useState<string | null>(null);
  const [review, setReview] = useState<{ changes: ConfigChange[]; valid: boolean; message?: string; mode: "set" | "yaml" } | null>(null);
  const [discard, setDiscard] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await core.config();
      setCfg(c);
      setDraft(clone(c.sections));
      setYamlText(null);
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, [setCfg, setDraft]);

  useEffect(() => {
    if (!cfg) void load();
  }, [cfg, load]);

  const d = draft || {};
  const update = (key: string, value: unknown) => setDraft({ ...d, [key]: value === undefined ? undefined : clone(value) });

  const changedSet = useMemo(() => {
    if (!cfg || !draft) return {};
    const out: Obj = {};
    const keys = new Set([...Object.keys(cfg.sections), ...Object.keys(draft)]);
    keys.forEach((k) => {
      if (JSON.stringify(cfg.sections[k]) !== JSON.stringify(draft[k])) out[k] = draft[k] === undefined ? null : draft[k];
    });
    return out;
  }, [cfg, draft]);

  const check = async (mode: "set" | "yaml") => {
    if (!cfg) return;
    setBusy(true);
    try {
      const body = mode === "yaml" ? { sha: cfg.sha, yaml: yamlText ?? cfg.yaml } : { sha: cfg.sha, set: changedSet };
      const res = await core.checkConfig(body);
      setReview({ changes: res.changes || [], valid: res.valid, message: res.message, mode });
    } catch (err) {
      const body = (err as { body?: { changes?: ConfigChange[] } }).body;
      setReview({ changes: body?.changes || [], valid: false, message: errText(err), mode });
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!cfg || !review) return;
    setBusy(true);
    try {
      const body = review.mode === "yaml" ? { sha: cfg.sha, yaml: yamlText ?? cfg.yaml } : { sha: cfg.sha, set: changedSet };
      const res = await core.applyConfig(body);
      log("Конфигурация mihomo", res.message || "Применено", "success");
      setReview(null);
      setCfg(null);
      await load();
      void refreshStatus();
    } catch (err) {
      log("Конфигурация mihomo", errText(err), "error");
      setReview((r) => (r ? { ...r, valid: false, message: errText(err) } : r));
    } finally {
      setBusy(false);
    }
  };

  if (!cfg || !draft) {
    return (
      <div className="stack">
        <PageHeader page="coreconfig" />
        {error ? <Alert tone="danger" title="Не удалось прочитать config.yaml">{error}</Alert> : <div className="launcher-loading">Читаю config.yaml…</div>}
      </div>
    );
  }

  const providers = asObj(d["proxy-providers"]) as Record<string, Provider>;
  const groups = asArr<Group>(d["proxy-groups"]);
  const rules = asArr<string>(d.rules);
  const nodes = asArr<Node>(d.proxies);

  return (
    <div className="stack mh-config">
      <PageHeader
        page="coreconfig"
        actions={
          <>
            <span className="cell-sub mono" title={cfg.target}>
              {cfg.path}
            </span>
            <button type="button" className="btn" onClick={() => (configDirty ? setDiscard(true) : void load())}>
              <Icon name="refresh" />
              Перечитать
            </button>
          </>
        }
      />
      {!cfg.can_validate ? <Alert tone="warning" title="Бинарник mihomo не найден">Правки можно собрать, но проверить и применить их нечем: нужен mihomo на роутере.</Alert> : null}
      <Tabs<Tab>
        label="Раздел конфигурации"
        value={tab}
        onChange={setTab}
        items={[
          ["subs", <>Подписки <TabCount n={Object.keys(providers).length} /></>],
          ["rules", <>Правила <TabCount n={rules.length} /></>],
          ["groups", <>Группы <TabCount n={groups.length} /></>],
          ["nodes", <>Свои узлы <TabCount n={nodes.length} /></>],
          ["devices", "Устройства"],
          ["net", "DNS и TUN"],
          ["yaml", "YAML"],
        ]}
      />
      {tab === "subs" ? <Subscriptions providers={providers} groups={groups} rules={rules} onChange={(p, g) => setDraft({ ...d, "proxy-providers": p, "proxy-groups": g })} onService={(p, g, r) => setDraft({ ...d, "proxy-providers": p, "proxy-groups": g, rules: r })} /> : null}
      {tab === "rules" ? <RulesEditor rules={rules} groups={groups} onChange={(r) => update("rules", r)} /> : null}
      {tab === "groups" ? <GroupsEditor groups={groups} providers={Object.keys(providers)} nodes={nodes.map((n) => n.name)} onChange={(g) => update("proxy-groups", g)} /> : null}
      {tab === "nodes" ? <NodesEditor nodes={nodes} groups={groups} onChange={(n, g) => setDraft({ ...d, proxies: n, "proxy-groups": g })} /> : null}
      {tab === "devices" ? <DevicesEditor rules={rules} groups={groups} onRules={(r) => update("rules", r)} /> : null}
      {tab === "net" ? <NetEditor draft={d} onChange={(k, v) => update(k, v)} /> : null}
      {tab === "yaml" ? (
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">config.yaml целиком</h2>
              <p className="cell-sub">secret скрыт и сохранится как был; external-controller и external-ui тоже не меняются.</p>
            </div>
            <div className="button-row">
              <button type="button" className="btn" onClick={() => setYamlText(null)} disabled={yamlText == null}>
                Отменить правки
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || configDirty || yamlText == null || !cfg.can_validate} onClick={() => void check("yaml")}>
                Проверить YAML
              </button>
            </div>
          </div>
          {configDirty ? <Alert tone="warning">В других вкладках есть несохранённые правки. Примените или отмените их, прежде чем править YAML целиком.</Alert> : null}
          <textarea className="config-editor mh-yaml" spellCheck={false} aria-label="config.yaml" value={yamlText ?? cfg.yaml} onChange={(e) => setYamlText(e.target.value)} />
          {cfg.backups.length ? (
            <div className="card-footer">
              Резервные копии рядом с конфигом: {cfg.backups.slice(0, 5).map((b) => `${b.name} (${dateTime(b.time)})`).join(", ")}
              {cfg.backups.length > 5 ? ` и ещё ${cfg.backups.length - 5}` : ""}.
            </div>
          ) : null}
        </section>
      ) : null}

      {configDirty ? (
        <div className="changes-bar" role="region" aria-label="Несохранённые изменения конфигурации">
          <div className="changes-row">
            <Icon name="alert" size={18} />
            <div className="changes-text">
              <strong>Конфиг mihomo изменён</strong>
              <span>
                Правки в разделах: {Object.keys(changedSet).join(", ")}. Ядро пока работает со старым файлом.
              </span>
            </div>
            <div className="button-row">
              <button type="button" className="btn btn-ghost" onClick={() => setDiscard(true)} disabled={busy}>
                Отменить
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void check("set")} disabled={busy || !cfg.can_validate}>
                {busy ? <span className="spinner" /> : <Icon name="test" />}
                Проверить и применить
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        open={!!review}
        onClose={() => !busy && setReview(null)}
        locked={busy}
        size="lg"
        title={review?.valid ? "Изменения прошли проверку" : "Проверка не пройдена"}
        description={review?.message}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setReview(null)} disabled={busy}>
              Вернуться к правкам
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void apply()} disabled={busy || !review?.valid}>
              {busy ? <span className="spinner" /> : <Icon name="bolt" />}
              Применить на роутере
            </button>
          </>
        }
      >
        <div className="stack">
          <ul className="mh-changes">
            {(review?.changes || []).map((c, i) => (
              <li key={i} className={`is-${c.kind}`}>
                <span className="mh-change-kind">{c.kind === "added" ? "+" : c.kind === "removed" ? "−" : "~"}</span>
                <span className="mono">{c.section}</span>
                {c.item ? <span className="mono truncate">{c.item}</span> : null}
              </li>
            ))}
            {!review?.changes.length ? <li>Изменений нет.</li> : null}
          </ul>
          <p className="cell-sub">
            При применении: копия текущего файла → замена config.yaml → перечитывание через контроллер. Если ядро не примет конфиг, старый файл и состояние вернутся автоматически.
          </p>
        </div>
      </Modal>
      <ConfirmDialog
        open={discard}
        title="Отменить правки конфигурации?"
        confirmLabel="Отменить правки"
        onClose={() => setDiscard(false)}
        onConfirm={() => {
          setDiscard(false);
          void load();
        }}
      >
        Несохранённые правки подписок, правил, групп и узлов будут потеряны, config.yaml перечитается с роутера.
      </ConfirmDialog>
    </div>
  );
}

/* ---------- subscriptions ---------- */

function Subscriptions({ providers, groups, rules, onChange, onService }: { providers: Record<string, Provider>; groups: Group[]; rules: string[]; onChange: (p: Record<string, Provider>, g: Group[]) => void; onService: (p: Record<string, Provider>, g: Group[], r: string[]) => void }) {
  const [service, setService] = useState(false);
  const [edit, setEdit] = useState<{ original: string | null; name: string; p: Provider; inGroups: string[] } | null>(null);
  const [remove, setRemove] = useState("");
  const usedBy = (name: string) => groups.filter((g) => (g.use || []).includes(name)).map((g) => g.name);

  const open = (name: string | null) => {
    const p = name ? clone(providers[name]) : ({ type: "http", url: "", interval: 43200, path: "", "health-check": adaptiveBlock() } as Provider);
    setEdit({ original: name, name: name || "", p, inGroups: name ? usedBy(name) : groups.filter((g) => g.type === "select").slice(0, 1).map((g) => g.name) });
  };

  const save = () => {
    if (!edit) return;
    const name = edit.name.trim();
    const next = { ...providers };
    if (edit.original && edit.original !== name) delete next[edit.original];
    const p = clone(edit.p);
    if (p.type === "http" && !p.path) p.path = `./providers/${name}.yaml`;
    next[name] = p;
    const g = groups.map((grp) => {
      const use = (grp.use || []).filter((u) => u !== edit.original && u !== name);
      if (edit.inGroups.includes(grp.name)) use.push(name);
      const out = { ...grp } as Group;
      if (use.length) out.use = use;
      else delete out.use;
      return out;
    });
    onChange(next, g);
    setEdit(null);
  };

  const nameError = edit ? (!/^[A-Za-z0-9_.-]{1,40}$/.test(edit.name.trim()) ? "латиница, цифры, точка, дефис, подчёркивание" : edit.name.trim() !== edit.original && providers[edit.name.trim()] ? "такая подписка уже есть" : "") : "";
  const urlError = edit && edit.p.type === "http" && !/^https?:\/\/\S+$/.test(String(edit.p.url || "")) ? "ссылка должна начинаться с http:// или https://" : "";
  const hc = asObj(edit?.p["health-check"]);
  const ad = asObj(hc.adaptive);
  const adaptive = !!ad.enable;
  const setHC = (next: Obj) => edit && setEdit({ ...edit, p: { ...edit.p, "health-check": next } });
  const setAd = (patch: Obj) => setHC({ ...hc, adaptive: { ...ad, ...patch } });
  const ua = edit?.p.header?.["User-Agent"]?.[0] || "";
  // A base for depends-on: adaptive, not itself a service check, not the one being edited.
  const isAdaptive = (p?: Provider) => !!asObj(asObj(p?.["health-check"]).adaptive).enable;
  const dependsOf = (p?: Provider) => String(asObj(asObj(p?.["health-check"]).adaptive)["depends-on"] || "");
  const baseCandidates = Object.entries(providers)
    .filter(([n, p]) => n !== edit?.original && isAdaptive(p) && !dependsOf(p))
    .map(([n]) => n);
  const dependents = edit?.original ? Object.entries(providers).filter(([, p]) => dependsOf(p) === edit.original).map(([n]) => n) : [];

  return (
    <section className="card card-flush">
      <div className="card-header">
        <h2 className="card-title">Подписки (proxy-providers)</h2>
        <div className="button-row">
          <button type="button" className="btn" onClick={() => setService(true)} title="Отдельная проверка узлов для ChatGPT, Claude или Gemini">
            <Icon name="test" />
            Проверка сервиса
          </button>
          <button type="button" className="btn btn-primary" onClick={() => open(null)}>
            <Icon name="plus" />
            Добавить подписку
          </button>
        </div>
      </div>
      {Object.keys(providers).length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Подписка</th>
                <th>Источник</th>
                <th>Обновление</th>
                <th>Проверка</th>
                <th>Группы</th>
                <th className="col-shrink" />
              </tr>
            </thead>
            <tbody>
              {Object.entries(providers).map(([name, p]) => {
                const h = asObj(p["health-check"]);
                const isAd = !!asObj(h.adaptive).enable;
                return (
                  <tr key={name}>
                    <td className="cell-primary" data-label="">
                      <strong>{name}</strong>
                    </td>
                    <td className="mono truncate mh-url" data-label="Источник" title={p.url || p.path}>
                      {p.type === "http" ? p.url : p.path}
                    </td>
                    <td data-label="Обновление">{p.type === "http" ? (p.interval ? `каждые ${number(Number(p.interval) / 3600)} ч` : "вручную") : "файл"}</td>
                    <td data-label="Проверка">
                      {h.enable ? isAd ? <span className="badge badge-accent">адаптивная</span> : <span className="badge">HEAD {String(h.interval || "")} с</span> : <span className="badge">выкл.</span>}
                      {asObj(h.adaptive)["depends-on"] ? <span className="cell-sub">после {String(asObj(h.adaptive)["depends-on"])}</span> : null}
                    </td>
                    <td data-label="Группы">{usedBy(name).join(", ") || "—"}</td>
                    <td className="col-shrink" data-label="">
                      <div className="row-actions">
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Изменить ${name}`} onClick={() => open(name)}>
                          <Icon name="edit" />
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Удалить ${name}`} onClick={() => setRemove(name)}>
                          <Icon name="trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon="layers" title="Подписок нет" action={<button type="button" className="btn btn-primary" onClick={() => open(null)}>Добавить подписку</button>}>
          Подписка — ссылка от VPN-провайдера со списком узлов.
        </EmptyState>
      )}

      <Modal
        open={!!edit}
        variant="drawer"
        onClose={() => setEdit(null)}
        title={edit?.original ? `Подписка ${edit.original}` : "Новая подписка"}
        autoFocusBody
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEdit(null)}>
              Отмена
            </button>
            <button type="button" className="btn btn-primary" disabled={!!nameError || !!urlError || (adaptive && !(targetsValid(ad.targets) && targetsValid(ad["direct-allowed"]) && targetsValid(ad["direct-global"])))} onClick={save}>
              В черновик
            </button>
          </>
        }
      >
        {edit ? (
          <div className="stack">
            <Field label="Название" hint={nameError || "Так подписка называется в группах и на странице «Прокси»."}>
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-invalid={!!nameError} />
            </Field>
            <Field label="Источник" group>
              <Segmented<string> label="Источник" value={String(edit.p.type || "http")} onChange={(v) => setEdit({ ...edit, p: { ...edit.p, type: v } })} options={[{ value: "http", label: "Ссылка" }, { value: "file", label: "Файл на роутере" }]} />
            </Field>
            {edit.p.type === "http" ? (
              <>
                <Field label="Ссылка подписки" hint={urlError || "Формат Clash/mihomo или base64-список."}>
                  <input className="mono" value={String(edit.p.url || "")} onChange={(e) => setEdit({ ...edit, p: { ...edit.p, url: e.target.value.trim() } })} aria-invalid={!!urlError} placeholder="https://…" />
                </Field>
                <Field label="Обновлять" group>
                  <Segmented<string>
                    label="Обновлять"
                    value={String(Number(edit.p.interval || 0) / 3600)}
                    onChange={(v) => setEdit({ ...edit, p: { ...edit.p, interval: Number(v) * 3600 } })}
                    options={HOURS.map((h) => ({ value: String(h), label: `${h} ч` }))}
                  />
                </Field>
                <Field label="User-Agent" hint="Некоторые провайдеры отдают узлы только клиентам Clash.">
                  <input
                    value={ua}
                    placeholder="clash.meta"
                    onChange={(e) => {
                      const header = { ...(edit.p.header || {}) };
                      if (e.target.value) header["User-Agent"] = [e.target.value];
                      else delete header["User-Agent"];
                      const p = { ...edit.p, header } as Provider;
                      if (!Object.keys(header).length) delete p.header;
                      setEdit({ ...edit, p });
                    }}
                  />
                </Field>
              </>
            ) : (
              <Field label="Путь к файлу" hint="Относительно каталога mihomo, например ./providers/local.yaml">
                <input className="mono" value={String(edit.p.path || "")} onChange={(e) => setEdit({ ...edit, p: { ...edit.p, path: e.target.value } })} />
              </Field>
            )}
            <div className="form-grid">
              <Field label="Взять только" hint="Регулярное выражение по имени узла">
                <input className="mono" value={String(edit.p.filter || "")} placeholder="(?i)nl|de|fi" onChange={(e) => setEdit({ ...edit, p: { ...edit.p, filter: e.target.value || undefined } })} />
              </Field>
              <Field label="Исключить">
                <input className="mono" value={String(edit.p["exclude-filter"] || "")} onChange={(e) => setEdit({ ...edit, p: { ...edit.p, "exclude-filter": e.target.value || undefined } })} />
              </Field>
            </div>
            <Field label="Проверка узлов" group hint={adaptive ? "GET через каждый узел с учётом белых списков; два отдельных рейтинга. Нужен форк x-happy-x/mihomo." : "Штатная проверка HEAD-запросом."}>
              <Segmented<string> label="Проверка узлов" value={adaptive ? "adaptive" : "head"} onChange={(v) => setHC(v === "adaptive" ? adaptiveBlock() : headBlock())} options={[{ value: "head", label: "Обычная" }, { value: "adaptive", label: "Адаптивная" }]} />
            </Field>
            {adaptive ? (
              <div className="form-section">
                <div className="form-grid">
                  <Field label="Интервал, с">
                    <input type="number" min={10} value={Number(hc.interval || 60)} onChange={(e) => setHC({ ...hc, interval: Number(e.target.value) })} />
                  </Field>
                  <Field label="Параллельно узлов">
                    <input type="number" min={1} max={10} value={Number(ad.concurrency || 4)} onChange={(e) => setAd({ concurrency: Number(e.target.value) })} />
                  </Field>
                  <Field label="Подтверждений режима">
                    <input type="number" min={1} max={10} value={Number(ad.confirmations || 2)} onChange={(e) => setAd({ confirmations: Number(e.target.value) })} />
                  </Field>
                  <Field label="Ключ сети" hint="Разделяет историю разных провайдеров интернета">
                    <input value={String(ad["network-key"] || "")} onChange={(e) => setAd({ "network-key": e.target.value })} />
                  </Field>
                </div>
                <Field
                  label="Сначала проверять подпиской"
                  hint={
                    dependents.length
                      ? `От этой подписки зависят: ${dependents.join(", ")} — сама она базовой быть не может.`
                      : "depends-on (MIHOMO-6): сервис проверяет только узлы, свежо прошедшие базовую проверку. Узлы должны совпадать по параметрам подключения — возьмите тот же источник."
                  }
                >
                  <select value={String(ad["depends-on"] || "")} disabled={dependents.length > 0} onChange={(e) => setAd({ "depends-on": e.target.value || undefined })}>
                    <option value="">нет — это базовая проверка</option>
                    {baseCandidates.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </Field>
                <div className="form-grid">
                  <Field label="Ошибок подряд до отказа" hint="failure-threshold, 1–10">
                    <input type="number" min={1} max={10} value={Number(ad["failure-threshold"] || 1)} onChange={(e) => setAd({ "failure-threshold": Number(e.target.value) })} />
                  </Field>
                  <Field label="Успехов подряд до возврата" hint="recovery-threshold, 1–10">
                    <input type="number" min={1} max={10} value={Number(ad["recovery-threshold"] || 1)} onChange={(e) => setAd({ "recovery-threshold": Number(e.target.value) })} />
                  </Field>
                </div>
                <TargetsEditor label="Цели узлов" hint="Через каждый узел; нужен успех по всем адресам." value={ad.targets} onChange={(t) => setAd({ targets: t })} full />
                <TargetsEditor label="Разрешённые при белых списках (напрямую)" value={ad["direct-allowed"]} onChange={(t) => setAd({ "direct-allowed": t })} />
                <TargetsEditor label="Глобальные (напрямую)" value={ad["direct-global"]} onChange={(t) => setAd({ "direct-global": t })} />
              </div>
            ) : null}
            <Field label="Добавить в группы" group>
              <div className="chip-wrap">
                {groups.map((g) => (
                  <label key={g.name} className="mh-check">
                    <input
                      type="checkbox"
                      checked={edit.inGroups.includes(g.name)}
                      onChange={(e) => setEdit({ ...edit, inGroups: e.target.checked ? [...edit.inGroups, g.name] : edit.inGroups.filter((x) => x !== g.name) })}
                    />
                    {g.name}
                  </label>
                ))}
                {!groups.length ? <span className="mh-muted">Групп нет — создайте во вкладке «Группы».</span> : null}
              </div>
            </Field>
          </div>
        ) : null}
      </Modal>
      <ServiceCheckDialog open={service} onClose={() => setService(false)} providers={providers} groups={groups} rules={rules} onCreate={onService} />
      <ConfirmDialog
        open={!!remove}
        title={`Удалить подписку ${remove}?`}
        confirmLabel="Удалить"
        onClose={() => setRemove("")}
        onConfirm={() => {
          const next: Record<string, Provider> = {};
          Object.entries(providers).forEach(([n, p]) => {
            if (n === remove) return;
            const hc = asObj(p["health-check"]);
            const ad = asObj(hc.adaptive);
            if (ad["depends-on"] === remove) {
              const nextAd = { ...ad };
              delete nextAd["depends-on"];
              next[n] = { ...p, "health-check": { ...hc, adaptive: nextAd } };
            } else next[n] = p;
          });
          onChange(
            next,
            groups.map((g) => {
              const use = (g.use || []).filter((u) => u !== remove);
              const out = { ...g } as Group;
              if (use.length) out.use = use;
              else delete out.use;
              return out;
            }),
          );
          setRemove("");
        }}
      >
        Подписка будет убрана из групп: {usedBy(remove).join(", ") || "ни в одной"}.
        {Object.entries(providers).some(([, p]) => asObj(asObj(p["health-check"]).adaptive)["depends-on"] === remove)
          ? ` Зависящие от неё проверки сервисов (${Object.entries(providers).filter(([, p]) => asObj(asObj(p["health-check"]).adaptive)["depends-on"] === remove).map(([n]) => n).join(", ")}) станут самостоятельными.`
          : ""}{" "}
        Изменение попадёт в черновик.
      </ConfirmDialog>
    </section>
  );
}

/* ---------- service check template (MIHOMO-5) ---------- */

function ServiceCheckDialog({
  open,
  onClose,
  providers,
  groups,
  rules,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  providers: Record<string, Provider>;
  groups: Group[];
  rules: string[];
  onCreate: (p: Record<string, Provider>, g: Group[], r: string[]) => void;
}) {
  const adaptiveOf = (p: Provider) => asObj(asObj(p["health-check"]).adaptive);
  // Bases for the cascade: adaptive subscriptions that are not service checks themselves.
  const bases = Object.entries(providers)
    .filter(([, p]) => adaptiveOf(p).enable && !adaptiveOf(p)["depends-on"])
    .map(([n]) => n);
  const [preset, setPreset] = useState("chatgpt");
  const [baseName, setBaseName] = useState("");
  const [source, setSource] = useState<"base" | "file">("base");
  const [path, setPath] = useState("./providers/ai-nodes.yaml");
  const [filter, setFilter] = useState("");
  const base = SERVICE_PRESETS[preset];
  const name = `AI-${base.title.toUpperCase()}`;
  const group = `AI-${base.title}`;
  const exists = !!providers[name] || groups.some((g) => g.name === group);
  const chosenBase = baseName || bases[0] || "";
  const from = providers[chosenBase];
  const cascade = !!chosenBase;

  const create = () => {
    let p: Provider;
    if (source === "base" && from) {
      // Same connection parameters as the base are what lets depends-on match nodes.
      // A file base is shared as is; an http base keeps managing downloads, the
      // service reads the same file and never fetches the subscription itself.
      p = from.type === "file" || from.path ? { type: "file", path: String(from.path || `./providers/${chosenBase}.yaml`), interval: 3600 } : { type: "http", url: from.url, interval: from.interval || 43200, path: `./providers/${name}.yaml`, ...(from.header ? { header: from.header } : {}) };
    } else p = { type: "file", path };
    if (filter.trim()) p.filter = filter.trim();
    p.override = { "additional-prefix": `${group} | ` };
    const adaptive: Obj = {
      ...asObj(adaptiveBlock().adaptive),
      concurrency: 2,
      "failure-threshold": 3,
      "recovery-threshold": 2,
      targets: [base.target],
    };
    if (cascade) {
      adaptive["depends-on"] = chosenBase;
      // Same network observation as the base so both agree on normal/whitelist.
      const bAd = adaptiveOf(from);
      ["network-key", "direct-allowed", "direct-global", "confirmations"].forEach((k) => {
        if (bAd[k] !== undefined) adaptive[k] = clone(bAd[k]);
      });
    }
    p["health-check"] = {
      enable: true,
      lazy: false,
      interval: 300,
      timeout: 5000,
      url: "https://www.gstatic.com/generate_204",
      "expected-status": "204",
      adaptive,
    };
    const g: Group = { name: group, type: "fallback", use: [name], url: "https://www.gstatic.com/generate_204", "expected-status": "204", timeout: 10000 };
    const match = rules.findIndex((r) => r.startsWith("MATCH,"));
    const add = base.domains.map((d) => `DOMAIN-SUFFIX,${d},${group}`).filter((r) => !rules.includes(r));
    const nextRules = [...rules];
    nextRules.splice(match < 0 ? nextRules.length : match, 0, ...add);
    onCreate({ ...providers, [name]: p }, [...groups, g], nextRules);
    onClose();
  };

  const sourceText =
    source === "base" && from
      ? from.path
        ? `файл ${String(from.path)} — его обновляет ${chosenBase}`
        : `та же ссылка, что у ${chosenBase}`
      : `файл ${path}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Проверка сервиса"
      description="Отдельная подписка и fallback-группа, которые проверяют узлы по странице сервиса. С каскадом сервис проверяет только узлы, уже прошедшие базовую подписку."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" disabled={exists || (source === "base" && !from) || (source === "file" && !path.trim())} onClick={create}>
            В черновик
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Сервис" group>
          <Segmented<string> label="Сервис" value={preset} onChange={setPreset} options={Object.entries(SERVICE_PRESETS).map(([value, v]) => ({ value, label: v.title }))} />
        </Field>
        <Field label="Сначала проверять подпиской" hint={bases.length ? "depends-on (MIHOMO-6). База продолжает проверять весь свой список; сервис ждёт её успеха и порога восстановления." : "Нет подписки с адаптивной проверкой — сервис будет проверять узлы сам, без каскада."}>
          <select value={chosenBase} onChange={(e) => setBaseName(e.target.value)} disabled={!bases.length}>
            {bases.map((n) => (
              <option key={n}>{n}</option>
            ))}
            {!bases.length ? <option value="">нет</option> : null}
          </select>
        </Field>
        <Field label="Узлы-кандидаты" group hint="Каскад сопоставляет узлы по параметрам подключения, поэтому надёжнее взять тот же источник, что у базы, и сузить его фильтром.">
          <Segmented<"base" | "file">
            label="Узлы-кандидаты"
            value={source}
            onChange={setSource}
            options={[
              { value: "base", label: "Тот же источник, что у базы" },
              { value: "file", label: "Отдельный файл" },
            ]}
            disabled={!from && source === "base" && !bases.length}
          />
        </Field>
        {source === "file" ? (
          <Field label="Файл провайдера" hint="YAML вида proxies: [...] в каталоге mihomo">
            <input className="mono" value={path} onChange={(e) => setPath(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Взять только узлы" hint="Регулярное выражение по имени; начните с небольшого списка — нагрузка растёт с числом сервисов.">
          <input className="mono" value={filter} placeholder="(?i)nl|de|fi" onChange={(e) => setFilter(e.target.value)} />
        </Field>
        <dl className="kv">
          <div>
            <dt>Подписка</dt>
            <dd className="mono">
              {name} · {sourceText}
            </dd>
          </div>
          <div>
            <dt>Каскад</dt>
            <dd className="mono">{cascade ? `depends-on: ${chosenBase} · режим сети как у базы` : "нет"}</dd>
          </div>
          <div>
            <dt>Группа</dt>
            <dd className="mono">{group} · fallback · ошибок до отказа 3, успехов до возврата 2</dd>
          </div>
          <div>
            <dt>Проверка</dt>
            <dd className="mono">
              GET {base.target.url} · {base.target["expected-status"]} · {base.target["content-type"]} · ≥{base.target["min-bytes"]} Б
            </dd>
          </div>
          <div>
            <dt>Текст / блок</dt>
            <dd className="mono">
              {base.target["body-regex"]} / {base.target["body-not-regex"]}
            </dd>
          </div>
          <div>
            <dt>Правила</dt>
            <dd className="mono">{base.domains.map((d) => `DOMAIN-SUFFIX,${d},${group}`).join("; ")}</dd>
          </div>
        </dl>
        {exists ? <Alert tone="warning">Подписка {name} или группа {group} уже есть в конфиге.</Alert> : null}
        {cascade ? <Alert tone="info">Каскад нужен ядру с MIHOMO-6. Старое ядро не примет depends-on, и проверка mihomo -t покажет это до применения.</Alert> : null}
        <Alert tone="info">
          Это шаблон проверки страницы, а не доказательство, что чат работает: вход, отправка сообщений и лимиты аккаунта не проверяются. Сверьте ответы через заведомо рабочий и нерабочий выход и поправьте шаблоны в настройках подписки.
        </Alert>
      </div>
    </Modal>
  );
}

/* ---------- rules ---------- */

function parseRule(r: string) {
  const parts = r.split(",");
  const type = parts[0] || "";
  if (type === "MATCH") return { type, value: "", target: parts[1] || "", opts: parts.slice(2) };
  return { type, value: parts[1] || "", target: parts[2] || "", opts: parts.slice(3) };
}

function targetsOf(groups: Group[]) {
  return [...groups.map((g) => g.name), "DIRECT", "REJECT"];
}

function RulesEditor({ rules, groups, onChange }: { rules: string[]; groups: Group[]; onChange: (r: string[]) => void }) {
  const { act } = useMihomo();
  const [type, setType] = useState("DOMAIN-SUFFIX");
  const [value, setValue] = useState("");
  const [target, setTarget] = useState(groups[0]?.name || "DIRECT");
  const [noResolve, setNoResolve] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    void mihomo
      .rules()
      .then((r) => setHits(new Map((r.rules || []).map((x) => [`${x.type},${x.payload},${x.proxy}`.toUpperCase(), x.extra?.hitCount || 0]))))
      .catch(() => undefined);
  }, []);

  const add = () => {
    const parts = type === "MATCH" ? [type, target] : [type, value.trim(), target];
    if (noResolve && /^(GEOIP|IP-CIDR6?|IP-ASN|SRC-IP-CIDR)$/.test(type)) parts.push("no-resolve");
    const rule = parts.join(",");
    const next = [...rules];
    const match = next.findIndex((r) => r.startsWith("MATCH,"));
    next.splice(match < 0 ? next.length : match, 0, rule);
    onChange(next);
    setValue("");
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const q = query.trim().toLowerCase();
  const canAdd = type === "MATCH" || !!value.trim();

  return (
    <div className="stack">
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Добавить правило</h2>
          <span className="cell-sub">встаёт перед MATCH; правила проверяются сверху вниз</span>
        </div>
        <div className="card-body mh-rule-add">
          <select aria-label="Тип правила" value={type} onChange={(e) => setType(e.target.value)}>
            {RULE_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          {type !== "MATCH" ? <input aria-label="Значение" className="mono" value={value} placeholder={type === "GEOSITE" ? "youtube" : type.startsWith("IP") ? "10.0.0.0/8" : "example.com"} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && canAdd && add()} /> : null}
          <select aria-label="Цель" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targetsOf(groups).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          {/^(GEOIP|IP-CIDR6?|IP-ASN)$/.test(type) ? (
            <label className="mh-check">
              <input type="checkbox" checked={noResolve} onChange={(e) => setNoResolve(e.target.checked)} />
              no-resolve
            </label>
          ) : null}
          <button type="button" className="btn btn-primary" disabled={!canAdd} onClick={add}>
            <Icon name="plus" />
            В черновик
          </button>
        </div>
      </section>
      <section className="card card-flush">
        <div className="card-header">
          <input aria-label="Поиск по правилам" className="mh-filter" placeholder="Фильтр" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" className="btn btn-sm" onClick={() => void act("Наборы правил", async () => Promise.all(Object.keys((await mihomo.ruleProviders()).providers || {}).map((n) => mihomo.updateRuleProvider(n))), "Обновлены")}>
            <Icon name="refresh" />
            Обновить наборы
          </button>
        </div>
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th className="col-num">#</th>
                <th>Тип</th>
                <th>Значение</th>
                <th>Цель</th>
                <th className="col-num">Срабат.</th>
                <th className="col-shrink" />
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => {
                if (q && !r.toLowerCase().includes(q)) return null;
                const p = parseRule(r);
                const hit = hits.get(`${p.type},${p.value},${p.target}`.toUpperCase());
                return (
                  <tr key={`${i}:${r}`}>
                    <td className="col-num mono" data-label="">{i + 1}</td>
                    <td data-label="Тип">
                      <span className="method">{p.type}</span>
                    </td>
                    <td className="cell-primary mono" data-label="">
                      <span className="break">{p.value || "—"}</span>
                      {p.opts.length ? <span className="cell-sub">{p.opts.join(", ")}</span> : null}
                    </td>
                    <td data-label="Цель">
                      <select aria-label={`Цель правила ${i + 1}`} value={p.target} onChange={(e) => onChange(rules.map((x, j) => (j === i ? [p.type, ...(p.type === "MATCH" ? [] : [p.value]), e.target.value, ...p.opts].join(",") : x)))}>
                        {[...new Set([...targetsOf(groups), p.target])].map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td className="col-num mono" data-label="Срабат.">{hit != null ? number(hit) : "—"}</td>
                    <td className="col-shrink" data-label="">
                      <div className="row-actions">
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Выше" disabled={i === 0} onClick={() => move(i, -1)}>
                          ↑
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Ниже" disabled={i === rules.length - 1} onClick={() => move(i, 1)}>
                          ↓
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Удалить правило" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                          <Icon name="trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ---------- groups ---------- */

function GroupsEditor({ groups, providers, nodes, onChange }: { groups: Group[]; providers: string[]; nodes: string[]; onChange: (g: Group[]) => void }) {
  const [edit, setEdit] = useState<{ index: number; g: Group } | null>(null);
  const [remove, setRemove] = useState(-1);
  const candidates = [...new Set([...groups.map((g) => g.name), ...nodes, "DIRECT", "REJECT"])];

  const save = () => {
    if (!edit) return;
    const g = clone(edit.g);
    if (!g.proxies?.length) delete g.proxies;
    if (!g.use?.length) delete g.use;
    if (g.type === "select") {
      delete g.url;
      delete g.interval;
    }
    const next = [...groups];
    if (edit.index < 0) next.push(g);
    else next[edit.index] = g;
    onChange(next);
    setEdit(null);
  };
  const nameTaken = edit && groups.some((g, i) => g.name === edit.g.name.trim() && i !== edit.index);
  const toggleIn = (key: "proxies" | "use", value: string, on: boolean) => {
    if (!edit) return;
    const list = (edit.g[key] || []).filter((x) => x !== value);
    if (on) list.push(value);
    setEdit({ ...edit, g: { ...edit.g, [key]: list } });
  };

  return (
    <section className="card card-flush">
      <div className="card-header">
        <h2 className="card-title">Группы (proxy-groups)</h2>
        <button type="button" className="btn btn-primary" onClick={() => setEdit({ index: -1, g: { name: "", type: "select", proxies: ["DIRECT"], use: [] } })}>
          <Icon name="plus" />
          Добавить группу
        </button>
      </div>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th>Группа</th>
              <th>Тип</th>
              <th>Узлы и группы</th>
              <th>Подписки</th>
              <th className="col-shrink" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g, i) => (
              <tr key={`${i}:${g.name}`}>
                <td className="cell-primary" data-label="">
                  <strong>{g.name}</strong>
                </td>
                <td data-label="Тип">
                  <span className="badge">{g.type}</span>
                </td>
                <td className="cell-sub" data-label="Узлы">{(g.proxies || []).join(", ") || "—"}</td>
                <td className="cell-sub" data-label="Подписки">{(g.use || []).join(", ") || "—"}</td>
                <td className="col-shrink" data-label="">
                  <div className="row-actions">
                    <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Выше" disabled={i === 0} onClick={() => onChange(groups.map((x, j) => (j === i - 1 ? groups[i] : j === i ? groups[i - 1] : x)))}>
                      ↑
                    </button>
                    <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Изменить ${g.name}`} onClick={() => setEdit({ index: i, g: clone(g) })}>
                      <Icon name="edit" />
                    </button>
                    <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Удалить ${g.name}`} onClick={() => setRemove(i)}>
                      <Icon name="trash" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal
        open={!!edit}
        variant="drawer"
        onClose={() => setEdit(null)}
        title={edit && edit.index >= 0 ? `Группа ${groups[edit.index]?.name}` : "Новая группа"}
        autoFocusBody
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEdit(null)}>
              Отмена
            </button>
            <button type="button" className="btn btn-primary" disabled={!edit?.g.name.trim() || !!nameTaken || (!edit?.g.proxies?.length && !edit?.g.use?.length)} onClick={save}>
              В черновик
            </button>
          </>
        }
      >
        {edit ? (
          <div className="stack">
            <Field label="Название" hint={nameTaken ? "такая группа уже есть" : "Переименование не меняет правила: поправьте их цели во вкладке «Правила»."}>
              <input value={edit.g.name} onChange={(e) => setEdit({ ...edit, g: { ...edit.g, name: e.target.value } })} />
            </Field>
            <Field label="Тип" group hint="select — выбор вручную; url-test — самый быстрый; fallback — первый живой; load-balance — по очереди.">
              <Segmented<string> label="Тип" value={edit.g.type} onChange={(v) => setEdit({ ...edit, g: { ...edit.g, type: v } })} options={GROUP_TYPES.map((t) => ({ value: t, label: t }))} />
            </Field>
            {edit.g.type !== "select" ? (
              <div className="form-grid">
                <Field label="Адрес проверки">
                  <input className="mono" value={String(edit.g.url || "https://www.gstatic.com/generate_204")} onChange={(e) => setEdit({ ...edit, g: { ...edit.g, url: e.target.value } })} />
                </Field>
                <Field label="Интервал, с">
                  <input type="number" min={30} value={Number(edit.g.interval || 300)} onChange={(e) => setEdit({ ...edit, g: { ...edit.g, interval: Number(e.target.value) } })} />
                </Field>
              </div>
            ) : null}
            <Field label="Подписки" group>
              <div className="chip-wrap">
                {providers.map((p) => (
                  <label key={p} className="mh-check">
                    <input type="checkbox" checked={(edit.g.use || []).includes(p)} onChange={(e) => toggleIn("use", p, e.target.checked)} />
                    {p}
                  </label>
                ))}
                {!providers.length ? <span className="mh-muted">Подписок нет</span> : null}
              </div>
            </Field>
            <Field label="Узлы и группы" group hint="Порядок — как в списке ниже.">
              <div className="chip-wrap">
                {candidates
                  .filter((c) => c !== edit.g.name)
                  .map((c) => (
                    <label key={c} className="mh-check">
                      <input type="checkbox" checked={(edit.g.proxies || []).includes(c)} onChange={(e) => toggleIn("proxies", c, e.target.checked)} />
                      {c}
                    </label>
                  ))}
              </div>
            </Field>
            <Field label="Фильтр узлов подписок" hint="Регулярное выражение по имени, необязательно">
              <input className="mono" value={String(edit.g.filter || "")} onChange={(e) => setEdit({ ...edit, g: { ...edit.g, filter: e.target.value || undefined } })} />
            </Field>
          </div>
        ) : null}
      </Modal>
      <ConfirmDialog
        open={remove >= 0}
        title={`Удалить группу ${groups[remove]?.name || ""}?`}
        confirmLabel="Удалить"
        onClose={() => setRemove(-1)}
        onConfirm={() => {
          onChange(groups.filter((_, i) => i !== remove));
          setRemove(-1);
        }}
      >
        Правила, которые ведут в эту группу, нужно перенаправить, иначе mihomo -t не пропустит конфиг.
      </ConfirmDialog>
    </section>
  );
}

/* ---------- own nodes (incl. OLCRTC) ---------- */

const OLCRTC_FIELDS: Array<[string, string, string]> = [
  ["auth-provider", "Провайдер конференций", "jitsi"],
  ["transport", "Транспорт", "datachannel"],
  ["room-id", "Комната", "https://meet.example.org/room"],
  ["encryption-key", "Ключ шифрования (64 hex)", ""],
  ["dns-server", "DNS", "8.8.8.8:53"],
  ["channel-id", "Канал (необязательно)", ""],
  ["provider-token", "Токен провайдера (необязательно)", ""],
  ["idle-timeout", "Тайм-аут простоя", "5m"],
];

function NodesEditor({ nodes, groups, onChange }: { nodes: Node[]; groups: Group[]; onChange: (n: Node[], g: Group[]) => void }) {
  const [edit, setEdit] = useState<{ index: number; n: Node; extra: string; extraError: string; inGroups: string[] } | null>(null);
  const known = ["name", "type", "server", "port", ...OLCRTC_FIELDS.map(([k]) => k)];
  const memberOf = (name: string) => groups.filter((g) => (g.proxies || []).includes(name)).map((g) => g.name);

  const open = (index: number, type = "vless") => {
    const n = index >= 0 ? clone(nodes[index]) : ({ name: "", type, ...(type === "olcrtc" ? { "auth-provider": "jitsi", transport: "datachannel", "dns-server": "8.8.8.8:53" } : { server: "", port: 443 }) } as Node);
    const extra: Obj = {};
    Object.entries(n).forEach(([k, v]) => {
      if (!(n.type === "olcrtc" ? known : ["name", "type", "server", "port"]).includes(k)) extra[k] = v;
    });
    setEdit({ index, n, extra: Object.keys(extra).length ? JSON.stringify(extra, null, 2) : "", extraError: "", inGroups: index >= 0 ? memberOf(nodes[index].name) : [] });
  };

  const save = () => {
    if (!edit) return;
    let extra: Obj = {};
    if (edit.extra.trim()) {
      try {
        extra = asObj(JSON.parse(edit.extra));
      } catch {
        setEdit({ ...edit, extraError: "Дополнительные параметры — это JSON-объект" });
        return;
      }
    }
    const base: Obj = {};
    const keep = edit.n.type === "olcrtc" ? known : ["name", "type", "server", "port"];
    keep.forEach((k) => {
      const v = edit.n[k];
      if (v !== undefined && v !== "") base[k] = v;
    });
    const n = { ...base, ...extra, name: edit.n.name.trim(), type: edit.n.type } as Node;
    if (n.port) n.port = Number(n.port);
    const oldName = edit.index >= 0 ? nodes[edit.index].name : "";
    const next = [...nodes];
    if (edit.index < 0) next.push(n);
    else next[edit.index] = n;
    const g = groups.map((grp) => {
      let list = (grp.proxies || []).map((x) => (x === oldName ? n.name : x)).filter((x) => x !== n.name);
      if (edit.inGroups.includes(grp.name)) list = [...list, n.name];
      return { ...grp, proxies: list } as Group;
    });
    onChange(next, g);
    setEdit(null);
  };

  const keyError = edit?.n.type === "olcrtc" && edit.n["encryption-key"] && !/^[0-9a-fA-F]{64}$/.test(String(edit.n["encryption-key"])) ? "нужно ровно 64 шестнадцатеричных символа" : "";
  const nameTaken = edit && nodes.some((x, i) => x.name === edit.n.name.trim() && i !== edit.index);

  return (
    <section className="card card-flush">
      <div className="card-header">
        <div>
          <h2 className="card-title">Свои узлы (proxies)</h2>
          <p className="cell-sub">Узлы вне подписок: свой сервер, OLCRTC через видеоконференцию, Tailscale.</p>
        </div>
        <div className="button-row">
          <button type="button" className="btn" onClick={() => open(-1, "olcrtc")}>
            <Icon name="plus" />
            OLCRTC
          </button>
          <button type="button" className="btn btn-primary" onClick={() => open(-1)}>
            <Icon name="plus" />
            Узел
          </button>
        </div>
      </div>
      {nodes.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Узел</th>
                <th>Тип</th>
                <th>Адрес</th>
                <th>В группах</th>
                <th className="col-shrink" />
              </tr>
            </thead>
            <tbody>
              {nodes.map((n, i) => (
                <tr key={`${i}:${n.name}`}>
                  <td className="cell-primary" data-label="">
                    <strong>{n.name}</strong>
                  </td>
                  <td data-label="Тип">
                    <span className={`badge${n.type === "olcrtc" ? " badge-accent" : ""}`}>{n.type}</span>
                  </td>
                  <td className="mono cell-sub" data-label="Адрес">{n.type === "olcrtc" ? String(n["room-id"] || "") : n.server ? `${n.server}:${n.port}` : "—"}</td>
                  <td className="cell-sub" data-label="Группы">{memberOf(n.name).join(", ") || "—"}</td>
                  <td className="col-shrink" data-label="">
                    <div className="row-actions">
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Изменить ${n.name}`} onClick={() => open(i)}>
                        <Icon name="edit" />
                      </button>
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Удалить ${n.name}`} onClick={() => onChange(nodes.filter((_, j) => j !== i), groups.map((g) => ({ ...g, proxies: (g.proxies || []).filter((x) => x !== n.name) })))}>
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon="servers" title="Своих узлов нет">
          Обычно узлы приходят из подписок. Здесь добавляются отдельные серверы и OLCRTC.
        </EmptyState>
      )}
      <Modal
        open={!!edit}
        variant="drawer"
        onClose={() => setEdit(null)}
        title={edit && edit.index >= 0 ? `Узел ${nodes[edit.index]?.name}` : edit?.n.type === "olcrtc" ? "Новый узел OLCRTC" : "Новый узел"}
        autoFocusBody
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEdit(null)}>
              Отмена
            </button>
            <button type="button" className="btn btn-primary" disabled={!edit?.n.name.trim() || !!nameTaken || !!keyError} onClick={save}>
              В черновик
            </button>
          </>
        }
      >
        {edit ? (
          <div className="stack">
            <Field label="Название" hint={nameTaken ? "такой узел уже есть" : undefined}>
              <input value={edit.n.name} onChange={(e) => setEdit({ ...edit, n: { ...edit.n, name: e.target.value } })} />
            </Field>
            <Field label="Тип">
              <select value={edit.n.type} onChange={(e) => setEdit({ ...edit, n: { ...edit.n, type: e.target.value } })}>
                {NODE_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            {edit.n.type === "olcrtc" ? (
              <>
                <Alert tone="info">OLCRTC передаёт трафик через комнату видеоконференции (WebRTC). Нужен бинарник форка x-happy-x/mihomo.</Alert>
                {OLCRTC_FIELDS.map(([k, label, ph]) => (
                  <Field key={k} label={label} hint={k === "encryption-key" ? keyError || "Тот же ключ указывается на стороне сервера." : undefined}>
                    {k === "encryption-key" ? (
                      <div className="input-with-button">
                        <input className="mono" value={String(edit.n[k] || "")} onChange={(e) => setEdit({ ...edit, n: { ...edit.n, [k]: e.target.value.trim() } })} aria-invalid={!!keyError} />
                        <button type="button" className="btn" onClick={() => setEdit({ ...edit, n: { ...edit.n, [k]: randomHex(64) } })}>
                          Сгенерировать
                        </button>
                      </div>
                    ) : (
                      <input className="mono" value={String(edit.n[k] || "")} placeholder={ph} onChange={(e) => setEdit({ ...edit, n: { ...edit.n, [k]: e.target.value } })} />
                    )}
                  </Field>
                ))}
              </>
            ) : (
              <div className="form-grid">
                <Field label="Сервер">
                  <input className="mono" value={String(edit.n.server || "")} onChange={(e) => setEdit({ ...edit, n: { ...edit.n, server: e.target.value.trim() } })} />
                </Field>
                <Field label="Порт">
                  <input type="number" value={Number(edit.n.port || 443)} onChange={(e) => setEdit({ ...edit, n: { ...edit.n, port: Number(e.target.value) } })} />
                </Field>
              </div>
            )}
            <Field label="Дополнительные параметры (JSON)" hint={edit.extraError || (edit.n.type === "olcrtc" ? "Необязательно." : 'Например {"uuid":"…","network":"tcp","tls":true,"servername":"…","reality-opts":{"public-key":"…"}}')}>
              <textarea className="mono" rows={6} value={edit.extra} onChange={(e) => setEdit({ ...edit, extra: e.target.value, extraError: "" })} aria-invalid={!!edit.extraError} />
            </Field>
            <Field label="Добавить в группы" group>
              <div className="chip-wrap">
                {groups.map((g) => (
                  <label key={g.name} className="mh-check">
                    <input type="checkbox" checked={edit.inGroups.includes(g.name)} onChange={(e) => setEdit({ ...edit, inGroups: e.target.checked ? [...edit.inGroups, g.name] : edit.inGroups.filter((x) => x !== g.name) })} />
                    {g.name}
                  </label>
                ))}
              </div>
            </Field>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}

/* ---------- devices ---------- */

function DevicesEditor({ rules, groups, onRules }: { rules: string[]; groups: Group[]; onRules: (r: string[]) => void }) {
  const { devices, refreshDevices, act } = useMihomo();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [warning, setWarning] = useState("");
  const [extraIp, setExtraIp] = useState("");

  useEffect(() => {
    void core
      .devices()
      .then((r) => {
        setWarning(r.warning || "");
        setLabels(Object.fromEntries(r.devices.filter((x) => x.source === "homenet").map((x) => [x.ip, x.name])));
      })
      .catch((err) => setWarning(errText(err)));
  }, []);

  const routeOf = (ip: string) => {
    const r = rules.find((x) => x.startsWith(`SRC-IP-CIDR,${ip}/32,`));
    return r ? r.split(",")[2] : "";
  };
  const setRoute = (ip: string, target: string) => {
    const rest = rules.filter((x) => !x.startsWith(`SRC-IP-CIDR,${ip}/32,`));
    onRules(target ? [`SRC-IP-CIDR,${ip}/32,${target}`, ...rest] : rest);
  };
  const saveLabels = async (next: Record<string, string>) => {
    setLabels(next);
    if (await act("Имена устройств", () => core.saveLabels(next), "Сохранены на роутере")) await refreshDevices();
  };

  const list: CoreDevice[] = devices.length ? devices : Object.entries(labels).map(([ip, name]) => ({ ip, name, source: "homenet", active: false }));

  return (
    <section className="card card-flush">
      <div className="card-header">
        <div>
          <h2 className="card-title">Устройства</h2>
          <p className="cell-sub">Имена из Keenetic видны в «Соединениях» и «Трафике». Своё имя хранится в HomeNet; маршрут добавляет правило SRC-IP-CIDR в начало списка.</p>
        </div>
        <button type="button" className="btn" onClick={() => void refreshDevices()}>
          <Icon name="refresh" />С роутера
        </button>
      </div>
      {warning ? <Alert tone="warning">{warning}</Alert> : null}
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th>Устройство</th>
              <th>Адрес</th>
              <th>Имя</th>
              <th>Маршрут</th>
            </tr>
          </thead>
          <tbody>
            {list.map((dev) => (
              <tr key={dev.ip}>
                <td className="cell-primary" data-label="">
                  <strong>
                    <span className={`dot ${dev.active ? "success" : ""}`} /> {dev.name}
                  </strong>
                  <span className="cell-sub">{dev.source === "homenet" ? "имя из HomeNet" : `Keenetic${dev.hostname && dev.hostname !== dev.name ? ` · ${dev.hostname}` : ""}`}</span>
                </td>
                <td className="mono" data-label="Адрес">
                  {dev.ip}
                  {dev.mac ? <span className="cell-sub">{dev.mac}</span> : null}
                </td>
                <td data-label="Имя">
                  <input
                    className="input-sm"
                    aria-label={`Своё имя для ${dev.ip}`}
                    placeholder="как в Keenetic"
                    defaultValue={labels[dev.ip] || ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if ((labels[dev.ip] || "") === v) return;
                      const next = { ...labels };
                      if (v) next[dev.ip] = v;
                      else delete next[dev.ip];
                      void saveLabels(next);
                    }}
                  />
                </td>
                <td data-label="Маршрут">
                  <select aria-label={`Маршрут ${dev.ip}`} value={routeOf(dev.ip)} onChange={(e) => setRoute(dev.ip, e.target.value)}>
                    <option value="">как всем</option>
                    {targetsOf(groups).map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-footer mh-rule-add">
        <input aria-label="IP устройства" className="mono" placeholder="192.168.1.50" value={extraIp} onChange={(e) => setExtraIp(e.target.value.trim())} />
        <button type="button" className="btn btn-sm" disabled={!/^\d{1,3}(\.\d{1,3}){3}$/.test(extraIp)} onClick={() => void saveLabels({ ...labels, [extraIp]: extraIp }).then(() => setExtraIp(""))}>
          Добавить устройство вручную
        </button>
      </div>
    </section>
  );
}

/* ---------- DNS / TUN / general ---------- */

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mh-setrow">
      <div>
        <strong>{title}</strong>
        {hint ? <span className="cell-sub">{hint}</span> : null}
      </div>
      <div className="mh-setrow-control">{children}</div>
    </div>
  );
}

function NetEditor({ draft, onChange }: { draft: Obj; onChange: (key: string, value: unknown) => void }) {
  const dns = asObj(draft.dns);
  const tun = asObj(draft.tun);
  const setDns = (patch: Obj) => onChange("dns", { ...dns, ...patch });
  const setTun = (patch: Obj) => onChange("tun", { ...tun, ...patch });
  return (
    <div className="grid-2 mh-grid-even">
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Общее</h2>
        </div>
        <div className="card-body stack">
          <Row title="Режим по умолчанию" hint="При запуске ядра; на лету меняется в верхней панели">
            <Segmented<string> label="Режим" value={String(draft.mode || "rule")} onChange={(v) => onChange("mode", v)} options={[{ value: "rule", label: "Правила" }, { value: "global", label: "Глобальный" }, { value: "direct", label: "Напрямую" }]} />
          </Row>
          <Row title="Журнал">
            <select value={String(draft["log-level"] || "info")} onChange={(e) => onChange("log-level", e.target.value)}>
              {["silent", "error", "warning", "info", "debug"].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </Row>
          <Switch checked={!!draft["allow-lan"]} onChange={(v) => onChange("allow-lan", v)} label="Разрешить LAN" hint="Подключения к портам из локальной сети" />
          <Switch checked={!!draft.ipv6} onChange={(v) => onChange("ipv6", v)} label="IPv6" />
          <div className="form-grid">
            {(["mixed-port", "socks-port", "port", "redir-port", "tproxy-port"] as const).map((k) => (
              <Field key={k} label={k}>
                <input type="number" value={draft[k] == null ? "" : Number(draft[k])} placeholder="—" onChange={(e) => onChange(k, e.target.value ? Number(e.target.value) : undefined)} />
              </Field>
            ))}
          </div>
        </div>
      </section>
      <div className="stack">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">DNS</h2>
          </div>
          <div className="card-body stack">
            <Switch checked={!!dns.enable} onChange={(v) => setDns({ enable: v })} label="DNS mihomo" />
            <Row title="Режим">
              <Segmented<string> label="Режим DNS" value={String(dns["enhanced-mode"] || "redir-host")} onChange={(v) => setDns({ "enhanced-mode": v })} options={[{ value: "redir-host", label: "redir-host" }, { value: "fake-ip", label: "fake-ip" }]} />
            </Row>
            <Field label="Слушать">
              <input className="mono" value={String(dns.listen || "")} onChange={(e) => setDns({ listen: e.target.value || undefined })} placeholder="0.0.0.0:1053" />
            </Field>
            <Field label="Серверы (nameserver)" hint="По одному в строке">
              <textarea className="mono" rows={3} defaultValue={asArr<string>(dns.nameserver).join("\n")} onBlur={(e) => setDns({ nameserver: lines(e.target.value) })} />
            </Field>
            <Field label="Начальные серверы (default-nameserver)" hint="Только IP, для разрешения адресов DoH">
              <textarea className="mono" rows={2} defaultValue={asArr<string>(dns["default-nameserver"]).join("\n")} onBlur={(e) => setDns({ "default-nameserver": lines(e.target.value) })} />
            </Field>
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">TUN</h2>
          </div>
          <div className="card-body stack">
            <Switch checked={!!tun.enable} onChange={(v) => setTun({ enable: v })} label="TUN-интерфейс" hint="Перехват всего трафика роутера. При XKeen обычно выключен." />
            <Row title="Стек">
              <Segmented<string> label="Стек TUN" value={String(tun.stack || "mixed")} onChange={(v) => setTun({ stack: v })} options={["system", "gvisor", "mixed"].map((s) => ({ value: s, label: s }))} />
            </Row>
            <Switch checked={!!tun["auto-route"]} onChange={(v) => setTun({ "auto-route": v })} label="auto-route" />
          </div>
        </section>
      </div>
    </div>
  );
}
