import { z } from "zod"

export const TimeTrigger = z.object({
  kind: z.literal("time"),
  at: z.number().int().positive().max(8_640_000_000_000_000),
})
export type TimeTrigger = z.output<typeof TimeTrigger>

export const SessionIdleTrigger = z.object({
  kind: z.literal("session.idle"),
  sessionID: z.string().startsWith("ses"),
})
export type SessionIdleTrigger = z.output<typeof SessionIdleTrigger>

const FutureTrigger = z
  .object({
    kind: z
      .string()
      .min(1)
      .refine((kind) => !["time", "session.idle"].includes(kind)),
  })
  .catchall(z.any())

export const Trigger = z.union([TimeTrigger, SessionIdleTrigger, FutureTrigger])
export type Trigger = z.output<typeof Trigger>

export const isTimeTrigger = (trigger: Trigger): trigger is TimeTrigger => trigger.kind === "time"
export const isSessionIdleTrigger = (trigger: Trigger): trigger is SessionIdleTrigger => trigger.kind === "session.idle"

export const isRunnable = (
  job: { status: "scheduled" | "waiting" | "delivering" | "failed"; trigger: Trigger },
  now: number,
) => job.status === "waiting" || (job.status === "scheduled" && isTimeTrigger(job.trigger) && job.trigger.at <= now)
