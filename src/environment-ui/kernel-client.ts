import type { Command, Environment } from "../environment/environment.ts"

export type Snapshot = ReturnType<Environment["snapshot"]>

/**
 * The page's line to the kernel process: snapshots arrive as server-sent events (the browser reconnects on its own if the kernel restarts),
 * commands go out as JSON posts. `onStatus` reports whether the kernel is reachable.
 */
export function connectKernel(onSnapshot: (snapshot: Snapshot) => void, onStatus: (isConnected: boolean) => void) {
  const events = new EventSource("/kernel/events")
  events.onmessage = (event) => {
    onStatus(true)
    onSnapshot(JSON.parse(event.data) as Snapshot)
  }
  events.onerror = () => onStatus(false)
  return { send }

  /** Resolves with the command's result; rejects with the kernel's error message. */
  async function send(command: Command): Promise<unknown> {
    const response = await fetch("/kernel/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) })
    const body = (await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` }))) as { result?: unknown; error?: string }
    if (!response.ok) throw new Error(body.error ?? `${response.status}`)
    return body.result
  }
}
