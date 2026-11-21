import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { Trigger } from "./trigger.ts"

export const Job = z.object({
  id: z.uuid(),
  kind: z.enum(["freeze", "new"]),
  sessionID: z.string().startsWith("ses"),
  sessionCreated: z.boolean(),
  goalID: z.string().nullable(),
  trigger: Trigger,
  createdAt: z.number().int().positive(),
  text: z.string(),
  status: z.enum(["scheduled", "waiting", "delivering", "failed"]),
  error: z.string().nullable(),
})

export type Job = z.output<typeof Job>

const LegacyJob = Job.omit({ trigger: true }).extend({
  dueAt: z.number().int().positive().max(8_640_000_000_000_000),
})

export function parseJob(value: unknown): Job {
  const parsed = Job.safeParse(value)
  if (parsed.success) return parsed.data
  const legacy = LegacyJob.safeParse(value)
  if (legacy.success) return { ...legacy.data, trigger: { kind: "time", at: legacy.data.dueAt } }
  throw new Error(`Invalid session timer job: ${z.prettifyError(parsed.error)}`)
}

export const Tempus = Rpc.define({
  id: "oc-tempus",
  methods: {
    freeze: {
      input: z.object({
        sessionID: z.string().startsWith("ses"),
        trigger: Trigger,
        text: z.string().optional(),
      }),
      output: Job,
      errors: { rejected: z.undefined() },
    },
    schedule: {
      input: z.object({
        trigger: Trigger,
        text: z.string().trim().min(1),
      }),
      output: Job,
      errors: { rejected: z.undefined() },
    },
    list: { input: z.object({}), output: z.array(Job) },
    run: {
      input: z.object({
        id: z.uuid(),
        model: z.object({ providerID: z.string().min(1), id: z.string().min(1), variant: z.string().optional() }),
        force: z.boolean().optional(),
      }),
      output: z.object({ started: z.boolean(), sessionID: z.string().optional() }),
      errors: { rejected: z.undefined() },
    },
    cancel: { input: z.object({ id: z.uuid() }), output: z.boolean() },
  },
  events: {
    due: { schema: z.object({ id: z.uuid() }) },
  },
})
