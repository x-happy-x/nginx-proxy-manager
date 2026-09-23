import { useMemo, useState } from "react";
import type { NdnsProxy } from "../types";
import { Icon } from "../components/ui/Icon";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { EmptyState, Field, SearchInput, Segmented, Switch } from "../components/ui/controls";
import { number } from "../lib/format";
import { PageHeader } from "../navigation";
import { PUBLIC_DOMAIN_SUFFIX } from "./Services";

export type DnsGrouped = { host: string; addresses: string[] };

type Props = {
  busy: boolean;
  dnsItems: DnsGrouped[];
  ndnsPorts: { http: number | null; https: number | null };
  ndnsItems: NdnsProxy[];
  onRefresh: () => void;
  onSaveDnsHost: (host: string, addresses: string[]) => void;
  onDeleteDnsHost: (host: string) => void;
  onAddDnsHost: (host: string, address: string) => void;
  onSaveNdns: (item: NdnsProxy, oldName: string) => void;
  onDeleteNdns: (name: string) => void;
  onSuggestPort: () => Promise<number | null>;
};

type Kind = "all" | "local" | "public" | "other";

function kindOf(host: string): Exclude<Kind, "all"> {
  if (host.endsWith(`.${PUBLIC_DOMAIN_SUFFIX}`)) return "public";
  if (host.endsWith(".local") || host.endsWith(".home.arpa") || host.endsWith(".lan"))
    return "local";
  return "other";
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

export function Dns(props: Props) {
  const [tab, setTab] = useState<"dns" | "ndns">("dns");
  return (
    <div className="stack">
      <PageHeader
        page="dns"
        actions={
          <button type="button" className="btn" onClick={props.onRefresh} disabled={props.busy}>
            <Icon name="refresh" />
            Перечитать с роутера
          </button>
        }
      >
        Локальные DNS-записи роутера и публичные входы KeenDNS. Изменения здесь не
        входят в черновик — они записываются прямо на роутер.
      </PageHeader>
      <div className="tabs" role="tablist" aria-label="Раздел">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "dns"}
          onClick={() => setTab("dns")}
        >
          DNS-записи <span className="badge-count">{props.dnsItems.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "ndns"}
          onClick={() => setTab("ndns")}
        >
          Публичные входы KeenDNS <span className="badge-count">{props.ndnsItems.length}</span>
        </button>
      </div>
      {tab === "dns" ? <DnsRecords {...props} /> : <NdnsEntries {...props} />}
    </div>
  );
}

function DnsRecords({
  busy,
  dnsItems,
  onSaveDnsHost,
  onDeleteDnsHost,
  onAddDnsHost,
}: Props) {
  const [newHost, setNewHost] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [remove, setRemove] = useState<string | null>(null);

  const counts = useMemo(() => {
    const result = { local: 0, public: 0, other: 0 };
    for (const item of dnsItems) result[kindOf(item.host)]++;
    return result;
  }, [dnsItems]);
  const needle = query.trim().toLowerCase();
  const rows = dnsItems.filter(
    (item) =>
      (kind === "all" || kindOf(item.host) === kind) &&
      (!needle || `${item.host} ${item.addresses.join(" ")}`.toLowerCase().includes(needle)),
  );
  const addressValid = !newAddress || IPV4.test(newAddress.trim());
  const canAdd = newHost.trim() && newAddress.trim() && addressValid && !busy;

  return (
    <>
      <section className="card">
        <div className="card-header">
          <div className="card-title">
            <h2>Новая запись</h2>
            <p>Свяжите доменное имя с IP-адресом в домашней сети</p>
          </div>
        </div>
        <form
          className="card-body dns-add"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canAdd) return;
            onAddDnsHost(newHost, newAddress);
            setNewHost("");
            setNewAddress("");
          }}
        >
          <Field label="Доменное имя">
            <input
              className="mono"
              value={newHost}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(e) => setNewHost(e.target.value)}
              placeholder="service.home.arpa"
            />
          </Field>
          <Field label="IP-адрес" hint={addressValid ? undefined : "Нужен IPv4-адрес, например 192.168.1.2"}>
            <input
              className="mono"
              inputMode="decimal"
              value={newAddress}
              aria-invalid={!addressValid}
              onChange={(e) => setNewAddress(e.target.value)}
              placeholder="192.168.1.2"
            />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={!canAdd}>
            <Icon name="plus" />
            Добавить
          </button>
        </form>
      </section>

      <div className="toolbar">
        <SearchInput
          label="Поиск DNS-записей"
          placeholder="Домен или IP-адрес"
          value={query}
          onChange={setQuery}
          meta={needle || kind !== "all" ? `${rows.length} из ${dnsItems.length}` : undefined}
        />
        <Segmented
          label="Тип записи"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "Все", count: dnsItems.length },
            { value: "local", label: "Локальные", count: counts.local },
            { value: "public", label: "Публичная зона", count: counts.public },
            { value: "other", label: "Другие", count: counts.other },
          ]}
        />
      </div>

      <section className="card card-flush">
        {rows.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Доменное имя</th>
                  <th>IP-адреса</th>
                  <th className="col-actions">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={`${item.host}:${item.addresses.join(",")}`}>
                    <td className="cell-primary" data-label="">
                      <div className="cell-title">
                        <Icon
                          name={kindOf(item.host) === "public" ? "globe" : "home"}
                          className="muted"
                        />
                        <strong className="mono domain">{item.host}</strong>
                      </div>
                    </td>
                    <td data-label="IP-адреса" style={{ minWidth: 220 }}>
                      <input
                        className="mono input-sm"
                        aria-label={`IP-адреса для ${item.host}`}
                        title="Несколько адресов — через запятую. Изменение применяется при выходе из поля."
                        defaultValue={item.addresses.join(", ")}
                        onBlur={(e) => {
                          const next = e.target.value
                            .split(",")
                            .map((v) => v.trim())
                            .filter(Boolean);
                          if (next.join(",") !== item.addresses.join(",")) onSaveDnsHost(item.host, next);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </td>
                    <td className="cell-aside col-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-danger-ghost"
                        aria-label={`Удалить ${item.host}`}
                        title="Удалить запись"
                        onClick={() => setRemove(item.host)}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="dns" title={dnsItems.length ? "Записей не найдено" : "DNS-записей нет"}>
            {dnsItems.length
              ? "Измените запрос или тип записи."
              : "Добавьте запись выше или перечитайте данные с роутера."}
          </EmptyState>
        )}
        <div className="card-footer">
          Несколько адресов указываются через запятую. Изменения копятся локально и
          записываются на роутер кнопкой «Записать на роутер».
        </div>
      </section>

      <ConfirmDialog
        open={!!remove}
        title="Удалить DNS-запись?"
        confirmLabel="Удалить"
        onClose={() => setRemove(null)}
        onConfirm={() => {
          if (remove) onDeleteDnsHost(remove);
          setRemove(null);
        }}
      >
        Запись <strong className="mono">{remove}</strong> будет удалена с роутера после
        записи изменений.
      </ConfirmDialog>
    </>
  );
}

function NdnsEntries({
  busy,
  ndnsItems,
  ndnsPorts,
  onSaveNdns,
  onDeleteNdns,
  onSuggestPort,
}: Props) {
  const [drafts, setDrafts] = useState<Record<string, NdnsProxy>>({});
  const [remove, setRemove] = useState<string | null>(null);

  const startEdit = (item: NdnsProxy) =>
    setDrafts((prev) => ({ ...prev, [item.name]: { ...item, upstream: { ...item.upstream } } }));
  const cancelEdit = (name: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  const update = (name: string, updater: (current: NdnsProxy) => NdnsProxy) =>
    setDrafts((prev) => (prev[name] ? { ...prev, [name]: updater(prev[name]) } : prev));

  return (
    <>
      <div className="ndns-summary">
        <span>
          <Icon name="globe" />
          Порты KeenDNS на роутере:
        </span>
        <span className="chip">HTTP {ndnsPorts.http ?? "—"}</span>
        <span className="chip">HTTPS {ndnsPorts.https ?? "—"}</span>
      </div>
      {ndnsItems.length ? (
        <div className="grid-auto ndns-grid">
          {ndnsItems.map((item) => {
            const draft = drafts[item.name];
            return (
              <article key={item.name} className="card ndns-card">
                <div className="card-header">
                  <div className="card-title">
                    <h2 className="mono break">{item.name}</h2>
                    <p className="mono break">{item.domain || "домен не задан"}</p>
                  </div>
                  <div className="row-actions">
                    {draft ? null : (
                      <button type="button" className="btn btn-sm" onClick={() => startEdit(item)}>
                        <Icon name="edit" size={14} />
                        Изменить
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-icon btn-danger-ghost"
                      aria-label={`Удалить вход ${item.name}`}
                      title="Удалить вход"
                      onClick={() => setRemove(item.name)}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
                {draft ? (
                  <form
                    className="card-body stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      onSaveNdns(draft, item.name);
                      cancelEdit(item.name);
                    }}
                  >
                    <div className="form-grid">
                      <Field label="Адрес назначения">
                        <input
                          className="mono"
                          value={draft.upstream.target}
                          onChange={(e) => update(item.name, (c) => ({ ...c, upstream: { ...c.upstream, target: e.target.value } }))}
                          placeholder="192.168.1.2"
                        />
                      </Field>
                      <Field label="Порт назначения">
                        <div className="input-with-button">
                          <input
                            className="mono"
                            inputMode="numeric"
                            value={draft.upstream.port}
                            onChange={(e) => update(item.name, (c) => ({ ...c, upstream: { ...c.upstream, port: e.target.value } }))}
                            placeholder="24192"
                          />
                          <button
                            type="button"
                            className="btn"
                            title="Подобрать свободный порт"
                            onClick={async () => {
                              const port = await onSuggestPort();
                              if (port) update(item.name, (c) => ({ ...c, upstream: { ...c.upstream, port: String(port) } }));
                            }}
                          >
                            Подобрать
                          </button>
                        </div>
                      </Field>
                      <Field label="Протокол назначения" group>
                        <Segmented
                          label="Протокол"
                          value={draft.upstream.proto}
                          onChange={(proto) => update(item.name, (c) => ({ ...c, upstream: { ...c.upstream, proto } }))}
                          options={[
                            { value: "http", label: "HTTP" },
                            { value: "https", label: "HTTPS" },
                          ]}
                        />
                      </Field>
                      <Field label="Доступ">
                        <select
                          value={draft.securityLevel}
                          onChange={(e) => update(item.name, (c) => ({ ...c, securityLevel: e.target.value as NdnsProxy["securityLevel"] }))}
                        >
                          <option value="public">Публичный</option>
                          <option value="private">Приватный</option>
                          <option value="">Не задан</option>
                        </select>
                      </Field>
                      <Field label="Домен" className="span-2">
                        <input
                          className="mono"
                          value={draft.domain}
                          onChange={(e) => update(item.name, (c) => ({ ...c, domain: e.target.value }))}
                          placeholder="ndns"
                        />
                      </Field>
                      <div className="span-2">
                        <Switch
                          checked={draft.sslRedirect}
                          onChange={(sslRedirect) => update(item.name, (c) => ({ ...c, sslRedirect }))}
                          label="Перенаправлять HTTP на HTTPS"
                        />
                      </div>
                    </div>
                    <div className="button-row end">
                      <button type="button" className="btn" onClick={() => cancelEdit(item.name)}>
                        Отмена
                      </button>
                      <button type="submit" className="btn btn-primary" disabled={busy}>
                        Готово
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="card-body">
                    <dl className="kv">
                      <div>
                        <dt>Назначение</dt>
                        <dd className="mono">
                          {item.upstream.proto}://{item.upstream.target}:{item.upstream.port}
                        </dd>
                      </div>
                      <div>
                        <dt>Доступ</dt>
                        <dd>
                          {item.securityLevel === "public"
                            ? "Публичный"
                            : item.securityLevel === "private"
                              ? "Приватный"
                              : "Не задан"}
                        </dd>
                      </div>
                      <div>
                        <dt>HTTP → HTTPS</dt>
                        <dd>{item.sslRedirect ? "Перенаправлять" : "Нет"}</dd>
                      </div>
                    </dl>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <section className="card">
          <EmptyState icon="globe" title="Публичных входов нет">
            Входы KeenDNS создаются при применении сервисов с публичным доменом.
          </EmptyState>
        </section>
      )}
      <p className="field-hint">
        Всего входов: {number(ndnsItems.length)}. Изменения записываются на роутер кнопкой
        «Записать на роутер».
      </p>

      <ConfirmDialog
        open={!!remove}
        title="Удалить публичный вход?"
        confirmLabel="Удалить"
        onClose={() => setRemove(null)}
        onConfirm={() => {
          if (remove) onDeleteNdns(remove);
          setRemove(null);
        }}
      >
        Вход <strong className="mono">{remove}</strong> перестанет принимать внешний трафик
        после записи изменений на роутер.
      </ConfirmDialog>
    </>
  );
}
