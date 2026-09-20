# ADR-0015: Production Compose и пакет передачи

- Статус: Accepted
- Дата: 2026-09-19

## Контекст

Этап 07.2 требует воспроизводимую self-hosted поставку одной однофилиальной
установки без платных SaaS-зависимостей, cloud-specific manifests и внешнего
автодеплоя. Локальный Compose должен остаться удобным для разработки. Production
должен закрывать TLS, migration ordering, secrets, persistent DB/media, worker
shutdown, backup и передачу заказчику.

## Решение

Добавлен отдельный `docker-compose.production.yml`: PostgreSQL 17 и application
roles находятся во внутренней сети, наружу публикуются только Caddy 80/443. Один
immutable application image выполняет one-shot `migrate`, Next.js `web`,
Telegram `worker` и явные operator CLI. Успешное завершение migration является
dependency для web/worker.

PostgreSQL password и Telegram token монтируются из локальных файлов только для чтения в
`/run/secrets`. PID 1 entrypoint читает их, формирует runtime environment дочернего процесса
без включения значений в YAML/argv/logs и пересылает SIGINT/SIGTERM. Web не получает
Telegram token/username. Application работает UID/GID 1001; заранее принадлежащий
ему `/app/storage` и named volume сохраняют media. Root init-container не нужен.

Caddy выбран как простой бесплатный open-source reverse proxy с automatic HTTPS.
Он является единственной внешней точкой входа и перезаписывает доверенный
`X-Zaprosto-Client-IP`. `PUBLIC_ORIGIN` остаётся обязательным точным HTTPS
origin. Локальный `docker-compose.yml` не меняется.

## Последствия

- Поставка переносима между Linux hosts с Docker Compose и не зависит от cloud API.
- Image больше минимального web runner, потому что содержит pinned Prisma/tsx и
  operator sources для migrations и TTY-only операций того же release.
- Secrets остаются обязанностью оператора host; read-only file mounts в single-host Compose
  защищают от Git/YAML/argv, но root на host всё равно может их прочитать.
- Backup обязан включать PostgreSQL и media. Обычный `down` сохраняет volumes.
- Rollback application image не откатывает schema; destructive schema rollback
  автоматически не выполняется.
- Одна установка по-прежнему равна одному бизнесу/филиалу. VPS/domain оплачивает и
  выбирает заказчик.
