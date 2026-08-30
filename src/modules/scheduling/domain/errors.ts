export type SchedulingErrorCode =
  | "BOOKING_DATE_OUT_OF_RANGE"
  | "BUSINESS_SETTINGS_NOT_FOUND"
  | "INACTIVE_SERVICE"
  | "INVALID_BOOKING_HORIZON"
  | "INVALID_IDENTIFIER"
  | "INVALID_INSTANT"
  | "INVALID_INTERVAL"
  | "INVALID_LOCAL_DATE"
  | "INVALID_LOCAL_DATE_TIME"
  | "INVALID_TIME_ZONE"
  | "MASTER_NOT_ELIGIBLE"
  | "SERVICE_NOT_FOUND";

export class SchedulingError extends Error {
  constructor(
    readonly code: SchedulingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class BusinessSettingsNotFoundError extends SchedulingError {
  constructor() {
    super("BUSINESS_SETTINGS_NOT_FOUND", "Business settings have not been configured");
  }
}

export class InvalidBookingHorizonError extends SchedulingError {
  constructor(readonly bookingHorizonDays: number) {
    super(
      "INVALID_BOOKING_HORIZON",
      `Booking horizon must be an integer from 7 to 90 days; received ${bookingHorizonDays}`,
    );
  }
}

export class InvalidTimeZoneError extends SchedulingError {
  constructor(
    readonly timeZone: string,
    options?: ErrorOptions,
  ) {
    super(
      "INVALID_TIME_ZONE",
      `Business time zone is not a valid IANA time zone: ${timeZone}`,
      options,
    );
  }
}

export class InvalidLocalDateError extends SchedulingError {
  constructor(
    readonly localDate: string,
    options?: ErrorOptions,
  ) {
    super(
      "INVALID_LOCAL_DATE",
      `Local date must be a valid ISO calendar date (YYYY-MM-DD): ${localDate}`,
      options,
    );
  }
}

export class InvalidLocalDateTimeError extends SchedulingError {
  constructor(
    readonly localDate: string,
    readonly localTime: string,
    readonly timeZone: string,
    options?: ErrorOptions,
  ) {
    super(
      "INVALID_LOCAL_DATE_TIME",
      `Local date-time ${localDate}T${localTime} is invalid or ambiguous in ${timeZone}`,
      options,
    );
  }
}

export class BookingDateOutOfRangeError extends SchedulingError {
  constructor(
    readonly localDate: string,
    readonly firstBookableDate: string,
    readonly lastBookableDate: string,
  ) {
    super(
      "BOOKING_DATE_OUT_OF_RANGE",
      `Booking date ${localDate} is outside ${firstBookableDate}..${lastBookableDate}`,
    );
  }
}

export class InvalidIdentifierError extends SchedulingError {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super("INVALID_IDENTIFIER", `${field} must be a valid UUID`);
  }
}

export class InvalidInstantError extends SchedulingError {
  constructor(readonly field: string) {
    super("INVALID_INSTANT", `${field} must be a valid Date`);
  }
}

export class InvalidIntervalError extends SchedulingError {
  constructor(message: string) {
    super("INVALID_INTERVAL", message);
  }
}

export class ServiceNotFoundError extends SchedulingError {
  constructor(readonly serviceId: string) {
    super("SERVICE_NOT_FOUND", `Service ${serviceId} was not found`);
  }
}

export class InactiveServiceError extends SchedulingError {
  constructor(readonly serviceId: string) {
    super("INACTIVE_SERVICE", `Service ${serviceId} is inactive`);
  }
}

export class MasterNotEligibleError extends SchedulingError {
  constructor(
    readonly masterId: string,
    readonly serviceId: string,
  ) {
    super(
      "MASTER_NOT_ELIGIBLE",
      `Master ${masterId} is inactive or is not assigned to service ${serviceId}`,
    );
  }
}
