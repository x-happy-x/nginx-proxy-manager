import { useCallback, useEffect, useState } from "react";
import { core, type ExitsReport } from "./api";

/*
 * Exit countries checked through each node (NPM-59). One poll for the page:
 * every minute, every 2 s while a check runs.
 */
export function useExits() {
  const [rep, setRep] = useState<ExitsReport>({ nodes: {} });
  const pull = useCallback(() => {
    void core
      .exits()
      .then((r) => setRep({ ...r, nodes: r.nodes || {} }))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), rep.running ? 2000 : 60000);
    return () => clearInterval(t);
  }, [pull, rep.running]);
  const check = useCallback(
    async (body: { provider?: string; nodes?: string[] }) => {
      const r = await core.exitsCheck(body);
      setRep({ ...r, nodes: r.nodes || {} });
    },
    [],
  );
  return { exits: rep, pullExits: pull, checkExits: check };
}
