import { useI18n } from "../../../i18n";
import { CardIconActions, IconButton, ModalShell } from "../../../components/ui";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmModal({ open, title, onClose, onConfirm }: Props) {
  const { t } = useI18n();

  return (
    <ModalShell open={open} onClose={onClose}>
      <header>
        <h3>{t("common.delete")}</h3>
        <IconButton iconName="close" iconOnly tooltip={t("common.close")} onClick={onClose} />
      </header>
      <p className="delete-confirm-text">{title || "-"}</p>
      <footer className="servers-modal-actions">
        <CardIconActions
          actions={[
            { iconName: "close", tooltip: t("common.cancel"), onClick: onClose },
            { iconName: "trash", tooltip: t("common.delete"), variant: "accent", onClick: onConfirm },
          ]}
        />
      </footer>
    </ModalShell>
  );
}
