-- Explicit optimistic versions avoid millisecond timestamp collisions and ABA edits.
ALTER TABLE "services" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0 CHECK ("version" >= 0);
ALTER TABLE "masters" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0 CHECK ("version" >= 0);
