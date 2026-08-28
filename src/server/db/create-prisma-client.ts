import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../generated/prisma/client";

export function createPrismaClient(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for server-side database access");
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
