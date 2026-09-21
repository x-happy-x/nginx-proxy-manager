import type { ReactNode } from "react";
export function FieldLabel({
  text,
  children,
  className = "",
}: {
  text: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`ui-label ${className}`}>
      <span className="ui-label__text">{text}</span>
      {children}
    </label>
  );
}
