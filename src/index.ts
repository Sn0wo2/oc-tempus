import { Plugin } from "@opencode/plugin"
import { Goal } from "@opencode/schema/goal"
import { type Job, parseJob, Tempus } from "./rpc.ts"
import { isRunnable, isSessionIdleTrigger, isTimeTrigger, type Trigger } from "./trigger.ts"
import { errorMessage } from "./utils/error.ts"
import { splitFirstToken } from "./utils/text.ts"

export default Plugin.define({
  id: "oc-tempus",
  async setup(ctx) {
    const prefix = `jobs/${encodeURIComponent(ctx.location.directory)}/`
    const jobs = new Map<string, Job>()
    const frozen = new Map<string, Job>()
    const parents = new Map<string, string | undefined>()
    const controller = new AbortController()
    const goals = ctx.rpc(Goal.Definition)
    const watches = new Map<string, () => void>()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let queue = Promise.resolve()

    function exclusive<T>(run: () => Promise<T> | T) {
      const result = queue.then(() => {
        if (stopped) throw new Error("Session timer is stopping; reconnect and try again.")
        return run()
      })
      queue = result.then(
        () => {},
        () => {},
      )
      return result
    }

    const track = (job: Job) => {
      jobs.set(job.id, job)
      if (job.kind === "freeze") frozen.set(job.sessionID, job)
    }

    const save = async (job: Job) => {
      await ctx.storage.set(prefix + job.id, job)
      track(job)
    }

    async function remove(job: Job) {
      await ctx.storage.remove(prefix + job.id)
      jobs.delete(job.id)
      if (frozen.get(job.sessionID)?.id === job.id) frozen.delete(job.sessionID)
    }

    async function findFreeze(sessionID: string, ignore?: string) {
      let current: string | undefined = sessionID
      while (current && frozen.size) {
        const job = frozen.get(current)
        if (job && job.id !== ignore) return job
        if (!parents.has(current)) parents.set(current, (await ctx.session.get({ sessionID: current })).parentID)
        current = parents.get(current)
      }
      return undefined
    }

    async function gate(sessionID: string) {
      const job = await findFreeze(sessionID)
      if (!job) return
      const until = isTimeTrigger(job.trigger)
        ? `until ${new Date(job.trigger.at).toISOString()}`
        : isSessionIdleTrigger(job.trigger)
          ? `until session ${job.trigger.sessionID} goes idle`
          : `until its ${job.trigger.kind} event fires`
      throw new Error(`Session frozen ${until} (timer ${job.id}). Use /tempus to resume or cancel.`)
    }

    async function interruptTree(sessionID: string) {
      const sessions = [sessionID]
      for (const id of sessions) {
        await ctx.session.interrupt({ sessionID: id, resume: false })
        let cursor: string | undefined
        do {
          const page = await ctx.session.list({ parentID: id, limit: 100, ...(cursor ? { cursor } : {}) })
          sessions.push(...page.data.map((session) => session.id))
          cursor = page.cursor.next ?? undefined
        } while (cursor)
      }
    }

    type TempusContext = { readonly error: (type: "rejected", message: string) => unknown }

    async function validateCommand(text: string, context: TempusContext) {
      if (!text.startsWith("/")) return
      const [name] = splitFirstToken(text.slice(1))
      const commands = await ctx.command.list({ location: { directory: ctx.location.directory } })
      if (!commands.data.some((command) => command.name === name))
        throw context.error(
          "rejected",
          `/${name} is not a registered server command. Schedule plain task text instead.`,
        )
    }

    async function plannedSession(sessionID: string) {
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix: "jobs/", limit: 100, ...(after ? { after } : {}) })
        for (const entry of page.entries) {
          let job: Job
          try {
            job = parseJob(entry.value)
          } catch {
            continue
          }
          if (
            job.kind === "new" &&
            !job.sessionCreated &&
            job.sessionID === sessionID &&
            entry.key.endsWith(`/${job.id}`) &&
            (job.status === "scheduled" || job.status === "waiting")
          )
            return true
        }
        after = page.next
      } while (after)
      return false
    }

    async function validateTrigger(trigger: Trigger, context: TempusContext) {
      if (isTimeTrigger(trigger)) {
        if (trigger.at <= Date.now()) throw context.error("rejected", "Choose a future time.")
        return
      }
      if (isSessionIdleTrigger(trigger)) {
        try {
          await ctx.session.get({ sessionID: trigger.sessionID })
        } catch (error) {
          if (!(await plannedSession(trigger.sessionID))) {
            const detail = errorMessage(error)
            throw context.error(
              "rejected",
              `Session ${trigger.sessionID} does not exist and no pending task will create it${
                detail ? ` (${detail})` : ""
              }; schedule the task that creates it first.`,
            )
          }
        }
        return
      }
      throw context.error(
        "rejected",
        `Unsupported event kind "${trigger.kind}". This server knows: ${["time", "session.idle"].join(", ")}.`,
      )
    }

    let after: string | undefined
    do {
      const page = await ctx.storage.scan({ prefix, limit: 100, ...(after ? { after } : {}) })
      for (const entry of page.entries) {
        let job: Job
        try {
          job = parseJob(entry.value)
          if (entry.key !== prefix + job.id) throw new Error(`key does not match job id ${job.id}`)
        } catch (error) {
          console.error("oc-tempus: skipping unreadable stored job:", entry.key, errorMessage(error))
          continue
        }
        if (job.status === "delivering") {
          await save({
            ...job,
            status: "failed",
            error: "The service stopped during delivery. Check the session, then resume explicitly if needed.",
          })
        } else {
          track(job)
        }
      }
      after = page.next
    } while (after)

    function watchSession(sessionID: string) {
      const abort = new AbortController()
      let dead = false
      let retry: ReturnType<typeof setTimeout> | undefined
      const probe = async () => {
        try {
          await ctx.session.wait({ sessionID }, { signal: abort.signal })
        } catch {
          if (!(dead || stopped)) retry = setTimeout(() => void probe(), 30_000)
          return
        }
        if (!(dead || stopped)) fire({ kind: "session.idle", sessionID })
      }
      void probe()
      return () => {
        dead = true
        clearTimeout(retry)
        abort.abort()
      }
    }

    function arm(backoff = 0) {
      clearTimeout(timer)
      timer = undefined
      for (const stop of watches.values()) stop()
      watches.clear()
      if (stopped) return
      let dueAt = Number.POSITIVE_INFINITY
      for (const job of jobs.values()) {
        if (job.status !== "scheduled") continue
        if (isTimeTrigger(job.trigger)) dueAt = Math.min(dueAt, job.trigger.at)
        else if (isSessionIdleTrigger(job.trigger)) watches.set(job.id, watchSession(job.trigger.sessionID))
      }
      if (!Number.isFinite(dueAt)) return
      timer = setTimeout(
        () => void fire({ kind: "time" }),
        Math.min(2_147_483_647, Math.max(backoff, dueAt - Date.now())),
      )
    }

    function fire(wake: { kind: "time" } | { kind: "session.idle"; sessionID: string }) {
      void exclusive(async () => {
        for (const job of jobs.values()) {
          if (job.status !== "scheduled") continue
          const { trigger } = job
          const due = isTimeTrigger(trigger)
            ? trigger.at <= Date.now()
            : isSessionIdleTrigger(trigger) && wake.kind === "session.idle" && wake.sessionID === trigger.sessionID
          if (!due) continue
          await save({ ...job, status: "waiting" })
          await rpc.events.emit("due", { id: job.id })
        }
      }).then(
        () => arm(),
        (error) => {
          if (!stopped) console.error("oc-tempus:", error)
          arm(30_000)
        },
      )
    }

    const rpc = await ctx.rpc.register(Tempus, {
      freeze: (input, context) =>
        exclusive(async () => {
          await validateTrigger(input.trigger, context)
          await ctx.session.get({ sessionID: input.sessionID })
          const previous = frozen.get(input.sessionID)
          const goal = await goals.get({ sessionID: input.sessionID })
          const job: Job = {
            id: previous?.id ?? crypto.randomUUID(),
            kind: "freeze",
            sessionID: input.sessionID,
            sessionCreated: true,
            goalID: goal?.status === "active" ? goal.id : (previous?.goalID ?? null),
            trigger: input.trigger,
            createdAt: previous?.createdAt ?? Date.now(),
            text: input.text?.trim() || "The scheduled freeze has ended. Continue the unfinished task in this session.",
            status: "scheduled",
            error: null,
          }
          await save(job)
          arm()
          try {
            await interruptTree(job.sessionID)
          } catch (error) {
            await save({ ...job, status: "failed", error: errorMessage(error) })
            arm()
            throw error
          }
          return job
        }),
      schedule: (input, context) =>
        exclusive(async () => {
          await validateTrigger(input.trigger, context)
          await validateCommand(input.text, context)
          const id = crypto.randomUUID()
          const job: Job = {
            id,
            kind: "new",
            sessionID: `ses_${id}`,
            sessionCreated: false,
            goalID: null,
            trigger: input.trigger,
            createdAt: Date.now(),
            text: input.text,
            status: "scheduled",
            error: null,
          }
          await save(job)
          arm()
          return job
        }),
      list: () =>
        exclusive(() =>
          Array.from(jobs.values()).sort(
            (left, right) =>
              (isTimeTrigger(left.trigger) ? left.trigger.at : Number.MAX_SAFE_INTEGER) -
              (isTimeTrigger(right.trigger) ? right.trigger.at : Number.MAX_SAFE_INTEGER),
          ),
        ),
      run: (input, context) =>
        exclusive(async () => {
          let job = jobs.get(input.id)
          if (!(job && (input.force || isRunnable(job, Date.now())))) return { started: false }
          const inherited = job.kind === "freeze" ? await findFreeze(job.sessionID, job.id) : undefined
          if (inherited) throw context.error("rejected", `The parent session is still frozen (timer ${inherited.id}).`)
          job = { ...job, status: "delivering", error: null }
          await save(job)
          const model = {
            providerID: input.model.providerID,
            id: input.model.id,
            ...(input.model.variant !== undefined ? { variant: input.model.variant } : {}),
          }
          try {
            if (job.kind === "new") {
              await validateCommand(job.text, context)
              if (!job.sessionCreated) {
                await ctx.session.create({
                  id: job.sessionID,
                  model,
                  title: job.text.slice(0, 100),
                  location: { directory: ctx.location.directory },
                })
                job = { ...job, sessionCreated: true }
                await save(job)
              }
            }
            await interruptTree(job.sessionID)
            await ctx.session.switchModel({ sessionID: job.sessionID, model })
            if (frozen.get(job.sessionID)?.id === job.id) frozen.delete(job.sessionID)
            if (job.kind === "freeze") {
              const goal = job.goalID ? await goals.get({ sessionID: job.sessionID }) : null
              const resumeGoal = goal?.id === job.goalID && goal?.status === "paused"
              await ctx.session.synthetic({
                sessionID: job.sessionID,
                id: `msg_${job.id}`,
                text: job.text,
                description: "Scheduled session resume",
                delivery: "queue",
                resume: !resumeGoal,
              })
              if (resumeGoal)
                await ctx.session.command({ sessionID: job.sessionID, name: "goal", text: "resume", delivery: "queue" })
            } else if (job.text.startsWith("/")) {
              const [name, text] = splitFirstToken(job.text.slice(1))
              await ctx.session.command({ sessionID: job.sessionID, name, text, delivery: "queue" })
            } else {
              await ctx.session.prompt({
                sessionID: job.sessionID,
                id: `msg_${job.id}`,
                text: job.text,
                delivery: "queue",
                resume: true,
              })
            }
            await remove(job)
            arm()
            return { started: true, sessionID: job.sessionID }
          } catch (error) {
            await save({ ...job, status: "failed", error: errorMessage(error) })
            if (job.kind === "freeze") {
              await interruptTree(job.sessionID).catch((interruption) => {
                console.error("oc-tempus:", interruption)
              })
            }
            arm()
            throw error
          }
        }),
      cancel: (input) =>
        exclusive(async () => {
          const job = jobs.get(input.id)
          if (!job) return false
          await remove(job)
          arm()
          return true
        }),
    })

    const hooks = await Promise.all([
      ctx.session.hook("prompt", (event) => gate(event.sessionID)),
      ctx.session.hook("model.request", (event) => gate(event.sessionID)),
      ctx.session.hook("retry", async (event) => {
        if (await findFreeze(event.sessionID)) event.decision = { retry: false }
      }),
    ])

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event.type === "session.deleted") {
            parents.clear()
            await exclusive(async () => {
              for (const job of jobs.values()) {
                if (
                  job.sessionID !== event.data.sessionID &&
                  !(isSessionIdleTrigger(job.trigger) && job.trigger.sessionID === event.data.sessionID)
                )
                  continue
                await remove(job)
              }
              arm()
            })
          } else if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            (event.type === "session.execution.interrupted" && event.data.reason !== "shutdown")
          ) {
            fire({ kind: "session.idle", sessionID: event.data.sessionID })
          } else if (event.type === "session.execution.started") {
            await exclusive(async () => {
              const job = await findFreeze(event.data.sessionID)
              if (job) await ctx.session.interrupt({ sessionID: event.data.sessionID, resume: false })
            })
          }
        } catch (error) {
          if (!stopped) console.error("oc-tempus:", error)
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("oc-tempus:", error)
    })

    for (const job of frozen.values()) {
      try {
        await interruptTree(job.sessionID)
      } catch (error) {
        await save({ ...job, status: "failed", error: errorMessage(error) })
      }
    }
    arm()

    return async () => {
      stopped = true
      clearTimeout(timer)
      controller.abort()
      for (const stop of watches.values()) stop()
      watches.clear()
      await queue
      await Promise.all([rpc.dispose(), ...hooks.map((hook) => hook.dispose())])
    }
  },
})
