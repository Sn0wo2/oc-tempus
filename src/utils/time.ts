import { Temporal } from "temporal-polyfill"
import { z } from "zod"

const DURATION_PART = /^(\d+(?:\.\d+)?|\.\d+)([smhdw])/i
const ISO_TIMESTAMP = z.union([z.iso.datetime({ offset: true }), z.iso.datetime({ offset: true, precision: -1 })])
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})/
const CLOCK_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const DURATION_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

function parseDuration(value: string, now: number) {
  let remaining = value
  let duration = 0
  while (remaining) {
    const match = DURATION_PART.exec(remaining)
    if (!match) return undefined
    const multiplier = DURATION_MS[match[2]?.toLowerCase() ?? ""]
    if (multiplier === undefined) return undefined
    duration += Number(match[1]) * multiplier
    if (!Number.isFinite(duration)) return undefined
    remaining = remaining.slice(match[0].length).trimStart()
  }
  return duration > 0 ? Math.ceil(now + duration) : undefined
}

function wallTime(date: { year: number; month: number; day: number; hour: number; minute: number; second: number }) {
  try {
    return Temporal.PlainDateTime.from(date, { overflow: "reject" }).toZonedDateTime(Temporal.Now.timeZoneId(), {
      disambiguation: "reject",
    }).epochMilliseconds
  } catch {
    return undefined
  }
}

function parseLocal(value: string, now: number) {
  const clock = CLOCK_TIME.exec(value)
  if (clock) {
    const time = { hour: Number(clock[1]), minute: Number(clock[2]), second: Number(clock[3] ?? 0) }
    const day = new Date(now)
    const at = time.hour * 3_600_000 + time.minute * 60_000 + time.second * 1000
    if (at <= day.getHours() * 3_600_000 + day.getMinutes() * 60_000 + day.getSeconds() * 1000)
      day.setDate(day.getDate() + 1)
    return wallTime({ ...time, year: day.getFullYear(), month: day.getMonth() + 1, day: day.getDate() })
  }
  const stamp = LOCAL_DATE_TIME.exec(value)
  if (!stamp) return undefined
  return wallTime({
    year: Number(stamp[1]),
    month: Number(stamp[2]),
    day: Number(stamp[3]),
    hour: Number(stamp[4] ?? 0),
    minute: Number(stamp[5] ?? 0),
    second: Number(stamp[6] ?? 0),
  })
}

export function parseWhen(input: string, now = Date.now()) {
  const value = input.trim()
  const calendar = CALENDAR_DATE.exec(value)
  let timestamp = parseDuration(value, now) ?? parseLocal(value, now)
  if (
    timestamp === undefined &&
    calendar &&
    Number(calendar[3]) <= new Date(Number(calendar[1]), Number(calendar[2]), 0).getDate() &&
    !value.endsWith("-00:00") &&
    ISO_TIMESTAMP.safeParse(value.toUpperCase()).success
  ) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) timestamp = parsed
  }
  if (timestamp === undefined) {
    throw new Error(
      "Use a duration (3h, 1h30m), a clock time (18:00), a local date and time (2026-11-06 18:00), or an ISO timestamp with a timezone.",
    )
  }
  if (!Number.isFinite(now) || timestamp <= now) throw new Error("The time must be in the future.")
  if (!Number.isInteger(timestamp) || timestamp <= 0 || timestamp > 8_640_000_000_000_000) {
    throw new Error("The time is outside the supported date range.")
  }
  return timestamp
}
