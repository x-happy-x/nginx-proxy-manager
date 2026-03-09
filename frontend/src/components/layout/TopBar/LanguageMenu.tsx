import { useEffect, useRef, useState } from "react";
import { IconButton } from "../../ui";
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

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div className={["lang-switch", open ? "open" : ""].filter(Boolean).join(" ")} ref={rootRef}>
      <IconButton
        iconName="dns"
        iconOnly
        className="lang-switch__trigger"
        tooltip={title}
        title={title}
        onClick={() => setOpen((prev) => !prev)}
        data-locale={locale.toUpperCase()}
        aria-expanded={open}
        aria-haspopup="menu"
      />
      <div className="lang-switch__menu" role="menu" aria-label={title}>
        <button
          className={["lang-switch__item", locale === "ru" ? "active" : ""].filter(Boolean).join(" ")}
          onClick={() => {
            onChange("ru");
            setOpen(false);
          }}
          role="menuitem"
        >
          {ruLabel}
        </button>
        <button
          className={["lang-switch__item", locale === "en" ? "active" : ""].filter(Boolean).join(" ")}
          onClick={() => {
            onChange("en");
            setOpen(false);
          }}
          role="menuitem"
        >
          {enLabel}
        </button>
      </div>
    </div>
  );
}
