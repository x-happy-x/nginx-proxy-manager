import "./ConfigEditorModal.scss";
import { Button, ModalShell } from "../../ui";
import { useI18n } from "../../../i18n";

type Props = {
  open: boolean;
  title: string;
  path: string;
  editable: boolean;
  content: string;
  busy: boolean;
  onClose: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
};

export function ConfigEditorModal({ open, title, path, editable, content, busy, onClose, onChange, onSave }: Props) {
  const { t } = useI18n();
  return (
    <ModalShell open={open} onClose={onClose} size="big">
        <header>
          <div>
            <h3>{title || t("modal.config.title")}</h3>
            <p>{path}</p>
          </div>
          <Button iconName="close" onClick={onClose} compact>{t("common.close")}</Button>
        </header>
        <textarea value={content} onChange={(e) => onChange(e.target.value)} readOnly={!editable || busy} />
        <footer>
          <Button iconName="close" onClick={onClose}>{t("common.cancel")}</Button>
          <Button iconName="save" variant="accent" onClick={onSave} disabled={!editable || busy}>{t("common.save")}</Button>
        </footer>
    </ModalShell>
  );
}
