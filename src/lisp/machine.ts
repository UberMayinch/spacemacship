import { errorAt, type Node } from "./analyze.ts"
import { show } from "./printer.ts"
import type { Site } from "./reader.ts"
import { showType, validate, type Schemas } from "./types.ts"
import { isKeyword, isMap, isTruthy, makeMap, mapGet, type CallContext, type Closure, type Env, type LispError, type Value } from "./values.ts"

/** What the machine needs from the image around it. */
export type Runtime = {
  global(name: string): Value
  hasGlobal(name: string): boolean
  setGlobal(name: string, value: Value): void
  define(node: Extract<Node, { op: "define" }>, value: Value): void
  defineMacro(name: string, expander: Value): void
  schemas: Schemas
  log(text: string): void
}

/** Effects allowed in the current scope; undefined allows all, as untyped code is not restricted. */
export type EffectScope = ReadonlySet<string> | undefined

type Frame =
  | { k: "if"; node: Extract<Node, { op: "if" }>; env: Env }
  | { k: "seq"; node: Extract<Node, { op: "seq" }>; index: number; env: Env }
  | { k: "args"; node: Extract<Node, { op: "app" }>; values: Value[]; env: Env }
  | { k: "items"; node: Extract<Node, { op: "vector" | "map" }>; values: Value[]; env: Env }
  | { k: "and" | "or"; node: Extract<Node, { op: "and" | "or" }>; index: number; env: Env }
  | { k: "define"; node: Extract<Node, { op: "define" }>; env: Env }
  | { k: "set"; node: Extract<Node, { op: "set" }>; env: Env }
  | { k: "defmacro"; node: Extract<Node, { op: "defmacro" }> }
  | { k: "try"; node: Extract<Node, { op: "try" }>; env: Env; effects: EffectScope }
  | { k: "effects"; effects: EffectScope }

/** Steps between checks of the cancel signal and the clock. */
const CHECK_EVERY = 256
/** Longest the machine runs before giving the page a turn. */
const SLICE_MS = 4

const VOID: Node = { op: "const", value: undefined, site: { origin: "", start: 0, end: 0, id: 0 } }

/**
 * Evaluates `start` with an explicit stack rather than JS recursion: tail calls take no stack, any step may await a primitive's promise,
 * the cancel signal is checked as it runs, and long runs yield to the page every few milliseconds.
 */
export async function execute(start: Node, startEnv: Env, runtime: Runtime, signal: AbortSignal, startEffects?: EffectScope, actor?: unknown): Promise<Value> {
  const stack: Frame[] = []
  let node: Node | undefined = start
  let env = startEnv
  let value: Value
  let effects = startEffects
  let steps = 0
  let sliceStart = performance.now()
  let site: Site = start.site

  const context: CallContext = {
    signal,
    call: (procedure, args, override) => callProcedure(procedure, args, runtime, override ?? signal, effects, actor),
    allows: (effect) => !effects || effects.has(effect),
    get effects() {
      return effects
    },
    actor,
    log: runtime.log,
  }

  while (true) {
    try {
      if (++steps % CHECK_EVERY === 0) {
        signal.throwIfAborted()
        if (performance.now() - sliceStart > SLICE_MS) {
          await nextTask()
          signal.throwIfAborted()
          sliceStart = performance.now()
        }
      }
      if (node) {
        site = node.site
        const current: Node = node
        node = undefined
        switch (current.op) {
          case "const":
            value = current.value
            break
          case "local":
            value = lookup(env, current.name, current.site)
            break
          case "global":
            if (!runtime.hasGlobal(current.name)) throw errorAt(`unbound variable ${current.name}`, current.site)
            value = runtime.global(current.name)
            break
          case "if":
            stack.push({ k: "if", node: current, env })
            node = current.test
            break
          case "seq":
            if (!current.body.length) value = undefined
            else {
              if (current.body.length > 1) stack.push({ k: "seq", node: current, index: 1, env })
              node = current.body[0]
            }
            break
          case "app":
            stack.push({ k: "args", node: current, values: [], env })
            node = current.fn
            break
          case "vector":
          case "map":
            if (!current.items.length) value = current.op === "vector" ? { tag: "vector", items: [] } : makeMap([])
            else {
              stack.push({ k: "items", node: current, values: [], env })
              node = current.items[0]
            }
            break
          case "and":
          case "or":
            if (!current.items.length) value = current.op === "and"
            else {
              stack.push({ k: current.op, node: current, index: 1, env })
              node = current.items[0]
            }
            break
          case "lambda":
            value = {
              tag: "closure",
              name: current.name,
              params: current.params,
              rest: current.rest,
              locals: current.locals,
              body: current.body,
              env,
              signature: current.signature,
            }
            break
          case "define":
            stack.push({ k: "define", node: current, env })
            node = current.value
            break
          case "set":
            stack.push({ k: "set", node: current, env })
            node = current.value
            break
          case "defmacro":
            stack.push({ k: "defmacro", node: current })
            node = current.value
            break
          case "try":
            stack.push({ k: "try", node: current, env, effects })
            node = current.body
            break
        }
        continue
      }

      const frame = stack.pop()
      if (!frame) return value
      switch (frame.k) {
        case "if":
          env = frame.env
          node = isTruthy(value) ? frame.node.then : (frame.node.else ?? VOID)
          break
        case "seq":
          env = frame.env
          node = frame.node.body[frame.index]
          if (frame.index + 1 < frame.node.body.length) stack.push({ ...frame, index: frame.index + 1 })
          break
        case "and":
        case "or": {
          const isDone = frame.k === "and" ? !isTruthy(value) : isTruthy(value)
          if (isDone || frame.index >= frame.node.items.length) break
          env = frame.env
          node = frame.node.items[frame.index]
          stack.push({ ...frame, index: frame.index + 1 })
          break
        }
        case "items":
          frame.values.push(value)
          if (frame.values.length < frame.node.items.length) {
            stack.push(frame)
            env = frame.env
            node = frame.node.items[frame.values.length]
          } else if (frame.node.op === "vector") value = { tag: "vector", items: frame.values }
          else value = makeMap(Array.from({ length: frame.values.length / 2 }, (_, i): [Value, Value] => [frame.values[2 * i], frame.values[2 * i + 1]]))
          break
        case "define":
          if (frame.node.isLocal) frame.env.vars.set(frame.node.name, value)
          else runtime.define(frame.node, value)
          value = frame.node.isLocal ? undefined : { tag: "sym", name: frame.node.name }
          break
        case "set":
          if (frame.node.isLocal) assign(frame.env, frame.node.name, value, frame.node.site)
          else if (!runtime.hasGlobal(frame.node.name)) throw errorAt(`set! of unbound variable ${frame.node.name}`, frame.node.site)
          else runtime.setGlobal(frame.node.name, value)
          value = undefined
          break
        case "defmacro":
          runtime.defineMacro(frame.node.name, value)
          value = { tag: "sym", name: frame.node.name }
          break
        case "try":
        case "effects":
          effects = frame.effects
          break
        case "args": {
          frame.values.push(value)
          if (frame.values.length <= frame.node.args.length) {
            stack.push(frame)
            env = frame.env
            node = frame.node.args[frame.values.length - 1]
            break
          }
          site = frame.node.site
          const [procedure, ...args] = frame.values
          if (typeof procedure === "object" && !Array.isArray(procedure) && procedure.tag === "closure") {
            checkArgs(procedure, args, runtime.schemas, site)
            const declared = procedure.signature?.effects
            if (declared) {
              const narrowed = new Set(effects ? declared.filter((effect) => effects!.has(effect)) : declared)
              if (stack.at(-1)?.k !== "effects") stack.push({ k: "effects", effects })
              effects = narrowed
            }
            env = bind(procedure, args, site)
            node = procedure.body
            break
          }
          if (typeof procedure === "object" && !Array.isArray(procedure) && procedure.tag === "primitive") {
            const [min, max] = procedure.arity
            if (args.length < min || args.length > max)
              throw errorAt(
                `${procedure.name} takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} arguments, got ${args.length}`,
                site,
              )
            for (const effect of procedure.effects)
              if (effects && !effects.has(effect)) throw errorAt(`${procedure.name} has effect ${effect}, which this scope does not declare`, site)
            const result = procedure.fn(args, context)
            value = result instanceof Promise ? await abortable(result, signal) : result
            break
          }
          if (isKeyword(procedure)) {
            if (args.length < 1 || args.length > 2) throw errorAt(`a keyword called as a function takes a map and an optional default`, site)
            value = isMap(args[0]) ? (mapGet(args[0], procedure) ?? args[1]) : args[1]
            break
          }
          throw errorAt(`not a procedure: ${show(procedure)}`, site)
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      const failure = located(error, site)
      const trace = traceOf(stack)
      const handler = unwindToTry(stack)
      if (!handler) {
        failure.trace = [...(failure.trace ?? []), ...trace]
        throw failure
      }
      effects = handler.effects
      env = { vars: new Map([[handler.node.name, failure.message]]), parent: handler.env }
      node = handler.node.handler
    }
  }
}

/** Calls a procedure from TypeScript, or from a primitive calling back into Lisp. */
export function callProcedure(procedure: Value, args: Value[], runtime: Runtime, signal: AbortSignal, effects?: EffectScope, actor?: unknown) {
  const site = typeof procedure === "object" && !Array.isArray(procedure) && procedure.tag === "closure" ? procedure.body.site : VOID.site
  const node: Node = { op: "app", fn: { op: "const", value: procedure, site }, args: args.map((value) => ({ op: "const", value, site })), site }
  return execute(node, { vars: new Map() }, runtime, signal, effects, actor)
}

function bind(closure: Closure, args: Value[], site: Site): Env {
  const { params, rest, locals, name } = closure
  if (args.length < params.length || (!rest && args.length > params.length))
    throw errorAt(
      `${name ?? "procedure"} takes ${rest ? `at least ${params.length}` : params.length} argument${params.length === 1 && !rest ? "" : "s"}, got ${args.length}`,
      site,
    )
  const vars = new Map<string, Value>()
  for (const local of locals) vars.set(local, undefined)
  params.forEach((param, i) => vars.set(param, args[i]))
  if (rest) vars.set(rest, args.slice(params.length))
  return { vars, parent: closure.env }
}

/** Gradual typing at the boundary: a typed procedure checks what untyped code hands it. */
function checkArgs(closure: Closure, args: Value[], schemas: Schemas, site: Site) {
  const signature = closure.signature
  if (!signature) return
  for (const [i, arg] of args.entries()) {
    const type = i < signature.params.length ? signature.params[i] : signature.rest
    if (!type) continue
    const problem = validate(arg, type, schemas)
    if (problem) throw errorAt(`argument ${i + 1} of ${closure.name ?? "procedure"} should be ${showType(type)}: ${problem}`, site)
  }
}

function lookup(env: Env, name: string, site: Site): Value {
  for (let e: Env | undefined = env; e; e = e.parent) if (e.vars.has(name)) return e.vars.get(name)
  throw errorAt(`unbound variable ${name}`, site)
}

function assign(env: Env, name: string, value: Value, site: Site) {
  for (let e: Env | undefined = env; e; e = e.parent)
    if (e.vars.has(name)) {
      e.vars.set(name, value)
      return
    }
  throw errorAt(`set! of unbound variable ${name}`, site)
}

function unwindToTry(stack: Frame[]) {
  while (stack.length) {
    const frame = stack.pop()!
    if (frame.k === "try") return frame
  }
}

function traceOf(stack: Frame[]) {
  return stack
    .flatMap((frame) =>
      frame.k === "args" && frame.node.fn.op !== "const" ? [`${callee(frame.node.fn)} at ${frame.node.site.origin}:${frame.node.site.start}`] : [],
    )
    .reverse()
}

function callee(node: Node) {
  return node.op === "global" || node.op === "local" ? node.name : "(...)"
}

function located(error: unknown, site: Site): LispError {
  const failure = (error instanceof Error ? error : new Error(String(error))) as LispError
  failure.site ??= site
  return failure
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => (signal.removeEventListener("abort", onAbort), resolve(value)),
      (error) => (signal.removeEventListener("abort", onAbort), reject(error)),
    )
  })
}

function nextTask() {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}
