-- Keep historical requests valid; only new online attempts require a fingerprint.
-- A legacy NULL fingerprint is never accepted as a successful idempotent replay.
ALTER TABLE "booking_requests" ADD COLUMN "request_hash" TEXT;

ALTER TABLE "booking_requests"
  ADD CONSTRAINT "booking_requests_request_hash_check"
  CHECK ("request_hash" IS NULL OR "request_hash" ~ '^[0-9a-f]{64}$');
