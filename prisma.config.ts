import "dotenv/config";

import { defineConfig } from "prisma/config";

const offlineGenerationUrl = "postgresql://unused:unused@127.0.0.1:1/unused";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? offlineGenerationUrl,
  },
});
