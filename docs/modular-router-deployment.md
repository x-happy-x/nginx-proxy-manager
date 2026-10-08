# Guarded first migration to modular HomeNet

NPM-64 / DMS-4. Deploy only merged master builds after explicit authorization.

1. Record the active Mihomo PID/start time, engine/config/init hashes, system hosts,
   routing rules and normalized firewall. Verify two HTTPS probes through its existing
   proxy. Do not switch selectors or invoke XKeen during deployment.
2. Back up HomeNet (including Account, routes, certificates and runtime state), DMS
   token/jobs/app metadata and the old DMS executable into a private directory on
   the router. Copy the archive off-device and verify its SHA256.
3. Place `scripts/modular-router-guard.py` in that private directory under
   `/opt/var/backups/homenet-modular/<deployment>`. Run `snapshot` once.
   Set `release` to the absolute staged Core release and `ready-url` to its health URL.
   Run `watch` under nohup before replacing DMS or cutting over the manager.
4. Update only DMS after checking that no installation job is active. Preserve its
   token and registry. Stage all four matching packages through the authenticated
   DMS API (dry-run first), checking release-set SHA256 values.
5. Run platformctl migrate in dry-run mode, then prepare state. Run activation
   dry-run, then apply. The old nginx, Account and VPN engines stay running.
6. After readiness succeeds, create `active` in the guard directory. Inspect the
   authenticated console, module APIs, logs, DMS registry and preserved data while
   the guard checks readiness, VPN identity/config/routing and connectivity every
   15 seconds. It requires at least 600 healthy seconds and a separate `confirmed`
   marker; check `completed` before calling the deployment successful.
7. On any failure or a 45-minute confirmation timeout the guard restores the
   legacy manager and original DMS executable. It never restarts VPN engines or
   rewrites their configuration. Keep backups for manual recovery. The `abort`
   marker requests the same rollback. Do not start a second manager if Core cannot
   drain; investigate its pending operation first.

Staged immutable packages and their DMS metadata may remain after rollback; they
are inert. The guard does not restore arbitrary external edits from a snapshot.
A router reboot during the confirmation window is not tested by this procedure.
Do not reboot during migration.

No-op DNS maintenance uses preview before creating durable snapshots. A changed
config-reload transaction still retries its reload after an interrupted rename;
an unchanged transaction never reloads Mihomo, including rollback.
