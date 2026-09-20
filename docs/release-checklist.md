# Release checklist

- [ ] Release checkout чистый; HEAD/revision записан, image имеет immutable tag/digest.
- [ ] `format:check`, `lint`, `typecheck`, production build и
      `git diff --check` успешны.
- [ ] Local и production `docker compose config --quiet` успешны с dummy secrets.
- [ ] Production image собран; application process работает non-root (UID 1001).
- [ ] Fresh isolated smoke: db healthy, migrate exit 0, web/worker healthy, HTTPS
      health успешен, наружу опубликованы только Caddy 80/443.
- [ ] `prisma migrate status` не сообщает pending migrations.
- [ ] Writable media volume проверен от UID 1001.
- [ ] Backup и restore rehearsal выполнены на отдельной вымышленной smoke DB и
      временном media volume.
- [ ] Graceful `down` завершён; named volumes остались после обычного `down`.
- [ ] Временные containers/networks/volumes удалены по точному smoke project name.
- [ ] Demo seed и admin creation не выполнялись автоматически.
- [ ] Tracked files и built client assets просканированы: реальных secrets,
      Telegram token и credentials нет.
- [ ] Реальная Telegram сеть не использовалась; smoke token пустой/Telegram disabled.
- [ ] Deployment и customer handoff проверены; schema rollback не обещан.
- [ ] Финальная локальная приёмка 07.3 пройдена по
      [demo checklist](demo-acceptance-checklist.md); реальные Telegram credentials,
      внешний production deploy и платные сервисы в неё не входят.
