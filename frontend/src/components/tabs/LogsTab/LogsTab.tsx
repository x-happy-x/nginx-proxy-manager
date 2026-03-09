import "./LogsTab.scss";
import { Button, FieldLabel, Panel } from "../../ui";
import { useI18n } from "../../../i18n";

type Props = {
  busy: boolean;
  type: "access" | "error";
  filter: string;
  limit: number;
  lines: string[];
  onType: (value: "access" | "error") => void;
  onFilter: (value: string) => void;
  onLimit: (value: number) => void;
  onRefresh: () => void;
};

export function LogsTab({ busy, type, filter, limit, lines, onType, onFilter, onLimit, onRefresh }: Props) {
  const { t } = useI18n();
  return (
    <section className="tab-section logs-tab">
      <Panel className="panel">
        <div className="section-head">
          <h2>{t("logs.title")}</h2>
          <Button iconName="refresh" onClick={onRefresh} disabled={busy}>{t("common.refresh")}</Button>
        </div>
        <div className="row-3">
          <FieldLabel text={t("logs.type")}>
            <select value={type} onChange={(e) => onType(e.target.value as "access" | "error")}> 
              <option value="access">{t("common.access")}</option>
              <option value="error">{t("common.error")}</option>
            </select>
          </FieldLabel>
          <FieldLabel text={t("logs.filter")}>
            <input value={filter} onChange={(e) => onFilter(e.target.value)} placeholder={t("ph.filter")} />
          </FieldLabel>
          <FieldLabel text={t("logs.limit")}>
            <input type="number" value={limit} onChange={(e) => onLimit(Number(e.target.value) || 200)} />
          </FieldLabel>
        </div>
        <pre>{lines.join("\n")}</pre>
      </Panel>
    </section>
  );
}
