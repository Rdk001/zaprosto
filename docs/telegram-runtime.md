# Telegram runtime primitives и Bot API adapter

Документ описывает изолированное техническое ядро 06.2B/06.2C: runtime primitives,
Bot API adapter и PostgreSQL repository жизненного цикла outbox. Repository работает только
с outbox и явно переданным Prisma client. Polling, dispatcher, бизнес-producers, выпуск
ссылок, подключения, worker integration и UI остаются следующими этапами.

## Границы модулей

- `src/modules/telegram/domain/policy.ts` фиксирует code-owned policy без env-настроек.
- `link-token.ts` генерирует и предварительно валидирует `c_`/`a_` start parameters:
  runtime purpose точно совпадает с Prisma enum (`APPOINTMENT` → `c_`, `ADMIN_USER` → `a_`).
  Затем модуль вычисляет purpose-separated SHA-256. Raw token не включается в ошибки.
- `payload-v1.ts` содержит strict runtime-схемы восьми `NotificationType`, проверку
  `changedFields`, UTC/UUID/version constraints и лимит сериализации 16 KiB.
- `dedupe.ts` строит только утверждённые deterministic keys длиной не более 255.
- `retry.ts` вычисляет backoff/retry-after/deadline решения без БД и с внедряемыми
  clock/RNG.
- `server/bot-api.ts` предоставляет узкий `TelegramBotApi`; production transport
  использует встроенный `fetch`, фиксированный HTTPS origin и POST JSON.
- `server/index.ts` — общая Node/worker-safe production-точка входа без Next-only
  `server-only`. Если Next-specific wrapper понадобится позже, он будет отдельным файлом.
- `server/fake-transport.ts` — только тестовый in-memory transport. Production entrypoint
  его не экспортирует.

## Bot API contract

Adapter поддерживает только `getMe`, `getWebhookInfo`, `deleteWebhook`, `getUpdates` и
`sendMessage`. `deleteWebhook` принимает только явное `dropPendingUpdates: false`;
`getUpdates` фиксирует `allowed_updates=["message"]`, limit 1–100 и project long-poll
timeout 5–50 секунд. `sendMessage` принимает только положительный private chat ID и
plain well-formed UTF-8 text до 4096 Unicode code points, без `parse_mode`; C0/C1 controls
удаляются, безопасные переносы нормализуются в LF.

Входящая transport-схема `getUpdates` принимает любой ненулевой safe integer `Chat.id`,
включая отрицательные ID групп, супергрупп и каналов. Ограничение private-only относится
только к исходящему `sendMessage`; будущий handler сам проигнорирует неподдерживаемые
group/channel updates.

HTTP timeout равен 10 секундам для обычных вызовов и long-poll timeout плюс 5 секунд для
`getUpdates`, но всегда ограничен 60 секундами. Ответ ограничивается по объявленной и
фактической длине: 256 KiB для обычных вызовов и 4 MiB для update batch. Из Telegram
DTO сохраняются только используемые поля; unsafe integer ID, неверный UTF-8/JSON и
неправильный envelope отклоняются.

Ошибки нормализуются в allowlist-коды ADR-0014. Human-readable `description` применяется
только внутри узких классификаторов и сразу отбрасывается. В error object не попадают bot
token, URL, headers/body, chat ID, message text или исходный `fetch` cause.

## Официальные источники

Контракт проверен по официальной документации Telegram:

- [Bot API и Making requests](https://core.telegram.org/bots/api#making-requests)
- [getMe](https://core.telegram.org/bots/api#getme)
- [getWebhookInfo](https://core.telegram.org/bots/api#getwebhookinfo)
- [deleteWebhook](https://core.telegram.org/bots/api#deletewebhook)
- [getUpdates и long polling](https://core.telegram.org/bots/api#getupdates)
- [sendMessage](https://core.telegram.org/bots/api#sendmessage)
- [ResponseParameters и retry_after](https://core.telegram.org/bots/api#responseparameters)
- [Update](https://core.telegram.org/bots/api#update), [User](https://core.telegram.org/bots/api#user),
  [Chat](https://core.telegram.org/bots/api#chat) и [Message](https://core.telegram.org/bots/api#message)
- [Deep linking и start parameter](https://core.telegram.org/bots/features#deep-linking)
- [Bots FAQ: ограничения отправки](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)

## PostgreSQL outbox repository (06.2C)

`server/outbox-repository.ts` — отдельная Node/worker-safe точка входа.
`server/outbox-contract.ts` определяет узкие input/result DTO и runtime-валидацию.
Ни один из этих файлов не импортирует Next.js, `server-only`, transport или глобальный
Prisma singleton. Repository не вызывает Telegram и не читает Appointment/connection.

### Публичные операции и DTO

- `new TelegramOutboxRepository(database, { clock?, random? })` получает PrismaClient явно.
  В production время берётся из PostgreSQL; clock/RNG внедряются для детерминированных тестов.
- `claimDue({ capacity, leaseOwner }) -> ClaimedOutboxJob[]`: due claim по фактической свободной
  capacity; ноль и пустая очередь возвращают пустой массив, большие capacity ограничиваются 20.
- `finish({ id, leaseToken, outcome, ... }) -> OutboxTransitionResult`: outcome принимает только
  `SENT`, `RETRY`, `DEAD`, `SKIPPED` или `CONFIGURATION_FAILURE`, каждый со своей
  строгой allowlist кодов. Результаты: `APPLIED` со статусом, `LEASE_LOST`,
  `TERMINAL` со статусом либо `TRANSITION_NOT_ALLOWED`. Конкурентный проигрыш не бросает exception.
- `recoverExpired({ batchSize }) -> RecoveredOutboxJob[]`: положительный batch, максимум 20,
  только восстановленные ID и новые статусы.
- `invalidateTelegramOutbox(tx, { target, code, now }) -> { cancelled, invalidated }`:
  принимает тот же Prisma transaction client, что будущая бизнес-операция, и не начинает
  вложенную транзакцию. Допустимы точная Appointment с непустым списком notification types,
  Appointment connection либо Admin connection. Произвольный SQL, неограниченный target
  «всё» и персональные external IDs не принимаются. К бизнес-сервисам helper ещё не подключён.

`ClaimedOutboxJob` содержит только ID, тип, attempts, UUID token/owner, claimedAt,
leaseExpiresAt, expiresAt, булевый invalidated и `payloadCheck`. Payload полностью проверяется
через `parseTelegramPayloadV1` (форма, version, 16 KiB), затем отбрасывается из результата,
включая корректный snapshot. Payload, его сериализация, recipient IDs и dedupe key не
передаются наружу. Это DTO жизненного цикла, не готовое разрешение на отправку.

`payloadCheck` равен `{ ok: true, payloadVersion: 1 }` либо безопасному
`{ ok: false, code: "PAYLOAD_VERSION_UNSUPPORTED" | "RESPONSE_INVALID" }`.
Повреждённая job остаётся claimed; вызывающая сторона может завершить её
`finish(... DEAD, errorCode)` по полученной lease. Она не получает непроверенный JSON,
Zod issues или исходные данные. `RESPONSE_INVALID` в `DEAD` относится к повреждённому
сохранённому payload; этот же код от внешнего ответа используется через `RETRY`, без refund.

UUID нормализуются в lowercase. Owner — случайный UUID процесса, переданный вызывающей
стороной (например, один `randomUUID()` при старте будущего dispatcher), с trim/lowercase;
такая более узкая форма укладывается в DB `varchar(100)` и исключает hostname/path/free text.
Числа должны быть safe integers, даты — валидные Date в диапазоне 1970–9999.
Невалидный input отклоняется до SQL с `OUTBOX_INPUT_INVALID`.
Неожиданная ошибка хранилища получает `OUTBOX_STORAGE_FAILURE` без driver cause, SQL и значений;
повреждённые lifecycle metadata — `OUTBOX_DATA_INVALID`. Неизвестный исход COMMIT автоматически
не повторяется. Клиент Prisma не следует конфигурировать для логирования SQL parameters.

### SQL и транзакционные гарантии claim

Каждый claim — короткая `ReadCommitted`-транзакция: maxWait/timeout по 5 секунд,
`SET LOCAL statement_timeout = '4s'`, затем один параметризованный CTE-запрос:

1. `claim_time AS MATERIALIZED` фиксирует одно `clock_timestamp()::timestamptz(3)`.
2. `due AS MATERIALIZED` выбирает `status = 'PENDING'`,
   `next_attempt_at <= claim_time.now`, `attempts < 6`;
   порядок `next_attempt_at, id`, `LIMIT min(capacity, 20)`,
   `FOR UPDATE OF o SKIP LOCKED`.
3. Один `UPDATE ... FROM due, claim_time ... RETURNING` меняет статус на `PROCESSING`,
   увеличивает attempts на 1, вызывает `gen_random_uuid()` отдельно для каждой строки,
   записывает owner, claimedAt, leaseExpiresAt = claimedAt + 60 секунд и updatedAt.
4. Финальный `SELECT` упорядочивает возвращённые строки по nextAttemptAt/id.
   Runtime-проверка и формирование минимального DTO выполняются до завершения транзакции.
   Promise возвращает jobs только после COMMIT.

Проверка attempts защищает от нештатно вставленного `PENDING/attempts=6`;
repository сам такого состояния не создаёт и не пытается выполнить седьмой claim.
Истёкший deadline не продлевается: даже claimed job должна пройти будущий preflight.
Никаких business reads, HTTP или ожидания sender capacity внутри claim нет.
Использование CTE с `SKIP LOCKED` соответствует
[PostgreSQL 17 UPDATE](https://www.postgresql.org/docs/17/sql-update.html).

### Lease, fencing и финализация

Финализация блокирует только outbox row по UUID через `FOR UPDATE`, затем читает текущее
время PostgreSQL после ожидания. Требуются `PROCESSING`, совпадающий token и
`leaseExpiresAt > now`; каждый изменяющий UPDATE дополнительно повторяет
`WHERE status = 'PROCESSING' AND lease_token = expectedToken`.
Recovery не сможет заменить lease между проверкой и UPDATE. Старый token не очищает
и не перезаписывает новую lease. Clock раньше claimedAt даёт `TRANSITION_NOT_ALLOWED`.

Для отсутствующей row, чужого token или истёкшей lease возвращается `LEASE_LOST`.
Для PENDING возвращается `TRANSITION_NOT_ALLOWED`, для любого terminal-статуса —
`TERMINAL`; строка при этом не меняется.

| Исход текущей lease                                                       | Новый статус и сохранение данных                                                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Подтверждённый успех                                                      | SENT, sentAt/finishedAt = now, lastErrorCode очищается, attempts сохраняется; invalidation не отменяет подтверждённый успех |
| Временная/неизвестная ошибка                                              | PENDING по готовому decideTelegramRetry; attempts не уменьшается; nextAttemptAt не выходит за expiresAt                     |
| Постоянная ошибка / исчерпание шести claims / слишком большой retry_after | DEAD с finishedAt и безопасным кодом, без изменения attempts                                                                |
| Worker preflight установил неактуальность                                 | SKIPPED с finishedAt и одним из четырёх worker-side кодов                                                                   |
| Job инвалидирована во время обычной неуспешной попытки                    | SKIPPED вместо повторов, с сохранённой producer invalidation-парой                                                          |

Каждый переход из PROCESSING очищает leaseToken, leaseOwner, claimedAt и leaseExpiresAt.
Non-SENT не получает sentAt; finishedAt заполнен только для terminal-состояния.
Retry на точной границе expiresAt разрешён; рассчитанный позже неё становится SKIPPED
без изменения прежнего допустимого nextAttemptAt.

Инвалидирование PENDING даёт CANCELLED, invalidatedAt/invalidationCode и finishedAt.
Для PROCESSING меняются только invalidation-пара и updatedAt; token, owner, attempts,
claim times и статус сохраняются. Первый producer-код сохраняется; повтор ничего
не меняет. SENT/DEAD/CANCELLED/SKIPPED исключены из UPDATE.

Worker-side коды: REMINDER_EXPIRED, CONNECTION_INACTIVE, APPOINTMENT_NOT_SCHEDULED,
VISIT_MISMATCH. APPOINTMENT_CANCELLED/COMPLETED/NO_SHOW отображаются в
APPOINTMENT_NOT_SCHEDULED, VISIT_CHANGED — в VISIT_MISMATCH, причины отключения —
в CONNECTION_INACTIVE. REMINDER_EXPIRED обозначает исчерпание deadline, в том числе
короткоживущего direct-ответа: отдельного direct-expiry кода в принятой DB allowlist нет.

SKIPPED запрещает дальнейшую отправку, но не доказывает её отсутствие: при потерянном
ответе Telegram мог уже принять сообщение. Exactly-once delivery не заявляется.

### Согласованная конфигурационная компенсация

`CONFIGURATION_FAILURE` принимает только `CONFIG_UNAUTHORIZED` при подтверждённом
отсутствии принятого сообщения и действующей lease. NETWORK_UNREACHABLE,
RESPONSE_INVALID, DELIVERY_OUTCOME_UNKNOWN, identity/webhook и другие коды не могут
вызвать refund. Глобальный circuit breaker и изменение connection в 06.2C отсутствуют.

Вычисляется retryAt = now + 5 минут. Если expiresAt отсутствует либо retryAt <= expiresAt,
job возвращается в PENDING с nextAttemptAt = retryAt, sentAt/finishedAt = null.
Если retryAt > expiresAt, job становится SKIPPED: прежний допустимый nextAttemptAt
сохраняется, finishedAt = now, sentAt = null. В обоих случаях attempts уменьшается
ровно на 1 с нижней границей 0, lastErrorCode = CONFIG_UNAUTHORIZED и вся lease очищается.
InvalidatedAt/invalidationCode не создаются, не очищаются и не переписываются этой операцией.

Подтверждённый `SENT` имеет приоритет над invalidation. Для любого другого outcome уже
инвалидированная `PROCESSING` job сразу становится `SKIPPED` с кодом из
`invalidationSkipCode`, прежним допустимым nextAttemptAt и неизменной invalidation-парой.
В частности, `CONFIGURATION_FAILURE` в этом случае не рассчитывает retryAt и не записывает
`CONFIG_UNAUTHORIZED`, но компенсирует текущую попытку уменьшением attempts на один.

Это согласованное узкое исключение для краткоживущей job: SKIPPED означает запрет повтора
дедлайном, а CONFIG_UNAUTHORIZED сохраняет фактическую причину пропуска. Оно не требует
изменения `notification_outbox_schedule_check`, Prisma schema или миграции 06.2A.
Идемпотентный повтор с прежней lease не компенсирует attempts ещё раз.

### Recovery

Recovery выполняет короткую отдельную ReadCommitted-транзакцию с теми же таймаутами:

1. Фиксирует now и выбирает до min(batchSize, 20) PROCESSING rows с
   leaseExpiresAt <= now, в порядке leaseExpiresAt/id, через FOR UPDATE SKIP LOCKED.
2. Пока эти ограниченные row locks удерживаются, вызывает готовый decideTelegramRetry
   для каждой job с DELIVERY_OUTCOME_UNKNOWN и внедряемым RNG. Сеть и бизнес-таблицы
   не используются, формула backoff не дублируется в SQL.
3. Одним параметризованным UPDATE FROM VALUES применяет решения ко всему batch;
   у каждой строки повторно проверяются PROCESSING и захваченный fencing token.
4. Актуальная job с attempts < 6 получает PENDING/retry time; инвалидированная,
   истёкшая либо выходящая за retry deadline — SKIPPED; исчерпанная — DEAD.
   Attempts сохраняется, lease очищается, finishedAt заполнен только у terminal rows.

Обычный recovery сохраняет DELIVERY_OUTCOME_UNKNOWN; для SKIPPED сохраняется worker-side
код причины прекращения повторов. Повтор recovery не меняет восстановленные строки.
Два независимых recovery worker не выбирают одну и ту же заблокированную row.

### Проверки и дальнейшая интеграция

PostgreSQL-наборы `telegram-outbox.test.ts` и `telegram-outbox-concurrency.test.ts`
запускаются только через `scripts/test-postgres.mjs` на случайной `zaprosto_test_*` БД.
Конкурентные сценарии используют два отдельных PrismaClient и dedicated pg connection;
барьеры удерживают реальные транзакции до COMMIT. Проверяются разделение claims,
SKIP LOCKED, recovery, stale/expired fencing, одновременная финализация, producer
invalidation, rollback и безопасность DTO. Все ожидания ограничены таймаутами.

Границы компенсации проверены для TELEGRAM_CONNECTION_REJECTED и
CLIENT_APPOINTMENT_REMINDER: retryAt = expiresAt и retryAt = expiresAt + 1 мс,
refund, очистка lease, неизменность invalidation и schedule check. Fetch подменён
запрещающим spy, новых API/сетевых вызовов в repository нет.

06.2 завершает техническое ядро данных и outbox. Следующий этап — 06.3:
конфигурация/readiness, leader polling, offset и /start, выпуск/отзыв ссылок,
клиентские/административные подключения и соответствующие тесты. Бизнес-producers
остаются 06.4, dispatcher/отправка/эксплуатация — 06.5. Этап 06 целиком не завершён,
ADR-0014 остаётся Proposed до реальной интеграции и приёмки.
