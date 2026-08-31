import { createPrismaClient } from "../src/server/db/create-prisma-client";
import {
  AdminOperatorError,
  createFirstAdmin,
  resetAdminPassword,
} from "../src/modules/auth/server/admin-operator";
import { readTerminalLine } from "./admin-terminal";

async function main() {
  const [operation, ...extra] = process.argv.slice(2);
  if (!["create", "reset"].includes(operation) || extra.length)
    throw new AdminOperatorError(
      "Используйте npm run admin:create или npm run admin:reset без аргументов.",
    );
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new AdminOperatorError("Нужен интерактивный терминал TTY; ввод из pipe запрещён.");
  const login = await readTerminalLine("Логин администратора: ", false, 64);
  if (operation === "reset")
    process.stdout.write(
      "Сброс пароля отзовёт все сессии этого администратора. Ctrl+C — отмена.\n",
    );
  let password = await readTerminalLine("Новый пароль (12–128 символов, ввод скрыт): ", true, 128);
  let confirmation = await readTerminalLine("Повторите пароль: ", true, 128);
  if (password !== confirmation)
    throw new AdminOperatorError("Пароли не совпадают. Изменений нет.");
  const db = createPrismaClient();
  try {
    if (operation === "create") await createFirstAdmin(db, { login, password });
    else await resetAdminPassword(db, { login, password });
    process.stdout.write(
      operation === "create"
        ? "Первый администратор создан.\n"
        : "Пароль обновлён, сессии отозваны. Активность аккаунта не изменена.\n",
    );
  } finally {
    password = "";
    confirmation = "";
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  // Never print driver/validation exceptions: they can contain credentials.
  process.stderr.write(
    error instanceof AdminOperatorError
      ? error.message + "\n"
      : "Операция не завершена. Проверьте терминал, подключение и миграции; секреты не выводятся.\n",
  );
  process.exitCode = 1;
});
