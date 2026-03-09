# Nginx Proxy Manager (for Entware)

Обратный прокси, который привязывает к локальным сервисам (которые работают на одном порту) домен.
Принцип такой, до
мен (например ha.local) указывает на nginx (192.168.1.2:80/443), он по нашей конфигурации проксирует запрос по нужному адресу (например 192.168.99.12:8123).
Автоматом можно задать dns в keenetic, чтобы вручную не добавлять записи `ip host`. И генерить сертификаты со своим CA.
Легкий UI и runtime теперь собраны в Go-бинарники. Работает с любым nginx и схемой `routes.yml`.
UI можно поднять на отдельном IP (скрипт `init.d/S20-nginx-ips` добавляет IP на `br0` перед запуском nginx).

Возможно при запуске с нуля по этому ридми будут проблемы, потому что его писал codex :)

## Скриншоты
![Снимок экрана 2026-02-07 231629.png](docs/screenshots/%D0%A1%D0%BD%D0%B8%D0%BC%D0%BE%D0%BA%20%D1%8D%D0%BA%D1%80%D0%B0%D0%BD%D0%B0%202026-02-07%20231629.png)

## Требования на nginx-хосте

- nginx
- `ndmc` для интеграции с Keenetic
- Python 3 только для вспомогательных legacy-скриптов вроде `scripts/convert_routes.py`

## Быстрый запуск

```sh
sh scripts/setup.sh
```

После запуска `scripts/setup.sh`:
- репозиторий будет установлен в `/opt/etc/homenet-nginx` или обновлен;
- локальный `config/runtime.env` будет сохранен при обновлении;
- файлы `init.d/S20-nginx-ips` и `init.d/S99nginx-manager-lite` будут
  симлинкнуты в `/opt/etc/init.d/`;
- `S20-nginx-ips` добавит IP на `br0` и запустит nginx;
- `S99nginx-manager-lite` запустит UI (или перезапустит, если уже работает).

## Бинарники

Бинарники лежат в подпапках `bin/<os-arch>/`:

- `bin/linux-amd64/manager`
- `bin/linux-amd64/nginx`
- `bin/linux-amd64/homenet`
- `bin/linux-arm64/manager`
- `bin/linux-arm64/nginx`
- `bin/linux-arm64/homenet`

На роутере используется `bin/linux-arm64/`.

## Локальная команда управления

Основной CLI теперь:

```sh
bin/linux-amd64/homenet setup
bin/linux-amd64/homenet apply
bin/linux-amd64/homenet restart
bin/linux-amd64/homenet stop
bin/linux-amd64/homenet status
bin/linux-amd64/homenet logs 100
```

На роутере те же команды вызываются через `bin/linux-arm64/homenet`.

`setup` создает симлинки в `/opt/etc/init.d` для `init.d/S*` и перезапускает их по порядку.
`apply` запускает отдельный генератор nginx (`bin/.../nginx --config <routes>`).

## Init.d (Entware)

- `init.d/S99nginx-manager-lite` — автозапуск UI.
- `init.d/S20-nginx-ips` — добавляет IP к `br0` и запускает nginx перед UI.
  Внутри задается IP (строка `ip addr add ... dev br0`). Отредактируйте под свой адрес.

## Установка зависимостей (Entware)

```sh
opkg update
opkg install nginx
```

## Запуск

```sh
cd /opt/etc/homenet-nginx
bin/linux-arm64/manager
```

По умолчанию UI доступен на `http://0.0.0.0:8080`.
Основные runtime-пути и bind UI теперь лежат в `config/runtime.env`.
Чтобы слушать на отдельном IP, измените там `LITE_UI_HOST`.

## Переменные окружения

- `CONFIG_ENV_PATH` — альтернативный путь к env-файлу runtime (по умолчанию `config/runtime.env`)
- `ROUTES_PATH` — путь к `routes.yml` (по умолчанию `/opt/etc/homenet-nginx/routes.v2.1.yml` для manager, в init.d у нас используется `/opt/etc/homenet-nginx/routes.yml`)
- `GEN_ROUTES_PATH` — путь к бинарнику генератора nginx
- `STATIC_ROOT` — корень primary static assets (по умолчанию `frontend/static`)
- `REACT_INDEX_REL` — относительный путь к React entrypoint внутри `STATIC_ROOT` (по умолчанию `react/index.html`)
- `NDMC_BIN` — путь к `ndmc` (по умолчанию `ndmc`)
- `IP_HOST_DELETE_MODE` — режим удаления записи DNS (по умолчанию `no-host`)
- `LITE_UI_HOST` — адрес для слушания (по умолчанию `0.0.0.0`)
- `LITE_UI_PORT` — порт (по умолчанию `8080`)
- `NGINX_CONF_ROOT` — корень конфигов nginx (по умолчанию `/etc/nginx`)
- `NGINX_LISTEN_IPS` — IP-адреса для `listen` (по умолчанию пусто, все интерфейсы)
- `ROUTE_ACCESS_LOG` — путь к подробному access log маршрутизации (по умолчанию `/opt/var/log/nginx/route_access.log`)
- `LOCAL_CA_CERT` — путь к локальному CA сертификату
- `LOCAL_CA_KEY` — путь к локальному CA ключу

## SSL Mode

В `routes.yml` есть поле `ssl_mode`:

- `acme` — пытаться выпускать Let's Encrypt (или `acme.sh`, если задано)
- `local-ca` — подписывать домены локальным CA
- `self-signed` — всегда self-signed для всех доменов
- `off` — только HTTP, без HTTPS

Также можно переопределять SSL режим на уровне сервиса и хоста:

```yaml
services:
  - hosts: [zashboard.local]
    ssl_mode: local-ca          # override для сервиса
    host_ssl_mode:              # override для конкретных хостов
      zashboard.local: off
```

## Local DNS

В каждом сервисе можно включить `add_to_local_dns: true`. При Apply UI вызывает
`ndmc -c "ip host <host> <upstream.address>"` для всех хостов сервиса.

## Listen & Stub

В `routes.yml` добавляются:

```yaml
listen_ips:
  - 192.168.1.2
  - 192.168.99.2
ports:
  http: 80
  https: 443
  http_extra: []
  https_extra: []
ui:
  host: 0.0.0.0
  port: 8080
stub:
  enabled: true
  root: /opt/var/www/stub
```

Кнопка "Apply Stub" в UI пишет `stub.conf` в `${NGINX_CONF_ROOT}/conf.d` и
создает self-signed сертификат `${NGINX_CONF_ROOT}/selfsigned/stub.crt`.
Порты nginx (`ports.http`/`ports.https` + `ports.http_extra`/`ports.https_extra`) и bind UI (`ui.host`/`ui.port`) также настраиваются из UI.
Для применения bind UI используйте кнопку restart UI (или `/opt/etc/init.d/S99nginx-manager-lite restart`).

## Local CA

В UI можно загрузить `ca.crt` и `ca.key` (PEM). Они сохраняются в
`${NGINX_CONF_ROOT}/local-ca/`. Кнопка "Issue Certs" выпустит сертификаты
для всех доменов из `routes.yml` в `${NGINX_CONF_ROOT}/selfsigned/`.
Кнопка "Force Re-issue" удалит старые сертификаты и выпустит заново.
Можно сгенерировать новый CA прямо в UI и скачать текущий CA.
Также доступна загрузка сертификата/ключа для конкретного домена.

## SAN

Для каждого сервиса есть поле `san` (список). Значения можно задавать как
`DNS:example.local`, `IP:192.168.1.2` или просто `example.local`/`192.168.1.2`.

Для upstream `scheme` доступны `http`, `https`, и `auto`.
`auto` подставляет входящий протокол (`$scheme`), порт при этом берется из `upstream.port`.

### WS/WSS proxy (для HTTPS + WebSocket)

Для сервиса можно включить поля:

```yaml
ws_proxy:
  enabled: true
  path: /connections
  rewrite_to_wss: true
  rewrite_from: ws://192.168.1.1:9090
```

- `enabled` — добавляет отдельный `location` для websocket path.
- `path` — путь websocket (например `/connections`).
- `rewrite_to_wss` — включает подмену `ws://...` в HTML/JS на `wss://$host`.
- `rewrite_from` — какая строка заменяется (если пусто, берется `ws://<upstream.address>:<upstream.port>`).

## Пример запуска с кастомными путями

```sh
CONFIG_ENV_PATH=/opt/etc/homenet-nginx/config/runtime.env \
bin/linux-arm64/manager
```

## DNS Proxy Static Hosts

Раздел "DNS Proxy Static Hosts" читает `static_a` из `ndmc -c "show dns-proxy"`.
Добавление вызывает `ndmc -c "ip host <host> <ip>"`.
Удаление по умолчанию использует `ndmc -c "no ip host <host>"`.

Если у вас требуется удаление с IP, задайте:

```sh
IP_HOST_DELETE_MODE=no-host-ip
```

## Routing Logs

Бинарник `nginx` создает формат `homenet_route_json` и пишет подробные маршрутизационные логи в `ROUTE_ACCESS_LOG`.
В UI для этого есть отдельная вкладка `Routing`.
Доступны быстрые фильтры `All`, `4xx`, `5xx`, `Errors (4xx+5xx)`.
API: `/api/nginx/route-logs` и `/api/nginx/route-logs/errors`.

## Schema v2 (Apps + Hosts)

Новая целевая модель вынесена в пример `routes.example.yml`.
Дефолтные значения полей вынесены в `routes.defaults.yml`.
Идея:

- `apps[]` — описание backend-приложения (upstream, ws_proxy).
- `hosts[]` — домены/хосты, которые ссылаются на `app_id`, и их SSL/NDNS/DNS настройки.
- `certs[]` — опциональные явные привязки custom-сертификатов.
- `globals` — общие настройки (`listen_ips`, `ports`, `ui`, `stub`, глобальный `ssl_mode`, `acme.email`).

Это пока схема-цель. Текущий runtime продолжает использовать `services` из `routes.yml`.

Для `hosts[]` добавлен тип:
- `kind: private` — локальный хост (LAN/local).
- `kind: public` — публичный хост (например через NDNS).

Подробное описание полей: `docs/schema-v2.1.md`.

### Конвертация legacy -> v2.1

```sh
python3 scripts/convert_routes.py --input routes.yml --output routes.converted.yml
```

Скрипт конвертирует `services` в `apps/hosts/endpoints`.

### Генерация nginx из v2.1

```sh
sudo bin/linux-amd64/nginx --config routes.converted.yml
```

Проверка без reload:

```sh
sudo bin/linux-amd64/nginx --config routes.converted.yml --dry-run
```
