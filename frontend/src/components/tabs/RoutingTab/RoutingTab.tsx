import type { RouteLogItem } from "../../../types";
import "./RoutingTab.scss";
import { Button, FieldLabel, Panel, RadioChips } from "../../ui";
import { useI18n } from "../../../i18n";

type Props = {
  busy: boolean;
  mode: "all" | "4xx" | "5xx" | "errors";
  filter: string;
  limit: number;
  smart: {
    host: string;
    targetIp: string;
    listenEndpoint: string;
  };
  items: RouteLogItem[];
  onMode: (value: "all" | "4xx" | "5xx" | "errors") => void;
  onFilter: (value: string) => void;
  onLimit: (value: number) => void;
  onSmart: (patch: Partial<Props["smart"]>) => void;
  onRefresh: () => void;
};

export function RoutingTab({ busy, mode, filter, limit, smart, items, onMode, onFilter, onLimit, onSmart, onRefresh }: Props) {
  const { t } = useI18n();
  return (
    <section className="tab-section routing-tab">
      <Panel className="panel">
        <div className="section-head">
          <h2>{t("routing.title")}</h2>
          <Button iconName="refresh" onClick={onRefresh} disabled={busy}>{t("common.refresh")}</Button>
        </div>
        <div className="row-3">
          <FieldLabel text={t("routing.contains")}>
            <input value={filter} onChange={(e) => onFilter(e.target.value)} placeholder={t("ph.contains_filter")} />
          </FieldLabel>
          <FieldLabel text={t("logs.limit")}>
            <input type="number" value={limit} onChange={(e) => onLimit(Number(e.target.value) || 200)} />
          </FieldLabel>
          <FieldLabel text={t("routing.status")}>
            <RadioChips
              value={mode}
              onChange={onMode}
              options={[
                { value: "all", label: t("common.all") },
                { value: "4xx", label: t("routing.mode_4xx") },
                { value: "5xx", label: t("routing.mode_5xx") },
                { value: "errors", label: t("common.errors") },
              ]}
            />
          </FieldLabel>
        </div>
        <div className="row-3">
          <FieldLabel text={t("routing.host")}>
            <input value={smart.host} onChange={(e) => onSmart({ host: e.target.value })} placeholder={t("ph.host")} />
          </FieldLabel>
          <FieldLabel text={t("routing.target_ip")}>
            <input value={smart.targetIp} onChange={(e) => onSmart({ targetIp: e.target.value })} placeholder={t("ph.target_ip")} />
          </FieldLabel>
          <FieldLabel text={t("routing.listen_endpoint")}>
            <input value={smart.listenEndpoint} onChange={(e) => onSmart({ listenEndpoint: e.target.value })} placeholder={t("ph.listen_endpoint")} />
          </FieldLabel>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("routing.time")}</th>
                <th>{t("routing.host")}</th>
                <th>{t("routing.status")}</th>
                <th>{t("routing.method")}</th>
                <th>{t("routing.uri")}</th>
                <th>{t("routing.upstream")}</th>
                <th>{t("routing.req_ms")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={`${String(item.time_local || "")}-${idx}`}>
                  <td>{String(item.time_local || "-")}</td>
                  <td>{String(item.host || "-")}</td>
                  <td>{String(item.status || "-")}</td>
                  <td>{String(item.request_method || "-")}</td>
                  <td>{String(item.uri || "-")}</td>
                  <td>{String(item.upstream_addr || "-")}</td>
                  <td>{String(item.request_time_ms || "-")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}
