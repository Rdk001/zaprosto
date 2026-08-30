CREATE TABLE "public_rate_limits" (
  "key" TEXT PRIMARY KEY,
  "hits" INTEGER NOT NULL CHECK ("hits" > 0),
  "expires_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "public_rate_limits_expires_at_idx" ON "public_rate_limits" ("expires_at");
