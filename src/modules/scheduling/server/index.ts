import "server-only";

import { prisma } from "../../../server/db/prisma";
import { createSchedulingAvailabilityService } from "./availability-service";

export const schedulingAvailability = createSchedulingAvailabilityService(prisma);

export type {
  AnyMasterAvailabilityResult,
  AnyMasterSelectionQuery,
  AnyMasterSelectionResult,
  AvailabilityQuery,
  MasterAvailabilityQuery,
  MasterAvailabilityResult,
  MasterIntervalCheckQuery,
  MasterIntervalCheckResult,
} from "./types";
