import "server-only";
import { createPrismaClient } from "./create-prisma-client";
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createPrismaClient> };
let client: ReturnType<typeof createPrismaClient> | undefined;
// Defer connection configuration until the first DB operation, not module import during build.
export const prisma = new Proxy({} as ReturnType<typeof createPrismaClient>, {
  get(_target, property) {
    client ??= globalForPrisma.prisma ?? createPrismaClient();
    if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = client;
    const value = Reflect.get(client, property);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
