import { analyze, type AnalyzeHost, type Node } from "./analyze.ts"
import { check, type Known } from "./checker.ts"
import { callProcedure, execute, type Runtime } from "./machine.ts"
import { PRELUDE } from "./prelude.ts"
import { show } from "./printer.ts"
import { readAll, siteAt, type Site } from "./reader.ts"
import { primitive, standardLibrary } from "./stdlib.ts"
import { asStream, streamLibrary } from "./streams.ts"
import { parseType, showSignature, showType, validate, type FnType, type Type } from "./types.ts"
import {
  equal,
  fail,
  fromLisp,
  isKeyword,
  isList,
  isMacro,
  isProcedure,
  isSym,
  keyword,
  makeMap,
  toLisp,
  type CallContext,
  type LispError,
  type Macro,
  type Primitive,
  type Value,
} from "./values.ts"

export type Binding = { value: Value; signature?: FnType; effects?: string[]; site?: Site; source?: string; doc?: string; isSource?: boolean }

export type LogEntry = { kind: "out" | "warning" | "error"; text: string }

export type EvalResult = { site: Site; value?: Value; error?: LispError; warnings: LispError[] }

/** `effects` are those the code surely uses; with `hasUnknownEffects` it may use others, through calls the checker could not follow. */
export type CheckReport = { errors: LispError[]; warnings: LispError[]; names: string[]; effects: string[]; hasUnknownEffects: boolean }

export type Lisp = ReturnType<typeof createLisp>

const MAX_CHOICE_OPTIONS = 4

/**
 * The image: global bindings, schemas, and the declared dimensions, plus the reader, checker and machine to change them while the page runs.
 * Listeners hear which names a change touched, once per evaluation, so the page can restart whatever depended on them.
 */
export function createLisp() {
  const globals = new Map<string, Binding>()
  const builtins = new Map<string, Primitive>()
  const schemas = new Map<string, Type>()
  const dimensions = new Map<string, Value>()
  const dimensionDocs = new Map<string, string>()
  const texts = new Map<string, string>()
  const changeListeners = new Set<(names: string[]) => void>()
  const logListeners = new Set<(entry: LogEntry) => void>()
  let changed = new Set<string>()
  let depth = 0
  const idle = new AbortController().signal

  const schemaOf = (name: string) => schemas.get(name)
  const log = (text: string) => emitLog({ kind: "out", text })

  const runtime: Runtime = {
    global: (name) => globals.get(name)!.value,
    hasGlobal: (name) => globals.has(name),
    setGlobal: (name, value) => {
      globals.set(name, { ...globals.get(name)!, value })
      changed.add(name)
    },
    define: defineGlobal,
    defineMacro: (name, expander) => {
      if (!isProcedure(expander)) fail(`macro ${name} needs a procedure`)
      setBinding(name, { value: { tag: "macro", name, expander } satisfies Macro })
    },
    schemas: schemaOf,
    log,
  }

  const known: Known = {
    isBound: (name) => globals.has(name),
    signatureOf: (name) => {
      const value = globals.get(name)?.value
      return globals.get(name)?.signature ?? (isProcedure(value) ? value.signature : undefined)
    },
    effectsOf: (name) => {
      const binding = globals.get(name)
      if (!binding) return
      if (binding.signature?.effects) return binding.signature.effects
      if (typeof binding.value === "object" && !Array.isArray(binding.value) && binding.value.tag === "primitive") return binding.value.effects
      return binding.effects
    },
  }

  /**
   * Macros expand under the signal of whatever is being evaluated, so a looping expander can be cancelled with it, and with no effects:
   * expansion happens while code is only being checked, before anyone has approved it, so it must not be able to act.
   */
  const analyzeHostFor = (signal: AbortSignal): AnalyzeHost => ({
    macro: (name) => {
      const value = globals.get(name)?.value
      return isMacro(value) ? value : undefined
    },
    expand: (macro, args) => callProcedure(macro.expander, args, runtime, signal, new Set()),
    builtin: (name) => builtins.get(name) ?? fail(`no builtin ${name}`),
  })

  for (const builtin of [...standardLibrary(), ...streamLibrary(), ...kernelLibrary()]) {
    builtins.set(builtin.name, builtin)
    globals.set(builtin.name, { value: builtin, signature: builtin.signature })
  }

  const ready = evalText(PRELUDE, "prelude.scm").then((results) => {
    const failure = results.find(({ error }) => error)?.error
    if (failure) throw failure
    changed.clear()
  })

  return {
    ready,
    evalText,
    callSource,
    definePrimitive,
    describeSite,
    describeError,
    checkText,
    undefine,
    callValue: (procedure: Value, args: Value[], signal: AbortSignal, effects?: string[], actor?: unknown) =>
      callProcedure(procedure, args, runtime, signal, effects && new Set(effects), actor),
    binding: (name: string): Readonly<Binding> | undefined => globals.get(name),
    schema: schemaOf,
    has: (name: string) => globals.has(name),
    isProcedure: (name: string) => isProcedure(globals.get(name)?.value),
    dimensions: () => [...dimensions.values()].map(fromLisp),
    names: () => [...globals.keys()],
    onChange: (listener: (names: string[]) => void) => (changeListeners.add(listener), () => changeListeners.delete(listener)),
    onLog: (listener: (entry: LogEntry) => void) => (logListeners.add(listener), () => logListeners.delete(listener)),
  }

  /**
   * Reads and evaluates each top-level form of `text` in turn (only those starting in `from` to `to`, if given); with `keepGoing`,
   * a failing form is reported and the rest still load, as when booting from a file, and a syntax error stops reading only where it is.
   * Changes are announced once at the end.
   */
  async function evalText(
    text: string,
    origin: string,
    {
      signal = idle,
      keepGoing = false,
      from = 0,
      to = text.length,
      effects,
      actor,
    }: { signal?: AbortSignal; keepGoing?: boolean; from?: number; to?: number; effects?: string[]; actor?: unknown } = {},
  ): Promise<EvalResult[]> {
    texts.set(origin, text)
    let forms
    let readFailure: EvalResult | undefined
    try {
      forms = readAll(text, origin, from, to)
    } catch (error) {
      const failure = error as LispError
      readFailure = { site: failure.site ?? siteAt(origin, 0, 0), error: failure, warnings: [] }
      if (!keepGoing || !failure.site) return [readFailure]
      forms = readAll(text, origin, from, Math.min(to, failure.site.start))
    }
    depth++
    const results: EvalResult[] = []
    try {
      for (const { form, site } of forms) {
        const result = await evalForm(form, site, signal, effects && new Set(effects), actor)
        results.push(result)
        if (result.error && !keepGoing) break
      }
    } finally {
      if (--depth === 0) flushChanges()
    }
    return readFailure ? [...results, readFailure] : results
  }

  async function evalForm(form: Value, site: Site, signal: AbortSignal, effects?: ReadonlySet<string>, actor?: unknown): Promise<EvalResult> {
    try {
      const node = await analyze(form, site, analyzeHostFor(signal))
      const { errors, warnings } = check(node, known, schemaOf)
      if (errors.length) return { site, error: combined(errors), warnings }
      return { site, value: await execute(node, { vars: new Map() }, runtime, signal, effects, actor), warnings }
    } catch (error) {
      if (signal.aborted) throw error
      return { site, error: error as LispError, warnings: [] }
    }
  }

  /**
   * Reads, expands and checks every form of `text` without running any of it: what would fail, and which global names it would define.
   * Names a form defines count as known to the forms after it.
   */
  async function checkText(text: string, origin: string, signal = idle): Promise<CheckReport> {
    texts.set(origin, text)
    const report: CheckReport = { errors: [], warnings: [], names: [], effects: [], hasUnknownEffects: false }
    let forms
    try {
      forms = readAll(text, origin)
    } catch (error) {
      report.errors.push(error as LispError)
      return report
    }
    const pending = new Set<string>()
    const knownSoFar: Known = { ...known, isBound: (name) => known.isBound(name) || pending.has(name) }
    for (const { form, site } of forms) {
      try {
        const node = await analyze(form, site, analyzeHostFor(signal))
        const result = check(node, knownSoFar, schemaOf)
        report.errors.push(...result.errors)
        report.warnings.push(...result.warnings)
        for (const effect of result.effects) if (!report.effects.includes(effect)) report.effects.push(effect)
        report.hasUnknownEffects ||= result.hasUnknownEffects
        for (const name of definedNames(node)) {
          pending.add(name)
          if (!report.names.includes(name)) report.names.push(name)
        }
      } catch (error) {
        report.errors.push(error as LispError)
      }
    }
    return report
  }

  /** Removes a global defined in Lisp; builtins stay. */
  function undefine(name: string) {
    if (builtins.has(name) || !globals.delete(name)) return
    changed.add(name)
    if (depth === 0) flushChanges()
  }

  /**
   * Runs the source procedure bound to `name` on plain data, under `signal`, and streams its items back as plain data.
   * The source runs with only the effects it declares; items that do not fit its declared item type are dropped and reported.
   */
  async function* callSource(name: string, args: unknown[], signal: AbortSignal): AsyncIterable<unknown> {
    try {
      yield* runSource(name, args, signal)
    } catch (error) {
      if (!signal.aborted) emitLog({ kind: "error", text: `${name}: ${describeError(error as LispError)}` })
      throw error
    }
  }

  async function* runSource(name: string, args: unknown[], signal: AbortSignal): AsyncIterable<unknown> {
    const binding = globals.get(name)
    if (!binding || !isProcedure(binding.value)) throw new Error(`no source ${name} is defined`)
    const declared = binding.signature?.effects
    const effects = declared ? new Set(declared) : undefined
    const result = await callProcedure(binding.value, args.map(toLisp), runtime, signal, effects)
    const context: CallContext = {
      signal,
      call: (procedure, callArgs, override) => callProcedure(procedure, callArgs, runtime, override ?? signal, effects),
      allows: (effect) => !effects || effects.has(effect),
      effects,
      log,
    }
    const ret = binding.signature?.ret
    const itemType = ret?.t === "stream" || ret?.t === "list" ? ret.of : undefined
    for await (const item of asStream(result).open(context)) {
      if (signal.aborted) return
      const problem = itemType && validate(item, itemType, schemaOf)
      if (problem) {
        emitLog({ kind: "warning", text: `${name} dropped an item that is not ${showType(itemType)}: ${problem}` })
        continue
      }
      yield fromLisp(item)
    }
  }

  /** For the host page: a capability Lisp can call but not see inside, e.g. a model call holding a key Lisp never reads. */
  function definePrimitive(name: string, fn: Primitive["fn"], spec: Parameters<typeof primitive>[2]) {
    const value = primitive(name, fn, spec)
    builtins.set(name, value)
    globals.set(name, { value, signature: value.signature })
  }

  /** The message, where it happened, and the calls that led there. */
  function describeError(error: LispError, { withSite = true } = {}) {
    const where = withSite && error.site?.origin ? ` (${describeSite(error.site).where})` : ""
    const trace = error.trace?.length ? `\n  ${error.trace.join("\n  ")}` : ""
    return `${error.message}${where}${trace}`
  }

  /** `origin:line:column` of a site, with the line of source it points at. */
  function describeSite(site: Site) {
    const text = texts.get(site.origin) ?? ""
    const before = text.slice(0, site.start)
    const line = before.split("\n").length
    const column = site.start - before.lastIndexOf("\n")
    return { where: `${site.origin}:${line}:${column}`, line: text.split("\n")[line - 1] ?? "" }
  }

  function defineGlobal(node: Extract<Node, { op: "define" }>, value: Value) {
    const { name, site } = node
    const result = check(node, known, schemaOf)
    const signature = isProcedure(value) ? value.signature : undefined
    if (node.isSource && !isProcedure(value)) fail(`define-source ${name} needs a procedure`)
    setBinding(name, {
      value,
      signature,
      effects: signature?.effects ?? (result.hasUnknownEffects ? undefined : [...result.effects]),
      site,
      source: texts.get(site.origin)?.slice(site.start, site.end),
      doc: node.doc,
      isSource: node.isSource,
    })
  }

  function setBinding(name: string, binding: Binding) {
    const previous = globals.get(name)
    const isSame = previous && (binding.source !== undefined ? previous.source === binding.source : equal(previous.value, binding.value))
    globals.set(name, binding)
    if (!isSame) changed.add(name)
  }

  function flushChanges() {
    if (!changed.size) return
    const names = [...changed]
    changed = new Set()
    for (const listener of changeListeners) listener(names)
  }

  function emitLog(entry: LogEntry) {
    for (const listener of logListeners) listener(entry)
  }

  function kernelLibrary(): Primitive[] {
    return [
      primitive(
        "register-dimension!",
        ([name, spec, doc]) => {
          const dimension = dimensionOf(name, spec)
          const key = (name as { name: string }).name
          if (!equal(dimensions.get(key), dimension)) changed.add(`dimension:${key}`)
          dimensions.set(key, dimension)
          if (typeof doc === "string") dimensionDocs.set(key, doc)
          else dimensionDocs.delete(key)
          return name
        },
        { arity: [2, 3] },
      ),
      primitive(
        "forget-dimension!",
        ([name]) => {
          const key = isSym(name) ? name.name : String(name)
          dimensionDocs.delete(key)
          if (dimensions.delete(key)) changed.add(`dimension:${key}`)
        },
        { arity: [1, 1] },
      ),
      primitive("dimensions", () => [...dimensions.values()], { sig: "-> (List Dimension)" }),
      primitive("dimension-doc", ([name]) => dimensionDocs.get(isSym(name) ? name.name : String(name)) ?? false, { sig: "Any -> Any" }),
      primitive(
        "register-schema!",
        ([name, form]) => {
          if (!isSym(name) || !/^[A-Z]/.test(name.name)) fail(`a schema name is a capitalized symbol, got ${show(name)}`)
          const type = parseType(form)
          if (JSON.stringify(schemas.get(name.name)) !== JSON.stringify(type)) changed.add(`schema:${name.name}`)
          schemas.set(name.name, type)
          return name
        },
        { arity: [2, 2] },
      ),
      primitive("conforms?", ([value, form]) => validate(value, parseType(form), schemaOf) === undefined, { arity: [2, 2] }),
      primitive("explain", ([value, form]) => validate(value, parseType(form), schemaOf) ?? "conforms", { arity: [2, 2] }),
      primitive("describe", ([name], context) => void context.log(describe(isSym(name) ? name.name : String(name))), { sig: "Any -> Void" }),
      primitive("describe->string", ([name]) => describe(isSym(name) ? name.name : String(name)), { sig: "Any -> String" }),
      primitive("sources", () => [...globals].filter(([, binding]) => binding.isSource).map(([name]) => keyword(name)), { arity: [0, 0] }),
      primitive(
        "eval",
        async ([form], context) => {
          const site = siteAt("eval", 0, 0)
          const node = await analyze(form, site, analyzeHostFor(context.signal))
          const { errors } = check(node, known, schemaOf)
          if (errors.length) throw combined(errors)
          return execute(node, { vars: new Map() }, runtime, context.signal, context.effects, context.actor)
        },
        { arity: [1, 1] },
      ),
      primitive(
        "macroexpand",
        async ([form], context) => {
          if (!isList(form) || !isSym(form[0])) return form
          const host = analyzeHostFor(context.signal)
          const macro = host.macro(form[0].name)
          return macro ? host.expand(macro, form.slice(1)) : form
        },
        { arity: [1, 1] },
      ),
    ]
  }

  function describe(name: string) {
    const binding = globals.get(name)
    if (!binding) return `${name} is not defined`
    const { value, signature, effects, site, doc, isSource } = binding
    const kind = isSource ? "source" : typeof value === "object" && !Array.isArray(value) ? value.tag : "value"
    const lines = [
      `${name}: ${kind === "primitive" ? "builtin" : kind}${signature ? ` ${showSignature(signature)}` : ""}`,
      ...(!signature?.effects && effects ? [`effects: ${effects.length ? effects.join(" ") : "pure"} (inferred)`] : []),
      ...(!signature?.effects && !effects && isProcedure(value) && value.tag === "closure" ? ["effects: unknown (calls untyped code)"] : []),
      ...(site ? [`defined at ${describeSite(site).where}`] : []),
      ...(doc ? [doc] : []),
    ]
    return lines.join("\n")
  }
}

/** `(scale low high)` or `(choice option ...)`; `(choice :characters)` offers the story's characters, named by the model. */
function dimensionOf(name: Value, spec: Value): Value {
  if (!isSym(name)) return fail(`a dimension name is a symbol, got ${show(name)}`)
  if (!isList(spec) || !isSym(spec[0])) return fail(`${name.name}: the spec is (scale low high) or (choice option ...), got ${show(spec)}`)
  const [kind, ...labels] = spec
  const entries: [Value, Value][] = [
    [keyword("name"), name.name],
    [keyword("kind"), kind.name],
  ]
  if (kind.name === "scale") {
    if (labels.length !== 2) fail(`${name.name}: a scale has a low and a high pole, got ${labels.length} labels`)
    const [low, high] = labels.map((label) => labelOf(label, name.name))
    return makeMap([...entries, [keyword("low"), low], [keyword("high"), high]])
  }
  if (kind.name !== "choice") return fail(`${name.name}: the kind is scale or choice, got ${kind.name}`)
  if (labels.length === 1 && isKeyword(labels[0]) && labels[0].name === "characters")
    return makeMap([...entries, [keyword("options"), { tag: "vector", items: [] }]])
  if (labels.length < 2 || labels.length > MAX_CHOICE_OPTIONS)
    fail(`${name.name}: a choice has 2 to ${MAX_CHOICE_OPTIONS} options, or :characters, got ${labels.length}`)
  return makeMap([...entries, [keyword("options"), { tag: "vector", items: labels.map((label) => labelOf(label, name.name)) }]])
}

function labelOf(label: Value, dimension: string) {
  if (typeof label === "string" && label.trim()) return label.trim()
  if (isSym(label)) return label.name
  return fail(`${dimension}: a label is a symbol or a string, got ${show(label)}`)
}

/** Global names a top-level node defines, looking through `begin`, as macros like `define-tool` expand to. */
function definedNames(node: Node): string[] {
  if (node.op === "define" && !node.isLocal) return [node.name]
  if (node.op === "defmacro") return [node.name]
  if (node.op === "seq") return node.body.flatMap(definedNames)
  return []
}

function combined(errors: LispError[]): LispError {
  if (errors.length === 1) return errors[0]
  return Object.assign(new Error(errors.map(({ message }) => message).join("\n")), { site: errors[0].site })
}
