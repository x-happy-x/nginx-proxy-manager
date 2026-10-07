import { useEffect, useState } from "react";
import { FLAG_MODE_KEY, countryName, flagCode, readFlagMode, stripFlags, type FlagMode } from "../../lib/flags";

/*
 * A country flag as a picture (NPM-59): flag-icons SVGs, one small file per
 * country, fetched only when shown. Windows can't draw flag emoji.
 */

const FILES = import.meta.glob("../../../node_modules/flag-icons/flags/4x3/??.svg", { eager: true, query: "?no-inline", import: "default" }) as Record<string, string>;
const URLS: Record<string, string> = {};
for (const [path, url] of Object.entries(FILES)) URLS[path.slice(-6, -4).toUpperCase()] = url;

export function Flag({ cc, title }: { cc?: string; title?: string }) {
  const code = (cc || "").toUpperCase();
  const url = URLS[code];
  if (!url) return <span className={`flag${code ? " flag-code" : " flag-none"}`} title={title}>{code}</span>;
  return <img className="flag" src={url} alt={code} title={title ?? countryName(code)} loading="lazy" decoding="async" />;
}

/** A node's name: the flag as a picture on the left, the text without emoji. `cc` overrides the flag in the name. */
export function NodeName({ name, cc, className }: { name: string; cc?: string; className?: string }) {
  const code = cc || flagCode(name);
  return (
    <span className={`node-name${className ? ` ${className}` : ""}`} title={name}>
      {code ? <Flag cc={code} /> : null}
      <span className="truncate">{stripFlags(name) || name}</span>
    </span>
  );
}

const RI_PAIR = /([\u{1F1E6}-\u{1F1FF}]{2})/u;

/** Any text with flag emoji — each flag drawn as a picture where it stands. */
export function FlagText({ text }: { text: string }) {
  if (!RI_PAIR.test(text)) return <>{text}</>;
  return (
    <>
      {text.split(RI_PAIR).map((part, i) => (i % 2 ? <Flag key={i} cc={flagCode(part)} /> : part))}
    </>
  );
}

const MODE_EVENT = "homenet:flagmode";

/** «Флаг по выходу / как в названии» — one setting for the whole UI, kept in the browser. */
export function useFlagMode(): [FlagMode, (m: FlagMode) => void] {
  const [mode, setMode] = useState<FlagMode>(readFlagMode);
  useEffect(() => {
    const sync = () => setMode(readFlagMode());
    window.addEventListener(MODE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(MODE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = (m: FlagMode) => {
    try {
      localStorage.setItem(FLAG_MODE_KEY, m);
    } catch {
      /* private mode: this tab only */
    }
    setMode(m);
    window.dispatchEvent(new Event(MODE_EVENT));
  };
  return [mode, set];
}
