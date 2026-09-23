import { useMemo, useState } from "react";
import type { NdnsProxy } from "../../../types";
import "./DnsTab.scss";
import { Button, CardIconActions, CheckboxChip, FieldLabel, IconButton, Panel, RadioChips, UiIcon } from "../../ui";
import { useI18n } from "../../../i18n";

type DnsGrouped = { host: string; addresses: string[] };

type Props = {
  busy: boolean;
  dnsItems: DnsGrouped[];
  ndnsHttpText: string;
  ndnsItems: NdnsProxy[];
  onRefreshDns: () => void;
  onSaveDnsHost: (host: string, addresses: string[]) => void;
  onDeleteDnsHost: (host: string) => void;
  onAddDnsHost: (host: string, address: string) => void;
  onSaveNdns: (item: NdnsProxy, oldName: string) => void;
  onDeleteNdns: (name: string) => void;
  onSuggestPort: () => Promise<number | null>;
};

export function DnsTab({
  busy,
  dnsItems,
  ndnsHttpText,
  ndnsItems,
  onRefreshDns,
  onSaveDnsHost,
  onDeleteDnsHost,
  onAddDnsHost,
  onSaveNdns,
  onDeleteNdns,
  onSuggestPort,
}: Props) {
  const { t } = useI18n();
  const [newHost, setNewHost] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [query, setQuery] = useState("");
  const [ndnsDrafts, setNdnsDrafts] = useState<Record<string, NdnsProxy>>({});
  const [ndnsModes, setNdnsModes] = useState<Record<string, "view" | "edit">>({});

  const rows = useMemo(
    () =>
      dnsItems.map((item) => ({
        ...item,
        addressesText: item.addresses.join(", "),
      })),
    [dnsItems],
  );
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((item) =>
      `${item.host} ${item.addressesText}`.toLowerCase().includes(needle),
    );
  }, [query, rows]);
  const localCount = rows.filter((item) => item.host.endsWith(".local")).length;
  const publicCount = rows.filter((item) =>
    item.host.endsWith(".crubs.crazedns.ru"),
  ).length;

  const clearDraft = (name: string) => {
    setNdnsDrafts((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const updateDraft = (name: string, updater: (current: NdnsProxy) => NdnsProxy) => {
    setNdnsDrafts((prev) => {
      const current = prev[name];
      if (!current) return prev;
      return { ...prev, [name]: updater(current) };
    });
  };

  const startEdit = (item: NdnsProxy) => {
    setNdnsDrafts((prev) => ({ ...prev, [item.name]: { ...item, upstream: { ...item.upstream } } }));
    setNdnsModes((prev) => ({ ...prev, [item.name]: "edit" }));
  };

  const cancelEdit = (name: string) => {
    clearDraft(name);
    setNdnsModes((prev) => ({ ...prev, [name]: "view" }));
  };

  const toggleEdit = (item: NdnsProxy, isEditing: boolean) => {
    if (isEditing) {
      cancelEdit(item.name);
      return;
    }
    startEdit(item);
  };

  const saveDraft = (name: string, draft: NdnsProxy) => {
    onSaveNdns(draft, name);
    setNdnsModes((prev) => ({ ...prev, [name]: "view" }));
  };

  const applySuggestedPort = async (name: string) => {
    const port = await onSuggestPort();
    if (!port) return;
    updateDraft(name, (current) => ({ ...current, upstream: { ...current.upstream, port: String(port) } }));
  };

  return (
    <section className="tab-section dns-tab">
      <Panel className="panel">
        <div className="section-head dns-section-head">
          <div className="section-title-block">
            <span className="section-icon"><UiIcon name="dns" /></span>
            <div>
              <h2>{t("dns.title")}</h2>
              <p>Записи локального резолвера Keenetic</p>
            </div>
          </div>
          <Button iconName="refresh" compact onClick={onRefreshDns} disabled={busy}>
            {t("common.refresh")}
          </Button>
        </div>
        <div className="dns-stats" aria-label="Сводка DNS">
          <div><strong>{rows.length}</strong><span>всего записей</span></div>
          <div><strong>{localCount}</strong><span>локальных</span></div>
          <div><strong>{publicCount}</strong><span>публичная зона</span></div>
        </div>
        <div className="dns-add-card">
          <div className="dns-add-copy">
            <strong>Новая DNS-запись</strong>
            <span>Свяжите доменное имя с IP-адресом в домашней сети.</span>
          </div>
          <div className="row-3">
            <FieldLabel text={t("dns.host")}>
              <input value={newHost} onChange={(e) => setNewHost(e.target.value)} placeholder={t("ph.host_example")} />
            </FieldLabel>
            <FieldLabel text={t("dns.address")}>
              <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="192.168.1.2" />
            </FieldLabel>
            <Button
              iconName="plus"
              variant="accent"
              onClick={() => {
                onAddDnsHost(newHost, newAddress);
                setNewHost("");
                setNewAddress("");
              }}
              disabled={!newHost || !newAddress || busy}
            >
              {t("common.add")}
            </Button>
          </div>
        </div>
        <label className="dns-search">
          <UiIcon name="search" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти домен или IP-адрес"
            aria-label="Поиск DNS-записей"
          />
          <span>{visibleRows.length} из {rows.length}</span>
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("dns.host")}</th>
                <th>{t("dns.addresses")}</th>
                <th>{t("dns.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((item) => (
                <tr key={`${item.host}:${item.addressesText}`}>
                  <td data-label={t("dns.host")}><strong>{item.host}</strong></td>
                  <td data-label={t("dns.addresses")}>
                    <input
                      aria-label={`IP-адреса для ${item.host}`}
                      defaultValue={item.addressesText}
                      onBlur={(e) => {
                        const next = e.target.value.split(",").map((v) => v.trim()).filter(Boolean);
                        onSaveDnsHost(item.host, next);
                      }}
                    />
                  </td>
                  <td data-label={t("dns.actions")}>
                    <IconButton
                      iconName="trash"
                      iconOnly
                      tooltip={t("common.delete")}
                      onClick={() => onDeleteDnsHost(item.host)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visibleRows.length === 0 && rows.length > 0 && (
          <div className="dns-empty-search">
            По запросу «{query}» записей не найдено.
          </div>
        )}
      </Panel>

      <Panel className="panel">
        <div className="section-head dns-section-head">
          <div className="section-title-block">
            <span className="section-icon"><UiIcon name="globe" /></span>
            <div>
              <h2>{t("dns.ndns_proxies")}</h2>
              <p>Публичные входы KeenDNS и их локальные назначения</p>
            </div>
          </div>
          <div className="ndns-listen"><span>{ndnsItems.length} входов</span><strong>{ndnsHttpText}</strong></div>
        </div>
        <div className="ndns-grid">
          {ndnsItems.map((item) => {
            const isEditing = ndnsModes[item.name] === "edit";
            const draft = ndnsDrafts[item.name] || item;
            return (
              <div key={item.name} className="ndns-card">
                <div className="ndns-card-head">
                  <div className="ndns-name"><UiIcon name="globe" /><strong>{item.name}</strong></div>
                  <div className="actions-row">
                    <CardIconActions
                      actions={[
                        {
                          iconName: isEditing ? "close" : "edit",
                          tooltip: isEditing ? t("common.cancel") : t("common.edit"),
                          onClick: () => toggleEdit(item, isEditing),
                        },
                        { iconName: "trash", tooltip: t("common.delete"), onClick: () => onDeleteNdns(item.name) },
                      ]}
                    />
                  </div>
                </div>

                {isEditing ? (
                  <>
                    <div className="row-2">
                      <FieldLabel text={t("servers.target")}>
                        <input value={draft.upstream.target} onChange={(e) => updateDraft(item.name, (current) => ({ ...current, upstream: { ...current.upstream, target: e.target.value } }))} placeholder={t("ph.target")} />
                      </FieldLabel>
                      <FieldLabel text={t("servers.port")}>
                        <input value={draft.upstream.port} onChange={(e) => updateDraft(item.name, (current) => ({ ...current, upstream: { ...current.upstream, port: e.target.value } }))} placeholder={t("ph.port")} />
                      </FieldLabel>
                    </div>
                    <div className="row-2">
                      <FieldLabel text={t("dns.protocol")}>
                        <RadioChips
                          value={draft.upstream.proto}
                          onChange={(next) => updateDraft(item.name, (current) => ({ ...current, upstream: { ...current.upstream, proto: next } }))}
                          options={[
                            { value: "http", label: t("common.http") },
                            { value: "https", label: t("common.https") },
                          ]}
                        />
                      </FieldLabel>
                      <FieldLabel text={t("dns.security")}>
                        <select value={draft.securityLevel} onChange={(e) => updateDraft(item.name, (current) => ({ ...current, securityLevel: e.target.value as NdnsProxy["securityLevel"] }))}>
                          <option value="public">{t("common.public")}</option>
                          <option value="private">{t("common.private")}</option>
                          <option value="">{t("common.none")}</option>
                        </select>
                      </FieldLabel>
                    </div>
                    <div className="row-2">
                      <FieldLabel text={t("servers.domain")}>
                        <input value={draft.domain} onChange={(e) => updateDraft(item.name, (current) => ({ ...current, domain: e.target.value }))} placeholder={t("ph.domain")} />
                      </FieldLabel>
                      <FieldLabel text={t("dns.flags")}>
                        <CheckboxChip checked={draft.sslRedirect} onChange={(next) => updateDraft(item.name, (current) => ({ ...current, sslRedirect: next }))} label={t("dns.ssl_redirect")} />
                      </FieldLabel>
                    </div>
                    <div className="actions-row">
                      <CardIconActions
                        actions={[
                          {
                            iconName: "save",
                            tooltip: t("common.save"),
                            onClick: () => saveDraft(item.name, draft),
                          },
                          {
                            iconName: "bolt",
                            tooltip: t("dns.suggest_port"),
                            onClick: async () => applySuggestedPort(item.name),
                          },
                          {
                            iconName: "close",
                            tooltip: t("common.cancel"),
                            onClick: () => cancelEdit(item.name),
                          },
                        ]}
                      />
                    </div>
                  </>
                ) : (
                  <div className="summary-grid">
                    <div className="summary-item">
                      <span className="muted">{t("servers.target")}</span>
                      <span className="summary-value">{`${item.upstream.proto}://${item.upstream.target}:${item.upstream.port}`}</span>
                    </div>
                    <div className="summary-item">
                      <span className="muted">{t("servers.domain")}</span>
                      <span className="summary-value">{item.domain || "-"}</span>
                    </div>
                    <div className="summary-item">
                      <span className="muted">{t("dns.security")}</span>
                      <span className="summary-value">{item.securityLevel || t("common.none")}</span>
                    </div>
                    <div className="summary-item">
                      <span className="muted">{t("dns.flags")}</span>
                      <span className="summary-value">{item.sslRedirect ? t("dns.ssl_redirect") : t("common.none")}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </section>
  );
}
