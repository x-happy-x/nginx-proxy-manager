# Account gateway

`backend/gateway` builds a small Go service listening only on `127.0.0.1:63415`.
The dedicated nginx uses `auth_request`; page bodies, downloads and WebSockets
continue directly to their original upstream. The firmware nginx is untouched.

`globals.access_gateway: true` installs reserved `/_gate/` locations. Each
protected host has `access_app` set to its Account application key. An empty key
leaves Account itself reachable. The gateway's root-only JSON configuration at
`/opt/etc/homenet/gateway.json` contains `secret`, `account_api`, `account_url`,
`emergency_url`, `router_url`, and a `hosts` object mapping exact DNS names to
`{ "app": "homenet", "min_role": "admin" }`. Never commit this file.
Account receives the same dedicated secret and an exact callback-to-app map in
`/data/gateway.json`. Its normal application service token is not reused.

The Account flow uses a host-bound state cookie and a single-use code. Every
protected request rechecks its Account role (Account caches LDAP roles briefly).
Network administration panels require `homenet=admin`; native applications keep
their own roles. `access_passthrough` lists exact paths or prefixes ending `/`
whose authentication remains the upstream's responsibility: e.g. signed
subscription links, Home Assistant API tokens and Proxmox API tickets.
No blanket Authorization-header bypass exists. Direct LAN backend addresses and
the management port remain available; this feature does not change firewalls.

LMS Android can use its existing HTTP Basic username/password fields with
Account credentials at `https://lms.crubs.crazedns.ru`. For `/api/ui/` only,
the gateway validates credentials and the LMS admin role through Account on
every request. Passwords are not cached or passed to the LMS backend. Basic
login over HTTP is rejected. Missing/invalid credentials return JSON 401,
denied access returns 403, and Account failure returns 503 instead of browser
redirects. Existing browser cookies still work. Password failures are rate
limited by Account. Emergency router login remains a browser flow.

When the dedicated authenticated Account health endpoint is unreachable or
returns 502/503/504, login redirects to the HTTPS `emergency_url`. The fixed
router user `admin` is authenticated through the firmware's challenge-response
`/auth` endpoint using a fresh cookie jar; the gateway does not store passwords.
There are five attempts per source and thirty globally per five minutes.
Emergency sessions last 15 minutes, belong to one host and scheme, and are
deleted when Account recovers (health cache at most three seconds). Restarting
the gateway also clears sessions. Account 401/403 and configuration errors do
not enable fallback. Fallback opens the outer gateway only; native logins remain.

Local HTTP hosts may initiate login but passwords are entered only on the HTTPS
emergency page. Its one-use callback returns to the originating host. On local
HTTP, cookies cannot protect against LAN traffic interception; use HTTPS for
sensitive administration. No credentials belong in URLs or access logs.

Build: `scripts/build-windows.ps1`; tests: `cd backend; go test ./...`.
Install `init.d/S98homenet-gateway` as `/opt/etc/init.d/S98homenet-gateway`.
Before activation back up the installed binaries, dedicated proxy configuration,
editable routes and `.runtime/applied.yml`. Base the candidate on **applied**
routes, preserve any unapplied draft separately, start and probe the gateway,
then use the generator's staged validation and graceful reload. Never restart
the firmware nginx or change routing, DNS or Mihomo to activate authentication.
On rollback restore those exact snapshots and reload the dedicated nginx;
Account additions are backward compatible and may remain installed.
