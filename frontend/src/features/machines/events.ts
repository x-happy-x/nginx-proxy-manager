import type { Host } from "../../platform/sdk";
import type { MonitoringEvent } from "../monitoring/EventCenter";

type Inbox = { events: MonitoringEvent[]; unread: number; storage_error?: string };
/** Namespace IDs and hosts, so equal IDs from the two durable inboxes cannot collide. */
export function combinedEvents(pve: Host, pc: Host, pcEnabled: boolean): Host {
  return { ...pve, api: async (path, init) => {
    if (!path.startsWith("/api/pve/events")) return pve.api(path, init);
    const body = init?.body ? JSON.parse(String(init.body)) as { all?: boolean; ids?: string[] } : undefined;
    const results = await Promise.allSettled((["pve", ...(pcEnabled ? ["pc"] : [])] as string[]).map(async source => {
      const api = source === "pve" ? pve : pc;
      const ids = body?.ids?.filter(id => id.startsWith(`${source}:`)).map(id => id.slice(source.length + 1));
      const writing = !!body && (body.all || !!ids?.length);
      const r = await api.api(`/api/${source}/events${writing ? "/read" : ""}`, writing ? { ...init, body: JSON.stringify(body.all ? { all: true } : { ids }) } : undefined);
      if (!r.ok) throw new Error(`${source}: HTTP ${r.status}`);
      const d = await r.json() as Inbox;
      return { ...d, events: (d.events || []).map(e => ({ ...e, id: `${source}:${e.id}`, host: `${source}:${e.host}` })) };
    }));
    const data = results.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
    const errors = results.flatMap(r => r.status === "rejected" ? [String(r.reason)] : []);
    if (!data.length || body && errors.length) throw new Error(errors.join("; "));
    const events = data.flatMap(d => d.events).sort((a,b) => b.created_at.localeCompare(a.created_at));
    return Response.json({ events, unread: events.filter(e => !e.read_at).length, source_error: errors.join("; "), storage_error: data.map(d => d.storage_error).filter(Boolean).join("; ") });
  } };
}
