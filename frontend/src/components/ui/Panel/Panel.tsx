import type { HTMLAttributes, ReactNode } from "react";

type Props = HTMLAttributes<HTMLElement> & {
  as?: "article" | "section" | "div";
  children: ReactNode;
};

export function Panel({
  as = "article",
  className = "",
  children,
  ...rest
}: Props) {
  const Element = as;
  return (
    <Element
      className={["ui-panel", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </Element>
  );
}
