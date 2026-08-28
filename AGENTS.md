# Правила работы над проектом

Эти правила обязательны для всех участников и автоматизированных агентов, работающих с репозиторием.

## Продуктовые ограничения

- На старте использовать только бесплатные сервисы и бесплатные тарифы. Подключение платной подписки требует отдельного решения пользователя.
- Не менять утверждённую бизнес-логику без предварительного обсуждения.
- Не добавлять функции, роли и требования, которых нет в утверждённой документации, без согласования.

## Инженерные правила

- Не усложнять архитектуру раньше появления подтверждённой необходимости.
- Выбирать минимальное решение, которое надёжно закрывает текущий этап и не нарушает бизнес-правила.
- Значимые архитектурные решения фиксировать в `docs/decisions/`.
- Не хранить секреты и рабочие учётные данные в репозитории.
- После каждого завершённого этапа обновлять `docs/progress.md`.
- Перед завершением любой задачи проверять внесённые изменения подходящими для неё средствами и сообщать о непроверенных аспектах.

## Источник истины

Подтверждённая концепция находится в `docs/product-brief.md`, бизнес-правила — в `docs/business-rules.md`, пользовательские сценарии — в `docs/user-flows.md`. При противоречии нельзя молча выбирать одну трактовку: вопрос необходимо вынести на обсуждение.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
