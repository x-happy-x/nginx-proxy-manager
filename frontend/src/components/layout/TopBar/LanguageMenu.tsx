import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DropdownItem, DropdownMenu } from "@x-happy-x/ui-kit";
import { Button } from "../../ui";
import type { Locale } from "../../../i18n";
import "./LanguageMenu.scss";

type Props = {
  locale: Locale;
  onChange: (next: Locale) => void;
  title: string;
  ruLabel: string;
  enLabel: string;
};

export function LanguageMenu({ locale, onChange, title, ruLabel, enLabel }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; minWidth: number }>({ top: 0, left: 0, minWidth: 132 });

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuStyle({
        top: rect.bottom + 8,
        left: rect.right,
        minWidth: Math.max(132, rect.width),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const currentLabel = locale.toUpperCase();

  return (
    <div className={["lang-switch", open ? "open" : ""].filter(Boolean).join(" ")} ref={rootRef}>
      <div ref={triggerRef}>
        <Button
          className="lang-switch__trigger"
          variant="ghost"
          compact
          iconName="globe"
          onClick={() => setOpen((prev) => !prev)}
          title={title}
          aria-label={title}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          {currentLabel}
        </Button>
      </div>
      {open
        ? createPortal(
            <div
              className="lang-switch__menu-wrap"
              style={{ top: menuStyle.top, left: menuStyle.left, minWidth: menuStyle.minWidth, transform: "translateX(-100%)" }}
            >
              <DropdownMenu className="lang-switch__menu">
                <DropdownItem
                  className={locale === "ru" ? "active" : ""}
                  onClick={() => {
                    onChange("ru");
                    setOpen(false);
                  }}
                >
                  <span>{ruLabel}</span>
                  {locale === "ru" ? <span className="lang-switch__check">✓</span> : <span className="lang-switch__check" />}
                </DropdownItem>
                <DropdownItem
                  className={locale === "en" ? "active" : ""}
                  onClick={() => {
                    onChange("en");
                    setOpen(false);
                  }}
                >
                  <span>{enLabel}</span>
                  {locale === "en" ? <span className="lang-switch__check">✓</span> : <span className="lang-switch__check" />}
                </DropdownItem>
              </DropdownMenu>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
