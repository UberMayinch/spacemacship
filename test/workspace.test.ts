import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createAgentEnvironment } from "../src/agents/environment.ts"
import { simulatedModel } from "../src/agents/model.ts"
import { installModel } from "../src/llm/lisp-model.ts"
import { createLisp } from "../src/lisp/lisp.ts"
import { formsOf, withLocks } from "../src/workspace/compiler.ts"
import { createUnits } from "../src/workspace/units.ts"
import { installWorkspaceHost } from "../src/workspace/workspace-host.ts"

const WORKSPACE = readFileSync(new URL("../workspace.scm", import.meta.url), "utf8")

async function workspace() {
  const lisp = createLisp()
  await lisp.ready
  installModel(lisp, () => false)
  const env = createAgentEnvironment(lisp, () => simulatedModel)
  await env.ready
  installWorkspaceHost(lisp, env)
  const results = await lisp.evalText(WORKSPACE, "workspace.scm", { keepGoing: true })
  assert.deepEqual(
    results.flatMap(({ error, warnings }) => [...(error ? [error] : []), ...warnings]).map((error) => lisp.describeError(error)),
    [],
  )
  let controls: { dimension: unknown; position: number; strength: number }[] = []
  const units = createUnits({ lisp, controls: () => controls, environment: env.summary, onChange: () => {} })
  const settled = async () => {
    while (units.isBusy()) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const setControl = (name: string, position: number) => {
    const dimension = lisp.dimensions().find((d) => (d as { name: string }).name === name)
    controls = [...controls.filter((c) => c.dimension !== dimension), { dimension, position, strength: 1 }]
  }
  return { lisp, env, units, settled, setControl }
}

test("workspace.scm loads cleanly", async () => {
  await workspace()
})

test("paragraphs compile, check and load into tools and agents an agent run can use", async () => {
  const { env, units, settled } = await workspace()
  units.sync("A tool that shouts text.\n\nAn agent that uses shouts text to answer loudly.")
  await settled()
  assert.deepEqual(
    units.units().map(({ status }) => status),
    ["ready", "ready"],
  )
  assert.deepEqual(
    env.tools().map(({ name }) => name),
    ["ask-llm", "post-note", "read-notes", "shouts-text"],
  )
  const [agent] = env.agents()
  assert.deepEqual(agent.tools, ["shouts-text"])
  env.spawn(agent.name, "shout hello")
  while (env.runs()[0].status === "running") await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(env.runs()[0].steps.at(-1)!.text, "(sim) shouts-text: shout hello")
})

test("a knob change rewrites unlocked forms and keeps locked ones verbatim", async () => {
  const { lisp, units, settled, setControl } = await workspace()
  units.sync("A tool that shouts text. A tool that whispers text.")
  await settled()
  const [unit] = units.units()
  const before = formsOf(unit.loaded!.code)
  units.toggleLock(unit, "whispers-text")
  setControl("reach", 0.5)
  units.recompileAll()
  await settled()
  const after = formsOf(unit.loaded!.code)
  assert.equal(after.find((form) => form.name === "whispers-text")!.text, before.find((form) => form.name === "whispers-text")!.text)
  assert.match(after.find((form) => form.name === "shouts-text")!.text, /ask-llm/)
  assert.equal(unit.versions.length, 2)
  await units.step(unit, -1)
  assert.doesNotMatch(String(lisp.binding("shouts-text")?.source), /ask-llm/)
})

test("code that fails to load goes back to the compiler with its errors, and the repaired code loads", async () => {
  const { lisp, env, units, settled } = await workspace()
  await lisp.evalText(
    `(define-source (compile-intent request)
       (: CompileRequest -> (Stream String) ! (time))
       (if (has-key? request :repair)
           (stream "(define-tool (shout text) (: String -> String ! pure) \\"Shouts.\\" (string-upcase text))")
           (stream "(define-tool (shout text) (string-upcase text))")))`,
    "test.scm",
  )
  units.sync("A tool that shouts.")
  await settled()
  const [unit] = units.units()
  assert.equal(unit.status, "ready")
  assert.equal(env.tools().at(-1)!.name, "shout")
})

test("code that never checks is not loaded, and the error is kept", async () => {
  const { lisp, units, settled } = await workspace()
  await lisp.evalText(`(define-source (compile-intent request) (stream "(define (f) (+ 1 \\"x\\"))"))`, "test.scm")
  units.sync("Anything.")
  await settled()
  const [unit] = units.units()
  assert.equal(unit.status, "failed")
  assert.match(unit.errors[0], /argument 2 of \+ should be Number/)
  assert.equal(lisp.has("f"), false)
})

test("removing a paragraph unloads what it defined; frozen units are not recompiled", async () => {
  const { lisp, units, settled, setControl } = await workspace()
  units.sync("A tool that shouts text.\n\nA tool that whispers text.")
  await settled()
  const [first] = units.units()
  units.toggleFreeze(first)
  setControl("reach", 0.5)
  units.recompileAll()
  await settled()
  assert.equal(first.versions.length, 1)
  units.sync("A tool that shouts text.")
  await settled()
  assert.equal(lisp.has("whispers-text"), false)
  assert.equal(lisp.has("shouts-text"), true)
})

test("locked forms the model dropped are put back", () => {
  const locked = '(define-tool (keep x) (: String -> String ! pure) "" x)'
  assert.equal(withLocks("(define (other) 1)", [locked]), `${locked}\n\n(define (other) 1)`)
  assert.equal(withLocks('(define-tool (keep y) (: Any -> String ! pure) "" "changed")', [locked]), locked)
})

test("a generated form that loops forever is stopped, repaired, and the next paragraph still compiles", async () => {
  const { lisp, units, settled } = await workspace()
  await lisp.evalText(
    `(define-source (compile-intent request)
       (: CompileRequest -> (Stream String) ! (time))
       (cond ((has-key? request :repair) (stream "(define-tool (fixed x) (: String -> String ! pure) \\"Fixed.\\" x)"))
             ((string-contains? (:intent request) "loop") (stream "(define stuck (let spin () (spin)))"))
             (else (stream "(define-tool (other x) (: String -> String ! pure) \\"Other.\\" x)"))))`,
    "test.scm",
  )
  const started = performance.now()
  units.sync("Something that loops.\n\nSomething else.")
  await settled()
  assert.deepEqual(
    units.units().map(({ status }) => status),
    ["ready", "ready"],
  )
  assert.equal(lisp.has("stuck"), false)
  assert.equal(lisp.has("fixed"), true)
  assert.equal(lisp.has("other"), true)
  assert.ok(performance.now() - started < 6000)
})
