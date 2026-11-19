import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createLisp } from "../src/lisp/lisp.ts"
import { show } from "../src/lisp/printer.ts"
import { streamOf } from "../src/lisp/streams.ts"
import { toLisp } from "../src/lisp/values.ts"
import { installHost } from "../src/text/lisp-host.ts"

const CONFIG = readFileSync(new URL("../config.scm", import.meta.url), "utf8")

async function booted(flight = false) {
  const lisp = createLisp()
  await lisp.ready
  installHost(lisp, () => flight)
  const results = await lisp.evalText(CONFIG, "config.scm", { keepGoing: true })
  const problems = results.flatMap(({ error, warnings }) => [...(error ? [error] : []), ...warnings]).map((error) => lisp.describeError(error))
  return { lisp, problems }
}

const signal = () => new AbortController().signal

test("config.scm loads with no errors or warnings", async () => {
  const { problems } = await booted()
  assert.deepEqual(problems, [])
})

test("the sim fan offers five declared dimensions, never the characters slot, and changes when one is redefined", async () => {
  const { lisp } = await booted()
  const menu = (await Array.fromAsync(lisp.callSource("dimension-menu", [{ text: "Once", leads: [], taken: [] }], signal()))) as { name: string }[]
  assert.deepEqual(
    menu.map(({ name }) => name),
    ["tension", "resolution", "pace", "mode", "tone"],
  )
  await lisp.evalText('(define-dimension tension (scale "at ease" "on edge"))', "repl")
  const [first] = (await Array.fromAsync(lisp.callSource("dimension-menu", [{ text: "Once", leads: [], taken: [] }], signal()))) as object[]
  assert.deepEqual(first, { name: "tension", kind: "scale", low: "at ease", high: "on edge" })
})

test("the flight fan parses the model's lines, names characters, and fills in what it leaves out", async () => {
  const { lisp } = await booted(true)
  lisp.definePrimitive(
    "llm-stream",
    () => streamOf(["tension: calm | ", "tense\nfocus: Mara (the sister) | narrator\nbogus: a | b\n", "mode: dialogue | action"]),
    {
      sig: "Map -> (Stream String)",
      effects: ["llm"],
    },
  )
  const menu = (await Array.fromAsync(
    lisp.callSource("dimension-menu", [{ text: "Mara ran.", leads: [], taken: [{ name: "pace", kind: "scale", low: "a", high: "b" }] }], signal()),
  )) as object[]
  assert.deepEqual(menu, [
    { name: "tension", kind: "scale", low: "calm", high: "tense" },
    { name: "focus", kind: "choice", options: ["Mara", "narrator"] },
    { name: "mode", kind: "choice", options: ["dialogue", "action"] },
    { name: "resolution", kind: "scale", low: "open question", high: "answered" },
    { name: "tone", kind: "choice", options: ["wry", "tender", "somber", "wondrous"] },
  ])
})

test("the steered message matches the upstream format", async () => {
  const { lisp } = await booted()
  const steering = {
    leads: [{ before: "not the one on her ", keyword: "phone", after: "" }],
    controls: [
      { dimension: { name: "tension", kind: "scale", low: "relaxed", high: "strained" }, position: 0.95, strength: 0.9 },
      { dimension: { name: "mode", kind: "choice", options: ["dialogue", "action", "description"] }, position: 0.5, strength: 0.1 },
    ],
  }
  lisp.definePrimitive("test-steering", () => toLisp(steering), { arity: [0, 0] })
  const [message] = await lisp.evalText('(steered-message "She lay still and" (test-steering))', "repl")
  assert.equal(
    message.value,
    "KEY PHRASES\nnot the one on her [phone]\n\nCONTROLS\ntension: very strained (strong)\nmode: action (options: dialogue, action, description) (slight)\n\nSTORY SO FAR\nShe lay still and",
  )
})

test("the sim continuation streams words until aborted, and describe shows its signature", async () => {
  const { lisp } = await booted()
  const controller = new AbortController()
  let text = ""
  try {
    for await (const chunk of lisp.callSource("continue-story", ["Once upon a time", { leads: [], controls: [] }], controller.signal)) {
      text += chunk
      if (text.split(" ").length > 20) controller.abort()
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  }
  assert.ok(text.split(" ").length > 20)
  assert.match(show((await lisp.evalText("(describe->string 'continue-story)", "repl"))[0].value), /\(: String Steering -> \(Stream String\) ! \(llm time\)\)/)
})
