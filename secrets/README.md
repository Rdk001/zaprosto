# Runtime secret files

This directory contains only this tracked instruction. Create the real files on the
production host; `.gitignore` excludes every other entry here.

```bash
install -d -m 700 secrets
openssl rand -base64 48 | tr -d '\n' > secrets/postgres_password
read -rsp 'BotFather token: ' TELEGRAM_TOKEN
printf '\n'
printf '%s' "$TELEGRAM_TOKEN" > secrets/telegram_bot_token
unset TELEGRAM_TOKEN
chmod 600 secrets/postgres_password secrets/telegram_bot_token
```

Do not paste either value into Compose YAML, `.env.production`, shell arguments,
terminal logs, tickets, chat, image layers, or Git. An empty Telegram token file is
allowed only for an isolated smoke test with Telegram intentionally disabled.
