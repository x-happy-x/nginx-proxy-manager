# Routes Schema v2.1

`schema_version: 2.1` introduces explicit `apps` and `hosts`.

## Top-level

- `schema_version`: must be `2.1`
- `globals`: global runtime and nginx options
- `apps[]`: backend application definitions
- `hosts[]`: host/domain exposure, TLS, DNS, endpoints

## globals

- `listen_ips[]`: nginx listen IPs (empty => all interfaces)
- `ports.http|https`: default web ports
- `ports.http_extra[]|https_extra[]`: optional additional global ports
- `ui.host|port`: manager bind settings
- `stub.enabled|root`: fallback stub server settings
- `acme.email`: ACME account email

## apps[]

- `id`: unique app id
- `name`: display name
- `upstream.address|port|scheme`

## hosts[]

- `host`: fqdn
- `kind`: `private|public`
- `app_id`: reference to `apps[].id`
- `verify_upstream_ssl`: `true|false` for HTTPS upstream verification
- `ws_proxy.enabled|path|rewrite_to_wss|rewrite_from`
- `dns.publish[]`: `local|public`
- `dns.local_record_ip`: explicit IP or `auto`
- `tls.cert_policy`: `off|auto_acme|auto_local_ca|self_signed|custom_ref`
- `tls.cert_ref`: `auto|none|<ref>`
- `tls.san[]`: additional SAN values
- `endpoints[]`: concrete entrypoints for this host

## hosts[].endpoints[]

- `name`: endpoint name (`web`, `ndns`, etc.)
- `listen.protocol`: `http|https`
- `listen.port`: number or `auto_random`
- `behavior.redirect`: `http|https|off`
- NDNS behavior fields (for ndns endpoints):
  - `ndns_profile`: `direct|ndns_proxy|tunnel`
  - `ndns_name`
  - `ndns_domain`
  - `ndns_security_level`: `public|private`
  - `ndns_ssl_redirect`: `true|false`
  - `ndns_target_ip`: explicit IP or `auto`

## Notes

- `apps` define where to proxy.
- `hosts` define how to expose domains and ports.
- Multiple hosts can point to one app.
- Multiple endpoints can be defined per host.
