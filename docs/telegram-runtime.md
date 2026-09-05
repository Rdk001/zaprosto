# Telegram runtime primitives и Bot API adapter

Документ описывает изолированный runtime-слой подэтапа 06.2B. Он не выпускает ссылки,
не пишет в PostgreSQL, не меняет `NotificationOutbox`, не запускает polling/dispatcher и
не подключён к worker.

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
