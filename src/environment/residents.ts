import { allowedEffects, createProposal, type Assessment, type Proposal } from "./proposals.ts"

export type Setting = { position: number; strength: number }

export type LogKind = "goal" | "message" | "action" | "result" | "error" | "rejected" | "say" | "done"
export type LogEntry = { kind: LogKind; text: string }

export type ResidentStatus = "thinking" | "waiting" | "running" | "idle" | "stopped"

/**
 * An agent that lives in a buffer until stopped: it works toward its goal one Lisp action at a time, then idles until a message wakes it.
 * Knobs and focus steer it while it runs; changing either while an action is being written or waiting for you writes the action again.
 */
export type Resident = {
  name: string
  buffer: string
  goal: string
  status: ResidentStatus
  log: LogEntry[]
  knobs: Record<string, Setting>
  focus: string[]
  proposal?: Proposal
}

/** Who an action runs for; `finished` is set by `(done ...)`. */
export type Actor = { name: string; buffer: string; resident?: Resident; finished?: string }

type ResidentsOptions = {
  /** Streams the next action for `context`, as Lisp source. */
  propose(context: unknown, signal: AbortSignal): AsyncIterable<string>
  /** What the model is told: the resident, its recent log, and the alternatives it already offered. */
  context(resident: Resident, avoid: string[]): unknown
  assess(code: string): Promise<Assessment>
  /** Runs approved code for `actor`, limited to `effects` (all, when undefined); resolves with what to show the agent next. */
  execute(code: string, actor: Actor, effects: string[] | undefined, signal: AbortSignal): Promise<{ text: string; isError: boolean }>
  /** Effects an action may have without asking. */
  granted: string[]
  onChange(): void
}

/** Actions per activation before the agent idles and waits to be told to go on. */
const MAX_STEPS = 8
const MAX_LOG = 200

export function createResidents({ propose, context, assess, execute, granted, onChange }: ResidentsOptions) {
  const residents = new Map<string, Resident>()
  const runtime = new Map<Resident, { controller: AbortController; inbox: string[]; wake?: () => void; restart: boolean; cancel?: () => void }>()
  const proposals = new Map<number, ReturnType<typeof createProposal>>()
  let nextProposal = 1

  return { list: () => [...residents.values()], start, send, stop, steer, focus, unfocus, proposal: (id: number) => proposals.get(id) }

  function start(name: string, buffer: string, goal: string) {
    const existing = residents.get(name)
    if (existing && existing.status !== "stopped") throw new Error(`agent ${name} is already running`)
    const resident: Resident = { name, buffer, goal, status: "thinking", log: [{ kind: "goal", text: goal }], knobs: {}, focus: [] }
    residents.set(name, resident)
    runtime.set(resident, { controller: new AbortController(), inbox: [], restart: false })
    onChange()
    live(resident)
    return resident
  }

  /** A message for the agent: it reads it with its next action, waking it if idle. */
  function send(name: string, text: string) {
    const resident = residents.get(name) ?? fail(`no agent ${name}`)
    const state = runtime.get(resident)!
    state.inbox.push(text)
    record(resident, "message", text)
    if (resident.status === "idle") state.wake?.()
    else rewrite(resident)
  }

  function stop(name: string) {
    const resident = residents.get(name) ?? fail(`no agent ${name}`)
    const state = runtime.get(resident)!
    resident.status = "stopped"
    state.controller.abort(new DOMException("stopped", "AbortError"))
    state.cancel?.()
    state.wake?.()
    onChange()
  }

  function steer(name: string, knob: string, setting: Setting) {
    const resident = residents.get(name) ?? fail(`no agent ${name}`)
    resident.knobs = { ...resident.knobs, [knob]: setting }
    rewrite(resident)
  }

  function focus(name: string, text: string) {
    const resident = residents.get(name) ?? fail(`no agent ${name}`)
    if (!text.trim() || resident.focus.includes(text)) return
    resident.focus = [...resident.focus, text]
    rewrite(resident)
  }

  function unfocus(name: string, text: string) {
    const resident = residents.get(name) ?? fail(`no agent ${name}`)
    resident.focus = resident.focus.filter((other) => other !== text)
    rewrite(resident)
  }

  /** Steering changed: an action still being written or awaiting a decision is written again under it. */
  function rewrite(resident: Resident) {
    const state = runtime.get(resident)!
    onChange()
    if (resident.status !== "thinking" && resident.status !== "waiting") return
    state.restart = true
    state.cancel?.()
  }

  async function live(resident: Resident) {
    const state = runtime.get(resident)!
    let hasWork = true
    while (resident.status !== "stopped") {
      if (!hasWork && !state.inbox.length) {
        resident.status = "idle"
        onChange()
        await new Promise<void>((resolve) => (state.wake = resolve))
        state.wake = undefined
        if (isStopped(resident)) return
      }
      hasWork = false
      for (let step = 0; step < MAX_STEPS && !isStopped(resident); step++) {
        const decision = await nextAction(resident)
        if (!decision) break
        if (decision.kind === "reject") {
          record(resident, "rejected", decision.note || "you rejected that action")
          continue
        }
        resident.status = "running"
        record(resident, "action", decision.code)
        const actor: Actor = { name: resident.name, buffer: resident.buffer, resident }
        const allowed = allowedEffects(await assess(decision.code), granted)
        try {
          const result = await execute(decision.code, actor, allowed, state.controller.signal)
          if (actor.finished !== undefined) {
            record(resident, "done", actor.finished)
            break
          }
          if (result.text || result.isError) record(resident, result.isError ? "error" : "result", result.text)
        } catch (error) {
          if (isStopped(resident)) return
          record(resident, "error", (error as Error).message)
        }
      }
    }
  }

  /** Proposes until there is a decision; steering cancels and restarts it. Undefined when the agent stopped. */
  async function nextAction(resident: Resident) {
    const state = runtime.get(resident)!
    while (resident.status !== "stopped") {
      state.restart = false
      const handle = createProposal({
        id: nextProposal++,
        actor: resident.name,
        generate: (_index, avoid, signal) => propose(context(resident, avoid), signal),
        assess,
        onChange,
      })
      proposals.set(handle.proposal.id, handle)
      resident.proposal = handle.proposal
      state.cancel = handle.cancel
      resident.status = "thinking"
      onChange()
      handle.write(0).then((first) => {
        if (handle.proposal.status !== "pending") return
        if (first && !first.needsApproval && !first.error) handle.approve()
        else {
          resident.status = "waiting"
          onChange()
        }
      })
      const decision = await handle.decision
      proposals.delete(handle.proposal.id)
      state.cancel = undefined
      if (decision.kind !== "cancel") {
        state.inbox.length = 0
        return decision
      }
      if (!state.restart) return
    }
  }

  function record(resident: Resident, kind: LogKind, text: string) {
    resident.log.push({ kind, text })
    if (resident.log.length > MAX_LOG) resident.log.splice(1, resident.log.length - MAX_LOG)
    onChange()
  }
}

/** Read through a call, as other calls change the status while this one awaits. */
function isStopped(resident: Resident) {
  return resident.status === "stopped"
}

function fail(message: string): never {
  throw new Error(message)
}
