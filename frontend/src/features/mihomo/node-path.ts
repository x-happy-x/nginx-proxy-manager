import type { MProxy } from "./api";

export const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Smart", "Relay"]);

/** Logical group followed by physical entry hops and the final exit. */
export function pathOf(name: string, proxies: Record<string, MProxy>): string[] {
 const walk=(n:string,seen:Set<string>,depth:number):string[]=>{
  if(depth>16||seen.has(n))return [];
  const next=new Set(seen);next.add(n);const p=proxies[n];
  if(p?.now)return [n,...walk(p.now,next,depth+1)];
  const via=p?.["dialer-proxy"];
  return via?[...walk(via,next,depth+1),n]:[n];
 };
 return walk(name,new Set(),0);
}
