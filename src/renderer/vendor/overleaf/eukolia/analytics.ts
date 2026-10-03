/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/eukolia/analytics`.
 *
 * Overleaf reports editor usage to its analytics pipeline. Eukolia is a local
 * desktop application with no telemetry backend, so events are recorded in a
 * bounded in-memory ring buffer instead: nothing is sent anywhere, but call
 * sites (`sendMB`, `sendSearchEvent`) keep working and remain inspectable,
 * which is also what the tests assert against.
 */

export interface AnalyticsEvent {
  name: string
  payload: Record<string, unknown>
  timestamp: number
}

const MAX_EVENTS = 500
const events: AnalyticsEvent[] = []

/** Record an event. Never throws: analytics must not break editing. */
export function sendMB(name: string, payload: Record<string, unknown> = {}): void {
  try {
    events.push({ name, payload, timestamp: Date.now() })
    if (events.length > MAX_EVENTS) events.shift()
  } catch {
    // ignore
  }
}

/** Alias used by the search extension. */
export const sendSearchEvent = sendMB

/** Record a page/segment view; same store as `sendMB`. */
export function sendEvent(name: string, payload: Record<string, unknown> = {}): void {
  sendMB(name, payload)
}

/** Recorded events, oldest first. */
export function getAnalyticsEvents(): readonly AnalyticsEvent[] {
  return events
}

/** Remove every recorded event. */
export function clearAnalyticsEvents(): void {
  events.length = 0
}
