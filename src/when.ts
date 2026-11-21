import type { Trigger } from "./trigger.ts"
import { parseWhen } from "./utils/time.ts"

export interface Claim {
  readonly trigger: Trigger
  readonly rest: string
}

export interface ClaimContext {
  readonly sessions: () => readonly { readonly id: string; readonly title?: string }[]
}

const SPLIT = /\s+/

const SESSION_ID = /^ses_[0-9a-z-]{16,}$/i

function claimTime(input: string): Claim | undefined {
  const parts = input.trim().split(SPLIT).filter(Boolean)
  for (let count = parts.length; count > 0; count--) {
    try {
      return {
        trigger: { kind: "time", at: parseWhen(parts.slice(0, count).join(" ")) },
        rest: parts.slice(count).join(" "),
      }
    } catch {}
  }
  return undefined
}

function claimSession(input: string, context: ClaimContext): Claim | undefined {
  const parts = input.trim().split(SPLIT).filter(Boolean)
  const sessions = context.sessions()
  for (let count = parts.length; count > 0; count--) {
    const value = parts.slice(0, count).join(" ").toLowerCase()
    const pool = value.startsWith("ses_")
      ? sessions.filter((session) => session.id.toLowerCase().startsWith(value))
      : sessions.filter((session) => (session.title ?? "").trim().toLowerCase() === value)
    if (pool.length > 1) return undefined
    const match = pool[0]
    if (match) return { trigger: { kind: "session.idle", sessionID: match.id }, rest: parts.slice(count).join(" ") }
  }
  return undefined
}

function claimSessionID(input: string, context: ClaimContext): Claim | undefined {
  const [first = "", ...rest] = input.trim().split(SPLIT).filter(Boolean)
  const value = first.toLowerCase()
  if (!SESSION_ID.test(value)) return undefined
  if (context.sessions().filter((session) => session.id.toLowerCase().startsWith(value)).length > 1) return undefined
  return { trigger: { kind: "session.idle", sessionID: first }, rest: rest.join(" ") }
}

export function claimTrigger(input: string, context: ClaimContext): Claim | undefined {
  for (const claimer of [claimTime, claimSession, claimSessionID]) {
    const claim = claimer(input, context)
    if (claim) return claim
  }
  return undefined
}
