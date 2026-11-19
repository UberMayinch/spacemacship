/** What the checker says about an alternative before it may run. */
export type Assessment = { effects: string[]; needsApproval: boolean; error?: string }

export type Alternative = { code: string; isWriting: boolean } & Partial<Assessment>

export type ProposalStatus = "writing" | "pending" | "approved" | "rejected" | "cancelled"

export type Proposal = { id: number; actor: string; alternatives: Alternative[]; index: number; status: ProposalStatus }

export type Decision = { kind: "approve"; code: string } | { kind: "reject"; note: string } | { kind: "cancel" }

type ProposalOptions = {
  id: number
  actor: string
  /** Streams the source of alternative number `index`; `avoid` holds the ones already offered, so the next differs. */
  generate(index: number, avoid: string[], signal: AbortSignal): AsyncIterable<string>
  assess(code: string): Promise<Assessment>
  onChange(): void
}

/**
 * A next action offered as Lisp, with alternatives you can scrub through before choosing. Alternatives are written on demand: scrubbing past
 * the last one asks for another. Each is checked as it completes, so what it would do (its effects) is known before anything runs.
 */
export function createProposal({ id, actor, generate, assess, onChange }: ProposalOptions) {
  const proposal: Proposal = { id, actor, alternatives: [], index: 0, status: "writing" }
  let writing: AbortController | undefined
  let settle: (decision: Decision) => void = () => {}
  const decision = new Promise<Decision>((resolve) => (settle = resolve))

  return { proposal, decision, write, scrub, approve, reject, cancel }

  /** Writes alternative `index`, unless it is already there; resolves once it is checked. */
  async function write(index = proposal.alternatives.length): Promise<Alternative | undefined> {
    if (proposal.alternatives[index]) return proposal.alternatives[index]
    writing?.abort()
    const controller = (writing = new AbortController())
    const alternative: Alternative = { code: "", isWriting: true }
    proposal.alternatives[index] = alternative
    proposal.index = index
    proposal.status = "writing"
    onChange()
    try {
      const avoid = proposal.alternatives.slice(0, index).map(({ code }) => code)
      for await (const chunk of generate(index, avoid, controller.signal)) {
        alternative.code += chunk
        onChange()
      }
      alternative.code = firstForms(alternative.code)
      Object.assign(alternative, await assess(alternative.code), { isWriting: false })
      if (proposal.status === "writing") proposal.status = "pending"
      onChange()
      return alternative
    } catch (error) {
      if (controller.signal.aborted) return
      Object.assign(alternative, { isWriting: false, effects: [], needsApproval: true, error: (error as Error).message })
      if (proposal.status === "writing") proposal.status = "pending"
      onChange()
      return alternative
    } finally {
      if (writing === controller) writing = undefined
    }
  }

  function scrub(delta: number) {
    if (proposal.status !== "pending" && proposal.status !== "writing") return
    const index = Math.max(0, proposal.index + delta)
    if (index < proposal.alternatives.length) {
      proposal.index = index
      onChange()
    } else if (!writing) write(index)
  }

  /** Runs the shown alternative, or `edited` code in its place. */
  function approve(edited?: string) {
    const current = proposal.alternatives[proposal.index]
    if (proposal.status !== "pending" || (!current && !edited)) return
    proposal.status = "approved"
    onChange()
    settle({ kind: "approve", code: edited ?? current.code })
  }

  function reject(note = "") {
    if (proposal.status !== "pending" && proposal.status !== "writing") return
    writing?.abort()
    proposal.status = "rejected"
    onChange()
    settle({ kind: "reject", note })
  }

  function cancel() {
    writing?.abort()
    if (proposal.status === "approved" || proposal.status === "rejected") return
    proposal.status = "cancelled"
    onChange()
    settle({ kind: "cancel" })
  }
}

/**
 * The effects an approved action may use: the granted ones plus what the checker saw it use. When it calls something the checker could not
 * follow, approving it grants everything, since you approved the code as written.
 */
export function allowedEffects({ effects, needsApproval, error }: Assessment, granted: string[]) {
  if (error) return [...granted]
  return needsApproval && effects.every((effect) => granted.includes(effect)) ? undefined : [...new Set([...granted, ...effects])]
}

/** Models sometimes wrap code in fences or add a sentence; keeps the text from the first form on, without fences. */
function firstForms(text: string) {
  const unfenced = text
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
  const start = unfenced.indexOf("(")
  return (start === -1 ? unfenced : unfenced.slice(start)).trim()
}
