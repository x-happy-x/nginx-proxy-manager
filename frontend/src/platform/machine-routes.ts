/** Keep bookmarks and widget page IDs valid; redirect only with an enabled PVE UI. */
export function unifiedMachineRoute(route: string, enabled: boolean): string | null {
  if (!enabled) return null;
  const [path, query] = route.replace(/^#\/?/, "").split("?");
  const oldHost = path.match(/^pc\/host\/([^/]+)$/);
  if (oldHost) return `pveguests/pc/${oldHost[1]}`;
  const aliases: Record<string,string> = { pc: "pveguests?filter=pc", pcdocker: "pve/containers", pcwsl: "pveguests?filter=wsl", "pc/events": "pve/events", pcsettings: "pvesettings" };
  const target=aliases[path];
  return target ? target + (query ? `${target.includes("?") ? "&" : "?"}${query}` : "") : null;
}
