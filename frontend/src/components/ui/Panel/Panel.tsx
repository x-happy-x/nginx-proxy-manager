import type { HTMLAttributes, ReactNode } from "react";
import { Card } from "@x-happy-x/ui-kit";

type Props = HTMLAttributes<HTMLElement> & {
  as?: "article" | "section" | "div";
  children: ReactNode;
};

export function Panel({ as = "article", className = "", children, ...rest }: Props) {
  void as;
  return (
    <Card className={["ui-panel", className].filter(Boolean).join(" ")} {...(rest as HTMLAttributes<HTMLElement>)}>{children}</Card>
  );
}
