# Repository Guidelines

## Project Structure & Module Organization
- `routes.yml`: primary configuration source for services, SSL mode, and listen IPs.
- `bin/linux-*/manager`: HTTP server that edits `routes.yml`, serves the UI, and exposes the API.
- `bin/linux-*/nginx`: nginx config generator that renders configs from `routes.yml` and reloads nginx.
- `bin/linux-*/homenet`: CLI tool for setup/start/stop/restart/apply/status/logs.
- `backend/`: Go source for `manager`, `nginx`, and `homenet`.
- `frontend/`: primary React + TypeScript UI source; deploy builds this app into `frontend/static/react`.
- `init.d/`: Entware-style init scripts.
- `scripts/setup.sh`: helper to install/update the repo on target devices.

## Build, Test, and Development Commands
- `bin/linux-amd64/manager`: run the UI locally (defaults to `0.0.0.0:8080`).
- `ROUTES_PATH=... GEN_ROUTES_PATH=... bin/linux-amd64/manager`: run with custom paths.
- `sudo bin/linux-amd64/nginx --config routes.yml`: generate nginx config from `routes.yml` and reload nginx.
- `bin/linux-amd64/homenet apply --dry-run`: verify config generation without reload.
- `sh scripts/setup.sh`: install/update on Entware-compatible hosts (pulls from GitHub).

## Coding Style & Naming Conventions
- Go: standard `gofmt`, exported names in `CamelCase`, unexported in `camelCase`.
- YAML: 2-space indentation, keep keys in lower snake case (`ssl_mode`, `listen_ips`).
- No formatter or linter is enforced; keep diffs small and prefer readable, explicit logic.

## Testing Guidelines
- There is no automated test suite in this repo.
- Validate changes manually:
  - Start the UI and confirm edits are persisted to `routes.yml`.
  - Run `bin/linux-amd64/nginx --config routes.yml --dry-run` against a sample `routes.yml`.
  - On router targets, verify `bin/linux-arm64/homenet status` and key API endpoints after restart.

## Commit & Pull Request Guidelines
- The repository currently has no commit history; no established commit message convention exists.
- For new commits, use clear, imperative subjects (e.g., "Add local CA upload flow").
- After every meaningful code/config change, create commits grouped by intent and deploy the updated runtime to the router.
- PRs should include a brief summary, the reason for change, and any config or env var updates.
- If UI behavior changes, add a short note about how it was verified (commands + outcome).

## Security & Configuration Tips
- The UI and generator rely on environment variables such as `ROUTES_PATH`, `GEN_ROUTES_PATH`,
  `NGINX_CONF_ROOT`, and `LOCAL_CA_CERT/KEY`; document any new variables you add.
- The `nginx` binary reloads nginx and writes under `/etc/nginx` or `/opt/etc/nginx`, so it typically needs root.
