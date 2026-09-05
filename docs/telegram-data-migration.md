# Миграция Telegram data layer

Документ относится только к подэтапу 06.2A и миграции
`20260904120000_telegram_transactional_outbox`. Он не включает запуск Telegram
adapter, polling, dispatcher или producers.

## Что меняется

Миграция удаляет неиспользовавшиеся ранние таблицы `telegram_links` и
`notification_outbox`, заменяет ранние `NotificationType` и
`NotificationStatus`, затем создаёт утверждённые ADR-0014 таблицы:

- `telegram_bot_state`;
- `telegram_link_tokens`;
- `appointment_telegram_connections`;
- `admin_telegram_connections`;
- новую `notification_outbox`.

Вместе с таблицами создаются enum-типы, внешние ключи `ON DELETE RESTRICT`,
именованные check constraints, уникальные и частичные индексы. Миграция создаёт
ровно одну начальную строку `telegram_bot_state(id = 1, next_update_id = 0)`.
Существующие `appointments` и `admin_users` не требуют backfill.

## Зачем нужен fail-closed preflight

По принятой базе ранние Telegram-таблицы должны быть пустыми. Их строки не имеют
однозначного безопасного преобразования в новую модель. Поэтому preflight идёт
до любого `DROP` и завершает транзакцию ошибкой, если хотя бы одна из двух
legacy-таблиц непуста. Ошибка сохраняет таблицы и строки без изменений.

Перед deploy на выбранной базе следует выполнить:

```sql
SELECT count(*) AS telegram_links_rows FROM telegram_links;
SELECT count(*) AS notification_outbox_rows FROM notification_outbox;
```

Оба результата должны быть равны нулю. Если найдено хотя бы одно значение,
отличное от нуля:

1. остановить развёртывание;
2. убедиться, что проверяется нужная установка и нужная база;
3. снять проверяемую резервную копию;
4. исследовать происхождение и смысл строк;
5. согласовать отдельный план сохранения или преобразования данных.

Нельзя обходить preflight ручным `DELETE`, `TRUNCATE`, изменением migration.sql
или отметкой миграции как применённой без анализа и резервной копии.

## Безопасное применение и проверка

Сначала проверить конфигурацию подключения и статус миграций, не выводя строку
подключения или credentials в журнал:

```powershell
rtk npm run prisma:migrate:status
```

После резервной копии, остановки несовместимых старых worker-процессов и нулевых
preflight-счётчиков:

```powershell
rtk npm run prisma:migrate:deploy
rtk npm run prisma:migrate:status
```

Проверка singleton после успешного deploy:

```sql
SELECT id, next_update_id, bot_user_id, bot_username
FROM telegram_bot_state;
```

Ожидается одна строка: `id = 1`, `next_update_id = 0`, а
`bot_user_id`/`bot_username` равны `NULL` до будущей проверки identity.
Дополнительно можно проверить наличие таблиц без чтения персональных данных:

```sql
SELECT to_regclass('telegram_bot_state');
SELECT to_regclass('telegram_link_tokens');
SELECT to_regclass('appointment_telegram_connections');
SELECT to_regclass('admin_telegram_connections');
SELECT to_regclass('notification_outbox');
```

Миграционные сценарии проекта запускаются только через отдельную случайную
`zaprosto_test_*` БД:

```powershell
rtk npm run test:postgres
```

Команды и запросы выше не содержат bot token, Telegram user/chat id или иных
рабочих credentials.
