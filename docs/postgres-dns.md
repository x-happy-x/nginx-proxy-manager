# PostgreSQL: pg-db.local

NPM-109, INFRA-103, HCC-66. Прямое локальное DNS-имя
`pg-db.local` → `192.168.99.37`, порт PostgreSQL **5432**.
Запись видна в списке DNS HomeNet (API `/api/ip-hosts`). HTTP-прокси,
веб-интерфейс управления и публичный KeenDNS-вход не создаются.

```powershell
python scripts/register-postgres-dns.py         # только проверка
python scripts/register-postgres-dns.py --apply # из master после слияния
```

Скрипт использует административное SSH-подключение `keenetic` и ту же операцию
`ndmc ip host`, что и HomeNet `/api/ip-hosts/add`. Доступ к API не ослабляется.
При несовпадающей существующей записи изменения блокируются. Статический DNS
сохраняется на роутере; отдельный именованный init-hook восстанавливает hosts
для действующего `Mihomo use-system-hosts`, не меняя его конфиг и профиль.
Остальные записи и управляемый блок HTTP-маршрутов HomeNet сохраняются.

Сертификат PostgreSQL должен включать DNS SAN `pg-db.local`; клиенты используют
CA сервера и `sslmode=verify-full`. В средах с mDNS для `.local` задайте DNS
домашней сети явно; контейнер Homecloud использует статическое сопоставление
этого имени с IP БД, сохраняя проверку имени в TLS.
