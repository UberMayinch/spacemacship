import assert from "node:assert/strict"
import { test } from "node:test"
import { createAgentEnvironment } from "../src/agents/environment.ts"
import { simulatedModel, type AgentModel, type ModelTurn } from "../src/agents/model.ts"
import type { ChatMessage, ToolSpec } from "../src/llm/cerebras.ts"
import { createLisp } from "../src/lisp/lisp.ts"

async function environment(model: AgentModel = simulatedModel) {
  const lisp = createLisp()
  await lisp.ready
  const env = createAgentEnvironment(lisp, () => model)
  await env.ready
  const run = async (source: string) => {
    const results = await lisp.evalText(source, "test.scm")
    const failure = results.find(({ error }) => error)?.error
    if (failure) throw failure
    return results.at(-1)?.value
  }
  return { lisp, env, run }
}

/** Plays back turns in order, recording what the model was shown each time. */
function scripted(turns: ((seen: { messages: ChatMessage[]; tools: ToolSpec[] }) => Omit<ModelTurn, "raw">)[]) {
  const seen: { messages: ChatMessage[]; tools: ToolSpec[] }[] = []
  const model: AgentModel = async (request) => {
    seen.push(structuredClone(request))
    const turn = turns[seen.length - 1](request)
    return {
      ...turn,
      raw: {
        role: "assistant",
        content: turn.content,
        tool_calls: turn.toolCalls.map(({ id, name, args }) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })),
      },
    }
  }
  return { model, seen }
}

test("a tool's signature becomes the schema the model sees", async () => {
  const { env, run } = await environment()
  await run(`(define-schema Place {:city String :days Number})
             (define-tool (plan-trip place budget?) (: Place Bool -> String ! pure) "Plans a trip." (str (:city place)))`)
  const [tool] = env.tools()
  assert.equal(tool.apiName, "plan-trip")
  const { lisp } = await environment()
  void lisp
  const { parametersOf } = await import("../src/agents/tool-schema.ts")
  assert.deepEqual(
    parametersOf(tool.params, tool.signature, () => ({ t: "record", fields: [{ key: "city", type: { t: "string" }, isOptional: false }] })),
    {
      type: "object",
      properties: { place: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, "budget?": { type: "boolean" } },
      required: ["place", "budget?"],
      additionalProperties: false,
    },
  )
})

test("tools need a signature with effects", async () => {
  const { run } = await environment()
  await assert.rejects(run("(define-tool (shout s) (string-upcase s))"), /needs a signature/)
  await assert.rejects(run("(define-tool (shout s) (: String -> String) (string-upcase s))"), /must declare its effects/)
})

test("an agent calls a Lisp tool, sees the result, and answers", async () => {
  const { model, seen } = scripted([
    () => ({ content: null, toolCalls: [{ id: "1", name: "shout", args: { text: "hi" } }] }),
    ({ messages }) => ({ content: `done: ${messages.at(-1)!.content}`, toolCalls: [] }),
  ])
  const { env, run } = await environment(model)
  await run(`(define-tool (shout text) (: String -> String ! pure) "Upper-cases text." (string-upcase text))
             (define-agent loud "Shouts things." {:instructions "Shout what you are given." :tools [shout]})`)
  assert.equal(await run('(run-agent \'loud "say hi")'), "done: HI")
  assert.equal(seen[0].tools[0].function.name, "shout")
  assert.deepEqual(
    env.runs()[0].steps.map(({ kind }) => kind),
    ["call", "result", "answer"],
  )
  assert.equal(env.runs()[0].status, "done")
})

test("a tool's declared effects are checked at definition, and enforced when an agent calls it", async () => {
  const { model } = scripted([
    () => ({ content: null, toolCalls: [{ id: "1", name: "sneaky", args: { text: "x" } }] }),
    ({ messages }) => ({ content: String(messages.at(-1)!.content), toolCalls: [] }),
  ])
  const { run } = await environment(model)
  await run(`(define (helper t) (board-post! "notes" t))`)
  await assert.rejects(run(`(define-tool (sneaky text) (: String -> String ! pure) "" (helper text))`), /sneaky uses effect store but declares ! pure/)
  await run(`(define hooks {:post board-post!})
             (define-tool (sneaky text) (: String -> String ! pure) "Hides the call from the checker." ((:post hooks) "notes" text))
             (define-agent a "" {:instructions "Use sneaky." :tools [sneaky]})`)
  assert.match(String(await run('(run-agent \'a "go")')), /error: board-post! has effect store, which this scope does not declare/)
})

test("agents delegate to agents, and the sub-run is linked to its parent", async () => {
  const { model } = scripted([
    () => ({ content: null, toolCalls: [{ id: "1", name: "loud", args: { task: "hello" } }] }),
    () => ({ content: null, toolCalls: [{ id: "2", name: "shout", args: { text: "hello" } }] }),
    ({ messages }) => ({ content: String(messages.at(-1)!.content), toolCalls: [] }),
    ({ messages }) => ({ content: `boss heard ${messages.at(-1)!.content}`, toolCalls: [] }),
  ])
  const { env, run } = await environment(model)
  await run(`(define-tool (shout text) (: String -> String ! pure) "Upper-cases text." (string-upcase text))
             (define-agent loud "Shouts." {:instructions "Shout." :tools [shout]})
             (define-agent boss "Delegates." {:instructions "Delegate." :tools [loud]})`)
  assert.equal(await run('(run-agent \'boss "greet")'), "boss heard HELLO")
  const [boss, loud] = env.runs()
  assert.equal(loud.parent, boss.id)
})

test("stopping a run aborts its model call", async () => {
  const model: AgentModel = (_request, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
  const { env, run } = await environment(model)
  await run(`(define-agent idle "" {:instructions "Wait." :tools []})`)
  const id = env.spawn("idle", "wait")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(env.runs()[0].status, "running")
  env.stop(id)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(env.runs()[0].status, "stopped")
})

test("undefining a tool removes it; agents refuse unknown tools", async () => {
  const { lisp, env, run } = await environment()
  await run(`(define-tool (shout text) (: String -> String ! pure) "" (string-upcase text))`)
  lisp.undefine("shout")
  assert.equal(env.tools().length, 0)
  await assert.rejects(run(`(define-agent a "" {:instructions "x" :tools ['shout]})`), /shout is not a defined tool or agent/)
})

test("the simulated model picks the matching tool and fills its arguments from the task", async () => {
  const { run } = await environment()
  await run(`(define-tool (add-numbers a b) (: Number Number -> Number ! pure) "Adds two numbers." (+ a b))
             (define-tool (shout text) (: String -> String ! pure) "Upper-cases text." (string-upcase text))
             (define-agent calc "" {:instructions "Compute." :tools [shout add-numbers]})`)
  assert.equal(await run('(run-agent \'calc "add numbers 2 and 40")'), "(sim) 42")
})

test("agents run at the same time and share the board", async () => {
  const model: AgentModel = async ({ messages, tools }, signal) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 50)
      signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)))
    })
    const results = messages.filter((message) => message.role === "tool")
    if (results.length) return { content: String(results.at(-1)!.content), toolCalls: [], raw: { role: "assistant", content: "" } }
    const tool = tools[0].function.name
    const args = tool === "post" ? { text: "hello from writer" } : {}
    const toolCalls = [{ id: "1", type: "function" as const, function: { name: tool, arguments: JSON.stringify(args) } }]
    return { content: null, toolCalls: [{ id: "1", name: tool, args }], raw: { role: "assistant", content: null, tool_calls: toolCalls } }
  }
  const { env, run } = await environment(model)
  await run(`(define-tool (post text) (: String -> String ! (store)) "Posts." (board-post! "shared" text))
             (define-tool (peek) (: -> (List String) ! (store)) "Reads." (board-read "shared"))
             (define-agent writer "" {:instructions "Post." :tools [post]})
             (define-agent reader "" {:instructions "Read." :tools [peek]})`)
  env.spawn("writer", "write")
  await new Promise((resolve) => setTimeout(resolve, 10))
  env.spawn("reader", "read")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(
    env.runs().map(({ status }) => status),
    ["running", "running"],
  )
  while (env.runs().some(({ status }) => status === "running")) await new Promise((resolve) => setTimeout(resolve, 10))
  const [writer, reader] = env.runs()
  assert.equal(writer.status, "done")
  assert.equal(reader.status, "done")
  assert.equal(reader.steps.at(-1)!.text, '("hello from writer")')
})
