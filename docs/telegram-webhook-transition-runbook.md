# Runbook: переход Telegram webhook → long polling

Команда предназначена только для явного операторского перехода уже настроенного
Telegram-бота с внешнего webhook на long polling worker-а. Она не меняет bot identity,
offset, readiness, connections, link tokens или outbox jobs.

## Перед запуском

1. Остановите все production worker-процессы. Web-процесс можно оставить работающим.
2. Передайте TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME и DATABASE_URL только через
   защищённое окружение процесса. Не помещайте token, подтверждение или параметры в
   argv, shell history либо pipe.
3. Запускайте команду только в интерактивном TTY. Команда сама доказывает остановку
   worker через PostgreSQL maintenance lock.

## Запуск

```text
npm run telegram:delete-webhook
```

Команда не принимает аргументы и piped input. Она предупреждает, что внешний webhook
будет удалён, pending Telegram updates сохранятся, а после запуска worker перейдёт к
long polling. Для продолжения нужно дословно ввести:

```text
DELETE TELEGRAM WEBHOOK
```

После подтверждения команда пытается получить exclusive maintenance lock. Если живой
worker удерживает shared guard, результат — WORKER_ACTIVE; Bot API не вызывается.

Под exclusive lock команда:

1. вызывает getMe и сверяет фактические id/username с настроенным username и
   сохранённой TelegramBotState; регистр username незначим;
2. вызывает getWebhookInfo;
3. при уже пустом webhook возвращает NO_CHANGE без deleteWebhook;
4. при активном webhook ровно один раз вызывает
   deleteWebhook({ dropPendingUpdates: false });
5. повторно вызывает getWebhookInfo и только после пустого URL возвращает
   TRANSITIONED.

Команда не очищает pending updates и не сбрасывает сохранённый polling offset.
После TRANSITIONED запустите worker: его обычный polling readiness самостоятельно
подтвердит отсутствие webhook и продолжит с сохранённого nextUpdateId. Delivery не
зависит от наличия webhook и не требует этого перехода.

## Безопасные отказы

- CONFIG_DISABLED, CONFIG_INCOMPLETE, CONFIG_INVALID — исправьте env;
- BOT_STATE_UNINITIALIZED — сначала завершите штатную инициализацию bot identity;
- BOT_USERNAME_MISMATCH, BOT_IDENTITY_MISMATCH — команда не принимает другую
  identity автоматически; проверьте env и сохранённое состояние;
- WORKER_ACTIVE — остановите оставшийся worker и повторите команду;
- MAINTENANCE_SESSION_LOST — exclusive session потеряна до подтверждённого удаления;
- TRANSITION_UNCONFIRMED — Telegram подтвердил deleteWebhook, но обязательный
  post-check был недоступен или webhook остался активным. Команда не выполняет второй
  delete автоматически: проверьте внешнюю конфигурацию и повторите весь операторский
  протокол вручную;
- остальные allowlist-коды Bot API и OPERATION_FAILED не содержат raw response,
  description, request URL, token, bot id или username.

Не исправляйте TelegramBotState и не снимайте advisory lock вручную. Команда всегда
освобождает полученную exclusive session в finally; pool и Prisma client закрываются
идемпотентно. Реальная команда не должна запускаться из тестов.
