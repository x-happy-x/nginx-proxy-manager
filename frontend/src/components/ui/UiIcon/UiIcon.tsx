import type { ImgHTMLAttributes } from "react";

export type IconName =
  | "apply"
  | "bolt"
  | "cert"
  | "close"
  | "console"
  | "dns"
  | "download"
  | "edit"
  | "file-off"
  | "file"
  | "globe"
  | "key"
  | "logs"
  | "menu"
  | "overview"
  | "pause"
  | "play"
  | "plus"
  | "refresh"
  | "save"
  | "server"
  | "test"
  | "theme"
  | "trash"
  | "upload";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  name: IconName;
  alt?: string;
};

export function UiIcon({ name, alt = "", className = "", ...rest }: Props) {
  return (
    <img
      src={`/static/icons/${name}.svg`}
      alt={alt}
      className={["ui-icon", className].filter(Boolean).join(" ")}
      draggable={false}
      {...rest}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}
