import type { PrismaClient } from "../../../generated/prisma/client";
import { credentialsSchema } from "../policy";
import { hashPassword } from "./password";

export class AdminOperatorError extends Error {}
export async function createFirstAdmin(db: PrismaClient, input: unknown) {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success)
    throw new AdminOperatorError(
      "Логин: 3–64 латинских символа, цифры, точка, дефис или _. Пароль: 12–128 символов.",
    );
  const passwordHash = await hashPassword(parsed.data.password);
  return db.$transaction(async (tx) => {
    // All first-admin invocations share this lock, even when the table is empty.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(5101, 1)`;
    if (await tx.adminUser.count())
      throw new AdminOperatorError(
        "Администратор уже существует. Пароль не изменён; для восстановления используйте admin:reset.",
      );
    await tx.adminUser.create({ data: { login: parsed.data.login, passwordHash } });
  });
}
export async function resetAdminPassword(db: PrismaClient, input: unknown) {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success)
    throw new AdminOperatorError("Неверный формат логина или пароля (12–128 символов).");
  const passwordHash = await hashPassword(parsed.data.password);
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM admin_users WHERE login = ${parsed.data.login} FOR UPDATE`;
    if (!rows[0])
      throw new AdminOperatorError("Администратор не найден. Учётная запись не создана.");
    await tx.adminUser.update({
      where: { id: rows[0].id },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
    });
    await tx.$executeRaw`UPDATE admin_sessions SET revoked_at = clock_timestamp()
      WHERE admin_id = ${rows[0].id}::uuid AND revoked_at IS NULL`;
  });
}
