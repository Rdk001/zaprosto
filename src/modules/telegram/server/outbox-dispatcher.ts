import { randomUUID } from "node:crypto";

import { z } from "zod";

import { TELEGRAM_POLICY } from "../domain/policy";
import type { TelegramDeliveryAttempt, TelegramDeliveryAttemptResult } from "./delivery-attempt";
import type { OutboxTransitionResult } from "./outbox-contract";
import type { TelegramOutboxRepository } from "./outbox-repository";

const configurationSchema = z.strictObject({
  concurrency: z.number().int().positive().max(TELEGRAM_POLICY.claimBatchSize),
});
const inputSchema = z.strictObject({
  signal: z.instanceof(AbortSignal).optional(),
});

type DispatcherOutbox = Pick<TelegramOutboxRepository, "claimDue">;
type DispatcherAttempt = Pick<TelegramDeliveryAttempt, "run">;

export type TelegramOutboxDispatcherConfiguration = Readonly<{
  concurrency: number;
}>;

export type TelegramOutboxDispatcherInput = Readonly<{
  signal?: AbortSignal;
}>;

export type TelegramOutboxDispatcherSummary = {
  claimed: number;
  started: number;
  completed: number;
  outcomes: {
    preflightLeaseLost: number;
    pending: number;
    sent: number;
    dead: number;
    cancelled: number;
    skipped: number;
    finishLeaseLost: number;
    terminal: number;
    transitionNotAllowed: number;
  };
  errors: {
    attemptFailed: number;
  };
};

export type TelegramOutboxDispatcherErrorCode =
  "DISPATCH_CONFIGURATION_INVALID" | "DISPATCH_INPUT_INVALID" | "DISPATCH_CLAIM_FAILED";

export class TelegramOutboxDispatcherError extends Error {
  constructor(readonly code: TelegramOutboxDispatcherErrorCode) {
    super(code);
    this.name = "TelegramOutboxDispatcherError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

function emptySummary(): TelegramOutboxDispatcherSummary {
  return {
    claimed: 0,
    started: 0,
    completed: 0,
    outcomes: {
      preflightLeaseLost: 0,
      pending: 0,
      sent: 0,
      dead: 0,
      cancelled: 0,
      skipped: 0,
      finishLeaseLost: 0,
      terminal: 0,
      transitionNotAllowed: 0,
    },
    errors: { attemptFailed: 0 },
  };
}

function recordFinish(
  outcomes: TelegramOutboxDispatcherSummary["outcomes"],
  finish: OutboxTransitionResult,
): void {
  if (finish.kind === "APPLIED") {
    outcomes[
      finish.status.toLowerCase() as "pending" | "sent" | "dead" | "cancelled" | "skipped"
    ] += 1;
  } else if (finish.kind === "LEASE_LOST") {
    outcomes.finishLeaseLost += 1;
  } else if (finish.kind === "TERMINAL") {
    outcomes.terminal += 1;
  } else {
    outcomes.transitionNotAllowed += 1;
  }
}

function recordAttempt(
  outcomes: TelegramOutboxDispatcherSummary["outcomes"],
  result: TelegramDeliveryAttemptResult,
): void {
  if (result.kind === "PREFLIGHT_LEASE_LOST") {
    outcomes.preflightLeaseLost += 1;
    return;
  }
  recordFinish(outcomes, result.finish);
}

export class TelegramOutboxDispatcher {
  private readonly concurrency: number;
  private readonly leaseOwner = randomUUID();

  constructor(
    private readonly dependencies: {
      outbox: DispatcherOutbox;
      attempt: DispatcherAttempt;
    },
    configuration: TelegramOutboxDispatcherConfiguration,
  ) {
    const parsed = configurationSchema.safeParse(configuration);
    if (!parsed.success) {
      throw new TelegramOutboxDispatcherError("DISPATCH_CONFIGURATION_INVALID");
    }
    this.concurrency = parsed.data.concurrency;
  }

  async dispatchOnce(
    input: TelegramOutboxDispatcherInput = {},
  ): Promise<TelegramOutboxDispatcherSummary> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new TelegramOutboxDispatcherError("DISPATCH_INPUT_INVALID");

    const summary = emptySummary();
    if (parsed.data.signal?.aborted) return summary;

    let jobs: Awaited<ReturnType<DispatcherOutbox["claimDue"]>>;
    try {
      jobs = await this.dependencies.outbox.claimDue({
        capacity: this.concurrency,
        leaseOwner: this.leaseOwner,
      });
    } catch {
      throw new TelegramOutboxDispatcherError("DISPATCH_CLAIM_FAILED");
    }

    summary.claimed = jobs.length;
    if (jobs.length === 0) return summary;

    // A successful claim is the start boundary. Invoke every claimed job synchronously
    // before awaiting any one attempt, including with an already-aborted caller signal.
    const attempts = jobs.map((job) => {
      summary.started += 1;
      try {
        return this.dependencies.attempt.run({
          jobId: job.id,
          leaseToken: job.leaseToken,
          ...(parsed.data.signal === undefined ? {} : { signal: parsed.data.signal }),
        });
      } catch {
        return Promise.reject(new Error("DISPATCH_ATTEMPT_FAILED"));
      }
    });

    await Promise.all(
      attempts.map(async (attempt) => {
        try {
          recordAttempt(summary.outcomes, await attempt);
        } catch {
          summary.errors.attemptFailed += 1;
        } finally {
          summary.completed += 1;
        }
      }),
    );
    return summary;
  }
}
