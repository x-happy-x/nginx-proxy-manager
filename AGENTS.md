# Repository Guidelines

## Project Structure & Module Organization
- `gen_routes.py`: CLI generator that renders nginx configs from `routes.yml` and reloads nginx.
- `routes.yml`: primary configuration source for services, SSL mode, and listen IPs.
- `lite-ui/`: lightweight Python UI server and static assets.
- `lite-ui/server.py`: HTTP server that edits `routes.yml` and calls `gen_routes.py`.
- `lite-ui/static/`: UI HTML/CSS/JS assets.
- `lite-ui/init.d/`: init script templates for Entware-style deployments.
- `scripts/install-update.sh`: helper to install/update the repo on target devices.

## Build, Test, and Development Commands
- `python3 lite-ui/server.py`: run the UI locally (defaults to `0.0.0.0:8080`).
- `ROUTES_PATH=... GEN_ROUTES_PATH=... python3 lite-ui/server.py`: run with custom paths.
- `sudo python3 gen_routes.py --config routes.yml`: generate nginx config from `routes.yml` and reload nginx.
- `sh scripts/install-update.sh`: install/update on Entware-compatible hosts (pulls from GitHub).

## Coding Style & Naming Conventions
- Python: 4-space indentation, `snake_case` for functions/variables, constants in `UPPER_SNAKE_CASE`.
- YAML: 2-space indentation, keep keys in lower snake case (`ssl_mode`, `listen_ips`).
- No formatter or linter is enforced; keep diffs small and prefer readable, explicit logic.

## Testing Guidelines
- There is no automated test suite in this repo.
- Validate changes manually:
  - Start the UI and confirm edits are persisted to `routes.yml`.
  - Run `gen_routes.py` against a sample `routes.yml` and ensure nginx reloads cleanly.

## Commit & Pull Request Guidelines
- The repository currently has no commit history; no established commit message convention exists.
- For new commits, use clear, imperative subjects (e.g., "Add local CA upload flow").
- PRs should include a brief summary, the reason for change, and any config or env var updates.
- If UI behavior changes, add a short note about how it was verified (commands + outcome).

## Security & Configuration Tips
- The UI and generator rely on environment variables such as `ROUTES_PATH`, `GEN_ROUTES_PATH`,
  `NGINX_CONF_ROOT`, and `LOCAL_CA_CERT/KEY`; document any new variables you add.
- `gen_routes.py` reloads nginx and writes under `/etc/nginx`, so it typically needs root on Unix.
