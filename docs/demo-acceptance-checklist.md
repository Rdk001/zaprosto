# Acceptance checklist демонстрации MVP

Отмечайте пункты на отдельной временной `zaprosto_test_*`/`zaprosto_demo_073_*` БД.
Рабочую БД, чужие процессы и Docker volumes не очищать.

## Автоматическая приёмка

- [ ] `npm ci`; Node.js 24 и npm 11 подтверждены.
- [ ] `npm run format:check`, `npm run lint`, `npm run build`, затем
      `npm run typecheck` успешны.
- [ ] `npm test` и `npm run test:postgres` успешны; runner применил
      `prisma migrate deploy/status` к созданной им БД и удалил только её.
- [ ] Один Chromium-прогон критических specs успешен:

  ```powershell
  npm run test:e2e -- tests/e2e/booking.spec.ts tests/e2e/admin.spec.ts tests/e2e/admin-catalog.spec.ts tests/e2e/admin-schedule.spec.ts tests/e2e/admin-settings.spec.ts tests/e2e/admin-appointments.spec.ts tests/e2e/admin-appointment-create.spec.ts tests/e2e/admin-appointment-reschedule.spec.ts
  ```

- [ ] Матрица внутри specs покрыла 360×800, 390×844, 412×915 и 1440×900.
- [ ] `demo:seed` выполнен дважды в отдельной demo-БД: по-прежнему 3 demo-услуги и
      2 demo-мастера; существующие строки не изменены; Appointment, AdminUser и
      Telegram-данные не созданы.
- [ ] Local и production `docker compose config --quiet` с dummy/file placeholders
      успешны. Полный production `up/down` на Docker Desktop Compose 5.4.0 повторно
      не требуется: принято runtime-доказательство 07.2.
- [ ] `git diff --check` и security scan tracked/changed файлов, `.next/static` и
      `.worker-dist` не нашли real secrets, private keys, token-shaped credentials
      или Telegram Bot API URL/token.

## Ручной показ

- [ ] Клиент: конкретный мастер и «Любой мастер», контакты, подтверждение,
      защищённая отмена; все данные очевидно вымышленные.
- [ ] Администратор: вход/выход, каталог/назначения, расписание/исключения,
      настройки времени, журнал/история.
- [ ] Ручная запись блокирует слот и показывает текст + fragment-ссылку для ручной
      передачи; исправление контактов не создаёт уведомление.
- [ ] Перенос показывает «Было / Станет», требует подтверждение и поддерживает
      KEEP_CURRENT/CATALOG и SPECIFIC/ANY; статусы следуют разрешённым переходам.
- [ ] Telegram показан только как штатно disabled либо через fake/local E2E; реальных
      credentials и сетевых вызовов нет.
- [ ] Protected links не попали в query/path, логи, чат, HAR или запись экрана.

## Завершение

- [ ] Временная БД удалена по её точному имени; `zaprosto_test_*` не осталось.
- [ ] Процессы web/worker/Playwright завершены, порты 3000 и 3108 свободны.
- [ ] Не осталось созданных этой приёмкой containers/networks/volumes или файлов с
      credentials; пользовательская локальная БД и существующие volumes не менялись.
- [ ] Зафиксированы release SHA, результаты и ограничения. Commit/push выполняются
      только отдельной управляющей задачей.

Расширенная последовательность показа и восстановление после сбоев — в
[demo-runbook.md](demo-runbook.md). Mobile, production и handoff подробности не
дублируются: см. [demo-mobile-checklist.md](demo-mobile-checklist.md),
[deployment.md](deployment.md) и [customer-handoff.md](customer-handoff.md).
