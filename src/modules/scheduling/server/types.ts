import type { MasterDailyLoad } from "../domain/any-master";
import type { TimeInterval } from "../domain/intervals";

export interface SchedulingScope {
  serviceId: string;
  serviceDurationMinutes: number;
  localDate: string;
  timeZone: string;
  day: TimeInterval;
}

export interface AvailableMaster {
  id: string;
  name: string;
  displayOrder: number;
}

export interface MasterAvailabilityResult extends SchedulingScope {
  master: AvailableMaster;
  dailyLoad: MasterDailyLoad;
  workingIntervals: TimeInterval[];
  freeIntervals: TimeInterval[];
  slots: TimeInterval[];
}

export interface AnyMasterSlotCandidate extends AvailableMaster {
  dailyLoad: MasterDailyLoad;
}

export interface AnyMasterAvailabilitySlot extends TimeInterval {
  candidates: AnyMasterSlotCandidate[];
}

export interface AnyMasterAvailabilityResult extends SchedulingScope {
  masters: MasterAvailabilityResult[];
  slots: AnyMasterAvailabilitySlot[];
}

export interface MasterIntervalCheckResult extends SchedulingScope {
  master: AvailableMaster;
  interval: TimeInterval;
  isAvailable: boolean;
  reason: "AVAILABLE" | "NOT_AVAILABLE";
}

export interface AnyMasterSelectionResult extends SchedulingScope {
  interval: TimeInterval;
  isAvailable: boolean;
  candidates: AnyMasterSlotCandidate[];
  selectedMaster: AnyMasterSlotCandidate | null;
}

export interface AvailabilityQuery {
  serviceId: string;
  localDate: string;
  excludeAppointmentId?: string;
}

export interface MasterAvailabilityQuery extends AvailabilityQuery {
  masterId: string;
}

export interface MasterIntervalCheckQuery extends MasterAvailabilityQuery {
  startsAt: Date;
}

export interface AnyMasterSelectionQuery extends AvailabilityQuery {
  startsAt: Date;
}
