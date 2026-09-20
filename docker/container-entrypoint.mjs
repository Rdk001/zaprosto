import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required runtime setting: ${name}`);
  return value;
}

async function readSecret(pathName) {
  const path = required(pathName);
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`Secret file is empty: ${pathName}`);
  return value;
}

async function prepareDatabaseUrl() {
  if (process.env.DATABASE_URL) return;
  const password = await readSecret("POSTGRES_PASSWORD_FILE");
  const user = encodeURIComponent(required("POSTGRES_USER"));
  const database = encodeURIComponent(required("POSTGRES_DB"));
  const host = required("POSTGRES_HOST");
  const port = process.env.POSTGRES_PORT || "5432";
  process.env.DATABASE_URL = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}?schema=public`;
}

async function prepareTelegramToken() {
  const path = process.env.TELEGRAM_BOT_TOKEN_FILE;
  if (!path) return;
  const value = (await readFile(path, "utf8")).trim();
  if (value) process.env.TELEGRAM_BOT_TOKEN = value;
  else delete process.env.TELEGRAM_BOT_TOKEN;
}

const roles = {
  web: ["node", ["server.js"]],
  worker: ["node", [".worker-dist/worker.js"]],
  migrate: ["node_modules/.bin/prisma", ["migrate", "deploy"]],
  "admin-create": ["node", ["--import", "tsx", "scripts/admin.ts", "create"]],
  "admin-reset": ["node", ["--import", "tsx", "scripts/admin.ts", "reset"]],
  "demo-seed": ["node", ["--import", "tsx", "scripts/seed-demo.ts"]],
  "telegram-replace-bot": ["node", ["--import", "tsx", "scripts/telegram-replace-bot.ts"]],
  "telegram-delete-webhook": ["node", ["--import", "tsx", "scripts/telegram-delete-webhook.ts"]],
};

const role = process.argv[2] || "web";
const command = roles[role];
if (!command || process.argv.length !== 3) {
  process.stderr.write("Unsupported container role.\n");
  process.exit(64);
}

try {
  await prepareDatabaseUrl();
  if (role === "worker" || role.startsWith("telegram-")) await prepareTelegramToken();
} catch {
  process.stderr.write("Container runtime configuration is incomplete.\n");
  process.exit(78);
}

const child = spawn(command[0], command[1], {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", () => {
  process.stderr.write("Container role failed to start.\n");
  process.exitCode = 1;
});

const result = await new Promise((resolve) =>
  child.once("exit", (code, signal) => resolve({ code, signal })),
);
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.code ?? 1);
