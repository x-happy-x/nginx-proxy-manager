import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]';

// Only the top dialog handles Escape/Tab (e.g. an action over a PC drawer).
const dialogStack: HTMLElement[] = [];
let bodyOverflow = "";

type Props = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  variant?: "modal" | "drawer";
  /** Blocks Escape, backdrop and the close button while an operation runs. */
  locked?: boolean;
  /** Focus the first field instead of the close button. */
  autoFocusBody?: boolean;
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  variant = "modal",
  locked = false,
  autoFocusBody = false,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    if (!open) return;
    const root = ref.current?.getRootNode() as Document | ShadowRoot;
    const previous = root.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    if (!dialogStack.length) bodyOverflow = document.body.style.overflow;
    dialogStack.push(dialog);
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) || []);
    const initial = autoFocusBody
      ? ref.current?.querySelector<HTMLElement>(
          ".modal-body input:not([type=hidden]), .modal-body select, .modal-body textarea",
        )
      : null;
    (initial || ref.current)?.focus();
    const listener = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== dialog) return;
      if (event.key === "Escape" && !lockedRef.current) {
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const list = focusable();
      if (!list.length) {
        event.preventDefault();
        ref.current?.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && (root.activeElement === first || root.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && root.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      const index = dialogStack.indexOf(dialog);
      if (index >= 0) dialogStack.splice(index, 1);
      if (!dialogStack.length) document.body.style.overflow = bodyOverflow;
      document.removeEventListener("keydown", listener);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  if (!open) return null;
  const drawer = variant === "drawer";
  return createPortal(
    <div
      className={`overlay${drawer ? " drawer-overlay" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={drawer ? "drawer" : `modal modal-${size}`}
      >
        <div className="modal-head">
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            aria-label="Закрыть"
            onClick={onClose}
            disabled={locked}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
