-- PostgreSQL features and domain constraints not expressible in Prisma Schema Language.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "business_settings"
  ADD CONSTRAINT "business_settings_singleton_check" CHECK ("id" = 1),
  ADD CONSTRAINT "business_settings_booking_horizon_days_check"
    CHECK ("booking_horizon_days" BETWEEN 7 AND 90);

ALTER TABLE "media_objects"
  ADD CONSTRAINT "media_objects_size_bytes_check" CHECK ("size_bytes" > 0),
  ADD CONSTRAINT "media_objects_width_check" CHECK ("width" IS NULL OR "width" > 0),
  ADD CONSTRAINT "media_objects_height_check" CHECK ("height" IS NULL OR "height" > 0);

ALTER TABLE "services"
  ADD CONSTRAINT "services_price_kopecks_check" CHECK ("price_kopecks" > 0),
  ADD CONSTRAINT "services_duration_minutes_check" CHECK ("duration_minutes" > 0);

ALTER TABLE "weekly_work_intervals"
  ADD CONSTRAINT "weekly_work_intervals_day_of_week_check" CHECK ("day_of_week" BETWEEN 1 AND 7),
  ADD CONSTRAINT "weekly_work_intervals_time_order_check" CHECK ("starts_at" < "ends_at");

ALTER TABLE "weekly_breaks"
  ADD CONSTRAINT "weekly_breaks_day_of_week_check" CHECK ("day_of_week" BETWEEN 1 AND 7),
  ADD CONSTRAINT "weekly_breaks_time_order_check" CHECK ("starts_at" < "ends_at");

ALTER TABLE "exception_work_intervals"
  ADD CONSTRAINT "exception_work_intervals_time_order_check" CHECK ("starts_at" < "ends_at");

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_time_order_check" CHECK ("starts_at" < "ends_at"),
  ADD CONSTRAINT "appointments_service_price_snapshot_check" CHECK ("service_price_snapshot" > 0),
  ADD CONSTRAINT "appointments_service_duration_snapshot_check" CHECK ("service_duration_snapshot" > 0),
  ADD CONSTRAINT "appointments_no_overlap"
    EXCLUDE USING gist (
      "master_id" WITH =,
      tstzrange("starts_at", "ends_at", '[)') WITH &&
    )
    WHERE ("status" <> 'CANCELLED'::"AppointmentStatus");

ALTER TABLE "notification_outbox"
  ADD CONSTRAINT "notification_outbox_attempts_check" CHECK ("attempts" >= 0);
