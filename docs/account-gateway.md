# Account gateway

HomeNet now owns application grants in `/opt/etc/homenet/access.json` (0600).
Each `apps` entry is keyed by the routes app ID (manual links use `link:<id>`),
with `mode: admin|users|public`, `users: [Account login]`, and optional `ip_url`
and `domain_url`. Missing rules are administrator-only. Changes apply on the next
request, without restarting nginx. Account supplies identity and the `homenet`
administrator role; it does not grant access to an individual router application.

Gateway host entries use `app: homenet` and `resource: <routes app ID>`.
HomeNet itself serves a curated portal to guests; every management API independently
requires an administrator, also on the direct IP port. Enable this guard with
`HOMENET_ACCESS_ENABLED=1` in `config/runtime.env`. The frontend does not enforce
security on its own. Its Access screen edits grants and optional URL overrides.
User names come from Account through an administrator-only directory endpoint.
Emergency router administrator sessions retain management access during an outage.

For router applications, `access_ip_port` creates a distinct HTTP listener on the
proxy's listen IPs, protected by the same gateway. Register each exact IP:port
authority in gateway.json and each HTTP callback in Account gateway.json.
`account_ip_url` selects the LAN Account URL when login starts at an IP address.
Domain links use the configured public host; IP links use the registered IP proxy
or the upstream. Native backend addresses and manual external links retain their
own authentication. Marking those links public controls portal visibility; it does
not change a third-party server's login or firewall.

Deploy from the user's current route draft when deliberately applying their host
changes; preserve both the prior draft and prior applied file in the backup.
Back up access.json, gateway.json, runtime.env, binaries, UI and proxy configs.
Never restore obsolete `.local` hosts during an update.

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
