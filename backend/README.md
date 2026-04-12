# Go Rewrite

`backend/manager`:
- HTTP API manager compatible with the current frontend
- serves `frontend/static/`
- manages routes, CA/certs, nDNS, static hosts, nginx status/configs

`backend/nginx`:
- standalone nginx config generator CLI
- reads `routes v2.1`
- writes managed nginx configs and reloads nginx

`backend/ctl`:
- standalone CLI management tool
- installs `init.d` scripts into the runtime init.d directory
- starts/stops/restarts services
- runs `apply`
- prints status and tails logs

Build examples:

```sh
cd backend
go build -o ../bin/linux-amd64/manager ./manager
go build -o ../bin/linux-amd64/nginx ./nginx
go build -o ../bin/linux-amd64/homenet ./ctl
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/linux-arm64/manager ./manager
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/linux-arm64/nginx ./nginx
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/linux-arm64/homenet ./ctl
```
