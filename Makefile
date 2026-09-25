DMS_DIR ?= ../dms

.PHONY: test build deploy

test:
	cd backend && go test ./...
	npm run build --prefix frontend

build:
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o ../bin/linux-arm64/manager ./manager
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o ../bin/linux-arm64/nginx ./nginx
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o ../bin/linux-arm64/homenet ./ctl
	npm run build --prefix frontend

deploy:
	$(MAKE) -C $(DMS_DIR) build
	set -a; . ../lms-client/scripts/deploy-routerd.env; set +a; \
	DMS_ROUTER_PASSWORD="$$ROUTER_PASSWORD" $(DMS_DIR)/bin/dms-client apply \
		--config ./dms.yml \
		--service-bin $(DMS_DIR)/bin/dms-service-linux-arm64
