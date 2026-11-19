import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { nodeShell } from "../server/node-shell.ts"
import type { Shell } from "../src/environment/buffers.ts"
import { createEnvironment, type Environment } from "../src/environment/environment.ts"

const CONFIG = readFileSync(new URL("../environment.scm", import.meta.url), "utf8")

/** Records every command and answers with canned output; `cd x` moves the directory. */
function scriptedShell() {
  const commands: { command: string; cwd: string }[] = []
  const shell: Shell = async ({ command, cwd, onOutput }) => {
    commands.push({ command, cwd })
    onOutput(`ran ${command}\n`)
    return { exitCode: command.includes("fail") ? 1 : 0, cwd: command.startsWith("cd ") ? `${cwd}/${command.slice(3)}` : cwd }
  }
  return { shell, commands }
}

async function environment(shell: Shell = scriptedShell().shell, home = "/home/test") {
  const env = await createEnvironment({ shell, home, config: CONFIG, onChange: () => {} })
  assert.deepEqual(env.loaded, [])
  return env
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const scratch = (env: Environment) => env.buffers.get("*scratch*")!.text
const resident = (env: Environment, name: string) => env.residents.list().find((agent) => agent.name === name)!

test("Lisp typed in *scratch* runs as typed", async () => {
  const env = await environment()
  await env.command({ type: "input", buffer: "*scratch*", text: "(+ 1 2)" })
  await until(() => scratch(env).includes("=> 3"))
})

test("a request in plain language becomes Lisp that opens a terminal and starts an agent in it, without asking", async () => {
  const { shell, commands } = scriptedShell()
  const env = await environment(shell)
  await env.command({ type: "input", buffer: "*scratch*", text: "open a terminal called tests and start an agent called tester in tests that runs `npm test`" })
  await until(() => env.residents.list().length === 1)
  assert.match(scratch(env), /\(open-terminal "tests"\)/)
  assert.match(scratch(env), /\(start-agent 'tester "tests" "runs `npm test`"\)/)
  const tester = resident(env, "tester")
  await until(() => tester.status === "waiting")
  assert.equal(tester.proposal!.alternatives[0].code, '(shell "npm test")')
  assert.deepEqual(tester.proposal!.alternatives[0].effects, ["shell"])
  assert.equal(commands.length, 0)
  await env.command({ type: "approve", proposal: tester.proposal!.id })
  await until(() => tester.status === "idle")
  assert.deepEqual(commands, [{ command: "npm test", cwd: "/home/test" }])
  assert.match(env.buffers.get("tests")!.text, /\/home\/test \$ npm test\nran npm test/)
  assert.deepEqual(
    tester.log.map(({ kind }) => kind),
    ["goal", "action", "result", "action", "say", "action", "done"],
  )
})

test("scrubbing writes alternatives; rejecting with a note makes the agent try something else", async () => {
  const env = await environment()
  await env.command({ type: "open", kind: "terminal", name: "t" })
  await env.command({ type: "input", buffer: "*scratch*", text: '(start-agent \'a "t" "list the files")' })
  const agent = await until(() => env.residents.list().length === 1).then(() => resident(env, "a"))
  await until(() => agent.status === "waiting")
  const first = agent.proposal!
  await env.command({ type: "scrub", proposal: first.id, delta: 1 })
  await until(() => first.alternatives.length === 2 && !first.alternatives[1].isWriting)
  assert.equal(first.index, 1)
  assert.equal(first.alternatives[1].code, '(shell "ls 2>&1 | tail -n 20")')
  await env.command({ type: "scrub", proposal: first.id, delta: -1 })
  assert.equal(first.index, 0)
  await env.command({ type: "reject", proposal: first.id, note: "not now" })
  await until(() => agent.proposal !== first && agent.status === "waiting")
  assert.equal(agent.log.at(-1)!.text, "not now")
})

test("turning a knob while an action waits writes it again under the new setting", async () => {
  const env = await environment()
  await env.command({ type: "open", kind: "terminal", name: "t" })
  await env.command({ type: "input", buffer: "*scratch*", text: '(start-agent \'a "t" "run `make`")' })
  await until(() => env.residents.list().length === 1)
  const agent = resident(env, "a")
  await until(() => agent.status === "waiting")
  const before = agent.proposal!
  await env.command({ type: "steer", agent: "a", knob: "verbosity", position: 0.9, strength: 0.9 })
  assert.equal(before.status, "cancelled")
  await until(() => agent.proposal !== before && agent.status === "waiting")
  assert.deepEqual(agent.knobs.verbosity, { position: 0.9, strength: 0.9 })
  await env.command({ type: "focus", agent: "a", text: "the linker error" })
  await until(() => agent.status === "waiting" && agent.focus.length === 1)
})

test("an agent's actions are checked before they run: pure ones run at once, shell waits, and a stopped agent stops", async () => {
  const { shell, commands } = scriptedShell()
  const env = await environment(shell)
  await env.command({ type: "input", buffer: "*scratch*", text: '(start-agent \'chat "*scratch*" "say hello")' })
  await until(() => env.residents.list().length === 1)
  const chat = resident(env, "chat")
  await until(() => chat.status === "idle")
  assert.deepEqual(
    chat.log.map(({ kind }) => kind),
    ["goal", "action", "say", "action", "say", "action", "done"],
  )
  await env.command({ type: "open", kind: "terminal", name: "t" })
  await env.command({ type: "message", agent: "chat", text: "now `rm -rf build` in t" })
  await env.command({ type: "stop", agent: "chat" })
  assert.equal(chat.status, "stopped")
  assert.equal(commands.length, 0)
})

test("a request that would use the shell waits for approval in *scratch*", async () => {
  const { shell, commands } = scriptedShell()
  const env = await environment(shell)
  await env.command({ type: "open", kind: "terminal", name: "t" })
  await env.command({ type: "input", buffer: "*scratch*", text: "run `echo hi` in t" })
  await until(() => env.snapshot().requests.at(-1)?.proposal.status === "pending")
  const { proposal } = env.snapshot().requests.at(-1)!
  assert.equal(proposal.alternatives[0].needsApproval, true)
  assert.equal(commands.length, 0)
  await env.command({ type: "approve", proposal: proposal.id })
  await until(() => commands.length === 1)
  assert.equal(commands[0].command, "echo hi")
})

test("agents can extend the environment with tools, checked like everything else", async () => {
  const env = await environment()
  await env.command({ type: "input", buffer: "*scratch*", text: "a tool that shouts text" })
  await until(() => env.snapshot().tools.some((tool) => tool.startsWith("shouts-text")))
})

test("the real shell streams output, reports exit codes, and keeps the directory across commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "spacemacship-"))
  const env = await environment(nodeShell, home)
  await env.command({ type: "open", kind: "terminal", name: "t" })
  await env.command({ type: "input", buffer: "t", text: "mkdir sub && cd sub && echo inside" })
  await until(() => env.buffers.get("t")!.running === undefined && env.buffers.get("t")!.text.includes("inside"))
  await env.command({ type: "input", buffer: "t", text: "pwd; exit 3" })
  await until(() => env.buffers.get("t")!.text.includes("[exit 3]"))
  assert.match(env.buffers.get("t")!.text, new RegExp(`${join(home, "sub")}\\n\\[exit 3\\]`))
  assert.equal(env.buffers.get("t")!.cwd, join(home, "sub"))
})

test("interrupting a terminal stops the command", async () => {
  const env = await environment(nodeShell, await mkdtemp(join(tmpdir(), "spacemacship-")))
  await env.command({ type: "open", kind: "terminal", name: "t" })
  await env.command({ type: "input", buffer: "t", text: "sleep 30" })
  await until(() => env.buffers.get("t")!.running === "sleep 30")
  await env.command({ type: "interrupt", buffer: "t" })
  await until(() => env.buffers.get("t")!.text.includes("[interrupted]"))
})

test("a task agent started by an agent cannot use the shell without approval", async () => {
  const { shell, commands } = scriptedShell()
  const env = await environment(shell)
  await env.command({ type: "open", kind: "terminal", name: "t" })
  await env.command({ type: "input", buffer: "*scratch*", text: '(define-tool (sh cmd) (: String -> String ! (shell)) "Runs a command." (shell-in "t" cmd))' })
  await env.command({ type: "input", buffer: "*scratch*", text: '(define-agent runner "" {:instructions "Run it." :tools [sh]})' })
  await until(() => env.snapshot().agents.includes("runner"))
  // An agent's action runs with the granted effects only; this evaluates as one would.
  const results = await env.lisp.evalText('(run-agent \'runner "rm -rf /")', "test", { effects: ["llm", "store", "ui", "time"] })
  assert.match(String(results[0].value), /sh needs the shell effect/)
  assert.equal(commands.length, 0)
  await assert.doesNotReject(
    env.lisp.evalText('(eval \'(shell-in "t" "ls"))', "test", { effects: ["ui"] }).then((r) => assert.match(r[0].error!.message, /shell-in has effect shell/)),
  )
  assert.equal(commands.length, 0)
})

test("checking an action cannot run it, even through a macro", async () => {
  const { shell, commands } = scriptedShell()
  const env = await environment(shell)
  await env.command({ type: "open", kind: "terminal", name: "t" })
  await env.lisp.evalText('(define-macro (sneak) (shell-in "t" "touch pwned") 1)', "test")
  const report = await env.lisp.checkText("(sneak)", "proposal")
  assert.match(report.errors[0].message, /shell-in has effect shell/)
  assert.equal(commands.length, 0)
})

test("interrupt stops a command an agent started, and your next command runs", async () => {
  const env = await environment(nodeShell, await mkdtemp(join(tmpdir(), "spacemacship-")))
  await env.command({ type: "open", kind: "terminal", name: "t" })
  await env.command({ type: "input", buffer: "*scratch*", text: '(start-agent \'sleeper "t" "run `sleep 30`")' })
  await until(() => env.residents.list().length === 1)
  const sleeper = resident(env, "sleeper")
  await until(() => sleeper.status === "waiting")
  await env.command({ type: "approve", proposal: sleeper.proposal!.id })
  await until(() => env.buffers.get("t")!.running === "sleep 30")
  await env.command({ type: "interrupt", buffer: "t" })
  await until(() => sleeper.log.some(({ kind, text }) => kind === "error" && text.includes("interrupted")))
  await env.command({ type: "stop", agent: "sleeper" })
  await env.command({ type: "input", buffer: "t", text: "echo after" })
  await until(() => env.buffers.get("t")!.text.includes("after\n"))
  assert.match(env.buffers.get("t")!.text, /\[interrupted\]/)
})
