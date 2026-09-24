import type { ReactNode } from "react";

/*
 * Service artwork for the launcher: every service gets a line icon in the
 * HomeNet icon style (24px grid, round caps) and a large card background
 * drawn from the same hue and a motif that hints at what the service does.
 * Everything is inline SVG, so the page works offline on the router.
 */

export type Motif = "rings" | "grid" | "nodes" | "waves" | "blocks" | "roofs" | "shield" | "stack" | "orbit" | "bars";

export type ArtSpec = {
  key: string;
  label: string;
  hue: number;
  motif: Motif;
  icon: ReactNode;
};

const ART: ArtSpec[] = [
  {
    key: "homeassistant", label: "Home Assistant", hue: 199, motif: "roofs",
    icon: (<>
      <path d="M3.5 11 12 4l8.5 7" />
      <path d="M6 9.5V20h12V9.5" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M12 14.1V20M12 12.5 9.2 10.4M12 15.5l2.6-1.6" />
    </>),
  },
  {
    key: "proxmox", label: "Proxmox", hue: 24, motif: "grid",
    icon: (<>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m7.5 8.5 9 7M16.5 8.5l-9 7" />
    </>),
  },
  {
    key: "mihomo", label: "Mihomo", hue: 262, motif: "nodes",
    icon: (<>
      <path d="M5 19.5V7l4 3.5h6L19 7v12.5Z" />
      <path d="M9.5 15h.01M14.5 15h.01M11 17.5h2" />
    </>),
  },
  {
    key: "xkeen", label: "XKeen", hue: 158, motif: "shield",
    icon: (<>
      <path d="M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6Z" />
      <path d="M10 8.5v7M10 12l4-3.5M10 12l4 3.5" />
    </>),
  },
  {
    key: "xkeennet", label: "xkeen-net", hue: 190, motif: "stack",
    icon: (<>
      <path d="M4 6.5h16M4 12h16M4 17.5h9" />
      <circle cx="16.5" cy="17.5" r="2.5" />
      <path d="M8 4.5v4M13 10v4" />
    </>),
  },
  {
    key: "home", label: "Home", hue: 36, motif: "roofs",
    icon: (<>
      <path d="M3.5 11 12 4l8.5 7" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </>),
  },
  {
    key: "lms", label: "LMS", hue: 48, motif: "stack",
    icon: (<>
      <path d="m2.5 9 9.5-5 9.5 5-9.5 5Z" />
      <path d="M6.5 11.2V16c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3v-4.8M21.5 9v5" />
    </>),
  },
  {
    key: "netping", label: "Netping", hue: 142, motif: "waves",
    icon: (<>
      <path d="M3 12h4l2-5 4 10 2-5h6" />
    </>),
  },
  {
    key: "homenet", label: "HomeNet", hue: 221, motif: "nodes",
    icon: (<>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M7.4 7.5 10.7 16M16.6 7.5 13.3 16M8 6h8" />
    </>),
  },
  {
    key: "bigfam", label: "BigFam", hue: 330, motif: "orbit",
    icon: (<>
      <circle cx="8.5" cy="8" r="2.8" />
      <circle cx="16.5" cy="9.5" r="2.2" />
      <path d="M3.5 19c.6-3.3 2.6-5 5-5s4.4 1.7 5 5M14 14.2c.8-.5 1.6-.7 2.5-.7 2 0 3.5 1.4 4 4.5" />
    </>),
  },
  {
    key: "sublab", label: "Sub Lab", hue: 280, motif: "bars",
    icon: (<>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />
      <path d="M7.5 15h9" />
    </>),
  },
  {
    key: "account", label: "Account", hue: 212, motif: "shield",
    icon: (<>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 20c1-3.6 3.7-5.5 7-5.5s6 1.9 7 5.5" />
    </>),
  },
  {
    key: "cloud", label: "HomeCloud", hue: 205, motif: "blocks",
    icon: (<>
      <path d="M7 18.5a4.2 4.2 0 0 1-.6-8.4 6 6 0 0 1 11.6 1.6 3.5 3.5 0 0 1-.5 6.8Z" />
      <path d="M12 11v5M9.8 13.2 12 11l2.2 2.2" />
    </>),
  },
  {
    key: "sms", label: "SMS", hue: 96, motif: "waves",
    icon: (<>
      <path d="M4 5h16v11H9l-5 4Z" />
      <path d="M8 9h8M8 12.5h5" />
    </>),
  },
  {
    key: "router", label: "Роутер", hue: 186, motif: "rings",
    icon: (<>
      <rect x="3" y="13" width="18" height="6.5" rx="2" />
      <path d="M7 16.2h.01M10 16.2h.01M8 13 6 6M16 13l2-7" />
      <path d="M13.5 8.5a3 3 0 0 1 3 0" />
    </>),
  },
  {
    key: "kvm", label: "KVM", hue: 0, motif: "grid",
    icon: (<>
      <rect x="3" y="4" width="18" height="11" rx="2" />
      <path d="M9 19h6M12 15v4" />
      <path d="m8 8 2 2-2 2M12 12h3" />
    </>),
  },
  {
    key: "tracker", label: "Задачи", hue: 12, motif: "stack",
    icon: (<>
      <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
      <path d="m8 9 1.5 1.5L12 8M8 15l1.5 1.5L12 14M14.5 9.5H16M14.5 15.5H16" />
    </>),
  },
  {
    key: "server", label: "Сервер", hue: 230, motif: "grid",
    icon: (<>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
    </>),
  },
  {
    key: "pc", label: "Компьютер", hue: 250, motif: "orbit",
    icon: (<>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8.5 20h7M12 16v4" />
    </>),
  },
  {
    key: "vm", label: "Виртуальная машина", hue: 170, motif: "blocks",
    icon: (<>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </>),
  },
  {
    key: "generic", label: "Сервис", hue: 215, motif: "orbit",
    icon: (<>
      <rect x="4" y="4" width="7" height="7" rx="1.8" />
      <rect x="13" y="4" width="7" height="7" rx="1.8" />
      <rect x="4" y="13" width="7" height="7" rx="1.8" />
      <circle cx="16.5" cy="16.5" r="3.5" />
    </>),
  },
];

const BY_KEY = new Map(ART.map((spec) => [spec.key, spec]));

export const ART_KEYS = ART.map((spec) => ({ key: spec.key, label: spec.label }));

const MATCHERS: Array<[RegExp, string]> = [
  [/home.?assistant|^ha$|\bha\b/i, "homeassistant"],
  [/proxmox|pve/i, "proxmox"],
  [/xkeen.?net/i, "xkeennet"],
  [/zashboard|mihomo|clash/i, "mihomo"],
  [/xkeen/i, "xkeen"],
  [/netping|ping/i, "netping"],
  [/homenet|proxy.?manager|nginx/i, "homenet"],
  [/lms/i, "lms"],
  [/bigfam|family/i, "bigfam"],
  [/sub.?lab|sub.?mirror|subscri/i, "sublab"],
  [/account|sso|auth/i, "account"],
  [/cloud|files|nextcloud/i, "cloud"],
  [/sms/i, "sms"],
  [/keenetic|netcraze|router|роутер/i, "router"],
  [/kvm/i, "kvm"],
  [/task|tracker|задач/i, "tracker"],
  [/^home$|home.?page|dashboard/i, "home"],
];

// artFor picks artwork by an explicit key or guesses from names and hosts.
export function artFor(explicit: string | undefined, ...hints: Array<string | undefined>): ArtSpec {
  if (explicit && BY_KEY.has(explicit)) return BY_KEY.get(explicit)!;
  const list = hints.filter(Boolean) as string[];
  const text = list.join(" ");
  for (const [pattern, key] of MATCHERS) {
    if (list.some((hint) => pattern.test(hint))) return BY_KEY.get(key)!;
  }
  // Unknown services still get a stable colour of their own.
  const base = BY_KEY.get("generic")!;
  return { ...base, hue: hashHue(text || "x") };
}

export function deviceArt(kind: string): ArtSpec {
  return BY_KEY.get(kind === "router" ? "router" : kind === "pc" ? "pc" : kind === "vm" ? "vm" : "server")!;
}

function hashHue(text: string) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function rng(seedText: string) {
  let seed = 2166136261;
  for (const ch of seedText) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    return ((seed ^ (seed >>> 13)) >>> 0) / 4294967296;
  };
}

export function ServiceIcon({ spec, size = 40, radius }: { spec: ArtSpec; size?: number; radius?: number }) {
  const r = radius ?? Math.round(size * 0.28);
  return (
    <span
      className="svc-icon"
      style={{
        width: size,
        height: size,
        borderRadius: r,
        background: `linear-gradient(145deg, hsl(${spec.hue} 78% 58%), hsl(${(spec.hue + 28) % 360} 70% 38%))`,
        boxShadow: `0 6px 16px hsl(${spec.hue} 70% 40% / 0.35), inset 0 1px 0 hsl(${spec.hue} 90% 80% / 0.45)`,
      }}
      aria-hidden="true"
    >
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        {spec.icon}
      </svg>
    </span>
  );
}

// CardArt draws the big background: a hue gradient, the motif layer, a soft
// glow and the service icon enlarged in the corner. The seed keeps each card
// unique even when two services share a motif.
export function CardArt({ spec, seed }: { spec: ArtSpec; seed: string }) {
  const rand = rng(seed + spec.key);
  const h = spec.hue;
  const h2 = (h + 34) % 360;
  const id = "a" + Math.abs(hashHue(seed + spec.key + "id")) + Math.floor(rand() * 1e6);
  return (
    <svg className="card-art" viewBox="0 0 480 270" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${h} 62% 22%)`} />
          <stop offset="0.55" stopColor={`hsl(${h2} 58% 14%)`} />
          <stop offset="1" stopColor={`hsl(${h2} 50% 8%)`} />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={`hsl(${h} 90% 62%)`} stopOpacity="0.55" />
          <stop offset="1" stopColor={`hsl(${h} 90% 62%)`} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-line`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={`hsl(${h} 95% 75%)`} stopOpacity="0.05" />
          <stop offset="1" stopColor={`hsl(${h} 95% 75%)`} stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect width="480" height="270" fill={`url(#${id}-bg)`} />
      <circle cx={300 + rand() * 120} cy={40 + rand() * 90} r={150} fill={`url(#${id}-glow)`} />
      <g stroke={`url(#${id}-line)`} fill="none" strokeWidth="1.4">{motif(spec.motif, rand, h)}</g>
      <g transform="translate(318 118) scale(6.4)" stroke={`hsl(${h} 95% 82%)`} strokeOpacity="0.22" fill="none" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
        {spec.icon}
      </g>
      {Array.from({ length: 26 }, (_, i) => (
        <circle key={i} cx={rand() * 480} cy={rand() * 270} r={rand() * 1.6 + 0.3} fill={`hsl(${h} 90% 85%)`} opacity={rand() * 0.5 + 0.1} />
      ))}
    </svg>
  );
}

function motif(kind: Motif, rand: () => number, hue: number): ReactNode {
  switch (kind) {
    case "rings": {
      const cx = 360 + rand() * 60;
      const cy = 90 + rand() * 60;
      return Array.from({ length: 7 }, (_, i) => <circle key={i} cx={cx} cy={cy} r={24 + i * 26} opacity={1 - i * 0.12} />);
    }
    case "grid": {
      const lines: ReactNode[] = [];
      for (let i = 0; i <= 12; i++) {
        const x = 40 + i * 40;
        lines.push(<path key={`v${i}`} d={`M${240 + (x - 240) * 0.35} 60 L${x} 270`} opacity={0.7} />);
      }
      for (let j = 0; j < 7; j++) {
        const y = 60 + Math.pow(j / 6, 1.7) * 210;
        lines.push(<path key={`h${j}`} d={`M0 ${y} H480`} opacity={0.25 + j * 0.1} />);
      }
      for (let k = 0; k < 4; k++) {
        const x = 250 + k * 50 + rand() * 20;
        lines.push(<rect key={`r${k}`} x={x} y={30 + rand() * 40} width="36" height={50 + rand() * 40} rx="4" opacity="0.8" />);
      }
      return lines;
    }
    case "nodes": {
      const pts = Array.from({ length: 13 }, () => [rand() * 480, rand() * 270]);
      const out: ReactNode[] = [];
      pts.forEach(([x, y], i) => {
        pts.forEach(([x2, y2], j) => {
          if (j > i && Math.hypot(x - x2, y - y2) < 150) out.push(<path key={`${i}-${j}`} d={`M${x} ${y} L${x2} ${y2}`} opacity="0.6" />);
        });
        out.push(<circle key={`n${i}`} cx={x} cy={y} r={3 + rand() * 4} fill={`hsl(${hue} 90% 75%)`} fillOpacity="0.5" />);
      });
      return out;
    }
    case "waves":
      return Array.from({ length: 8 }, (_, i) => {
        const amp = 14 + rand() * 22;
        const y = 70 + i * 24;
        const phase = rand() * 60;
        let d = `M-10 ${y}`;
        for (let x = 0; x <= 500; x += 20) d += ` L${x} ${y + Math.sin((x + phase) / 38) * amp * (0.4 + i / 10)}`;
        return <path key={i} d={d} opacity={0.25 + i * 0.08} />;
      });
    case "blocks": {
      const out: ReactNode[] = [];
      for (let i = 0; i < 9; i++) {
        const x = 230 + (i % 3) * 64 + (Math.floor(i / 3) % 2) * 32;
        const y = 50 + Math.floor(i / 3) * 56 - rand() * 12;
        const s = 30;
        out.push(<path key={i} d={`M${x} ${y} l${s} -${s / 2} l${s} ${s / 2} l-${s} ${s / 2} Z M${x} ${y} v${s} l${s} ${s / 2} v-${s} M${x + 2 * s} ${y} v${s} l-${s} ${s / 2}`} opacity={0.35 + rand() * 0.5} />);
      }
      return out;
    }
    case "roofs":
      return Array.from({ length: 6 }, (_, i) => {
        const x = 200 + i * 48 + rand() * 20;
        const w = 60 + rand() * 50;
        const y = 150 - rand() * 70;
        return <path key={i} d={`M${x} ${y + 40} L${x + w / 2} ${y} L${x + w} ${y + 40} V270 M${x} ${y + 40} V270`} opacity={0.3 + i * 0.1} />;
      });
    case "shield":
      return Array.from({ length: 6 }, (_, i) => {
        const s = 1 + i * 0.35;
        const cx = 380;
        const cy = 60;
        return <path key={i} d={`M${cx} ${cy - 30 * s + 40} l${-50 * s} ${20 * s} v${34 * s} c0 ${46 * s} ${30 * s} ${78 * s} ${50 * s} ${90 * s} c${20 * s} ${-12 * s} ${50 * s} ${-44 * s} ${50 * s} ${-90 * s} v${-34 * s} Z`} opacity={0.75 - i * 0.1} />;
      });
    case "stack":
      return Array.from({ length: 6 }, (_, i) => (
        <rect key={i} x={220 + i * 26} y={40 + i * 26} width={200} height={120} rx="14" opacity={0.2 + i * 0.12} transform={`rotate(${-8 + rand() * 4} 320 140)`} />
      ));
    case "orbit": {
      const cx = 360;
      const cy = 110;
      return Array.from({ length: 5 }, (_, i) => (
        <g key={i}>
          <ellipse cx={cx} cy={cy} rx={50 + i * 34} ry={20 + i * 14} transform={`rotate(${-18 + i * 7} ${cx} ${cy})`} opacity={0.7 - i * 0.1} />
          <circle cx={cx + Math.cos(rand() * 6.28) * (50 + i * 34)} cy={cy + Math.sin(rand() * 6.28) * (20 + i * 14)} r="4" fill={`hsl(${hue} 90% 78%)`} fillOpacity="0.6" />
        </g>
      ));
    }
    case "bars":
      return Array.from({ length: 16 }, (_, i) => {
        const hgt = 30 + rand() * 170;
        return <rect key={i} x={200 + i * 17} y={250 - hgt} width="9" height={hgt} rx="4" opacity={0.25 + rand() * 0.6} />;
      });
  }
}
