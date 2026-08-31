import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { getActiveAdmin } from "../../modules/auth/server/auth-service";
import {
  readAdminCatalog,
  saveService,
  saveMaster,
  moveCatalog,
  type CatalogMutationResult,
} from "../../modules/catalog/server/admin-catalog";
import type { CatalogFailure } from "../../modules/catalog/domain/admin-input";
import { validOrigin } from "../public/security";

const failure = (code: CatalogFailure["code"]): CatalogFailure => ({ ok: false, code });
export function createCatalogBoundary(db: PrismaClient) {
  async function run<T>(
    token: unknown,
    write: boolean,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | CatalogFailure> {
    try {
      return await db.$transaction(
        async (tx) => {
          // First refuse unauthenticated callers, then check again after any lock wait.
          if (!(await getActiveAdmin(tx, token))) return failure("UNAUTHORIZED");
          if (write) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(526008, 52)`;
            if (!(await getActiveAdmin(tx, token))) return failure("UNAUTHORIZED");
          }
          return operation(tx);
        },
        {
          isolationLevel: write ? "ReadCommitted" : "RepeatableRead",
          maxWait: 5000,
          timeout: 10000,
        },
      );
    } catch {
      // Includes an ambiguous connection loss at COMMIT: never report success or retry.
      return failure("UNAVAILABLE");
    }
  }
  async function withCatalog(tx: Prisma.TransactionClient, result: CatalogMutationResult) {
    return result.ok ? { ...result, catalog: await readAdminCatalog(tx) } : result;
  }
  return {
    list: (token: unknown) =>
      run(token, false, async (tx) => ({ ok: true as const, catalog: await readAdminCatalog(tx) })),
    saveService: (headers: Headers, token: unknown, input: unknown) =>
      validOrigin(headers)
        ? run(token, true, async (tx) => withCatalog(tx, await saveService(tx, input)))
        : Promise.resolve(failure("FORBIDDEN")),
    saveMaster: (headers: Headers, token: unknown, input: unknown) =>
      validOrigin(headers)
        ? run(token, true, async (tx) => withCatalog(tx, await saveMaster(tx, input)))
        : Promise.resolve(failure("FORBIDDEN")),
    move: (headers: Headers, token: unknown, input: unknown) =>
      validOrigin(headers)
        ? run(token, true, async (tx) => withCatalog(tx, await moveCatalog(tx, input)))
        : Promise.resolve(failure("FORBIDDEN")),
  };
}
