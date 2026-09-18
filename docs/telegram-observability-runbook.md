# Наблюдаемость Telegram: операторский runbook

Runbook относится к защищённому snapshot `GET /api/admin/telegram/health`. Endpoint
доступен только действующей административной сессии и возвращает `401 UNAUTHORIZED`
без агрегатов для анонимного запроса. Ответ не кэшируется. Дешёвый публичный
`GET /api/health` остаётся только liveness web-процесса и не проверяет PostgreSQL или
Telegram.

## Как читать snapshot

- `status = HEALTHY`: polling свежий, delivery разрешена сохранённой identity, due
  очередь не старше пяти минут и expired leases нет.
- `status = DEGRADED`: polling старше двух минут, oldest due job старше пяти минут
  либо есть expired `PROCESSING` lease. Точные границы 2 и 5 минут ещё не stale.
- `status = NOT_READY`: Telegram выключен, конфигурация неполна/невалидна, identity
  не инициализирована/не совпадает, timestamp некорректен или присутствует безопасный
  polling error code.
- `readiness.delivery` — разрешение delivery, выводимое только из конфигурации и
  сохранённой bot identity. Это не process heartbeat и не измерение Telegram HTTP.
- `queue.byNotificationType` всегда содержит все восемь типов с `PENDING`,
  `PROCESSING` и `DEAD`, включая нули.
- `queue.newestDeadAt` — сравнимый между запросами timestamp. Новый более поздний
  timestamp означает новый `DEAD`; исторический `DEAD` сам по себе не делает статус
  красным.
- `deliveryMetrics.additionalAttemptClaims` — сумма сохранённых
  `max(attempts - 1, 0)`, а не полный журнал retry outcomes.
- `jobsWithLastRateLimitCode` считает только строки, у которых текущий последний
  безопасный код равен `TELEGRAM_RATE_LIMIT`; перезаписанная история не заявляется.
- `confirmedSendLatencyMs` — время `scheduledAt → sentAt` для валидных `SENT` rows.
  Это queue-to-confirmed-send latency, не HTTP latency. Если данных нет, значения
  latency равны `null`, а `sampleSize` — нулю.

## Безопасный порядок проверки

1. Сохраните только bounded snapshot и сравните `generatedAt`, status/reason codes,
   ages, counts и `newestDeadAt`. Не копируйте cookie или заголовок запроса.
2. Проверьте наличие `TELEGRAM_BOT_TOKEN` и `TELEGRAM_BOT_USERNAME` в защищённых
   настройках окружения deployment/worker. Проверяйте только факт наличия; не
   выполняйте `echo`, `printenv`, дамп окружения или вставку token в ticket/chat.
3. Проверьте PostgreSQL штатной проверкой подключения платформы. Локально допустим
   `docker compose exec db pg_isready -U zaprosto -d zaprosto`; команда не выводит
   пароль, Telegram token или данные очереди. Не публикуйте connection string.
4. Для `IDENTITY_UNVERIFIED`, `BOT_USERNAME_MISMATCH`,
   `BOT_IDENTITY_MISMATCH` или `CONFIG_UNAUTHORIZED` перезапустите worker в
   контролируемом окружении и смотрите только allowlist code. Worker выполняет `getMe`
   через существующий adapter и сверяет configured/saved identity. Не вызывайте Bot API
   через `curl`: token окажется в URL, shell history и диагностике. Не печатайте ответ
   `getMe`, bot id или username; достаточно результата `READY` либо safe code.
5. Для `WEBHOOK_ACTIVE` используйте polling readiness как безопасный результат
   `getWebhookInfo`: URL не возвращается. Если webhook действительно нужно удалить,
   следуйте отдельному
   [runbook перехода](telegram-webhook-transition-runbook.md). Не запускайте destructive
   transition только ради диагностики и не сохраняйте raw `getWebhookInfo` response.
6. При stale polling проверьте жив ли worker и доступна ли PostgreSQL. При stale due
   queue проверьте delivery readiness и рост `PENDING`. При expired leases дождитесь
   штатного recovery cadence; устойчивый ненулевой count требует проверки worker logs
   только по safe codes.
7. При новом `DEAD` сравните `newestDeadAt`, типовые counts и безопасный глобальный
   code. Не извлекайте payload, recipient/chat ids, имя, телефон или raw error для
   dashboard/ticket. Ручной resend и правка status SQL не являются частью runbook.

Endpoint и runbook не вызывают Telegram API, не меняют очередь и не добавляют внешнюю
telemetry. Token, token hash, chat/user ids, bot identity, webhook URL, appointment id,
payload, имя/телефон, SQL/driver cause и Telegram description отсутствуют в DTO.
