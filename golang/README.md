# Go Rewrite

`golang/manager`:
- HTTP API manager compatible with the current frontend
- serves `frontend/static/`
- manages routes, CA/certs, nDNS, static hosts, nginx status/configs

`golang/nginx`:
- standalone nginx config generator CLI
- reads `routes v2.1`
- writes managed nginx configs and reloads nginx

`golang/ctl`:
- standalone CLI management tool
- links `init.d` scripts
- starts/stops/restarts services
- runs `apply`
- prints status and tails logs

Build examples:

```sh
cd golang
go build -o ../bin/linux-amd64/manager ./manager
go build -o ../bin/linux-amd64/nginx ./nginx
go build -o ../bin/linux-amd64/homenet ./ctl
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/linux-arm64/manager ./manager
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/linux-arm64/nginx ./nginx
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/linux-arm64/homenet ./ctl
```
