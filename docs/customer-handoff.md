# Передача отдельной установки заказчику

Одна передача относится ровно к одному барбершопу и одному филиалу. Установка не
является SaaS и не делит БД, secrets или media с другими заказчиками. Бесплатное ПО
не означает бесплатный VPS, домен, DNS или резервное хранилище; их выбор, договор и
оплата переходят заказчику. Пакет не привязан к cloud provider.

## Что передаётся

- release SHA и immutable image tag/digest;
- `docker-compose.production.yml`, `Caddyfile` и документация;
- домен/DNS и доступ к VPS либо процедура их переноса;
- отдельный PostgreSQL backup и media archive с checksum;
- список применённых migrations и результат restore rehearsal;
- BotFather ownership бота, но не token через чат или документ;
- перечень операторов и дата последней проверки health.

Исходный `.env.production`, пароли, Telegram token, cookie, private keys и raw
database URL не включаются в обычный пакет. Они передаются отдельным согласованным
защищённым каналом либо, предпочтительно, заменяются заказчиком при приёмке.

## Чек-лист приёмки заказчиком

- [ ] Заказчик принял договор/аккаунт VPS, DNS и обязанность их оплаты/продления.
- [ ] DNS указывает на принятый host; firewall оставляет только SSH и 80/443.
- [ ] Заказчик сменил SSH keys и удалил доступы исполнителя, которые больше не нужны.
- [ ] Сгенерирован новый PostgreSQL password; старый экземпляр secret file удалён
      после успешной смены и backup.
- [ ] Заказчик принял BotFather ownership, перевыпустил token и безопасно обновил
      secret file. Старый token отозван.
- [ ] `TELEGRAM_BOT_USERNAME` сверён; при другой identity выполнены
      replace-bot → при необходимости delete-webhook → worker start.
- [ ] Заказчик создал или сбросил собственный admin password в TTY; все старые
      admin sessions отозваны.
- [ ] `PUBLIC_ORIGIN` точно равен HTTPS origin; сертификат и HTTP→HTTPS проверены.
- [ ] Web/worker healthy, migrate завершён успешно, публичный и защищённый health
      проверены без вывода секретов.
- [ ] Заказчик получил DB+media backup, checksum и самостоятельно выполнил либо
      наблюдал успешный restore rehearsal.
- [ ] Зафиксированы release SHA/image digest, график backup, место хранения и
      ответственный за обновления.
- [ ] Подтверждено: rollback image не откатывает schema автоматически.
- [ ] Подтверждено: demo seed не используется в production.

## Смена доступов

Сначала создайте и проверьте новый доступ, затем отзывайте старый, чтобы не потерять
управление. Пароль администратора меняется ролью `admin-reset`; она отзывает все
его сессии. PostgreSQL password меняется в контролируемое окно с backup: обновите
роль БД и secret file, затем пересоздайте db-dependent containers. Telegram token
ротируется в BotFather и secret file; token той же bot identity не требует
`replace-bot`, но worker нужно пересоздать.

Не отправляйте секреты в issue, email без шифрования, мессенджер, shell argv или
демонстрационную запись экрана.

## Завершение доступа исполнителя

После письменной приёмки:

1. Заказчик подтверждает доступ к host, DNS, BotFather, backups и admin account.
2. Выполняется финальный backup и restore rehearsal, фиксируются checksum и release.
3. Удаляются SSH keys, sudo/Docker access и аккаунты исполнителя.
4. Отзываются временные tokens и пароли передачи.
5. Исполнитель удаляет локальные копии персональных данных и secrets согласно
   договорённости, сохраняя только разрешённый исходный код и обезличенные записи.

## Удаление установки

Обычное `docker compose down` сохраняет данные. Полное удаление выполняется только
после отдельного подтверждения заказчика и проверки внешних DB+media backups:

```bash
docker compose --project-name EXACT_PROJECT \
  --env-file .env.production -f docker-compose.production.yml down --volumes
```

Перед командой оператор обязан сверить точный project name через
`docker compose ... ls` и список принадлежащих ему volumes. После `--volumes`
локальные PostgreSQL/media/Caddy данные не восстанавливаются без backup. Домен,
BotFather bot, VPS snapshots и внешнее backup storage удаляются отдельно только их
владельцем.
