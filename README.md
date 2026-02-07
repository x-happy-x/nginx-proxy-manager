# Nginx Proxy Manager (for Entware)

Обратный прокси, который привязывает к локальным сервисам (которые работают на одном порту) домен.
Принцип такой, до
мен (например ha.local) указывает на nginx (192.168.1.2:80/443), он по нашей конфигурации проксирует запрос по нужному адресу (например 192.168.99.12:8123).
Автоматом можно задать dns в keenetic, чтобы вручную не добавлять записи `ip host`. И генерить сертификаты со своим CA.
Легкий UI: один Python-скрипт + статические файлы. Работает с любым nginx и `gen_routes.py`.
UI можно поднять на отдельном IP (скрипт `init.d/S20-nginx-ips` добавляет IP на `br0` перед запуском nginx).

Возможно при запуске с нуля по этому ридми будут проблемы, потому что его писал codex :)

## Скриншоты
![Снимок экрана 2026-02-07 231629.png](screenshots/%D0%A1%D0%BD%D0%B8%D0%BC%D0%BE%D0%BA%20%D1%8D%D0%BA%D1%80%D0%B0%D0%BD%D0%B0%202026-02-07%20231629.png)

## Требования на nginx-хосте

- Python 3
- nginx

## Быстрый запуск

```sh
sh scripts/setup.sh
```

После запуска `scripts/setup.sh`:
- репозиторий будет установлен в `/opt/etc/homenet-nginx` или обновлен;
- файлы `init.d/S20-nginx-ips` и `init.d/S99nginx-manager-lite` будут
  симлинкнуты в `/opt/etc/init.d/`;
- `S20-nginx-ips` добавит IP на `br0` и запустит nginx;
- `S99nginx-manager-lite` запустит UI (или перезапустит, если уже работает).

## Init.d (Entware)

- `init.d/S99nginx-manager-lite` — автозапуск UI.
- `init.d/S20-nginx-ips` — добавляет IP к `br0` и запускает nginx перед UI.
  Внутри задается IP (строка `ip addr add ... dev br0`). Отредактируйте под свой адрес.

## Установка зависимостей (Entware)

```sh
opkg update
opkg install python3
```

## Запуск

```sh
cd /opt/etc/homenet-nginx
python3 lite-ui/server.py
```

По умолчанию UI доступен на `http://0.0.0.0:8080`.
Чтобы слушать на отдельном IP, укажите `LITE_UI_HOST` (пример: `LITE_UI_HOST=192.168.1.2`).

## Переменные окружения

- `ROUTES_PATH` — путь к `routes.yml` (по умолчанию `/opt/crubs-nginx/routes.yml`)
- `GEN_ROUTES_PATH` — путь к `gen_routes.py` (по умолчанию `/opt/crubs-nginx/gen_routes.py`)
- `PYTHON_BIN` — интерпретатор Python (по умолчанию `python3`)
- `NDMC_BIN` — путь к `ndmc` (по умолчанию `ndmc`)
- `IP_HOST_DELETE_MODE` — режим удаления записи DNS (по умолчанию `no-host`)
- `LITE_UI_HOST` — адрес для слушания (по умолчанию `0.0.0.0`)
- `LITE_UI_PORT` — порт (по умолчанию `8080`)
- `NGINX_CONF_ROOT` — корень конфигов nginx (по умолчанию `/etc/nginx`)
- `NGINX_LISTEN_IPS` — IP-адреса для `listen` (по умолчанию пусто, все интерфейсы)
- `LOCAL_CA_CERT` — путь к локальному CA сертификату
- `LOCAL_CA_KEY` — путь к локальному CA ключу

## SSL Mode

В `routes.yml` есть поле `ssl_mode`:

- `acme` — пытаться выпускать Let's Encrypt (или `acme.sh`, если задано)
- `local-ca` — подписывать домены локальным CA
- `self-signed` — всегда self-signed для всех доменов
- `off` — только HTTP, без HTTPS

## Local DNS

В каждом сервисе можно включить `add_to_local_dns: true`. При Apply UI вызывает
`ndmc -c "ip host <host> <upstream.address>"` для всех хостов сервиса.

## Listen & Stub

В `routes.yml` добавляются:

```yaml
listen_ips:
  - 192.168.1.2
  - 192.168.99.2
stub:
  enabled: true
  root: /opt/var/www/stub
```

Кнопка "Apply Stub" в UI пишет `stub.conf` в `${NGINX_CONF_ROOT}/conf.d` и
создает self-signed сертификат `${NGINX_CONF_ROOT}/selfsigned/stub.crt`.

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

## Пример запуска с кастомными путями

```sh
ROUTES_PATH=/opt/etc/nginx/routes.yml \
GEN_ROUTES_PATH=/opt/etc/nginx/gen_routes.py \
LITE_UI_PORT=8080 \
python3 lite-ui/server.py
```

## DNS Proxy Static Hosts

Раздел "DNS Proxy Static Hosts" читает `static_a` из `ndmc -c "show dns-proxy"`.
Добавление вызывает `ndmc -c "ip host <host> <ip>"`.
Удаление по умолчанию использует `ndmc -c "no ip host <host>"`.

Если у вас требуется удаление с IP, задайте:

```sh
IP_HOST_DELETE_MODE=no-host-ip
```

