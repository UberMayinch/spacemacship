import type { Lisp } from "../lisp/lisp.ts"
import { readAll } from "../lisp/reader.ts"
import { isList, isSym, type Value } from "../lisp/values.ts"

export type Control = { dimension: unknown; position: number; strength: number }

/** `environment` describes what is loaded now, asked again before every attempt. */
export type CompileInput = { origin: string; intent: string; phrases: string[]; locked: string[]; controls: Control[]; environment: () => string }

export type CompilePhase = "writing" | "checking" | "repairing" | "loading"

/** What is loaded for a unit: its code and the global names that code defined. */
export type Loaded = { code: string; names: string[] }

export type CompileResult = { code: string; errors: string[]; loaded?: Loaded }

export type FormView = { text: string; name?: string; kind?: string; start: number; end: number }

/** Attempts after the first, each with the previous attempt's errors. */
const MAX_REPAIRS = 2
/** Loading only defines things, so it is quick; top-level code still running after this is stopped and reported as an error. */
const LOAD_LIMIT_MS = 2000
const DEFINING_FORMS = new Set(["define", "define-tool", "define-agent", "define-schema", "define-source", "define-macro", "define-prompt", "define-dimension"])

/**
 * Turns one unit of intent into loaded code: streams source from `compile-intent`, puts the locked forms back exactly as they were,
 * checks it against the running environment, and hands any errors back to the model to repair. Only code that checks is loaded,
 * with no effects allowed while it loads. If loading still fails, the unit's previous code is restored.
 */
export async function compileUnit(
  lisp: Lisp,
  input: CompileInput,
  previous: Loaded | undefined,
  signal: AbortSignal,
  onProgress: (phase: CompilePhase, code: string) => void,
): Promise<CompileResult> {
  let repair: { code: string; errors: string[] } | undefined
  let code = ""
  let errors: string[] = []
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    onProgress(repair ? "repairing" : "writing", "")
    code = ""
    const request = { intent: input.intent, phrases: input.phrases, locked: input.locked, controls: input.controls, environment: input.environment(), repair }
    for await (const chunk of lisp.callSource("compile-intent", [request], signal)) {
      code += String(chunk)
      onProgress(repair ? "repairing" : "writing", withoutFences(code))
    }
    code = withLocks(withoutFences(code), input.locked)
    onProgress("checking", code)
    const report = await lisp.checkText(code, input.origin, signal)
    errors = report.errors.map((error) => lisp.describeError(error))
    if (!report.names.length && !errors.length) errors = ["the code defines nothing; define the tools, agents or helpers the intent asks for"]
    if (!errors.length) {
      onProgress("loading", code)
      const result = await loadCode(lisp, input.origin, code, previous, signal)
      if (result.loaded) return { code, errors: [], loaded: result.loaded }
      errors = result.errors
    }
    signal.throwIfAborted()
    repair = { code, errors }
  }
  return { code, errors }
}

/**
 * Loads `code` in place of `previous`: names the new code no longer defines are removed once it loads.
 * On failure, everything it defined is removed again and `previous` is loaded back, so a unit is never left half loaded.
 * Throws only when `signal` aborts; running past `LOAD_LIMIT_MS` is a failure like any other.
 */
export async function loadCode(
  lisp: Lisp,
  origin: string,
  code: string,
  previous: Loaded | undefined,
  signal = new AbortController().signal,
): Promise<{ loaded?: Loaded; errors: string[] }> {
  const report = await lisp.checkText(code, origin, signal)
  if (report.errors.length) return { errors: report.errors.map((error) => lisp.describeError(error)) }
  const failures = await evaluate(lisp, origin, code, signal)
  if (failures.length) {
    for (const name of report.names) if (!previous?.names.includes(name)) lisp.undefine(name)
    if (previous) await evaluate(lisp, origin, previous.code, signal)
    return { errors: failures }
  }
  for (const name of previous?.names ?? []) if (!report.names.includes(name)) lisp.undefine(name)
  return { loaded: { code, names: report.names }, errors: [] }
}

/** Evaluates with no effects and a time limit; the errors, described. */
async function evaluate(lisp: Lisp, origin: string, code: string, signal: AbortSignal) {
  const limit = AbortSignal.any([signal, AbortSignal.timeout(LOAD_LIMIT_MS)])
  try {
    const results = await lisp.evalText(code, origin, { effects: [], signal: limit })
    return results.flatMap(({ error }) => (error ? [lisp.describeError(error)] : []))
  } catch (error) {
    signal.throwIfAborted()
    if (limit.aborted) return [`loading ran longer than ${LOAD_LIMIT_MS / 1000} s and was stopped: top-level code should only define things`]
    throw error
  }
}

export function unload(lisp: Lisp, loaded: Loaded | undefined) {
  for (const name of loaded?.names ?? []) lisp.undefine(name)
}

/** Every top-level form of `code` with the name it defines, if any; stops at the first form that does not read. */
export function formsOf(code: string, origin = "view"): FormView[] {
  const forms: FormView[] = []
  for (let at = 0; at < code.length;) {
    let read
    try {
      read = readAll(code, origin, at, code.length, 1)[0]
    } catch {
      return forms
    }
    if (!read) return forms
    const { form, site } = read
    forms.push({ text: code.slice(site.start, site.end), start: site.start, end: site.end, ...nameAndKindOf(form) })
    at = site.end
  }
  return forms
}

/** Locked forms win: a form defining a locked name is replaced by the locked text, and a locked form the code left out is added back. */
export function withLocks(code: string, locked: string[]) {
  if (!locked.length) return code
  const lockedForms = locked.map((text) => ({ text, name: formsOf(text)[0]?.name }))
  const forms = formsOf(code)
  const kept = forms.map((form) => lockedForms.find((lock) => lock.name && lock.name === form.name)?.text ?? form.text)
  const missing = lockedForms.filter((lock) => !kept.includes(lock.text)).map(({ text }) => text)
  return [...missing, ...kept].join("\n\n")
}

function nameAndKindOf(form: Value): { name?: string; kind?: string } {
  if (!isList(form) || !isSym(form[0]) || !DEFINING_FORMS.has(form[0].name)) return {}
  const target = isList(form[1]) ? form[1][0] : form[1]
  return { kind: form[0].name.replace(/^define-?/, "") || "define", name: isSym(target) ? target.name : undefined }
}

function withoutFences(code: string) {
  return code
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .trim()
}
