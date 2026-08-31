import type { PublicTimeContext } from "../../settings/server/context";
import type { PublicServiceTerms } from "../../catalog/server/service-terms";
import type { AppointmentConfirmation } from "../../appointments/server/confirmation";
import type { InputIssue } from "../domain/booking-input";

export type BookingRejectionReason =
  "SERVICE_NOT_FOUND" | "INACTIVE_SERVICE" | "MASTER_NOT_ELIGIBLE" | "BOOKING_DATE_OUT_OF_RANGE";

export interface BookingAvailability {
  serviceId: string;
  localDate: string;
  timeZone?: string;
  unavailableReason?: BookingRejectionReason;
  slots: Array<{ startsAt: Date; endsAt: Date; masters: Array<{ id: string; name: string }> }>;
}

export type CreateBookingResult =
  | {
      ok: true;
      replayed: boolean;
      timeZone: string;
      confirmation: AppointmentConfirmation;
      cancellationToken: string;
    }
  | { ok: false; code: "BUSINESS_CONTEXT_CHANGED"; context: PublicTimeContext }
  | { ok: false; code: "INVALID_INPUT"; issues: InputIssue[] }
  | { ok: false; code: "IDEMPOTENCY_CONFLICT" }
  | {
      ok: false;
      code: "SERVICE_TERMS_CHANGED";
      service: PublicServiceTerms;
      availability: BookingAvailability;
    }
  | { ok: false; code: "SLOT_UNAVAILABLE"; availability: BookingAvailability }
  | { ok: false; code: "REQUEST_REJECTED"; reason: BookingRejectionReason };
