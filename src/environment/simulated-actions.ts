import { simulatedCode } from "../workspace/workspace-host.ts"

type Entry = { kind: string; text: string }
type Control = { dimension: { name: string; options?: string[]; low?: string; high?: string }; position: number; strength: number }

export type ActionContext = {
  name: string
  goal: string
  buffer: string
  "is-terminal": boolean
  log: Entry[]
  focus: string[]
  controls: Control[]
  avoid: string[]
}

/**
 * Plays a resident agent without a model: run the command its goal or latest message names (in `backticks`, or guessed), report the
 * result, then finish. Alternatives cycle through other ways to do the same step, so scrubbing shows real choices.
 */
export function simulatedAction({ goal, "is-terminal": isTerminal, log, focus, controls, avoid }: ActionContext) {
  const since = log.slice(log.findLastIndex(({ kind }) => kind === "goal" || kind === "message"))
  const instruction = since[0]?.text ?? goal
  const command = commandIn(instruction) ?? commandIn(goal) ?? guessCommand(`${instruction} ${goal}`)
  const actions = since.filter(({ kind }) => kind === "action").length
  const isChatty = controls.some(({ dimension, position }) => dimension.name === "verbosity" && position > 0.6)
  const lastResult = since.findLast(({ kind }) => kind === "result" || kind === "error")?.text ?? ""
  const step = [
    isTerminal ? `(shell ${quoted(command)})` : `(say ${quoted(`I need a terminal to run ${command}`)})`,
    `(say ${quoted(`${command}: ${firstLine(lastResult)}${isChatty ? ` (${lastResult.split("\n").length} lines of output)` : ""}`)})`,
    `(done ${quoted(`Ran ${command}${focus.length ? `, focusing on ${focus.map((text) => `"${text.slice(0, 40)}"`).join(", ")}` : ""}.`)})`,
  ][Math.min(actions, 2)]
  if (!avoid.length) return step
  const alternatives = [`(shell ${quoted(`${command} 2>&1 | tail -n 20`)})`, `(say ${quoted(`Next I would run ${command}.`)})`, `(shell "pwd")`]
  return alternatives[(avoid.length - 1) % alternatives.length]
}

/**
 * Plays the scratch interpreter without a model: opening terminals and notes, starting agents in them, running a `command`, and defining
 * tools and agents (through the workspace's stand-in compiler). Several requests in one sentence become one `begin`.
 */
export function simulatedInterpretation(request: string, terminals: string[]) {
  let lastTerminal = terminals.at(-1)
  const forms = clausesOf(request).map((clause) => {
    const named = clause.match(/\b(?:called|named)\s+["']?([\w*-]+)/i)?.[1]
    if (/\bopen\b.*\bterminal\b|\bnew terminal\b/i.test(clause)) {
      lastTerminal = named ?? "term"
      return `(open-terminal ${quoted(lastTerminal)})`
    }
    if (/\b(open|new|create)\b.*\b(notes?|buffer)\b/i.test(clause)) return `(new-buffer ${quoted(named ?? "notes")})`
    if (/\b(start|launch|spawn|put|run)\b.*\bagent\b/i.test(clause)) {
      const buffer = clause.match(/\b(?:in|on|at)\s+(?:the\s+)?([\w*-]+)/i)?.[1] ?? lastTerminal ?? "*scratch*"
      const goal = clause.match(/\b(?:that|to|which)\s+(.+)$/i)?.[1] ?? clause
      return `(start-agent '${named ?? "agent"} ${quoted(buffer)} ${quoted(goal)})`
    }
    const command = commandIn(clause)
    if (command) return `(shell-in ${quoted(clause.match(/\bin\s+([\w*-]+)/i)?.[1] ?? lastTerminal ?? "term")} ${quoted(command)})`
    if (/\b(tool|agent)\b/i.test(clause)) return simulatedCode({ intent: clause, controls: [] }, [], [])
    return `(say ${quoted(`(sim) I can open terminals and notes, start agents, run \`commands\` and define tools; not: ${clause}`)})`
  })
  return forms.length === 1 ? forms[0] : `(begin\n  ${forms.join("\n  ")})`
}

function clausesOf(request: string) {
  return request
    .split(/(?<=[.;!?])\s+|,?\s+(?:and\s+)?then\s+|,?\s+and\s+(?=(?:open|start|launch|spawn|put|run|create|make|define|send)\b)/i)
    .map((clause) => clause.trim())
    .filter((clause) => /[a-z]/i.test(clause))
}

function commandIn(text: string) {
  return text.match(/`([^`]+)`/)?.[1]
}

function guessCommand(text: string) {
  if (/\btests?\b/i.test(text)) return "npm test"
  if (/\bgit\b|\bstatus\b|\bchanges?\b/i.test(text)) return "git status --short"
  if (/\bdisk\b|\bspace\b/i.test(text)) return "df -h ."
  return "ls"
}

function firstLine(text: string) {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.slice(0, 120) ?? "no output"
  )
}

function quoted(text: string) {
  return JSON.stringify(text)
}
