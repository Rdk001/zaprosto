# Production-развёртывание и эксплуатация

## Граница поставки

Production-контур предназначен для одной установки: один барбершоп, один филиал и
одна отдельная PostgreSQL. Это self-hosted пакет без зависимости от конкретного
cloud provider. Используемое ПО бесплатно и open source, но VPS, домен, резервное
хранилище и их продление бесплатными не становятся: поставщика и оплату выбирает
заказчик.

Локальная разработка по-прежнему использует `docker-compose.yml`. Production
использует только `docker-compose.production.yml` и один immutable application
image для ролей `migrate`, `web`, `worker` и ручных операторских команд.
PostgreSQL, web и worker не публикуют host ports. Снаружи доступны только 80/443
Caddy; backend network помечена `internal`.

## Требования к Linux host

- поддерживаемый 64-bit Linux, рекомендуемо не менее 2 CPU, 4 GiB RAM и достаточный
  SSD с запасом под БД, media и две локальные резервные копии;
- Docker Engine и Docker Compose v2 с поддержкой
  `condition: service_completed_successfully`;
- пользователь deployment входит в ограниченную группу `docker` либо запускает
  команды через контролируемый sudo;
- A/AAAA DNS имени установки указывает на host; перед запуском Caddy проверены
  маршрутизация IPv4/IPv6;
- firewall публикует только SSH с административных адресов и TCP 80/443. PostgreSQL
  5432 и web 3000 наружу не открываются;
- исходящий HTTPS разрешён для ACME и, если включён Telegram, Bot API;
- синхронизация времени включена.

Docker daemon и членство в группе `docker` эквивалентны root-доступу. Не выдавайте
их обычному пользователю админки.

## Первая установка

1. Получите проверенный release checkout и зафиксируйте его commit SHA. Не собирайте
   production из изменённого рабочего дерева.
2. Скопируйте `.env.production.example` в защищённый
   `.env.production`, установите режим `600` и замените все placeholders.
   `ZAPROSTO_IMAGE` должен содержать неизменяемый release tag или digest.
3. Создайте секреты по [инструкции](../secrets/README.md). Пароль PostgreSQL должен
   быть уникальным случайным значением. Telegram token хранится только в отдельном
   файле. Не используйте его в YAML, argv, истории shell или логах.
4. Убедитесь, что `PUBLIC_ORIGIN` равен точному browser origin вида
   `https://booking.example.com` без завершающего slash. Значение должно описывать
   тот же DNS endpoint, что и `CADDY_SITE_ADDRESS`.
5. Проверьте конфигурацию без вывода секретов:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml config --quiet
   ```

6. Соберите единый image и поднимите контур:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml build
   docker compose --env-file .env.production -f docker-compose.production.yml up -d
   docker compose --env-file .env.production -f docker-compose.production.yml ps --all
   ```

   `migrate` обязан завершиться кодом 0. При ошибке migration зависимости не
   запустят web/worker. Не обходите это условие и не применяйте `prisma db push`.

7. Создайте первого администратора только из интерактивного TTY:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml \
     run --rm --no-deps -it web admin-create
   ```

   Пароль не передаётся аргументом. Повторный запуск не перезаписывает существующего
   администратора. Сброс выполняется той же командой с ролью `admin-reset`.

8. `demo-seed` не запускается автоматически. Он допустим только в отдельной
   демонстрационной установке с вымышленными данными:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml \
     run --rm --no-deps web demo-seed
   ```

## HTTPS и доверенный proxy

Caddy автоматически получает и обновляет сертификат для публичного DNS имени.
Порты 80/443 должны достигать именно Caddy. Прямой доступ к web отсутствует по
Compose topology. Caddy перезаписывает `X-Zaprosto-Client-IP`; поэтому production
web получает `TRUST_PROXY_CLIENT_IP=true`. Не добавляйте второй недоверенный proxy
и не публикуйте web port без пересмотра этой границы.

Не логируйте request bodies, Cookie/Set-Cookie, Authorization и заголовки с
персональными данными. Не кешируйте `/admin`, Server Actions и динамические ответы.
После выпуска проверьте сертификат, redirect HTTP→HTTPS и точное совпадение
`PUBLIC_ORIGIN`.

## Telegram и BotFather

1. Заказчик создаёт отдельного бота в BotFather и принимает владение им. Username
   записывается без `@`, token — только в secret file.
2. Новый бот BotFather обычно не имеет webhook. После старта worker проверьте
   защищённый `/api/admin/telegram/health` по
   [observability runbook](telegram-observability-runbook.md). Не вызывайте Bot API
   через curl и не печатайте raw response.
3. При замене bot identity остановите worker, обновите token/username, затем выполните
   `telegram-replace-bot`. Если у нового бота ранее был webhook, после успешной
   замены и до рестарта worker выполните `telegram-delete-webhook`. Только затем
   запустите worker:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml stop worker
   docker compose --env-file .env.production -f docker-compose.production.yml \
     run --rm --no-deps -it worker telegram-replace-bot
   docker compose --env-file .env.production -f docker-compose.production.yml \
     run --rm --no-deps -it worker telegram-delete-webhook
   docker compose --env-file .env.production -f docker-compose.production.yml start worker
   ```

Подтверждения вводятся только в TTY. Команды требуют остановленного worker и
проверяют PostgreSQL maintenance lock. Подробные безопасные отказы описаны в
[replacement](telegram-bot-replacement-runbook.md) и
[webhook transition](telegram-webhook-transition-runbook.md).

## Health и readiness

- `GET https://DOMAIN/api/health` — дешёвый web liveness; ожидается HTTP 200 и
  `{"status":"ok","service":"zaprosto-web"}`;
- `docker compose ... ps --all` — db/web/worker/caddy работают, web и worker
  healthy, migrate завершён кодом 0;
- `docker compose ... exec -T db pg_isready -U zaprosto -d zaprosto` — DB
  readiness без вывода пароля;
- `docker compose ... run --rm --no-deps migrate` — повторный migration status
  фактически применяет только ещё не применённые версии и обязан сообщить отсутствие
  pending migrations;
- защищённый `/api/admin/telegram/health` — единственный прикладной Telegram
  snapshot. Публичный health не проверяет БД и Telegram.

Worker healthcheck подтверждает наличие живого application child process под `init`; Telegram
readiness оценивается отдельно.
При выключенном Telegram worker остаётся штатно живым, а snapshot сообщает
`NOT_READY/DISABLED`.

## Backup

Резервная копия считается полной только вместе: PostgreSQL dump, media archive,
release SHA/image digest, Compose/Caddy config без секретов и запись времени.

```bash
mkdir -p backups/2026-09-19
docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T db pg_dump -U zaprosto --format=custom --no-owner --no-acl zaprosto \
  > backups/2026-09-19/postgres.dump
docker compose --env-file .env.production -f docker-compose.production.yml \
  run --rm --no-deps --entrypoint tar web -C /app/storage -czf - . \
  > backups/2026-09-19/media.tar.gz
sha256sum backups/2026-09-19/*
```

Подставьте настроенные несекретные имена DB/user. Храните копии за пределами host,
шифруйте их и ограничьте доступ: dump содержит персональные данные. Не сохраняйте
`.env.production` и secret files в тот же незашифрованный архив.

## Restore rehearsal

Проверяйте restore регулярно на отдельной временной БД и пустом временном media
volume. Никогда не восстанавливайте поверх production для репетиции.

```bash
docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T db createdb -U zaprosto zaprosto_restore_rehearsal
docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T db pg_restore -U zaprosto --exit-on-error --no-owner --no-acl \
  -d zaprosto_restore_rehearsal < backups/2026-09-19/postgres.dump
docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T db psql -U zaprosto -d zaprosto_restore_rehearsal \
  -c 'SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;'
docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T db dropdb -U zaprosto zaprosto_restore_rehearsal
```

Для media распакуйте архив в новый временный named volume через application image,
сверьте checksum/число файлов и удалите только точный rehearsal volume. Запишите дату,
release и результат. Restore без такой проверки не считается подтверждённым.

## Обновление и rollback

1. Зафиксируйте текущий image digest/release SHA и сделайте проверенный backup.
2. Соберите или получите новый immutable image, измените только
   `ZAPROSTO_IMAGE` на новый revision.
3. Запустите one-shot migration и не продолжайте при ненулевом коде:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml \
     run --rm --no-deps migrate
   ```

4. Пересоздайте application roles, затем проверьте health:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml \
     up -d --no-deps --force-recreate web worker
   docker compose --env-file .env.production -f docker-compose.production.yml ps --all
   ```

Rollback приложения выполняется возвратом прежнего immutable image и пересозданием
web/worker. **Schema rollback автоматически не выполняется.** Если новая миграция
несовместима со старым кодом, остановитесь и используйте заранее подготовленный
forward-fix либо полное восстановление DB+media из проверенной копии по отдельному
плану. Не редактируйте `_prisma_migrations` вручную.

## Логи и диагностика

Используйте `docker compose ... logs --since 15m web worker caddy db`, но перед
передачей удаляйте персональные данные и URL. Worker пишет только bounded allowlist
codes. Запрещены `docker inspect`/environment dump в ticket, `printenv`, вывод
secret files, raw Telegram response, Bot API URL, cookie и DB connection string.
Для Telegram следуйте observability runbook; ручная правка outbox/status SQL не
является штатной диагностикой.

## Остановка и удаление

`docker compose ... down` останавливает процессы gracefully и сохраняет named
volumes. Не добавляйте `--volumes` при обычной остановке или обновлении. Полное
удаление volumes необратимо и допустимо только после подтверждённой передачи,
проверки внешнего backup и точного project name. Порядок передачи и удаления —
в [customer handoff](customer-handoff.md).
