# Технический план этапа 06: Telegram-подключения, уведомления и outbox

- Статус: план реализации
- Дата: 2026-09-04
- Архитектурное решение: Proposed [ADR-0014](decisions/0014-telegram-notifications.md)
- Граница текущей задачи: только проектирование 06.1; код, Prisma schema, миграции, Docker и worker ещё не изменены

## 1. Цель и нецели

Этап 06 должен добавить добровольное Telegram-подключение клиента к конкретной записи, безопасное подключение администратора, согласованные продуктом сообщения и надёжный PostgreSQL outbox. Недоступность Telegram не должна откатывать или блокировать создание, отмену, статус, исправление контактов либо перенос записи.

В план не входят:

- поиск Telegram по телефону;
- SMS, email и другие каналы;
- общий Customer/account;
- группы и каналы Telegram как получатели;
- webhook в MVP;
- платные broadcasts;
- брокер сообщений, отдельный сервис или универсальная event bus;
- Telegram SDK;
- уведомления для `COMPLETED` и `NO_SHOW`;
- уведомление при изменении только имени или телефона;
- exactly-once внешняя доставка.

## 2. Изученная исходная реализация

### 2.1. Транзакции Appointment

- Публичное и ручное создание используют общий `createBookingInTransaction` внутри `Serializable`: `BookingRequest`, `Appointment` и начальная `AppointmentStatusHistory` создаются атомарно. Replay распознаётся до новых записей.
- Клиентская отмена использует условный `SCHEDULED → CANCELLED` и добавляет историю в той же `ReadCommitted`-транзакции. Повтор уже отменённой записи не добавляет историю.
- Административная отмена и статусы соблюдают порядок `advisory (526008, 52) → BusinessSettings FOR SHARE → Appointment FOR UPDATE`, затем меняют Appointment и историю.
- Исправление контактов блокирует только `Appointment FOR UPDATE`, увеличивает общую version и сознательно не создаёт историю или уведомление.
- Перенос использует тот же общий administrative lock order, `Appointment FOR UPDATE`, повторные проверки и один `UPDATE` с `version + 1`. История статуса не создаётся.

Будущие producer-ы встраиваются внутрь этих транзакций после успешного предметного изменения и до COMMIT. В ветках replay, conflict, no-op и validation failure jobs не создаются.

### 2.2. Ранние Telegram/outbox модели

| Элемент              | Полезная часть                                 | Недостаток                                                                                                       | Решение                                              |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `TelegramLink`       | `appointmentId`, hash, TTL, Telegram IDs       | token и durable connection смешаны; нет отключения, identity поколения, admin target и согласованных constraints | заменить на отдельный token и две connection-модели  |
| `NotificationOutbox` | `type`, `scheduledAt`, attempts, unique dedupe | нет recipient, next attempt, lease, sent time, terminal skip/cancel/dead и payload version                       | перестроить до первого producer                      |
| `NotificationType`   | различает client/admin и основные события      | `APPOINTMENT_CREATED` двусмысленен: Telegram не может подтвердить клиенту запись до Start                        | заменить на точные message-семантики                 |
| `NotificationStatus` | есть pending/processing/sent/failed            | `FAILED` не различает retry, terminal error и неактуальность                                                     | использовать конечные `DEAD`, `CANCELLED`, `SKIPPED` |

По текущему коду эти таблицы не заполняются. Миграция всё равно не должна молча предполагать, что они пусты: SQL preflight обязан остановиться при неожиданных строках.

## 3. Проверенные ограничения Telegram

Технические факты ниже взяты только из официальных страниц Telegram.

| Факт                                                                                                                 | Следствие для проекта                                                                                             | Источник                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `getUpdates` и webhook одновременно не работают                                                                      | polling стартует только при пустом `WebhookInfo.url`                                                              | [Bot API: getUpdates](https://core.telegram.org/bots/api#getupdates)                                                                     |
| Update подтверждается вызовом с `offset > update_id`; limit 1–100, long-poll timeout должен быть положительным       | хранить `nextUpdateId`, использовать limit 100 и timeout 30 секунд                                                | [Bot API: getUpdates](https://core.telegram.org/bots/api#getupdates)                                                                     |
| `allowed_updates` не отсекает уже накопленные старые updates мгновенно                                               | неизвестные виды update нужно безопасно пропускать с продвижением offset                                          | [Bot API: getUpdates](https://core.telegram.org/bots/api#getupdates)                                                                     |
| Неполученные updates хранятся не дольше 24 часов                                                                     | outage дольше суток может потребовать новую deep link                                                             | [Bot API: getting updates](https://core.telegram.org/bots/api#getting-updates)                                                           |
| `deleteWebhook` может сохранить pending updates при `drop_pending_updates=false`                                     | переход к polling не должен по умолчанию удалять очередь Telegram                                                 | [Bot API: deleteWebhook](https://core.telegram.org/bots/api#deletewebhook)                                                               |
| `getWebhookInfo.url` пуст при polling                                                                                | это startup-проверка и диагностический признак                                                                    | [Bot API: getWebhookInfo](https://core.telegram.org/bots/api#getwebhookinfo)                                                             |
| Start parameter — до 64 base64url-символов; разрешены `A-Z a-z 0-9 _ -`                                              | `c_`/`a_` + 43 символа помещаются без ослабления entropy                                                          | [Bot Features: Deep Linking](https://core.telegram.org/bots/features#deep-linking)                                                       |
| Бот не может первым начать private conversation                                                                      | web подтверждает запись сразу, Telegram — только после Start                                                      | [Bots: ограничения](https://core.telegram.org/bots#how-are-bots-different-from-users)                                                    |
| Текст `sendMessage` — 1–4096 символов                                                                                | builders имеют меньший внутренний предел и не используют parse mode                                               | [Bot API: sendMessage](https://core.telegram.org/bots/api#sendmessage)                                                                   |
| Flood control может вернуть `retry_after`                                                                            | 429 имеет отдельный retry путь                                                                                    | [Bot API: ResponseParameters](https://core.telegram.org/bots/api#responseparameters)                                                     |
| Рекомендуется не превышать примерно 1 сообщение/с в один chat и около 30/с broadcast                                 | отправитель сериализует chat и ограничивает global rate до 25/с                                                   | [Bots FAQ: limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)                                      |
| Bot API error содержит `ok`, optional `description`, `error_code` и иногда `parameters`; текст предназначен человеку | полный ответ/description не хранить, классифицировать в ограниченные внутренние коды                              | [Bot API: making requests](https://core.telegram.org/bots/api#making-requests)                                                           |
| Telegram документирует 403 для privacy/blacklist и `USER_IS_BLOCKED`, но не как стабильный текст Bot API             | распознавать проверенные chat-specific случаи, неизвестный 403 считать запретом записи без сохранения description | [API errors](https://core.telegram.org/api/errors), [messages.sendMessage errors](https://core.telegram.org/method/messages.sendMessage) |

## 4. Компоненты и ответственность

1. **Telegram configuration/readiness** валидирует env, `getMe`, bot identity и отсутствие webhook. Состояние без секретов записывается в `TelegramBotState`.
2. **Link issuer** создаёт клиентский или административный raw-токен, сохраняет только hash и возвращает deep link один раз.
3. **Polling leader** удерживает PostgreSQL advisory lock и вызывает `getUpdates`.
4. **Update processor** строго разбирает private `/start`, атомарно меняет token/connection/outbox/offset.
5. **Business producers** добавляют jobs и инвалидируют reminders внутри существующих Appointment-транзакций.
6. **Outbox dispatcher** атомарно claim-ит jobs, выполняет preflight, вызывает Telegram вне транзакции и фиксирует результат по fencing token.
7. **Cleanup** небольшими batch удаляет просроченные token rows и старую terminal-историю.

Polling и delivery работают независимо: активный webhook останавливает только приём команд, а не должен сам по себе ломать уже настроенную исходящую доставку. Несовпадение bot identity останавливает оба пути, чтобы новый бот не получил старые connection identities.

## 5. Одноразовый токен

### 5.1. Формат

- Клиент: `c_` + `base64url(randomBytes(32))`.
- Администратор: `a_` + `base64url(randomBytes(32))`.
- Random part: 43 символа, 256 бит энтропии.
- Полный start parameter: 45 символов.
- Padding `=` отсутствует.
- Hash: lowercase hex SHA-256 от domain separator, NUL и полного start parameter.
- Domain separators: `zaprosto:telegram-client-link:v1` и `zaprosto:telegram-admin-link:v1`.

Prefix не является секретом; он позволяет выбрать строго один purpose и не выполнять поиск одного hash в нескольких пространствах. Hash lookup выполняется по unique index. Сравнение raw-токенов и вывод token prefix в диагностике запрещены.

### 5.2. TTL, rotation и rate limit

- TTL обоих purpose — 30 минут от PostgreSQL `clock_timestamp()`.
- Токен одноразовый.
- Новая выдача под row lock отзывает прежний неиспользованный токен target и вставляет новый.
- Потеря ответа лечится только новой выдачей; восстановить raw невозможно.
- Public issuance использует существующий cancellation token, strict POST, Origin/no-store/no-referrer и отдельные PostgreSQL rate-limit keys.
- Admin issuance использует текущую активную server session, strict POST и Origin.
- Предлагаемый предел выдачи: 5 попыток за 15 минут на target и 20 за 15 минут на installation. Эти значения являются константами и используют существующую инфраструктуру `PublicRateLimit`.

### 5.3. Нейтральные ответы

Expired, revoked, malformed, wrong-purpose, wrong-chat и already-used-by-another-chat не раскрывают:

- существование Appointment/AdminUser;
- её статус или время;
- Telegram ID прежнего владельца;
- различие между неверным и уже использованным токеном.

Для них создаётся короткая direct-chat job с одинаковым текстом: ссылка недействительна или устарела, нужно вернуться в «Запросто» и получить новую. Dedupe такой job основан на `update_id`.

## 6. Последовательность клиентского подключения

### 6.1. Выдача ссылки

1. Клиент уже имеет существующий cancellation token в fragment и передаёт его только POST-действию.
2. Web проверяет Telegram readiness: настроен username, bot identity подтверждён, polling heartbeat свежий и нет safe error code.
3. Сервис генерирует raw-токен до транзакции и hash в памяти процесса.
4. `ReadCommitted`-транзакция блокирует `Appointment FOR UPDATE`, повторно проверяет cancellation hash, `SCHEDULED`, `startsAt > database now` и отсутствие active connection.
5. В порядке `Appointment → прежние link tokens → новый link token` прежние токены отзываются, новый hash сохраняется.
6. После COMMIT raw-токен один раз возвращается browser-у; browser строит `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<token>`.
7. При неизвестном результате UI не считает ссылку созданной; повтор создаёт новый token и отзывает потенциально сохранённый прежний.

Кнопка не показывается для `CANCELLED`, `COMPLETED`, `NO_SHOW`, прошедшей записи, уже active connection либо неготового Telegram.

### 6.2. Обработка Start

1. Poller получает update только от Telegram API и проверяет safe integer `update_id`.
2. Принимается только `message.chat.type = private`, обычный `message.from` и точная команда настроенного бота.
3. В update-транзакции блокируется `TelegramBotState`; update ниже `nextUpdateId` завершается no-op.
4. По hash выполняется неблокирующее определение target, затем lock order: `Appointment → TelegramLinkToken → active connection`.
5. После всех ожиданий читается `clock_timestamp()` и повторяются проверки TTL/status/time.
6. Первый валидный Start создаёт `AppointmentTelegramConnection`, помечает token used, добавляет `CLIENT_CONNECTION_CONFIRMED`, при необходимости reminder и обновляет offset.
7. Подтверждение подключения формируется при отправке из актуальной Appointment и показывает услугу, мастера, дату и время в текущей зоне бизнеса.

### 6.3. Пограничные случаи

| Случай                                                             | Результат                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| До визита осталось ровно или меньше 2 часов                        | связь создаётся, confirmation отправляется, reminder не создаётся                 |
| Appointment отменена/завершена/прошла до Start                     | connection не создаётся; token отзывается; нейтральный ответ                      |
| Тот же update доставлен повторно                                   | offset делает no-op                                                               |
| Пользователь второй раз нажал Start и Telegram создал новый update | та же connection остаётся; второе логическое confirmation/reminder не создаётся   |
| Тот же токен открыл другой chat                                    | отказ без раскрытия target; существующая connection не меняется                   |
| Appointment уже связана с другим chat                              | отказ; переназначение без явного отключения невозможно                            |
| Один chat открывает ссылки двух разных Appointments                | разрешены две независимые per-appointment connections                             |
| Worker был выключен больше 24 часов                                | update мог исчезнуть у Telegram; клиент создаёт новую ссылку                      |
| Raw link попал в server log middleware                             | это дефект безопасности; URL `t.me` не должен проходить через app request/logging |

## 7. Последовательность административного подключения

1. Администратор открывает собственный раздел уведомлений в защищённой админке.
2. Active session и Origin проверяются до выдачи.
3. Транзакция блокирует целевой `AdminUser`, проверяет `isActive`, отсутствие active connection, отзывает прежний unused token и сохраняет новый admin hash.
4. Raw deep link показывается ровно один раз. Его не нужно копировать в `.env`.
5. `/start a_…` проходит тот же update protocol, но target — конкретный `AdminUser`.
6. Создаётся `AdminTelegramConnection` и `ADMIN_CONNECTION_CONFIRMED`.
7. Самостоятельное отключение ставит `disabledAt`/`USER_DISCONNECTED`, отзывает active token и инвалидирует неотправленные jobs этой connection.
8. Новое подключение после отключения создаёт новую connection row и новую identity; старые jobs не перенаправляются.

Получателями бизнес-события являются все administrative connections, которые на снимке producer-транзакции одновременно:

- `disabledAt IS NULL`;
- принадлежат `AdminUser.isActive = true`.

Автор события не исключается. Это следует общему правилу «администратор получает уведомление о новой записи и отмене» и сохраняет одинаковое поведение при одном или нескольких администраторах.

## 8. Матрица событий и получателей

| Событие                                        | Получатель                                            | Условие                                                                                     | Тип уведомления                             | Время                                                 |
| ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| Успешное публичное создание                    | Каждый active связанный администратор                 | Новый COMMIT, не BookingRequest replay                                                      | `ADMIN_APPOINTMENT_CREATED`                 | `scheduledAt = occurredAt`, job в транзакции создания |
| Успешное публичное создание                    | Клиент в web                                          | Всегда после подтверждённого результата                                                     | Не Telegram: существующее web-подтверждение | Сразу                                                 |
| Ручное создание администратором                | Каждый active связанный администратор, включая автора | Новый COMMIT, не replay                                                                     | `ADMIN_APPOINTMENT_CREATED`                 | Сразу через outbox той же транзакции                  |
| Ручное создание                                | Клиент                                                | Telegram ещё не связан; администратор передаёт существующую защищённую web-ссылку           | Telegram job нет                            | Ручная передача                                       |
| Клиент успешно подключил Telegram              | Эта новая Appointment connection                      | Appointment остаётся будущей `SCHEDULED`                                                    | `CLIENT_CONNECTION_CONFIRMED`               | Сразу через outbox update-транзакции                  |
| Администратор успешно подключил Telegram       | Эта новая Admin connection                            | AdminUser active                                                                            | `ADMIN_CONNECTION_CONFIRMED`                | Сразу через outbox update-транзакции                  |
| Клиент отменил запись                          | Каждый active связанный администратор                 | Первый переход `SCHEDULED → CANCELLED`                                                      | `ADMIN_APPOINTMENT_CANCELLED`               | Сразу через outbox транзакции отмены                  |
| Клиент отменил запись                          | Сам клиент                                            | Web уже показывает результат; отдельного продуктового Telegram-сообщения нет                | Нет                                         | —                                                     |
| Администратор отменил запись                   | Каждый active связанный администратор                 | Первый переход `SCHEDULED → CANCELLED`                                                      | `ADMIN_APPOINTMENT_CANCELLED`               | Сразу через outbox транзакции статуса                 |
| Администратор отменил запись                   | Active client connection этой Appointment             | Connection существует на снимке транзакции                                                  | `CLIENT_APPOINTMENT_CANCELLED`              | Сразу через outbox транзакции статуса                 |
| Администратор изменил service/master/date/time | Active client connection этой Appointment             | Успешный не-no-op перенос `SCHEDULED`; есть meaningful before/after                         | `CLIENT_APPOINTMENT_CHANGED`                | Сразу через outbox транзакции переноса                |
| Исправлено только имя или телефон              | Никто                                                 | Любой допустимый статус, кроме `CANCELLED`                                                  | Нет                                         | —                                                     |
| Статус стал `COMPLETED`                        | Никто                                                 | Допустимый переход после начала                                                             | Нет; pending reminder инвалидируется        | —                                                     |
| Статус стал `NO_SHOW`                          | Никто                                                 | Допустимый переход после начала                                                             | Нет; pending reminder инвалидируется        | —                                                     |
| Reminder                                       | Active client connection этой Appointment             | Job была создана при остатке `> 2h`; preflight подтверждает актуальную `SCHEDULED` identity | `CLIENT_APPOINTMENT_REMINDER`               | `startsAt - 2h`, не позднее чем через 15 минут        |
| Неверный/просроченный Start                    | Private chat из update                                | Известный и безопасно обработанный отказ                                                    | `TELEGRAM_CONNECTION_REJECTED`              | Сразу, direct-chat, expiry 5 минут                    |

Административный перенос не создаёт административное уведомление: такого продуктового правила нет. `COMPLETED`/`NO_SHOW` и исправление контактов также не создают Telegram job.

## 9. Смысл «подтверждения сразу после создания»

Подтверждение новой записи уже является синхронным web-результатом и защищённой страницей. Telegram не может написать клиенту до того, как клиент сам открыл бота. Поэтому:

- текст интерфейса не обещает Telegram-сообщение при создании;
- на подтверждённой странице предлагается добровольное действие «Подключить Telegram»;
- после успешного Start бот подтверждает именно подключение и показывает актуальные параметры записи;
- reminder создаётся в транзакции подключения, а не заранее без получателя.

Для ручной записи администратор по-прежнему передаёт клиенту защищённую web-ссылку самостоятельно. Клиент открывает её и при желании запускает Telegram.

## 10. Предлагаемая модель данных

Названия ниже являются целевым контрактом 06.2. Prisma schema и SQL-миграция создаются только на этапе реализации.

### 10.1. Enums

```prisma
enum TelegramLinkPurpose {
  APPOINTMENT
  ADMIN_USER
}

enum TelegramConnectionDisabledReason {
  USER_DISCONNECTED
  BOT_REPLACED
  BOT_BLOCKED
  CHAT_NOT_FOUND
  CHAT_WRITE_FORBIDDEN
  TELEGRAM_USER_DEACTIVATED
  ADMIN_USER_DEACTIVATED
}

enum NotificationRecipientKind {
  APPOINTMENT_CONNECTION
  ADMIN_CONNECTION
  DIRECT_CHAT
}

enum NotificationType {
  CLIENT_CONNECTION_CONFIRMED
  ADMIN_CONNECTION_CONFIRMED
  TELEGRAM_CONNECTION_REJECTED
  CLIENT_APPOINTMENT_CANCELLED
  CLIENT_APPOINTMENT_CHANGED
  CLIENT_APPOINTMENT_REMINDER
  ADMIN_APPOINTMENT_CREATED
  ADMIN_APPOINTMENT_CANCELLED
}

enum NotificationStatus {
  PENDING
  PROCESSING
  SENT
  DEAD
  CANCELLED
  SKIPPED
}
```

`ADMIN_USER_DEACTIVATED` допустим только для `AdminTelegramConnection`; `TELEGRAM_USER_DEACTIVATED` означает подтверждённую внешнюю ошибку и допустим для обоих видов connection. `USER_DISCONNECTED`, `BOT_REPLACED`, `BOT_BLOCKED`, `CHAT_NOT_FOUND` и `CHAT_WRITE_FORBIDDEN` также применимы к обоим видам связи.

`FAILED` не сохраняется: retryable failure возвращает job в `PENDING`, а окончательный результат называется `DEAD`. `CANCELLED` означает producer invalidation без будущей отправки; `SKIPPED` — server-side preflight установил, что отправка уже неактуальна.

### 10.2. Концептуальная Prisma-схема

```prisma
model TelegramBotState {
  id              Int       @id @default(1) @db.SmallInt
  botUserId       BigInt?   @map("bot_user_id")
  botUsername     String?   @map("bot_username") @db.VarChar(32)
  nextUpdateId    BigInt    @default(0) @map("next_update_id")
  lastVerifiedAt  DateTime? @map("last_verified_at") @db.Timestamptz(3)
  lastPollAt      DateTime? @map("last_poll_at") @db.Timestamptz(3)
  lastErrorCode   String?   @map("last_error_code") @db.VarChar(64)
  updatedAt       DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@map("telegram_bot_state")
}

model TelegramLinkToken {
  id             String              @id @default(uuid()) @db.Uuid
  purpose        TelegramLinkPurpose
  tokenHash      String              @unique @map("token_hash") @db.Char(64)
  appointmentId  String?             @map("appointment_id") @db.Uuid
  adminUserId    String?             @map("admin_user_id") @db.Uuid
  expiresAt      DateTime            @map("expires_at") @db.Timestamptz(3)
  usedAt         DateTime?           @map("used_at") @db.Timestamptz(3)
  usedByUpdateId BigInt?             @unique @map("used_by_update_id")
  revokedAt      DateTime?           @map("revoked_at") @db.Timestamptz(3)
  createdAt      DateTime            @default(now()) @map("created_at") @db.Timestamptz(3)
  appointment    Appointment?        @relation(fields: [appointmentId], references: [id], onDelete: Restrict)
  adminUser      AdminUser?          @relation(fields: [adminUserId], references: [id], onDelete: Restrict)

  @@index([appointmentId])
  @@index([adminUserId])
  @@index([expiresAt])
  @@map("telegram_link_tokens")
}

model AppointmentTelegramConnection {
  id                String                              @id @default(uuid()) @db.Uuid
  appointmentId     String                              @map("appointment_id") @db.Uuid
  telegramUserId    BigInt                              @map("telegram_user_id")
  telegramChatId    BigInt                              @map("telegram_chat_id")
  sourceUpdateId    BigInt                              @unique @map("source_update_id")
  connectedAt       DateTime                            @map("connected_at") @db.Timestamptz(3)
  disabledAt        DateTime?                           @map("disabled_at") @db.Timestamptz(3)
  disabledReason    TelegramConnectionDisabledReason?   @map("disabled_reason")
  appointment       Appointment                         @relation(fields: [appointmentId], references: [id], onDelete: Restrict)
  notificationJobs  NotificationOutbox[]

  @@unique([id, appointmentId])
  @@index([appointmentId])
  @@index([telegramChatId])
  @@map("appointment_telegram_connections")
}

model AdminTelegramConnection {
  id                String                              @id @default(uuid()) @db.Uuid
  adminUserId       String                              @map("admin_user_id") @db.Uuid
  telegramUserId    BigInt                              @map("telegram_user_id")
  telegramChatId    BigInt                              @map("telegram_chat_id")
  sourceUpdateId    BigInt                              @unique @map("source_update_id")
  connectedAt       DateTime                            @map("connected_at") @db.Timestamptz(3)
  disabledAt        DateTime?                           @map("disabled_at") @db.Timestamptz(3)
  disabledReason    TelegramConnectionDisabledReason?   @map("disabled_reason")
  adminUser         AdminUser                           @relation(fields: [adminUserId], references: [id], onDelete: Restrict)
  notificationJobs  NotificationOutbox[]

  @@index([adminUserId])
  @@index([telegramChatId])
  @@map("admin_telegram_connections")
}

model NotificationOutbox {
  id                        String                     @id @default(uuid()) @db.Uuid
  appointmentId             String?                    @map("appointment_id") @db.Uuid
  appointmentConnectionId   String?                    @map("appointment_connection_id") @db.Uuid
  adminConnectionId         String?                    @map("admin_connection_id") @db.Uuid
  directChatId              BigInt?                    @map("direct_chat_id")
  recipientKind             NotificationRecipientKind  @map("recipient_kind")
  type                      NotificationType
  status                    NotificationStatus         @default(PENDING)
  scheduledAt               DateTime                   @map("scheduled_at") @db.Timestamptz(3)
  nextAttemptAt             DateTime                   @map("next_attempt_at") @db.Timestamptz(3)
  expiresAt                 DateTime?                  @map("expires_at") @db.Timestamptz(3)
  attempts                  Int                        @default(0)
  leaseToken                String?                    @map("lease_token") @db.Uuid
  leaseOwner                String?                    @map("lease_owner") @db.VarChar(100)
  claimedAt                 DateTime?                  @map("claimed_at") @db.Timestamptz(3)
  leaseExpiresAt            DateTime?                  @map("lease_expires_at") @db.Timestamptz(3)
  invalidatedAt             DateTime?                  @map("invalidated_at") @db.Timestamptz(3)
  invalidationCode          String?                    @map("invalidation_code") @db.VarChar(64)
  lastErrorCode             String?                    @map("last_error_code") @db.VarChar(64)
  payloadVersion            Int                        @default(1) @map("payload_version")
  payload                   Json
  dedupeKey                 String                     @unique @map("dedupe_key") @db.VarChar(255)
  sentAt                    DateTime?                  @map("sent_at") @db.Timestamptz(3)
  finishedAt                DateTime?                  @map("finished_at") @db.Timestamptz(3)
  createdAt                 DateTime                   @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt                 DateTime                   @updatedAt @map("updated_at") @db.Timestamptz(3)
  appointment               Appointment?               @relation(fields: [appointmentId], references: [id], onDelete: Restrict)
  appointmentConnection     AppointmentTelegramConnection? @relation(fields: [appointmentConnectionId], references: [id], onDelete: Restrict)
  adminConnection           AdminTelegramConnection?   @relation(fields: [adminConnectionId], references: [id], onDelete: Restrict)

  @@index([status, nextAttemptAt, id])
  @@index([status, leaseExpiresAt])
  @@index([appointmentId, type])
  @@index([appointmentConnectionId, status])
  @@index([adminConnectionId, status])
  @@map("notification_outbox")
}
```

`Appointment` получает массивы `telegramLinkTokens`, `telegramConnections` и сохраняет `notificationJobs`. `AdminUser` получает `telegramLinkTokens` и `telegramConnections`. Другие существующие бизнес-поля не меняются.

### 10.3. `TelegramBotState`

Таблица содержит одну строку для одного настроенного бота. Это не очередь и не журнал всех updates.

| Колонка          | Тип / nullability          | Ограничения и индекс                                                                         | Источник и жизненный цикл                                                               |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `id`             | `smallint`, not null       | PK, `CHECK (id = 1)`                                                                         | Константа singleton; создаётся миграцией.                                               |
| `botUserId`      | `bigint`, nullable         | Пара `botUserId`/`botUsername` либо целиком заполнена, либо пуста; при наличии `CHECK (> 0)` | Результат успешного `getMe`; меняется только после проверки identity.                   |
| `botUsername`    | `varchar(32)`, nullable    | Та же проверка пары; хранится без `@`                                                        | Результат `getMe`; сравнивается с конфигурацией без учёта регистра.                     |
| `nextUpdateId`   | `bigint`, not null         | `CHECK (next_update_id >= 0)`                                                                | Следующий `offset`; продвигается в транзакции обработки update. Начальное значение `0`. |
| `lastVerifiedAt` | `timestamptz(3)`, nullable | —                                                                                            | Последняя успешная проверка `getMe` и отсутствия webhook.                               |
| `lastPollAt`     | `timestamptz(3)`, nullable | —                                                                                            | Последний успешный цикл polling, в том числе пустой.                                    |
| `lastErrorCode`  | `varchar(64)`, nullable    | Только код из allowlist                                                                      | Безопасная диагностика readiness; очищается после восстановления.                       |
| `updatedAt`      | `timestamptz(3)`, not null | —                                                                                            | Служебное время изменения строки.                                                       |

Если сохранённый `botUserId` не совпал с новым `getMe`, worker безопасно прекращает принимать updates до операторского решения. Web считает Telegram готовым только когда username из конфигурации совпадает с проверенным, нет ошибки, а `lastVerifiedAt` и `lastPollAt` достаточно свежие; начальный ориентир свежести polling — две минуты.

### 10.4. `TelegramLinkToken`

| Колонка          | Тип / nullability               | Ограничения и индекс                             | Источник и жизненный цикл                                |
| ---------------- | ------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `id`             | UUID, not null                  | PK                                               | Сервер.                                                  |
| `purpose`        | `TelegramLinkPurpose`, not null | —                                                | `APPOINTMENT` или `ADMIN_USER`.                          |
| `tokenHash`      | `char(64)`, not null            | UNIQUE; hex-check                                | Контекстный SHA-256; raw-токен не сохраняется.           |
| `appointmentId`  | UUID, nullable                  | FK `appointments(id) ON DELETE RESTRICT`; индекс | Только для `APPOINTMENT`.                                |
| `adminUserId`    | UUID, nullable                  | FK `admin_users(id) ON DELETE RESTRICT`; индекс  | Только для `ADMIN_USER`.                                 |
| `expiresAt`      | `timestamptz(3)`, not null      | Индекс; `expires_at > created_at`                | `createdAt + 30 минут`.                                  |
| `usedAt`         | `timestamptz(3)`, nullable      | —                                                | Ставится при успешном или идемпотентном потреблении.     |
| `usedByUpdateId` | `bigint`, nullable              | UNIQUE; согласован с `usedAt`                    | Telegram `update_id`, которым токен потреблён.           |
| `revokedAt`      | `timestamptz(3)`, nullable      | —                                                | Перевыпуск, явный отзыв либо невозможность связать цель. |
| `createdAt`      | `timestamptz(3)`, not null      | —                                                | Сервер.                                                  |

SQL-check требует ровно одну цель и соответствие `purpose`, запрещает одновременно `usedAt` и `revokedAt`, а также требует пару `usedAt`/`usedByUpdateId`. Частичные UNIQUE-индексы допускают не более одного неиспользованного и неотозванного токена на Appointment и на AdminUser; при выпуске нового старый отзывается в той же транзакции. Истёкшие строки неактивны независимо от `revokedAt`.

### 10.5. `AppointmentTelegramConnection`

| Колонка          | Тип / nullability          | Ограничения и индекс                             | Источник и жизненный цикл                             |
| ---------------- | -------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `id`             | UUID, not null             | PK                                               | Сервер; immutable identity адресата.                  |
| `appointmentId`  | UUID, not null             | FK `appointments(id) ON DELETE RESTRICT`; индекс | Целевая запись из токена; после создания не меняется. |
| `telegramUserId` | `bigint`, not null         | `CHECK (> 0)`                                    | `message.from.id` из приватного `/start`.             |
| `telegramChatId` | `bigint`, not null         | `CHECK (> 0)`; индекс                            | `message.chat.id`; принимается только private chat.   |
| `sourceUpdateId` | `bigint`, not null         | UNIQUE, `CHECK (>= 0)`                           | Update успешного подключения.                         |
| `connectedAt`    | `timestamptz(3)`, not null | —                                                | Время атомарного подключения.                         |
| `disabledAt`     | `timestamptz(3)`, nullable | —                                                | Явное отключение или постоянная ошибка доставки.      |
| `disabledReason` | enum, nullable             | Согласован с `disabledAt`                        | Безопасная нормализованная причина.                   |

Частичный UNIQUE-индекс на `appointment_id WHERE disabled_at IS NULL` разрешает только одну активную связь записи. Одинаковый Telegram chat может независимо подключить несколько разных записей: это не создаёт профиль клиента и не объединяет их по телефону. Пара `disabledAt`/`disabledReason` либо целиком пуста, либо заполнена.

### 10.6. `AdminTelegramConnection`

Набор колонок тот же, что у клиентской связи, но вместо `appointmentId` хранится `adminUserId` с FK `admin_users(id) ON DELETE RESTRICT`. Частичные UNIQUE-индексы обеспечивают:

- не более одной активной связи на `AdminUser`;
- не более одного активного администратора на один `telegramChatId`;
- уникальность `sourceUpdateId`.

Связь работает только пока сам `AdminUser` активен. Отключение или переподключение не переиспользует строку: прежняя connection identity остаётся для аудита и адресации уже созданных jobs, а новая получает другой UUID. Такая отдельная модель безопаснее полей на `AdminUser`: она хранит историю отключения, не смешивает учётную запись с внешним каналом и поддерживает несколько администраторов без преждевременной модели филиалов.

### 10.7. `NotificationOutbox`

| Колонка                   | Тип / nullability              | Ограничения и индекс                                                             | Источник и жизненный цикл                                                                |
| ------------------------- | ------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `id`                      | UUID, not null                 | PK                                                                               | Producer.                                                                                |
| `appointmentId`           | UUID, nullable                 | FK `appointments(id) ON DELETE RESTRICT`; индекс с `type`                        | Бизнес-объект, если событие относится к записи.                                          |
| `appointmentConnectionId` | UUID, nullable                 | FK `appointment_telegram_connections(id) ON DELETE RESTRICT`; индекс со `status` | Получатель-клиент.                                                                       |
| `adminConnectionId`       | UUID, nullable                 | FK `admin_telegram_connections(id) ON DELETE RESTRICT`; индекс со `status`       | Получатель-администратор.                                                                |
| `directChatId`            | `bigint`, nullable             | `CHECK (> 0)`                                                                    | Только краткий нейтральный ответ на некорректный `/start`; не общий обход модели связей. |
| `recipientKind`           | enum, not null                 | Ровно один из трёх адресатов заполнен                                            | Явно определяет способ адресации.                                                        |
| `type`                    | `NotificationType`, not null   | Проверка допустимой пары type/recipient                                          | Логический тип события.                                                                  |
| `status`                  | `NotificationStatus`, not null | Индексы claim/recovery                                                           | Состояние job.                                                                           |
| `scheduledAt`             | `timestamptz(3)`, not null     | —                                                                                | Момент, раньше которого job не отправляется.                                             |
| `nextAttemptAt`           | `timestamptz(3)`, not null     | Частичный индекс очереди; `next_attempt_at >= scheduled_at`                      | Первый due time либо рассчитанный retry.                                                 |
| `expiresAt`               | `timestamptz(3)`, nullable     | `expires_at > scheduled_at`                                                      | Дедлайн только для короткоживущих сообщений.                                             |
| `attempts`                | integer, not null              | `DEFAULT 0`, `CHECK (0 <= attempts AND attempts <= 6)`                           | Увеличивается при атомарном claim до HTTP.                                               |
| `leaseToken`              | UUID, nullable                 | Вся lease-группа заполнена вместе                                                | Fencing token конкретного claim.                                                         |
| `leaseOwner`              | `varchar(100)`, nullable       | —                                                                                | Случайный идентификатор процесса, не hostname с PII.                                     |
| `claimedAt`               | `timestamptz(3)`, nullable     | —                                                                                | Время claim.                                                                             |
| `leaseExpiresAt`          | `timestamptz(3)`, nullable     | Частичный recovery-индекс                                                        | `claimedAt + 60 секунд`.                                                                 |
| `invalidatedAt`           | `timestamptz(3)`, nullable     | Согласован с `invalidationCode`                                                  | Producer помечает уже неактуальную, в том числе PROCESSING, job.                         |
| `invalidationCode`        | `varchar(64)`, nullable        | Только код из allowlist                                                          | Например `APPOINTMENT_CANCELLED` или `VISIT_CHANGED`.                                    |
| `lastErrorCode`           | `varchar(64)`, nullable        | Только код из allowlist                                                          | Безопасная классификация последней ошибки без ответа Telegram.                           |
| `payloadVersion`          | integer, not null              | `DEFAULT 1`, `CHECK (> 0)`                                                       | Версия схемы payload.                                                                    |
| `payload`                 | JSONB, not null                | Размер сериализации не более 16 KiB                                              | Минимальный snapshot либо ссылки/версии для live-read.                                   |
| `dedupeKey`               | `varchar(255)`, not null       | UNIQUE                                                                           | Детерминированная identity логического сообщения.                                        |
| `sentAt`                  | `timestamptz(3)`, nullable     | Согласован со `SENT`                                                             | Подтверждённый успешный ответ API.                                                       |
| `finishedAt`              | `timestamptz(3)`, nullable     | Обязателен в terminal states                                                     | Конец обработки.                                                                         |
| `createdAt`, `updatedAt`  | `timestamptz(3)`, not null     | —                                                                                | Аудит строки.                                                                            |

SQL-checks дополнительно требуют: ровно один адресат; `lease_expires_at > claimed_at`; согласованность lease, invalidation и terminal timestamps; отсутствие lease в terminal state. `expiresAt` обязателен и точно равен `scheduledAt + 15 минут` для reminder и `scheduledAt + 5 минут` для direct reject; для остальных типов он `NULL`. Матрица ссылочной целостности закрыта явно:

- `CLIENT_*` требует `appointmentId` и `appointmentConnectionId`; составной FK гарантирует, что connection принадлежит той же Appointment;
- `ADMIN_APPOINTMENT_*` требует `appointmentId` и `adminConnectionId`;
- `ADMIN_CONNECTION_CONFIRMED` требует только `adminConnectionId`;
- `TELEGRAM_CONNECTION_REJECTED` требует только `DIRECT_CHAT` и не содержит `appointmentId`.

Для составного FK клиентская connection получает UNIQUE `(id, appointment_id)`. Частичные индексы outbox:

- `(next_attempt_at, id) WHERE status = 'PENDING'` — claim;
- `(lease_expires_at, id) WHERE status = 'PROCESSING'` — восстановление lease;
- индексы по connection и status — массовая инвалидизация при отключении.

## 11. План миграции

Миграция должна быть сознательно несовместимой с неиспользовавшимся ранним каркасом, а не консервировать его ограничения.

1. SQL-preflight завершает миграцию ошибкой, если в текущих `telegram_links` или `notification_outbox` есть хотя бы одна строка. По принятой чистой базе они не использовались; тихо терять неожиданно появившиеся данные нельзя.
2. Удаляются пустые ранние таблицы и связанные с ними enum-типы `NotificationType`/`NotificationStatus`.
3. Создаются новые enum-типы, пять таблиц, FK, check constraints и частичные индексы, которые Prisma DSL выразить не может.
4. Создаётся singleton-строка `telegram_bot_state(id = 1, next_update_id = 0)`.
5. В Prisma добавляются только обратные relation-поля; существующие бизнес-поля Appointment и AdminUser не меняются.

Для существующих Appointment backfill не нужен: они смогут получить ссылку только после явного действия владельца защищённой страницы. Существующие AdminUser подключаются явно из админки. Старые записи не получают ретроспективные уведомления или напоминания.

Порядок развёртывания будущего блока: остановить старые workers, сделать резервную копию, применить миграцию, развернуть совместимые web/worker, проверить `getMe`, webhook state, singleton offset и безопасные логи. Кнопки подключения остаются скрыты до readiness.

## 12. Транзакционные producers

Во всех пунктах insert/update outbox выполняется через тот же Prisma transaction client, что и изменение бизнес-состояния. Вызов Telegram API внутри этих транзакций запрещён.

### 12.1. Создание записи

В общий `createBookingInTransaction` после Appointment и начальной status history добавляется fan-out по всем активным `AdminTelegramConnection` активных AdminUser. Для каждого получателя создаётся отдельный `ADMIN_APPOINTMENT_CREATED`. Это одинаково работает для публичного и ручного создания. Ветка idempotency replay возвращает прежний результат и ничего не создаёт; UNIQUE `dedupeKey` остаётся второй защитой.

### 12.2. Клиентская отмена

После успешного перехода `SCHEDULED -> CANCELLED` и status history одна транзакция:

- инвалидирует PENDING и помечает PROCESSING напоминания этой версии;
- создаёт `ADMIN_APPOINTMENT_CANCELLED` каждому активному администратору.

Ветка `alreadyCancelled` не создаёт jobs. Клиент видит результат своего действия на защищённой веб-странице, поэтому отдельное Telegram-сообщение инициатору не создаётся.

### 12.3. Административный статус

После административного перехода в `CANCELLED` та же транзакция инвалидирует напоминание, создаёт административный fan-out и, при активной клиентской связи, `CLIENT_APPOINTMENT_CANCELLED`. Переходы в `COMPLETED` и `NO_SHOW` только инвалидируют напоминание; Telegram-событий без нового продуктового решения нет.

### 12.4. Исправление контактов

Изменение только имени и/или телефона не пишет в outbox и не меняет напоминание. Это явное правило, а не случайное отсутствие producer.

### 12.5. Перенос и изменение параметров визита

Сервис переноса сохраняет минимальный before-snapshot, обновляет Appointment с увеличением `version`, а затем в той же транзакции:

- инвалидирует старое напоминание кодом `VISIT_CHANGED`;
- создаёт `CLIENT_APPOINTMENT_CHANGED`, если есть активная клиентская связь;
- создаёт новое напоминание только когда новое начало строго позднее текущего момента более чем на два часа.

Изменением визита считаются услуга, мастер, дата и время. Одновременная смена нескольких полей создаёт одно сообщение с одним before/after snapshot.

### 12.6. Обработка `/start`

Одна транзакция блокирует bot state, целевую строку и токен, затем атомарно:

- создаёт либо подтверждает connection;
- помечает токен использованным;
- создаёт confirmation job и, для будущей записи с запасом более двух часов, reminder job;
- продвигает `nextUpdateId`.

Отказ также продвигает offset и при необходимости создаёт короткоживущий нейтральный ответ. Повтор update не имеет локальных побочных эффектов.

### 12.7. Отключение

Отключение admin/client connection ставит `disabledAt` и причину, отзывает активные токены цели и инвалидирует все её неотправленные jobs в одной транзакции. Переподключение создаёт новую строку connection; прежние jobs не перенаправляются на новый chat.

Если `AdminUser.isActive` меняется на `false`, та же транзакция отключает его активную connection с `ADMIN_USER_DEACTIVATED`, отзывает admin link token и инвалидирует jobs. Sender повторно проверяет `AdminUser.isActive`; если внешняя/старая операция нарушила producer-протокол, он выполняет ту же инвалидизацию и завершает claim как `SKIPPED`. `TELEGRAM_USER_DEACTIVATED` используется только для подтверждённой постоянной ошибки Telegram и не смешивается с состоянием локального AdminUser.

## 13. Payload и формирование текста

Выбран гибридный подход:

- `ADMIN_APPOINTMENT_CREATED`, оба вида отмены и `CLIENT_APPOINTMENT_CHANGED` несут версионированный snapshot конкретного бизнес-события;
- confirmation и reminder читают актуальную Appointment непосредственно перед отправкой;
- адресат всегда берётся из immutable connection, на которую ссылается job, а не ищется заново по телефону или пользователю.

### 13.1. Точный контракт payload v1

`payloadVersion = 1` хранится отдельной колонкой. Все runtime-схемы strict: дополнительные свойства отклоняются, объект Appointment целиком никогда не сериализуется.

`VisitIdentityV1` содержит только `serviceId`, `masterId`, `startsAt`, `endsAt` и `durationMinutes`. UUID передаются канонической строкой, timestamps — UTC ISO 8601, duration — положительным целым.

`VisitSnapshotV1` добавляет к identity `businessTimeZone`, `serviceName` и `masterName`. Это публичные условия визита, а не контакты клиента.

| `NotificationType`             | Точный payload v1                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN_APPOINTMENT_CREATED`    | `{ source, appointmentVersion, occurredAt, visit: VisitSnapshotV1 }`; `source` принимает только `"PUBLIC"` или `"ADMIN"`                                                                   |
| `ADMIN_APPOINTMENT_CANCELLED`  | `{ actor, appointmentVersion, occurredAt, visit: VisitSnapshotV1 }`; `actor` принимает только `"CLIENT"` или `"ADMIN"`                                                                     |
| `CLIENT_APPOINTMENT_CANCELLED` | `{ actor: "ADMIN", appointmentVersion, occurredAt, visit: VisitSnapshotV1 }`                                                                                                               |
| `CLIENT_APPOINTMENT_CHANGED`   | `{ appointmentVersion, occurredAt, changedFields, before: VisitSnapshotV1, after: VisitSnapshotV1 }`; `changedFields` — непустой отсортированный набор из `SERVICE`, `MASTER`, `STARTS_AT` |
| `CLIENT_APPOINTMENT_REMINDER`  | `{ visitVersion, expectedVisit: VisitIdentityV1 }`                                                                                                                                         |
| `CLIENT_CONNECTION_CONFIRMED`  | `{}`; данные берутся live по appointment connection                                                                                                                                        |
| `ADMIN_CONNECTION_CONFIRMED`   | `{}`; проверяются live connection и `AdminUser.isActive`                                                                                                                                   |
| `TELEGRAM_CONNECTION_REJECTED` | `{}`; причина намеренно не сохраняется и не влияет на нейтральный текст                                                                                                                    |

`appointmentVersion` и `visitVersion` — неотрицательные safe integers, `durationMinutes` — положительный safe integer; `occurredAt` берётся из PostgreSQL clock в producer-транзакции. Для confirmation отмена, успевшая произойти после подключения, не превращается в ложное подтверждение будущего визита: builder показывает актуальный статус либо job уже инвалидирована вместе со связью.

Snapshot содержит только перечисленное. Идентификаторы события и получателя находятся в колонках outbox. Payload не содержит телефон или имя клиента, cancellation reason/token/hash, Telegram link token/hash, bot token, session/cookie, credential, полный URL со start-параметром, Telegram chat/user id или полный ответ API. Телефон также не включается в Telegram-текст MVP; администратор открывает защищённую карточку записи.

Snapshot нужен, чтобы сообщение о переносе версии N не описало версию N+1. Live-read для confirmation показывает состояние на момент фактической отправки, а reminder проходит строгую проверку актуальности. Неизвестная `payloadVersion` является постоянной ошибкой job; молча интерпретировать её как текущую нельзя.

Тексты формируются как простой UTF-8 text без `parse_mode`. Пользовательские строки нормализуются: управляющие символы, кроме безопасных переносов, удаляются; длины ограничиваются доменными пределами и общим внутренним пределом сообщения. HTML/Markdown-экранирование поэтому не требуется.

## 14. Детерминированная дедупликация

Префикс `v1` относится к формату dedupe key, а `v{n}` — к версии Appointment после события. Начальная версия новой записи — `0`.

| Логическое сообщение            | `dedupeKey`                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Новая запись администратору     | `admin-appointment-created:v1:{appointmentId}:v{version}:c{adminConnectionId}`                                      |
| Подключение клиента             | `client-connection-confirmed:v1:{appointmentId}:c{appointmentConnectionId}`                                         |
| Подключение администратора      | `admin-connection-confirmed:v1:{adminUserId}:c{adminConnectionId}`                                                  |
| Отмена администратору           | `admin-appointment-cancelled:v1:{appointmentId}:v{newVersion}:c{adminConnectionId}`                                 |
| Административная отмена клиенту | `client-appointment-cancelled:v1:{appointmentId}:v{newVersion}:c{appointmentConnectionId}`                          |
| Изменение визита клиенту        | `client-appointment-changed:v1:{appointmentId}:v{newVersion}:c{appointmentConnectionId}`                            |
| Напоминание                     | `client-appointment-reminder:v1:{appointmentId}:v{visitVersion}:at{reminderEpochMillis}:c{appointmentConnectionId}` |
| Нейтральный отказ на update     | `telegram-connection-rejected:v1:u{updateId}`                                                                       |

Тип, версия бизнес-события и connection identity являются частью ключа; идентификатор попытки и случайный job ID — нет. Поэтому retry использует ту же строку, replay producer упирается в UNIQUE, а новый администратор или новое добровольное подключение не получает сообщения, созданные для прежней связи.

## 15. Состояния outbox и claim

Состояния:

- `PENDING` — ожидает `nextAttemptAt`;
- `PROCESSING` — принадлежит действующей lease;
- `SENT` — Telegram подтвердил успешный `sendMessage`;
- `DEAD` — постоянная ошибка либо исчерпано шесть попыток;
- `CANCELLED` — producer отменил ещё не начатую job как неактуальную;
- `SKIPPED` — worker при preflight обнаружил неактуальность/истечение либо прекратил retry уже инвалидированной PROCESSING job.

Старый `FAILED` заменяется на однозначно terminal `DEAD`; отдельного промежуточного FAILED нет.

### 15.1. Атомарный claim

Каждый dispatcher может обрабатывать очередь, лидерство polling для этого не требуется. Короткая транзакция использует CTE:

1. выбирает до 20 due-строк `PENDING` с `nextAttemptAt <= now()` в порядке `nextAttemptAt, id`;
2. применяет `FOR UPDATE SKIP LOCKED`;
3. одним `UPDATE ... RETURNING` ставит `PROCESSING`, увеличивает `attempts`, записывает новый `leaseToken`, `leaseOwner`, `claimedAt` и `leaseExpiresAt = now() + 60 секунд`;
4. commit выполняется до чтения Appointment и до HTTP.

Batch дополнительно ограничен фактически свободными слотами dispatcher: процесс не claim-ит работу, которую не успеет начать в пределах lease. Так два процесса не claim одну строку, а медленная сеть не держит транзакцию и row locks. Финализация использует fencing-условие `WHERE status = 'PROCESSING' AND lease_token = :token`: просроченный процесс не может переписать результат новой lease.

### 15.2. Восстановление lease

Отдельный короткий запрос с `FOR UPDATE SKIP LOCKED` находит `PROCESSING` с истёкшей lease. Такая попытка считается `DELIVERY_OUTCOME_UNKNOWN`, потому что процесс мог упасть после фактической отправки:

- если job ещё актуальна, не истекла и `attempts < 6`, она возвращается в `PENDING` с retry backoff;
- если она инвалидирована или истекла, получает `SKIPPED`;
- если попытки исчерпаны, получает `DEAD`.

Lease не продлевается бесконечно. Таймаут одного HTTP-вызова короче lease; heartbeat lease не нужен для MVP.

### 15.3. Preflight и завершение

После claim worker заново читает immutable connection и нужное бизнес-состояние. Невалидная job завершается `SKIPPED` до HTTP. После результата:

- подтверждённый успех всегда становится `SENT` и получает `sentAt/finishedAt`;
- временная ошибка возвращает актуальную job в `PENDING` с новым `nextAttemptAt`;
- постоянная ошибка или шестая неуспешная попытка даёт `DEAD`;
- инвалидированная во время попытки job больше не повторяется: при подтверждённом успехе остаётся `SENT`, иначе становится `SKIPPED`.

`CANCELLED` применяется producer к PENDING job. Для уже PROCESSING строки producer ставит `invalidatedAt/invalidationCode`; это не похищает lease и позволяет sender корректно завершить уже начатый вызов.

`SKIPPED` означает «дальнейшей отправки не будет», но не является доказательством отсутствия доставки: если invalidation победила после начала HTTP, а ответ был потерян, Telegram мог принять сообщение. Этот редкий случай остаётся частью явно принятой at-least-once семантики.

Producer allowlist для `invalidationCode`: `APPOINTMENT_CANCELLED`, `APPOINTMENT_COMPLETED`, `APPOINTMENT_NO_SHOW`, `VISIT_CHANGED`, `CONNECTION_DISABLED`, `ADMIN_USER_DEACTIVATED`, `BOT_REPLACED`. Для PENDING он одновременно ставит `CANCELLED`, `invalidatedAt`, код и `finishedAt`; для PROCESSING — только invalidation-пару. Worker-side `SKIPPED` использует безопасные финальные коды `REMINDER_EXPIRED`, `CONNECTION_INACTIVE`, `APPOINTMENT_NOT_SCHEDULED` или `VISIT_MISMATCH` в `lastErrorCode` и очищает lease. Успешный retry очищает `lastErrorCode`.

## 16. Доставка, ошибки и retry

Выбрана семантика **at-least-once** с редкой возможностью дубликата. Если процесс потерял ответ после фактической отправки, автоматический retry предпочтён потере важного уведомления. Ни Bot API, ни наша БД не дают общей транзакции, поэтому exactly-once delivery не заявляется.

Максимум — шесть delivery claims одной job. `attempts` увеличивается атомарно при claim до preflight/HTTP, поэтому crash до сети также консервативно расходует попытку. Для обычной временной ошибки задержка равна `min(30 секунд × 2^(attempts - 1), 15 минут) × random(0.5, 1.0)`. Напоминание никогда не планируется после собственного `expiresAt`.

Для HTTP 429 положительный целый `retry_after <= 86 400` секунд имеет приоритет над exponential backoff: `nextAttemptAt = now + retry_after + jitter 0..1 секунда`. Отсутствующее или невалидное значение использует обычный backoff с кодом `TELEGRAM_RATE_LIMIT`. Значение больше суток не сокращается искусственно и завершает автоматические попытки как `DEAD`; оператор может исследовать причину. Шестая попытка и более ранний deadline по-прежнему terminal.

| Класс                                                       | Безопасный код                                       | Действие                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Сеть до подтверждённого ответа                              | `NETWORK_UNREACHABLE` или `DELIVERY_OUTCOME_UNKNOWN` | Retry; после начала отправки классифицировать консервативно как unknown с риском дубля.                         |
| HTTP 429                                                    | `TELEGRAM_RATE_LIMIT`                                | Retry по валидному `retry_after`; без busy loop.                                                                |
| Telegram 5xx                                                | `TELEGRAM_5XX`                                       | Exponential backoff с jitter.                                                                                   |
| Неверный метод/payload и прочие постоянные 4xx              | `INVALID_REQUEST`                                    | `DEAD`; связь не отключать автоматически.                                                                       |
| Chat не существует                                          | `CHAT_NOT_FOUND`                                     | `DEAD`; для connection-recipient атомарно отключить именно эту связь и инвалидировать её очередь.               |
| Пользователь заблокировал бота / писать запрещено           | `BOT_BLOCKED` или `CHAT_WRITE_FORBIDDEN`             | `DEAD`; отключить connection-recipient, direct-chat job только завершить.                                       |
| Telegram-пользователь деактивирован                         | `TELEGRAM_USER_DEACTIVATED`                          | `DEAD`; отключить connection-recipient, direct-chat job только завершить.                                       |
| Неверный bot token или identity                             | `CONFIG_UNAUTHORIZED` или `BOT_IDENTITY_MISMATCH`    | Открыть глобальный circuit, остановить polling/dispatch, не отключать связи и не сжигать очередь.               |
| Активный webhook                                            | `WEBHOOK_ACTIVE`                                     | Polling paused до явного операторского перехода; dispatcher можно запускать только при подтверждённой identity. |
| Невалидный/слишком большой ответ                            | `RESPONSE_INVALID` или `RESPONSE_TOO_LARGE`          | Для `sendMessage` считать outcome unknown и retry; для read-методов — временная ошибка polling.                 |
| Неизвестная версия payload                                  | `PAYLOAD_VERSION_UNSUPPORTED`                        | `DEAD`; требуется совместимый deploy/оператор.                                                                  |
| Отменённое состояние, отозванная связь, позднее напоминание | allowlist-код причины                                | `SKIPPED`, без HTTP.                                                                                            |

Поскольку текстовое `description` Telegram не является стабильным контрактом, адаптер сопоставляет только заранее протестированные комбинации HTTP/error fields с нормализованными кодами и отбрасывает исходный текст. Неизвестный chat-specific 403 безопасно относится к `CHAT_WRITE_FORBIDDEN`; неизвестный прочий 4xx не должен отключать связь.

`lastErrorCode` хранит только код из allowlist. В БД и логах запрещены полный ответ Telegram, URL запроса, bot token, payload сообщения, raw deep-link token, chat/user id, телефон и персональные строки. Подтверждённая конфигурационная ошибка, при которой Telegram доказанно не принял сообщение, возвращает текущую job в `PENDING`, очищает lease, компенсирует сделанный claim уменьшением `attempts` на один, ставит `nextAttemptAt` не раньше чем через пять минут и открывает circuit до следующей успешной проверки `getMe`. Identity/webhook ошибки обнаруживаются до claim. Пока circuit открыт, новые jobs не claim-ятся; network/invalid-response не получают refund, потому что их outcome неизвестен. Так постоянная конфигурационная проблема не исчерпывает очередь в crash loop.

`DEAD` автоматически не переоткрывается и не правится ручным SQL. После устранения причины оператор видит безопасный код и связывается с получателем иным способом; отдельный аудируемый resend может быть добавлен только новым продуктовым решением.

## 17. Напоминания

### 17.1. Создание

Due time равен ровно `startsAt - 2 часа`. Job создаётся только если одновременно:

- Appointment в `SCHEDULED`;
- есть активная `AppointmentTelegramConnection`;
- `startsAt - now` строго больше двух часов.

При создании Appointment клиентской связи ещё нет, поэтому клиент получает только веб-подтверждение. При последующем `/start` reminder создаётся в транзакции подключения, если условие времени ещё выполняется. Подключение ровно за два часа или позже reminder не создаёт.

`expiresAt` напоминания равен `scheduledAt + 15 минут`. Это осознанное окно допустимой задержки: после долгого простоя важнее не отправить устаревшее «за два часа», чем догонять очередь. Retry, рассчитанный позже deadline, заменяется на `SKIPPED`.

### 17.2. Перенос и терминальные состояния

Любой перенос либо смена услуги/мастера/даты/времени инвалидирует прежнюю job. Для нового состояния:

- начало дальше чем через два часа — создаётся новая job;
- начало ближе или ровно через два часа — новой job нет;
- перенос на более позднее время снова создаёт job при выполнении порога.

Отмена, `COMPLETED`, `NO_SHOW` и отключение связи инвалидируют ожидающее напоминание. Исправление имени/телефона его не трогает, хотя существующий optimistic-lock `Appointment.version` при этом меняется.

### 17.3. Обязательный preflight

Непосредственно перед `sendMessage` worker проверяет:

- connection существует, активна и совпадает с connection identity job;
- Appointment существует и всё ещё `SCHEDULED`;
- `startsAt`, service/master и длительность совпадают с visit snapshot job;
- `scheduledAt = startsAt - 2 часа`;
- `invalidatedAt IS NULL`;
- текущее время не позже `expiresAt` и раньше `startsAt`.

`visitVersion` в dedupe key — версия Appointment, на которой создано конкретное состояние визита, но preflight не требует равенства общей текущей `Appointment.version`: исправление контактов законно увеличивает её без изменения визита. Защиту дают snapshot полей плюс обязательная транзакционная invalidation при переносе. Если визит был перенесён и затем возвращён к тем же параметрам, старая job всё равно остаётся invalidated, а новая отличается версией события.

Остановленный worker после восстановления обрабатывает только reminder в пределах 15-минутного окна. Более поздние jobs становятся `SKIPPED`; одна лишь запись `PENDING` никогда не является разрешением отправлять.

## 18. Конкурентность и порядок блокировок

| Гонка                                         | Решение                                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Два poller пытаются читать updates            | Единственная основная гарантия — session-level advisory lock на dedicated PostgreSQL connection; только владелец lock вызывает `getUpdates`.                                                              |
| Второй poller работает без лидерского lock    | Это неподдерживаемый режим: ответ non-leader отбрасывается. Потеря lock или изменение singleton относительно ожидаемого текущим лидером состояния останавливает batch; числовой gap сам по себе допустим. |
| Два dispatcher claim job                      | `FOR UPDATE SKIP LOCKED`, атомарный UPDATE и fencing lease token.                                                                                                                                         |
| Повтор одного update                          | Offset, UNIQUE `sourceUpdateId` и dedupe key; все локальные эффекты с offset в одной транзакции.                                                                                                          |
| Два нажатия Start                             | Первый update потребляет токен; повтор из того же chat идемпотентен и не создаёт вторую confirmation job.                                                                                                 |
| Одна Appointment и две разные ссылки/chats    | Перевыпуск отзывает старый токен; блокировка цели и частичный UNIQUE активной связи дают одного победителя. Другому chat возвращается нейтральный отказ.                                                  |
| Один chat открывает ссылки разных Appointment | Разрешено: каждая связь относится только к своей Appointment.                                                                                                                                             |
| Отмена или перенос против reminder claim      | Producer пишет invalidation и состояние Appointment транзакционно; sender проверяет оба после claim и ещё раз перед HTTP.                                                                                 |
| Отзыв связи во время отправки                 | Sender проверяет connection; инвалидизация прекращает retry, но уже начатый HTTP нельзя отменить надёжно.                                                                                                 |
| Retry после 429                               | Та же строка и dedupe key, единственный `nextAttemptAt`; новый claim только после due.                                                                                                                    |
| Падение до HTTP                               | Lease истекает и job повторяется; обычно без дубля.                                                                                                                                                       |
| Падение после HTTP или потеря ответа          | Lease recovery повторяет job; редкий дубль является принятой ценой at-least-once.                                                                                                                         |

Есть неизбежное узкое окно между последней DB-проверкой и приёмом HTTP-запроса Telegram. Если отмена/перенос/отзыв произошли уже после начала отправки, сообщение может дойти. Удерживать Appointment lock или бизнес-транзакцию во время сети нельзя; exactly-once и абсолютную отмену уже начатого внешнего вызова система не обещает.

### 18.1. Единый порядок блокировок

Существующий порядок административных транзакций сохраняется: business advisory lock → `BusinessSettings FOR SHARE` → `Appointment FOR UPDATE` → status/history/business update → outbox inserts/invalidation. Outbox добавляется после изменения Appointment.

Для выпуска ссылки: Appointment либо AdminUser → активные link tokens. Для потребления `/start` выполняется неблокирующее первичное чтение token hash, затем `TelegramBotState FOR UPDATE` → целевая Appointment/AdminUser `FOR UPDATE` → тот же token `FOR UPDATE` с полной повторной проверкой → connection → outbox → offset.

Sender никогда не держит outbox lock, пока ждёт Appointment/connection: claim-транзакция уже завершена. Финализация блокирует только job по lease token. Отключение после постоянной ошибки блокирует connection, затем относящиеся к ней jobs. Эти порядки должны быть общими helper-ами и проверяться concurrency-тестами.

## 19. Малый Telegram API adapter

Новый SDK и npm-зависимости не нужны. Поверх встроенного `fetch` проект получает узкий порт:

```ts
type TelegramCallOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

interface TelegramBotApi {
  getMe(options?: TelegramCallOptions): Promise<TelegramBotIdentity>;
  getWebhookInfo(options?: TelegramCallOptions): Promise<TelegramWebhookInfo>;
  deleteWebhook(input: { dropPendingUpdates: false }, options?: TelegramCallOptions): Promise<void>;
  getUpdates(
    input: {
      offset: bigint;
      limit: number;
      timeoutSeconds: number;
      allowedUpdates: readonly ["message"];
    },
    options?: TelegramCallOptions,
  ): Promise<readonly TelegramUpdate[]>;
  sendMessage(
    input: { chatId: bigint; text: string },
    options?: TelegramCallOptions,
  ): Promise<{ messageId: bigint }>;
}

interface TelegramTransport {
  request(input: TelegramTransportRequest): Promise<TelegramTransportResponse>;
}
```

Production transport использует фиксированный HTTPS-origin Bot API, POST JSON и `redirect: "error"`. Base URL не принимается из пользовательского ввода и не становится production env. Token подставляется только внутри transport; итоговый URL и исходные ошибки `fetch` никогда не выходят из адаптера.

### 19.1. Таймауты и разбор

- Каждый метод объединяет переданный `AbortSignal` с внутренним timeout.
- Для `getUpdates` timeout HTTP равен long-poll timeout плюс 5 секунд; для остальных операций — 10 секунд.
- Ответ сначала ограничивается по `Content-Length`, затем по реально прочитанным байтам: 4 MiB для batch updates и 256 KiB для прочих методов.
- Проверяются UTF-8/JSON, top-level `ok`, ожидаемое `result` и только используемые поля. Неизвестные поля игнорируются; отсутствие или неверный тип обязательного поля отклоняется.
- Числовые Telegram identifiers принимаются только как неотрицательные safe integers и на границе преобразуются в `bigint`; при отправке обратно выполняется обратная проверка safe range.
- Неуспешный ответ разбирается в нормализованный тип ошибки. `description` и тело ответа после классификации уничтожаются, а не логируются.

`sendMessage` принимает текст длиной до внутреннего лимита 2000 символов, что оставляет запас относительно лимита Bot API 4096. `parse_mode` намеренно отсутствует: простой текст уменьшает поверхность ошибок и не требует доверять пользовательской строке как разметке.

Для тестов внедряется `FakeTelegramTransport`: он возвращает заранее заданные bounded responses, записывает вызовы без bot token и умеет моделировать timeout, reset, 429, 5xx, malformed JSON, oversized body и потерю ответа. Ни один тест не меняет production origin и не обращается к сети.

## 20. Polling loop

Poller работает в существующем отдельном worker-процессе на выделенном PostgreSQL connection. Session lock берётся реальным `pg.PoolClient` из уже установленного `pg`, а не последовательными Prisma raw queries, для которых pool не гарантирует одну сессию. Connection освобождается в `finally`; его `error/end` abort-ит текущий long poll. Session-level advisory lock — единственная основная гарантия последовательного polling; параллельная обработка двумя poller не является поддерживаемым или безопасным режимом.

1. При неполной конфигурации записывает один безопасный диагностический код, остаётся idle и периодически проверяет конфигурацию без crash loop.
2. Пытается взять session advisory lock `(526008, 61)`. Не-лидер продолжает outbox dispatch, но не вызывает `getUpdates` и не обрабатывает случайно полученный polling response.
3. Лидер выполняет `getMe`, сверяет user id/username с сохранённой identity и вызывает `getWebhookInfo`.
4. При непустом webhook URL ставит `WEBHOOK_ACTIVE` и не poll. Автоматический `deleteWebhook` на каждом старте запрещён.
5. Из singleton читает `nextUpdateId`, запоминает его как `requestedOffset` и вызывает `getUpdates(offset=requestedOffset, limit=100, timeout=30, allowed_updates=["message"])`.
6. После ответа и до любых эффектов лидер на том же dedicated `pg.PoolClient` повторно подтверждает, что connection жив и эта PostgreSQL session всё ещё владеет lock `(526008, 61)`. При потере connection/lock response отбрасывается и batch останавливается.
7. Updates сортируются по возрастанию `update_id` и обрабатываются строго по одному. Локальное `expectedStoredOffset` сначала равно `requestedOffset`, а после каждого собственного успешного commit — фактически записанному значению.
8. Перед эффектами очередного update транзакция блокирует singleton и требует `TelegramBotState.nextUpdateId === expectedStoredOffset`. Если сохранённое значение изменил другой процесс относительно состояния, ожидаемого текущим лидером, batch останавливается с `POLL_OFFSET_CONFLICT` без эффектов этого и следующих updates.
9. Если `update_id < TelegramBotState.nextUpdateId`, это уже обработанный повтор: он не создаёт связь или jobs, не потребляет токен и не меняет offset.
10. Если `update_id >= TelegramBotState.nextUpdateId`, update допустим. Равенство соседнему числу не требуется: `allowed_updates=["message"]` может скрывать другие типы, а Telegram не гарантирует вечную непрерывность идентификаторов. Числовой gap сам по себе не является `POLL_OFFSET_CONFLICT`.
11. Для принятого update, включая неизвестную команду или тип, эффекты и `nextUpdateId = update_id + 1` коммитятся одной транзакцией; локальный `expectedStoredOffset` обновляется только после commit. После batch сразу выполняется следующий long poll; сетевые ошибки read-loop получают отдельный exponential backoff 1–30 секунд с jitter.

Один update подтверждается Telegram только следующим запросом с большим offset. Сохранение offset вместе с локальными эффектами предотвращает их повтор после рестарта при соблюдении лидерского протокола. Проверка `update_id < nextUpdateId` превращает уже подтверждённый повтор в no-op, но не делает безопасной параллельную обработку разных updates. Если лидерство нарушено, второй poller обязан остановиться; stale leader обнаруживается по потере своего session connection/lock либо по изменению сохранённого offset относительно `expectedStoredOffset`, а не по отсутствию соседнего `update_id`.

Конфликтный ответ polling не вызывает tight retry: worker ставит `POLLING_CONFLICT`, повторяет `getWebhookInfo` и возвращается к backoff. Так гонка с внешней установкой webhook или ошибочно запущенным вторым poller диагностируется без автоматического удаления чужой конфигурации.

Явный переход с webhook выполняется отдельной операторской командой через `deleteWebhook({ dropPendingUpdates: false })`, после чего заново проверяется `getWebhookInfo`. В MVP web endpoint и автоматическое переключение режимов не создаются.

Telegram хранит updates не более 24 часов, поэтому простой poller дольше суток может дать невосстановимый gap. Метрика stale polling должна предупредить намного раньше; после восстановления пользователь создаёт новую ссылку и повторяет Start. Система не делает вид, что способна восстановить уже удалённый Telegram update.

## 21. Конфигурация и деградация

| Переменная                      | Где доступна                | Обязательность                        | Безопасный пример           |
| ------------------------------- | --------------------------- | ------------------------------------- | --------------------------- |
| `TELEGRAM_BOT_TOKEN`            | Только worker/server secret | Для включения интеграции              | `replace-with-bot-token`    |
| `TELEGRAM_BOT_USERNAME`         | Web и worker                | Для показа deep link и identity check | `replace_with_bot_username` |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | Worker                      | Необязательна; default 30, range 5–50 | `30`                        |

Lease 60 секунд, batch 20, max attempts 6, backoff cap 15 минут, token TTL 30 минут, reminder grace 15 минут и rate limits являются проверяемыми кодовыми policy-константами, а не набором env knobs. Менять их следует осознанным изменением кода/документации.

`.env.example` в будущем получает только placeholders. Настоящий token не попадает в Git, Prisma, URL приложения, browser bundle, документацию, telemetry, исключения или логи. Web знает только username и readiness из безопасного server-side состояния.

Если обе переменные отсутствуют, Telegram считается выключенным. Если задана только одна, identity не совпадает, активен webhook либо polling stale:

- web-приложение, создание, перенос и отмена записей продолжают работать;
- интерфейс не показывает кнопку подключения и не выпускает link token;
- worker остаётся живым, не poll и не claim отправки при недоказанной identity;
- пишется rate-limited структурированная диагностика с безопасным кодом, без секрета.

Producer продолжает транзакционно сохранять административные события только для уже существующих активных connections; они останутся в очереди до восстановления конфигурации. Отсутствие активных получателей означает отсутствие jobs, а не ошибку бронирования.

### 21.1. Rotation и замена бота

Новый token того же бота безопасен: `getMe.id` совпадает, offset и connections сохраняются. Смена username того же bot id требует одновременно обновить `TELEGRAM_BOT_USERNAME`, повторно пройти readiness и отозвать неиспользованные deep-link tokens; активные connections остаются.

Другой `getMe.id` никогда не принимается автоматически. Будущая явная операторская команда должна при остановленном poller проверить нового бота и одной DB-транзакцией:

1. отключить все прежние connections с `BOT_REPLACED`;
2. отозвать link tokens и инвалидировать неотправленные jobs старой identity;
3. заменить сохранённые bot id/username;
4. сбросить `nextUpdateId` в `0` и readiness timestamps.

После этого клиентам и администраторам нужно добровольно подключиться к новому боту заново. Ручное исправление singleton без этого протокола запрещено.

## 22. Безопасность, хранение и эксплуатация

### 22.1. Границы доверия

- Клиент выпускает ссылку только с защищённой страницы конкретной Appointment; существующий cancellation token авторизует доступ, но никогда не копируется в Telegram token.
- Администратор выпускает ссылку только для самого себя в аутентифицированной админке с обычной CSRF-защитой.
- Raw link token показывается один раз в прямом `https://t.me/<bot_username>?start=<token>`; нет redirect/analytics-wrapper и сервер не пишет URL в access log.
- Приём разрешён только из private chat и только по точному `/start <token>`. Телефон, contact-sharing, username и display name Telegram не используются как identity.
- Ошибка токена формулируется одинаково для expired, revoked, already-linked-to-other-chat и unknown, чтобы не раскрывать существование записи или администратора.
- Выпуск link ограничивается по цели и аутентифицированному контексту; повторный выпуск отзывает предыдущий token. Глобальный abuse-limit добавляется на server boundary без передачи raw token в key/log.

### 22.2. Минимизация данных и логов

Telegram user/chat id — персональные внешние идентификаторы: durable значения хранятся в connection-таблицах; единственное исключение — `directChatId` короткоживущей `TELEGRAM_CONNECTION_REJECTED` job. Они не появляются в payload, логах или metrics labels. Outbox payload не содержит клиентские контакты и секреты. Сообщения не содержат телефон; диагностические события содержат только job id, тип, номер попытки, latency и allowlist error code.

При исключении transport создаёт новый безопасный error object без `cause.message`, request URL, headers и body. Bot token нельзя передавать библиотечному logger даже в redacted поле: первичная гарантия — значение туда не попадает.

### 22.3. Ограничение отправки

Rate gate должен быть общим для нескольких worker, а не process-local. Он использует session advisory locks на отдельных `pg` connections вне бизнес-транзакций:

1. sender берёт lock для domain-separated 64-bit hash пары bot/chat;
2. затем берёт общий lock `(526008, 62)`;
3. непосредственно перед запуском `sendMessage` фиксирует монотонное время старта, всё ещё удерживая общий lock;
4. запускает HTTP и удерживает общий lock до момента не раньше чем через 40 мс от зафиксированного старта, даже если HTTP завершился быстрее; только затем освобождает общий lock;
5. chat lock удерживается до завершения вызова и не менее секунды от его старта.

Пока общий lock не освобождён, следующий worker физически не может начать запрос, поэтому старты разделены интервалом не менее 40 мс: не более 25 стартов/с на бота. Chat lock сохраняет предел одного вызова/с на chat даже при нескольких процессах. Коллизия 64-bit hash может только лишний раз сериализовать разные chats, но не смешивает адресатов. При падении процесса session locks освобождаются PostgreSQL; небольшой восстановительный burst дополнительно защищён обработкой 429. Ни бизнес-, ни любая другая SQL-транзакция во время HTTP не удерживается: dedicated connections используются только для session advisory locks.

Все продуктовые связи — private chats; group routing в MVP запрещён. Платные broadcasts не используются.

### 22.4. Retention и cleanup

Cleanup выполняется небольшими повторяемыми batch:

- terminal/expired/revoked link-token rows — через 30 дней;
- terminal `TELEGRAM_CONNECTION_REJECTED` rows с `directChatId` — не позднее 24 часов;
- terminal outbox rows — через 90 дней;
- disabled connections — не раньше 90 дней и только после удаления ссылающихся outbox rows;
- клиентская connection для terminal либо давно прошедшей Appointment — не раньше 90 дней после конца визита/статуса и только после удаления ссылающихся outbox rows;
- активные административные connections и singleton bot state — пока нужны продукту.

`ON DELETE RESTRICT` не допускает потерю адресной истории раньше outbox. История самой Appointment и её статусов остаётся источником бизнес-аудита; outbox не превращается в бессрочную event-bus платформу.

### 22.5. Наблюдаемость и runbook

Без персональных labels нужны:

- readiness polling/dispatch и возраст `lastPollAt`;
- количество PENDING/PROCESSING/DEAD по notification type;
- возраст старейшей due job, число expired leases и skipped reminders;
- send success/retry/rate-limit counters и latency;
- безопасный последний global error code.

Первичные сигналы: polling старше двух минут, due queue старше пяти минут, expired lease или новый DEAD. Runbook проверяет наличие обеих переменных, `getMe`, совпадение username/identity, `getWebhookInfo`, доступность PostgreSQL и безопасные коды outbox. Он никогда не предлагает печатать token или полный Telegram response.

## 23. Тестовая стратегия

Ни один тест не использует реальный bot token и не обращается к `api.telegram.org`.

### 23.1. Unit

- генерация 32 random bytes, base64url без padding, префиксы `c_`/`a_`, длина 45, purpose-separated hash и границы TTL;
- одноразовость, revoked/expired/used cases и одинаковый нейтральный ответ;
- runtime-схемы каждого payload version, запрет лишних/секретных полей и лимит 16 KiB;
- все dedupe keys, различие business versions/connections и стабильность replay;
- backoff с внедрёнными clock/RNG, max attempts, jitter, `retry_after` и deadline;
- классификатор Telegram errors, bounded JSON parser, safe-integer checks, abort/timeout и sanitizer plain text;
- readiness при missing/partial config, username mismatch, webhook active и stale poll.

### 23.2. PostgreSQL integration

- успешная бизнес-транзакция сохраняет Appointment/history/outbox вместе; искусственный rollback не оставляет ни одного из эффектов;
- public/admin create fan-out, idempotency replay и UNIQUE dedupe;
- client/admin cancellation, reschedule и contact-only edit проверяют точную матрицу;
- два реальных DB connection доказывают `FOR UPDATE SKIP LOCKED`: одну job получает один worker, разные jobs могут обрабатываться параллельно;
- lease expiry, fencing stale owner, attempts/exhaustion и восстановление PROCESSING;
- все check/partial unique/FK constraints и SQL-preflight ранних таблиц;
- update effects и `nextUpdateId` commit/rollback как одна транзакция;
- batch с несмежными `update_id` сортируется и обрабатывается по возрастанию, а после каждого принятого update сохраняется его `update_id + 1`;
- gap из-за `allowed_updates` не вызывает `POLL_OFFSET_CONFLICT`;
- изменение singleton относительно `expectedStoredOffset` либо потеря лидерского session lock останавливают batch без дальнейших offset/jobs;
- два dispatcher на разных chats начинают fake HTTP с интервалом не меньше 40 мс, а на одном chat — не чаще раза в секунду; во время ожидания и HTTP нет открытой SQL-транзакции.

### 23.3. Гонки

- два Start одного токена из одного и разных chats;
- старый и новый токены одной цели;
- две разные Appointment в одном chat;
- admin reconnect/disable одновременно с delivery;
- отмена и перенос на барьерах до claim, после claim до preflight и во время fake HTTP;
- reschedule туда-обратно, contact version bump и reminder;
- второй poller без advisory lock не вызывает `getUpdates`; искусственно переданный ему response отбрасывается;
- stale leader выявляется по изменению сохранённого состояния или потере lock, а не по отсутствию соседнего `update_id`; тест не трактует offset как поддержку двух poller;
- crash до fake HTTP, после зафиксированной отправки и до `SENT`.

### 23.4. Worker и fake HTTP

Внедряемый fake transport/server моделирует `getMe`, webhook info, batches updates, success, 400/401/403/429/5xx, malformed/oversized response, timeout и lost response. Проверяются последовательность offset, явный `deleteWebhook(false)`, отсутствие busy loop и то, что fake никогда не получает вызов при disabled Telegram.

### 23.5. E2E и безопасность

- защищённая клиентская страница выпускает link только для своей Appointment и скрывает кнопку при неготовом Telegram;
- администратор выпускает/отзывает собственную одноразовую ссылку;
- имитация Telegram update подключает нужную цель, создаёт confirmation/reminder jobs и возвращает актуальные данные через fake;
- отмена/перенос отражаются ровно в ожидаемых jobs;
- worker без token, с partial config и с активным webhook остаётся жив;
- spy logger, error objects, metrics и repository scan не содержат raw token, bot token, phone, chat id или payload message; chat id и текст допускаются только в ожидаемом in-memory outbound request fake transport и в предназначенных DB-колонках, а такие fixtures не коммитятся.

## 24. Разбиение реализации

### 06.2 — данные, адаптер и ядро outbox

- заменить ранние модели/enum по migration preflight;
- добавить runtime payload schemas, token/hash/dedupe helpers и policy constants;
- реализовать малый typed adapter и fake transport без реальной сети;
- реализовать repository claim/lease/fencing/recovery и state transitions без Telegram dispatcher;
- покрыть constraints, rollback, SKIP LOCKED, payload, retry и secret-safety unit/integration tests;
- документировать migration/runbook skeleton.

Критерий блока: схема и outbox primitives доказаны на PostgreSQL; ни одна бизнес-операция пока не обязана отправлять Telegram.

### 06.3 — polling и подключения

- добавить конфигурацию/readiness и leader long polling в существующий worker;
- реализовать транзакционную обработку offset и `/start`;
- добавить выпуск/отзыв клиентской ссылки и отключение active connection на защищённой странице Appointment;
- добавить выпуск/отключение собственной admin link в аутентифицированной админке;
- создавать confirmation и допустимый reminder при подключении;
- закрыть token, replay, race, webhook-active и simulated-update E2E tests.

Критерий блока: обе роли безопасно подключаются через fake Telegram update; jobs созданы, raw tokens не сохраняются.

### 06.4 — бизнес-события и напоминания

- встроить producers в существующие create/cancel/status/reschedule transactions;
- реализовать admin fan-out, snapshot payloads и точные dedupe keys;
- реализовать invalidation старого reminder и создание нового по строгому правилу двух часов;
- оставить contact-only, COMPLETED и NO_SHOW без сообщений;
- покрыть rollback/idempotency и все гонки отмены/переноса/reminder.

Критерий блока: матрица событий полностью отражается в outbox атомарно, но внешняя сеть всё ещё заменяется fake.

### 06.5 — отправка и эксплуатационная готовность

- подключить dispatcher `sendMessage`, limiter, preflight, retry/429, lease recovery и disable-on-permanent-chat-error;
- добавить cleanup, metrics, health/readiness и операторский webhook-transition command;
- выполнить полный набор unit/integration/E2E с fake transport, degraded-mode и secret scans;
- обновить эксплуатационную документацию и только после отдельной приёмки решить статус ADR.

Критерий блока: end-to-end путь через имитацию API надёжен; реальные credentials и реальный Telegram не нужны для тестов.

## 25. Итог проектирования 06.1

Архитектурные неоднозначности, блокирующие 06.2, закрыты. [ADR-0014](decisions/0014-telegram-notifications.md) остаётся `Proposed` до реализации и отдельной приёмки. Эта задача не меняет приложение, Prisma schema, миграции, зависимости, Docker или worker и не начинает 06.2.
