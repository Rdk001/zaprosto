# Runbook: безопасная замена Telegram-бота

Этот runbook относится только к замене на другую bot identity. Ротация token того же
бота не требует массового отключения. Переход с webhook (`deleteWebhook`) остаётся
отдельной операторской командой и описан в
[webhook-transition runbook](telegram-webhook-transition-runbook.md).

## Перед запуском

1. Подготовьте новый token и username в защищённом окружении процесса как
   `TELEGRAM_BOT_TOKEN` и `TELEGRAM_BOT_USERNAME`. Не вставляйте token в аргументы,
   shell history, документацию или pipe.
2. Остановите все production worker-процессы. Web-процесс можно оставить работающим.
3. Убедитесь, что запускаете команду в интерактивном терминале с корректным
   `DATABASE_URL`. Команда сама доказывает остановку worker через PostgreSQL lock;
   текстового подтверждения оператора для этого недостаточно.

## Запуск

```text
npm run telegram:replace-bot
```

Команда не принимает аргументы. Она проверяет конфигурацию и `getMe` со сравнением
username без учёта регистра, но не печатает token, URL Bot API, identity или raw
response/error. Если identity уже совпадает,
результат — `NO_CHANGE`. Для другой identity команда показывает предупреждение и
требует дословно ввести `REPLACE TELEGRAM BOT`.

`WORKER_ACTIVE` означает, что хотя бы один worker всё ещё держит shared maintenance
lock. Ничего не изменено: остановите оставшийся worker и повторите команду. Не
исправляйте singleton вручную и не пытайтесь снимать advisory lock из чужой session.

Успешный `REPLACED` показывает только количества отключённых connections, отозванных
tokens и отменённых jobs. После успеха запустите worker с новой конфигурацией и
проверьте readiness по safe diagnostic codes. Клиенты и администраторы должны создать
новые ссылки и подключиться добровольно; старые связи не восстанавливаются.

## Безопасные отказы

- `CONFIG_DISABLED`, `CONFIG_INCOMPLETE`, `CONFIG_INVALID` — исправьте env без вывода
  секрета;
- `BOT_VERIFICATION_FAILED`, `BOT_USERNAME_MISMATCH` — перепроверьте BotFather/env,
  не публикуя token или Telegram response;
- `BOT_STATE_UNINITIALIZED` — это первичная настройка, а не replacement;
- `BOT_STATE_CONFLICT` — состояние изменилось между preflight и транзакцией, мутация
  откатилась; исследуйте конкурирующую операцию;
- `REPLACEMENT_STORAGE_FAILURE`, `MAINTENANCE_LOCK_FAILED`, `OPERATION_FAILED` —
  проверьте доступность PostgreSQL и миграции, не включая raw driver error в отчёт.
