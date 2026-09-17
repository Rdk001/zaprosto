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

## Конфигурация и readiness (06.3A)

Worker/server-модуль runtime-config.ts разбирает три утверждённые переменные:
TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME и необязательный
TELEGRAM_POLL_TIMEOUT_SECONDS. Обе отсутствующие обязательные переменные означают
штатное состояние DISABLED. Одна отсутствующая переменная даёт INCOMPLETE, а
невалидный token, username или timeout — INVALID с кодом из закрытого allowlist.
Username принимается и хранится без @. Timeout по умолчанию равен 30 секундам;
допустимы только целые значения 5–50. Синтаксически неверный token и ответ Bot API
401 дают только CONFIG_UNAUTHORIZED.

Отдельный чистый web-safe parser принимает объект только с TELEGRAM_BOT_USERNAME.
Отсутствующий username означает DISABLED, невалидный — INVALID с безопасным
BOT_USERNAME_INVALID, валидный — ENABLED с username. Его входной и выходной типы не
содержат TELEGRAM_BOT_TOKEN или TELEGRAM_POLL_TIMEOUT_SECONDS; parser не импортирует
полную runtime-конфигурацию и не читает token. Полный результат runtime parser доступен
только worker/server-коду и содержит token лишь в состоянии ENABLED. Token не входит
в web-safe domain-модуль, DTO readiness, PostgreSQL, ошибки или логи. .env.example
содержит только закомментированные placeholders.

Сервис verifyTelegramBotReadiness получает уже созданный TelegramBotApi, repository,
типизированную конфигурацию и внедряемые часы. DISABLED, INCOMPLETE и INVALID не
вызывают Bot API; неполная или ошибочная конфигурация записывает существующий
безопасный глобальный код CONFIG_UNAUTHORIZED. Для ENABLED сервис вызывает getMe,
сравнивает username без учёта регистра, проверяет сохранённый bot id, затем вызывает
getWebhookInfo. Непустой webhook даёт WEBHOOK_ACTIVE; deleteWebhook автоматически
не вызывается, URL нигде не сохраняется.

HTTP-вызовы выполняются без SQL-транзакции. Успешная identity фиксируется короткой
ReadCommitted-транзакцией с row lock singleton. Пустая identity заполняется. Для
сохранённой identity должны совпасть bot id и username без учёта регистра; различие
только в регистре успешно подтверждается без перезаписи сохранённого username.
Другой bot id или фактически новый username не принимаются и не перезаписываются:
сохраняется BOT_IDENTITY_MISMATCH, lastVerifiedAt не обновляется. Принимающая смену
username операция появится только вместе с будущим атомарным протоколом rotation,
который одновременно обновит TELEGRAM_BOT_USERNAME и отзовёт неиспользованные
deep-link tokens. Запись 06.3A не меняет nextUpdateId, lastPollAt или connections.
lastVerifiedAt обновляется только после успешных getMe и getWebhookInfo и совпадения
сохранённой identity.

Чистая функция computeTelegramWebReadiness возвращает только enabled, ready,
безопасный reasonCode и валидно настроенный botUsername. Положительный результат
требует подтверждённую совпадающую identity, отсутствие глобальной ошибки и свежие
lastVerifiedAt и lastPollAt. Возраст каждой отметки должен быть от нуля до 120000 мс
включительно: точная двухминутная граница считается свежей, 120001 мс — stale.
Будущая отметка времени закрывается как not ready. Проверка identity не подделывает
lastPollAt, поэтому до будущего успешного polling web readiness остаётся false.

06.3A не подключает этот сервис к worker и не реализует advisory lock, getUpdates,
offset, обработку команд, ссылки, connections, producer, dispatcher, UI или endpoint.

## Выпуск и отзыв одноразовых ссылок (06.3B)

`server/link-service.ts` генерирует существующим domain helper 32 случайных байта и
purpose-separated SHA-256 до открытия транзакции. В repository передаётся только hash.
После подтверждённого COMMIT service добавляет raw start parameter к единственному
допустимому результату — прямому
`https://t.me/<подтверждённый_username>?start=<start_parameter>`. Username возвращается
repository из той же readiness-проверки, которая разрешила INSERT, поэтому вызывающий
код не может подменить identity. Повторная выдача не восстанавливает прежний raw token:
она создаёт новый credential и атомарно отзывает предыдущую unused/unrevoked строку.

Клиентская операция принимает только существующий cancellation token, проверяет его
строгой booking schema и ищет Appointment по существующему hash. В короткой
ReadCommitted-транзакции Appointment блокируется `FOR UPDATE`; после ожидания заново
проверяются hash, `SCHEDULED`, строгое `startsAt > clock_timestamp()` и отсутствие
active Appointment connection. Malformed token даёт `INVALID_INPUT`, неизвестный —
`NOT_FOUND`; ни один из них не создаёт rate-limit key.

Административная операция принимает только server-side session token. Active session
сначала определяет текущий AdminUser вне транзакции. Затем repository блокирует именно
его строку, повторно проверяет `isActive` и удерживает session/AdminUser через
существующий `getActiveAdminForShare` до COMMIT. Внешний `adminUserId` не принимается.
Expired/revoked session не проходит, деактивация или отзыв session во время ожидания
lock обнаруживаются повторной проверкой.

Для обоих purpose после target lock проверяется web readiness: валидный настроенный
username, совпадающая подтверждённая bot identity, отсутствие safe global error,
свежие `lastVerifiedAt` и `lastPollAt`. HTTP и Telegram Bot API не вызываются.
Порядок изменяющих блокировок фиксирован:
`Appointment/AdminUser → installation rate row → purpose target rate row → прежний
TelegramLinkToken → новый TelegramLinkToken`.

Rate limit использует только `public_rate_limits` и PostgreSQL
`clock_timestamp()::timestamptz(3)`: 5 попыток на purpose-separated target и 20 общих
клиентских/административных попыток на installation за 15 минут. Target key содержит
domain-separated SHA-256 UUID, но не UUID в читаемом виде и не cancellation/session/link
token либо их hash. UPSERT атомарен между процессами; denied counter насыщается на
`maximum + 1`, а точная граница `expiresAt <= now` начинает новое окно. Отзыв quota
не расходует.

Revoke использует тот же target lock и авторизацию, меняет только соответствующие
unused/unrevoked purpose rows, идемпотентен, не требует readiness и не отключает
connection. Repository DTO содержит только закрытый outcome, verified username и
`expiresAt` успешной выдачи; raw token и target id наружу не читаются.

Узкие проверки 06.3B: 12/12 unit-тестов и 24/24 PostgreSQL
integration/concurrency-теста на случайных базах. Проверены client/admin rotation,
условно потерянный ответ, реальное ожидание target row lock разными DB sessions,
конкурентные status/connection/session/account изменения, общая installation quota,
target quota, rollback перед INSERT, exact 15-minute boundary и partial UNIQUE как
последняя защита. Реальная Telegram-сеть и credentials не использовались.
Полный regression-прогон завершился 540/540 unit и 957/957 PostgreSQL-runner tests;
production build, Prisma validate и Docker Compose config прошли.

06.3B не добавляет UI, Server Actions, HTTP routes, polling, `getUpdates`, обработку
`/start`, connections, confirmation/reminder jobs, outbox producers, dispatcher или
`sendMessage`. Следующая точка: 06.3C — `/start`, Appointment/Admin connections и
confirmation/reminder jobs; затем 06.3D — leader polling, offset protocol и worker.

## Транзакционная обработка `/start` (06.3C)

### Точная грамматика и безопасный parser

`server/start-command-parser.ts` работает только с уже нормализованным `TelegramUpdate`
и не выполняет I/O. Поддерживаются ровно две строки:

```text
/start <start_parameter>
/start@<configured_bot_username> <start_parameter>
```

Разделитель — ровно один ASCII-пробел. Вся строка должна совпасть целиком: leading или
trailing whitespace, newline, второй аргумент, другой/невалидный username и приближённые
варианты запрещены. Username после `@` сравнивается с настроенным без учёта регистра.
Message принимается только из `private` chat, от `from.isBot === false`, при
положительных и равных `chat.id` и `from.id`.

Start parameter проходит `parseTelegramLinkToken`, после чего внутри parser немедленно
вычисляется существующий purpose-separated SHA-256. Parsed DTO содержит только
`updateId`, `telegramUserId`, `telegramChatId`, `purpose`, `tokenHash`. Raw parameter не
выходит из parser. Любой неподдерживаемый update возвращает `IGNORED`; поскольку parser
чистый, при этом нет DB-записи и rejection job.

### TransactionClient и lock order

`server/start-processor.ts` принимает runtime input как `unknown` и уже открытый
`Prisma.TransactionClient`. До `Object.keys` processor требует ненулевой обычный объект
и запрещает массив; затем проверяет точный набор полей, типы и границы PostgreSQL bigint.
`null`, `undefined`, примитивы, bigint, массив, function и объект неверной формы дают
только `START_PROCESSOR_INPUT_INVALID` без cause, credentials или отражения входа.
Storage/driver failures дают только `START_PROCESSOR_STORAGE_FAILURE`. Собственную
транзакцию processor не открывает; сеть, Bot API и fetch внутри отсутствуют. Это позволяет
06.3D поместить effects и будущий offset в один COMMIT. Все временные решения используют
PostgreSQL `clock_timestamp()::timestamptz(3)`.

Перед обработкой берётся domain-separated transaction advisory lock updateId, который
сериализует повтор одного update между процессами. Link credential читается в две фазы:

1. lookup по hash без row lock определяет target;
2. соответствующий `Appointment` или `AdminUser` блокируется `FOR UPDATE`;
3. для admin после target lock берётся domain-separated transaction advisory lock
   положительного private chat;
4. `TelegramLinkToken` повторно читается с `FOR UPDATE`;
5. после ожидания заново проверяются hash/purpose, оба target FK, revoked/used/expiry,
   target state и active connections.

Таким образом, `TelegramLinkToken` никогда не блокируется раньше target. Порядок
согласован с issue/revoke из 06.3B. Admin chat lock сериализует разные AdminUser target
для одного chat до проверки active chat connection; partial UNIQUE остаётся последней,
а не основной защитой.

### Outcomes, connections и outbox

Processor возвращает только `{ kind: "CONNECTED" | "ALREADY_PROCESSED" | "REJECTED" }`.
Target purpose/existence, Appointment/AdminUser/connection ID, token hash и chat/user ID
наружу не выходят. Неизвестные ошибки БД преобразуются в
`TelegramStartProcessorError("START_PROCESSOR_STORAGE_FAILURE")` без SQL, driver cause
и identifiers; ошибка остаётся исключением, чтобы внешняя транзакция откатилась.

При клиентском успехе создаётся immutable `AppointmentTelegramConnection`, link token
получает те же DB now и updateId, затем создаётся `CLIENT_CONNECTION_CONFIRMED`. Если
`startsAt - now` строго больше двух часов, дополнительно создаётся
`CLIENT_APPOINTMENT_REMINDER`: `scheduledAt = startsAt - 2 hours`,
`nextAttemptAt = scheduledAt`, `expiresAt = scheduledAt + 15 minutes`. Ровно два часа и
меньше reminder не создают. Граница детерминированно покрыта чистым расчётом: ровно два
часа возвращают отсутствие schedule, а два часа плюс 1 мс создают schedule с указанными
временами; production now остаётся значением PostgreSQL. Payload v1 содержит только
актуальные `visitVersion` и `expectedVisit` (`serviceId`, `masterId`, `startsAt`,
`endsAt`, `durationMinutes`).

При административном успехе создаётся immutable `AdminTelegramConnection`, link token
помечается использованным и создаётся `ADMIN_CONNECTION_CONFIRMED`. Confirmation jobs
имеют пустой payload v1, `PENDING`, DB now в scheduled/next-attempt и не имеют expiry.

Любая синтаксически корректная команда с корректным форматом token, которую нельзя
применить, получает одинаковую `TELEGRAM_CONNECTION_REJECTED` direct-chat job: пустой
payload v1, `PENDING`, DB now и expiry через 5 минут. Причина отказа не входит ни в DTO,
ни в payload. Dedupe keys имеют формы:

```text
telegram:v1:appointment-connection:<connectionId>:confirmed
telegram:v1:appointment:<appointmentId>:version:<version>:connection:<connectionId>:reminder
telegram:v1:admin-connection:<connectionId>:confirmed
telegram:v1:update:<updateId>:connection-rejected
```

Повтор updateId не создаёт effects. Used token с теми же immutable chat/user возвращает
`ALREADY_PROCESSED` и при новом updateId; другой chat/user получает `REJECTED`. Connection,
token usage и все обязательные jobs записываются одной внешней транзакцией. Ошибка любой
job или rollback caller-а не оставляет connection, used token или частичных jobs.

Узкие проверки: 55/55 unit/security tests в 4 файлах и 31/31 PostgreSQL
integration/concurrency tests в 2 файлах. Concurrency-набор использует два независимых
PrismaClient, dedicated pg session, реальные row/advisory waits и bounded polling без
`sleep`. Все базы случайные `zaprosto_test_*` и удаляются runner-ом. Global fetch
запрещён spy; реальные Telegram credentials/API не использовались.

Полный regression-прогон завершился 585/585 unit tests в 45 файлах и 1033/1033 tests
PostgreSQL runner в 66 файлах. Format check, lint, typecheck, production build, Prisma
validate, Docker Compose config и `git diff --check` прошли.

06.3C не вызывает `getUpdates`, не реализует leader election, polling, batch protocol,
offset/`nextUpdateId`, worker integration, dispatcher, `sendMessage`, webhook, UI или
routes. Эти границы сохраняются для 06.3D и последующих этапов. ADR-0014 остаётся
`Proposed`.

## Single-leader polling и транзакционный offset (06.3D)

`worker` запускает отдельный `TelegramPollingOrchestrator`. При полностью отключённой
Telegram-конфигурации процесс остаётся жив, не создаёт Bot API и раз в 60 секунд
перепроверяет конфигурацию. `INCOMPLETE`, `INVALID`, несовпадение identity и активный
webhook дают только безопасный код и тот же ограниченный readiness retry. Worker никогда
не вызывает `deleteWebhook`.

Право на `getUpdates` выдаёт только session-level advisory lock `(526008, 61)`.
`PostgresTelegramPollingLeaderSource` удерживает его на выделенном `pg.PoolClient`.
Проверка после ответа и перед каждым update читает `pg_locks` для
`pg_backend_pid()`, `classid/objid` двухчастного ключа и `objsubid = 2`; повторный
`pg_try_advisory_lock` не используется. События dedicated connection `error/end`
сразу инвалидируют session и abort-ят long poll. Ответ, пришедший после потери lock,
отбрасывается. Healthy shutdown явно снимает lock до возврата connection в pool,
потерянная connection уничтожается.

Лидер перед polling и затем каждые 60 секунд проходит существующий
`verifyTelegramBotReadiness`. Каждый запрос использует сохранённый
`TelegramBotState.nextUpdateId`, `limit = 100`, runtime timeout и
`allowed_updates = ["message"]`. Для номера подряд идущей ошибки `n`, начиная с нуля,
base delay равен `min(30 000, 1 000 * 2^min(n, 5))` миллисекунд. К нему добавляется
jitter в диапазоне от `lowerBound = max(1 000, floor(baseDelay * 0,75))` до `baseDelay`:
`lowerBound + floor((baseDelay - lowerBound) * clamp(rng, 0, 1))`. Поэтому задержка
всегда остаётся в диапазоне 1–30 секунд, а на cap разные RNG дают 22,5–30 секунд и
worker не синхронизируют retry. Non-finite RNG предсказуемо выбирает `lowerBound`,
а успешный poll сбрасывает счётчик. RNG внедрён
в orchestrator и детерминирован в тестах. HTTP 409 нормализуется в `POLLING_CONFLICT`, после чего readiness повторно
проверяет webhook без автоматического переключения режима.

Batch копируется, сортируется по `updateId` и обрабатывается последовательно. Каждая
транзакция блокирует singleton через `SELECT ... FOR UPDATE` и требует точного
совпадения с локальным `expectedStoredOffset`. Replay `updateId < nextUpdateId`
не вызывает parser/processor и не меняет offset. Gap допустим; новый или проигнорированный
update фиксирует `nextUpdateId = updateId + 1`. Валидный `/start` передаётся
`processTelegramStart` с тем же `Prisma.TransactionClient`, поэтому connection,
token usage, outbox jobs, offset, DB-time `lastPollAt` и очистка error code входят в
один commit. Ошибка откатывает весь update и останавливает остаток batch. Пустой batch
обновляет только DB-time `lastPollAt` после того же lock/equality check.

SIGINT/SIGTERM идемпотентно abort-ят ожидание/long poll, дожидаются выхода оркестратора,
освобождают leader connection/pool и отключают Prisma. Сразу после создания `pg.Pool`
регистрируется обработчик idle-client `error`: он не запускает повторный shutdown и
логирует только `LEADER_SESSION_FAILURE`, без объекта ошибки и connection details.
Production worker собирается в единый ESM artifact прямой точно зафиксированной
devDependency `esbuild@0.28.2`, вызываемой через npm script, чтобы Node runtime не зависел от
extensionless imports сгенерированного Prisma TypeScript client.

Узкие проверки исправлений 06.3D: 24/24 unit-теста leader/orchestrator/worker entrypoint
и 10/10 PostgreSQL polling integration-тестов. Полный unit-набор содержит 609 тестов,
полный изолированный PostgreSQL runner — 1067 тестов, E2E — 133 теста. Реальный Telegram, Bot Token,
`deleteWebhook` и production advisory key в integration tests не использовались;
тестовый lock key внедряется отдельно и обязательно освобождается.

06.3D не добавляет dispatcher, обработку `NotificationOutbox`, `sendMessage`, rate
limiter отправки, business producers, UI, routes или webhook endpoint. Prisma schema и
миграции не менялись.

## Самостоятельное подключение администратора (06.3F)

Страница `/admin/notifications` доступна только действующей административной сессии.
HttpOnly session cookie читается исключительно в server-only composition root и в
zero-argument Server Actions; значение cookie не передаётся в Client Components, props,
DOM, URL или browser storage. Read action не требует Origin, а issue, revoke и disconnect
проходят точную проверку настроенного Origin до обращения к доменному сервису.

Read model возвращает закрытый набор `AVAILABLE`, `CONNECTED`, `UNAVAILABLE` и
`UNAUTHORIZED`. Выпуск и отзыв deep link используют существующий
`TelegramLinkService`; raw start token живёт только в текущем React state и только внутри
`https://t.me/<bot>?start=<token>`. Перезагрузка, смена owner generation или любой более
новый ответ скрывают старую ссылку. UI не восстанавливает её из истории или storage, не
запускает polling и игнорирует stale async responses.

Admin disconnect выполняется одной транзакцией. Сначала блокируется `AdminUser`, затем
повторно проверяются активная сессия и аккаунт, после чего блокируется активная
`AdminTelegramConnection`. Неиспользованные admin link tokens отзываются, connection
получает `disabledAt` и `USER_DISCONNECTED`, а существующий
`invalidateTelegramOutbox` вызывается для target `ADMIN_CONNECTION` с кодом
`CONNECTION_DISABLED`. PENDING jobs отменяются, PROCESSING получают fencing; terminal
jobs и jobs других connections не изменяются. Повторный disconnect идемпотентен.

Этап не добавляет dispatcher, `sendMessage`, business producers 06.4, webhook,
автоматический browser polling, новые зависимости, схему или миграции. Integration и E2E
используют существующий parser/processor без реальных Telegram-запросов.

## Одна попытка доставки outbox job (06.5C)

`TelegramDeliveryAttempt.run({ jobId, leaseToken, signal? })` выполняет preflight
уже захваченного job. `LEASE_LOST` не вызывает ни Telegram, ни `finish`;
`SKIP` и `DEAD` сразу передаются в существующий fenced `finish`. Только `READY`
даёт сервису актуальные `chatId` и готовый текст и разрешает ровно один вызов
`sendMessage`. Внешний caller не может передать адресата или текст в attempt.

HTTP-вызов выполняется после завершения read-only preflight и до отдельной транзакции
`finish`. Внутренних HTTP-retry нет. Нормализованные ошибки adapter переводятся в
`RETRY`, `DEAD` или `CONFIGURATION_FAILURE`; неизвестное исключение отправки
безопасно становится `DELIVERY_OUTCOME_UNKNOWN`. Ошибки preflight, PostgreSQL и
`finish` поднимаются вызывающему коду без повторной отправки или финализации.

Результат сервиса различает потерю lease на preflight и фактический
`OutboxTransitionResult` финализации. Успешная отправка остаётся `SENT`, даже если
producer инвалидировал job во время HTTP; ошибка отправки после такой инвалидации
обычно становится `SKIPPED`. Потеря lease перед `finish` возвращается как есть.
Модель доставки остаётся at-least-once: сбой БД после принятого Telegram сообщения
может привести к повторной доставке после recovery.

06.5C не подключает production dispatcher/worker loop, distributed rate limiter,
recovery loop и отключение `TelegramConnection` при постоянной ошибке получателя.
Отключение connection должно быть реализовано следующим этапом до production dispatcher.

## Атомарное отключение connection при постоянной ошибке получателя (06.5D)

`TelegramOutboxRepository.finish()` автоматически отключает connection только для
`CHAT_NOT_FOUND`, `BOT_BLOCKED`, `CHAT_WRITE_FORBIDDEN` и
`TELEGRAM_USER_DEACTIVATED`. Значение `disabledReason` совпадает с error code.
`INVALID_REQUEST`, `PAYLOAD_VERSION_UNSUPPORTED`, `RESPONSE_INVALID`,
`RESPONSE_TOO_LARGE`, retryable ошибки, `CONFIG_UNAUTHORIZED` и успешный `SENT`
connection не изменяют.

Операция выполняется в одной fenced PostgreSQL-транзакции. Сначала блокируется текущий
outbox job и проверяются `PROCESSING`, lease token, DB-time expiry и существующая
invalidation. Затем по immutable `appointmentConnectionId` или `adminConnectionId`
блокируется ровно один connection, при первом отключении сохраняются PostgreSQL time и
постоянный error code, после чего связанные sibling jobs инвалидируются
`CONNECTION_DISABLED`. PENDING становятся `CANCELLED`; PROCESSING сохраняют lease и
статус, а их поздний `finish` становится `SKIPPED/CONNECTION_INACTIVE`. Текущий job
первого отключения завершается `DEAD`.

`DIRECT_CHAT` не имеет connection: постоянная ошибка завершает только текущий job как
`DEAD`, без поиска по `telegramChatId` и без изменения чужих очередей. Уже сохранённые
`disabledAt/disabledReason` не перезаписываются. Если параллельный `finish` видит уже
отключённый connection, его job безопасно получает `CONNECTION_DISABLED` и
`SKIPPED/CONNECTION_INACTIVE`. Ошибка SQL откатывает финализацию, отключение и
инвалидацию целиком.

06.5D не подключает production dispatcher/worker loop, distributed rate limiter,
recovery scheduler, advisory locks, readiness polling или глобальный circuit breaker.
