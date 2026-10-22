import { useEffect, useMemo, useState } from "react";
import type { LauncherConfig } from "../../api";
import { OTHER_DEVICE, type LauncherItem } from "./model";

// NPM-87: router software that has no route of its own — HomeNet with its
// modules, the mihomo core and XKeen — shown to administrators as cards that
// lead to the router console. Titles and descriptions can be changed like any
// app's: they are kept in launcher.json under apps["sys:<id>"].

type Integration = { manifest: { id: string; name: string; version: string; description?: string; ui?: { pages?: { id: string }[] } }; enabled: boolean };
type CoreStatus = { installed?: boolean; running?: boolean; version?: string; xkeen?: boolean };

async function getJSON<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { headers: { "X-HomeNet-UI": "1" } });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The Forgejo of this network, taken from a repository link the administrator already set. */
function forgeOf(cfg: LauncherConfig) {
  const repo = [...Object.values(cfg.apps || {}).map((a) => a.repo), ...(cfg.links || []).map((l) => l.repo)].find(Boolean);
  try {
    const u = new URL(repo!);
    return `${u.origin}/`;
  } catch {
    return "";
  }
}

export function useSystemItems(admin: boolean, cfg: LauncherConfig): LauncherItem[] {
  const [mods, setMods] = useState<Integration[]>([]);
  const [core, setCore] = useState<CoreStatus | null>(null);
  useEffect(() => {
    if (!admin) return;
    void getJSON<{ integrations?: Integration[] }>("/api/platform").then((p) => setMods(p?.integrations || []));
    void getJSON<{ status?: CoreStatus }>("/api/core/status").then((s) => setCore(s?.status || null));
  }, [admin]);
  return useMemo(() => {
    if (!admin) return [];
    const router = cfg.devices.find((d) => d.kind === "router");
    const device = router?.id || OTHER_DEVICE;
    const ip = router?.addresses[0] || "192.168.1.1";
    const forge = forgeOf(cfg);
    const make = (id: string, title: string, about: string, subtitle: string, page: string, art: string, repo: string, probe?: string): LauncherItem => {
      const o = cfg.apps?.[`sys:${id}`] || {};
      return {
        key: `sys:${id}`,
        source: "system",
        system: true,
        title: o.title || title,
        description: subtitle,
        about: o.description || about,
        subtitle,
        device,
        art,
        hints: [id, title, "роутер"],
        primary: `#/${page}`,
        probe,
        repo: o.repo || (forge && repo ? forge + repo : undefined),
        hidden: !!o.hidden,
      };
    };
    const enabled = mods.filter((m) => m.enabled);
    const homenet = make("homenet", "HomeNet", "Ядро и модули домашней сети", enabled.length ? `Core · ${enabled.length} модулей` : "Core", "overview", "homenet", "homenet/nginx-proxy-manager", `${ip}:63412`);
    homenet.modules = enabled.map((m) => ({ name: m.manifest.name, version: m.manifest.version, description: m.manifest.description, page: m.manifest.ui?.pages?.[0]?.id }));
    const out = [homenet];
    if (core?.installed) out.push(make("mihomo", "mihomo", "Прокси-ядро: маршрутизация, VPN и белые списки", core.version || "ядро", "vpn", "mihomo", "homenet/mihomo", core.running ? `${ip}:9090` : undefined));
    if (core?.xkeen) out.push(make("xkeen", "XKeen", "Установка, обновление и запуск ядер на роутере", "установщик ядер", "vpn", "xkeen", "homenet/XKeen"));
    return out.filter((i) => !i.hidden);
  }, [admin, cfg, mods, core]);
}
