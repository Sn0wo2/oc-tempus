import { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { jsx, jsxs } from "@opentui/solid/jsx-runtime"
import { createComponent, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { type Job, Tempus } from "./rpc.ts"
import { isRunnable, isSessionIdleTrigger, isTimeTrigger } from "./trigger.ts"
import { errorMessage } from "./utils/error.ts"
import { splitFirstToken } from "./utils/text.ts"
import { type ClaimContext, claimTrigger } from "./when.ts"

type TaskAction = "resume" | "cancel" | "open"

const TempusHost = ({ ctx }: { ctx: Plugin.Context }) => {
  const rpc = ctx.client.rpc(Tempus)
  const controller = new AbortController()
  const requestOptions = { location: ctx.location ?? ctx.data.location.default(), signal: controller.signal }
  const automaticFailures = new Set<string>()
  let listedJobs: readonly Job[] = []
  let checking = false
  let running = false
  let rerunRequested = false
  let alive = true

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", sessionID?: string) => {
    if (!alive) return
    ctx.ui.toast.show({
      title: "Tempus",
      message,
      variant,
      ...(sessionID === undefined ? {} : { sessionID }),
    })
  }

  const routeSessionID = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const notifyStarted = (job: Job, sessionID: string | undefined, manual: boolean) => {
    if (!alive) return
    if (job.kind === "new" && sessionID) ctx.ui.tabs.open(sessionID)
    toast(
      manual ? "Task resumed." : job.kind === "new" ? "Scheduled session started." : "Scheduled session resumed.",
      "success",
      sessionID ?? job.sessionID,
    )
  }

  const runTask = async (job: Job, manual: boolean) => {
    if (!alive) return { kind: "disposed" as const }
    if (running) {
      rerunRequested = true
      return { kind: "in-flight" as const }
    }
    running = true

    try {
      const current = ctx.ui.model.current()
      if (!current) return { kind: "no-model" as const }

      const result = await rpc.run(
        {
          id: job.id,
          model: {
            providerID: current.providerID,
            id: current.modelID,
            ...(current.variant === undefined ? {} : { variant: current.variant }),
          },
          force: manual,
        },
        requestOptions,
      )
      return alive ? { kind: "result" as const, result } : { kind: "disposed" as const }
    } finally {
      running = false
      if (alive && rerunRequested && !checking) {
        rerunRequested = false
        queueMicrotask(() => void checkDue())
      }
    }
  }

  const checkDue = async () => {
    if (!alive) return
    if (checking || running) {
      rerunRequested = true
      return
    }

    checking = true
    let listed = false
    try {
      const jobs = await rpc.list({}, requestOptions).catch(() => undefined)
      if (!(alive && jobs)) return
      listed = true
      listedJobs = jobs
      const now = Date.now()
      for (const job of jobs) {
        if (!alive) break
        if (!isRunnable(job, now)) continue
        try {
          const outcome = await runTask(job, false)
          if (!alive || outcome.kind !== "result" || !outcome.result.started) continue
          automaticFailures.delete(job.id)
          notifyStarted(job, outcome.result.sessionID, false)
        } catch (error) {
          if (!alive || automaticFailures.has(job.id)) continue
          automaticFailures.add(job.id)
          toast(`Scheduled task ${job.id.slice(0, 8)} failed: ${errorMessage(error)}`, "error", job.sessionID)
        }
      }
    } finally {
      checking = false
      if (rerunRequested) {
        rerunRequested = false
        if (alive && listed) queueMicrotask(() => void checkDue())
      }
    }
  }

  const onDue = rpc.events.on(
    "due",
    (event) => {
      if (!alive || event.location.directory !== requestOptions.location.directory) return
      void checkDue()
    },
    { signal: controller.signal },
  )
  const timer = setInterval(() => void checkDue(), 15_000)
  onCleanup(() => {
    alive = false
    controller.abort()
    clearInterval(timer)
    onDue()
  })

  createEffect(() => {
    ctx.ui.model.current()
    void checkDue()
  })

  const runCommand = async (command: () => Promise<void>) => {
    if (!alive) return
    try {
      await command()
    } catch (error) {
      toast(errorMessage(error), "error", routeSessionID())
    }
  }

  const claimContext: ClaimContext = {
    sessions: () => [
      ...ctx.data.session.list(),
      ...listedJobs
        .filter((job) => job.kind === "new" && !job.sessionCreated)
        .map((job) => {
          return { id: job.sessionID }
        }),
    ],
  }

  const schedule = async (input: string | undefined) => {
    const sessionID = routeSessionID()
    let claim = claimTrigger(input ?? "", claimContext)
    let task = claim?.rest.trim() ?? ""
    if (!claim) {
      task = (input ?? "").trim()
      const value = await ctx.ui.dialog.prompt({
        title: sessionID ? "Freeze this session until when?" : "Start the task when?",
        placeholder: "3h, 18:00, 2026-11-20 09:30, a session ID, or an exact session title",
      })
      if (!alive || value === undefined) return
      claim = claimTrigger(value, claimContext)
      if (!claim) {
        toast(`Could not read "${value.trim()}" as a time or session reference.`, "warning", sessionID)
        return
      }
    }
    const { trigger } = claim
    if (sessionID) {
      await rpc.freeze({ sessionID, trigger, ...(task ? { text: task } : {}) }, requestOptions)
      toast(
        `Session frozen ${
          isTimeTrigger(trigger)
            ? `until ${new Date(trigger.at).toLocaleString()}`
            : isSessionIdleTrigger(trigger)
              ? `until session ${trigger.sessionID} goes idle`
              : `until its ${trigger.kind} event fires`
        }; it resumes automatically.`,
        "success",
        sessionID,
      )
      return
    }
    if (!task) {
      const answer = await promptText(ctx, {
        title: "Task to run",
        placeholder: "Prompt text, or a /registered-command with arguments",
      })
      if (!alive || answer === undefined) return
      task = answer.trim()
      if (!task) return
    }
    const job = await rpc.schedule({ trigger, text: task }, requestOptions)
    listedJobs = [job, ...listedJobs]
    toast(
      `Task ${job.id.slice(0, 8)} ${
        isTimeTrigger(trigger)
          ? `is scheduled for ${new Date(trigger.at).toLocaleString()}`
          : isSessionIdleTrigger(trigger)
            ? listedJobs.some(
                (listed) => listed.kind === "new" && !listed.sessionCreated && listed.sessionID === trigger.sessionID,
              )
              ? `waits for scheduled session ${trigger.sessionID} to be created and go idle`
              : ctx.data.session.status(trigger.sessionID) === "running"
                ? `will start when session ${trigger.sessionID} goes idle`
                : `starts now; session ${trigger.sessionID} is already idle`
            : `waits for its ${trigger.kind} event`
      }.`,
      "success",
      isSessionIdleTrigger(trigger) ? trigger.sessionID : job.sessionID,
    )
  }

  const copySessionID = () => {
    const sessionID = routeSessionID()
    if (sessionID === undefined) {
      toast("Open a session to copy its ID.", "warning")
      return
    }
    const copied = ctx.renderer.copyToClipboardOSC52(sessionID)
    toast(
      copied ? `Session ID copied: ${sessionID}` : `Session ID: ${sessionID}`,
      copied ? "success" : "info",
      sessionID,
    )
  }

  const taskAction = async (job: Job, action: TaskAction) => {
    switch (action) {
      case "resume": {
        const outcome = await runTask(job, true)
        if (!alive || outcome.kind === "disposed") return
        if (outcome.kind === "no-model") {
          toast("Select a model in the TUI before resuming a task.", "error", job.sessionID)
          return
        }
        if (outcome.kind === "in-flight") {
          toast("This task is already being started.", "info", job.sessionID)
          return
        }
        if (!outcome.result.started) {
          toast("Task was not started; another client may already be delivering it.", "info", job.sessionID)
          return
        }
        automaticFailures.delete(job.id)
        notifyStarted(job, outcome.result.sessionID, true)
        return
      }
      case "cancel": {
        const confirmed = await ctx.ui.dialog.confirm({
          title:
            job.kind === "freeze"
              ? `Cancel automatic resume ${job.id.slice(0, 8)}?`
              : `Cancel task ${job.id.slice(0, 8)}?`,
          message:
            job.kind === "freeze"
              ? "This cancels the automatic resume and lifts the freeze gate, but leaves the session stopped. It will not resume the session."
              : "This permanently cancels the scheduled task.",
          label: { confirm: "Cancel task" },
        })
        if (!(alive && confirmed)) return
        const cancelled = await rpc.cancel({ id: job.id }, requestOptions)
        if (!alive) return
        if (!cancelled) {
          toast("Task was not cancelled; it may already be running or complete.", "info", job.sessionID)
          return
        }
        automaticFailures.delete(job.id)
        toast(
          job.kind === "freeze"
            ? "Automatic resume cancelled; the session remains stopped."
            : "Scheduled task cancelled.",
          "success",
          job.sessionID,
        )
        return
      }
      case "open": {
        await ctx.data.session.sync(job.sessionID)
        if (!alive) return
        if (!ctx.data.session.get(job.sessionID)) {
          await ctx.ui.dialog.alert({
            title: "Session unavailable",
            message: `Session ${job.sessionID} no longer exists.`,
          })
          return
        }
        ctx.ui.router.navigate({ type: "session", sessionID: job.sessionID })
      }
    }
  }

  const manageTasks = async () => {
    const jobs = await rpc.list({}, requestOptions)
    if (!alive) return
    listedJobs = jobs
    if (jobs.length === 0) {
      await ctx.ui.dialog.alert({ title: "Tempus", message: "There are no scheduled tasks." })
      return
    }
    const act = (action: TaskAction) => (id: string) => {
      ctx.ui.dialog.clear()
      const job = jobs.find((candidate) => candidate.id === id)
      if (job) void runCommand(() => taskAction(job, action))
    }
    const selected = await ctx.ui.dialog.select<string>({
      title: "Tempus tasks",
      placeholder: "Select a task, or use a footer action",
      options: jobs.map((job) => {
        return {
          title: `${job.kind === "freeze" ? "resume" : "task"} · ${job.status} · ${
            isTimeTrigger(job.trigger)
              ? `at ${new Date(job.trigger.at).toLocaleString()}`
              : isSessionIdleTrigger(job.trigger)
                ? `when ${job.trigger.sessionID} goes idle`
                : `on its ${job.trigger.kind} event`
          } · ${job.id.slice(0, 8)}`,
          value: job.id,
          description: [
            job.sessionID,
            job.text.replace(/\s+/g, " ").slice(0, 120),
            job.error ? `Error: ${job.error}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        }
      }),
      actions: [
        { bind: "r", title: "Resume", onTrigger: act("resume") },
        { bind: "c", title: "Cancel", onTrigger: act("cancel") },
        { bind: "o", title: "Open", onTrigger: act("open") },
      ],
    })
    if (!alive || selected === undefined) return
    const job = jobs.find((candidate) => candidate.id === selected)
    if (!job) return
    const action = await ctx.ui.dialog.select<TaskAction>({
      title: `Task ${job.id.slice(0, 8)} · ${job.status}`,
      options: [
        ...(job.status === "delivering" ? [] : [{ title: "Resume now", value: "resume" as const }]),
        {
          title: job.kind === "freeze" ? "Cancel automatic resume (session stays stopped)" : "Cancel task",
          value: "cancel" as const,
        },
        { title: "Open session if it exists", value: "open" as const },
      ],
    })
    if (!alive || action === undefined) return
    await taskAction(job, action)
  }

  const openHub = async () => {
    const sessionID = routeSessionID()
    const choice = await ctx.ui.dialog.select<"schedule" | "list" | "id" | "help">({
      title: "Tempus",
      placeholder: "Choose an action",
      options: [
        {
          title: "Schedule",
          value: "schedule",
          description:
            sessionID !== undefined
              ? "Freeze this session now; resume at a time or when a session finishes"
              : "Run a prompt or /command at a time or when a session finishes",
        },
        {
          title: "Manage tasks",
          value: "list",
          description: "Resume, cancel, or open scheduled tasks",
        },
        ...(sessionID === undefined
          ? []
          : [{ title: "Copy session ID", value: "id" as const, description: `Copy ${sessionID} to the clipboard` }]),
        {
          title: "Help",
          value: "help",
          description: "Usage and time formats",
        },
      ],
    })
    if (!alive || choice === undefined) return
    if (choice === "schedule") return runCommand(() => schedule(undefined))
    if (choice === "list") return runCommand(() => manageTasks())
    if (choice === "id") return runCommand(async () => copySessionID())
    return runCommand(() => showHelp())
  }

  const showHelp = () =>
    ctx.ui.dialog.alert({
      title: "Tempus",
      message: [
        "/tempus — open the menu: schedule, manage, copy ID, or help.",
        "/tempus <when> [message] — in a session, freeze it now and resume it automatically with the message; on the home screen, run a prompt or /registered-command in a new session.",
        "<when> is auto-detected, no subcommands: durations (3h, 1h30m), clock times (18:00; rolls to tomorrow once past), local dates with a time (2026-11-20 09:30), ISO timestamps with a timezone (2026-11-06T18:00:00-05:00), a session ID — including one a pending task will create later — or unique ses_ prefix, or an exact unique session title.",
        "Anything the slot cannot read is kept as the task message and the missing <when> is prompted for.",
        "Session-idle tasks start as soon as the watched session stops running — including when it is interrupted, or when it is already idle at scheduling time. Watching a session that a pending task will create later works too: the task starts once that session is created and stops running.",
        "Cancelling an automatic resume lifts the freeze gate but leaves that session stopped.",
        "Tasks run only while the service and a TUI with a selected model are up; they are not OS wake timers.",
      ].join("\n\n"),
    })

  ctx.keymap.layer(() => {
    return {
      mode: "global",
      commands: [
        {
          id: "oc-tempus",
          title: "Tempus",
          description: "Schedule the current session or new tasks, and manage timers",
          group: "Tempus",
          bind: false,
          palette: true,
          slash: { name: "tempus", arguments: true },
          run: (input) =>
            runCommand(() => {
              const [verb] = splitFirstToken(input)
              switch (verb.toLowerCase()) {
                case "list":
                  return manageTasks()
                case "id":
                  return Promise.resolve(copySessionID())
                case "help":
                  return showHelp()
                case "":
                  return openHub()
                default:
                  return schedule(input)
              }
            }),
        },
      ],
    }
  })

  return null
}

function Editor(props: {
  readonly ctx: Plugin.Context
  readonly title: string
  readonly placeholder: string
  readonly hint: string
  readonly onSubmit: (value: string) => void
}) {
  const theme = props.ctx.theme.surface("dialog")
  const [target, setTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable | undefined

  props.ctx.keymap.layer(() => {
    return {
      mode: "modal",
      target,
      enabled: target() !== undefined,
      priority: 1,
      commands: [
        {
          id: "oc-tempus.prompt.submit",
          title: "Submit prompt",
          group: "Dialog",
          bind: "return",
          run: () => {
            if (!textarea || textarea.isDestroyed) return
            props.onSubmit(textarea.plainText)
          },
        },
        {
          id: "oc-tempus.prompt.newline",
          title: "Insert newline",
          group: "Dialog",
          bind: "shift+return,ctrl+return,alt+return,ctrl+j",
          run: () => {
            if (!textarea || textarea.isDestroyed) return
            textarea.newLine()
          },
        },
      ],
    }
  })

  onMount(() => {
    props.ctx.ui.dialog.set({ size: "large" })
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
  })

  return jsxs("box", {
    paddingLeft: 3,
    paddingRight: 3,
    paddingBottom: 1,
    gap: 1,
    children: [
      jsxs("box", {
        flexDirection: "row",
        justifyContent: "space-between",
        children: [
          jsx("text", { attributes: TextAttributes.BOLD, fg: theme.text.base, children: props.title }),
          jsx("text", { fg: theme.text.muted, children: "esc" }),
        ],
      }),
      jsx("textarea", {
        ref: (value: TextareaRenderable) => {
          textarea = value
          setTarget(value)
        },
        height: 6,
        wrapMode: "word",
        placeholder: props.placeholder,
        placeholderColor: theme.text.muted,
        textColor: theme.text.formfield.base,
        focusedTextColor: theme.text.formfield.base,
        cursorColor: theme.text.base,
      }),
      jsx("text", { fg: theme.text.muted, children: props.hint }),
    ],
  })
}

function promptText(ctx: Plugin.Context, options: { readonly title: string; readonly placeholder?: string }) {
  return new Promise<string | undefined>((resolve) => {
    let settled = false
    const done = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    ctx.ui.dialog.show(
      () =>
        createComponent(Editor, {
          ctx,
          title: options.title,
          placeholder: options.placeholder ?? "",
          hint: "enter submit · shift+enter newline · esc cancel",
          onSubmit: (value) => {
            done(value)
            ctx.ui.dialog.clear()
          },
        }),
      () => done(undefined),
    )
  })
}

export default Plugin.define({
  id: "oc-tempus",
  setup(ctx) {
    return ctx.ui.slot({ append: "app", render: () => createComponent(TempusHost, { ctx }) })
  },
})
