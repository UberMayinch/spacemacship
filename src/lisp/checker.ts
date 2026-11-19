import { errorAt, type Node } from "./analyze.ts"
import { ANY, consistent, showType, typeOfValue, type FnType, type Schemas, type Type } from "./types.ts"
import { isKeyword, type LispError } from "./values.ts"

/** What the checker knows about globals already loaded. */
export type Known = {
  isBound(name: string): boolean
  signatureOf(name: string): FnType | undefined
  /** Undefined when the global's effects are not known, e.g. an untyped procedure that calls something unknown. */
  effectsOf(name: string): string[] | undefined
}

export type CheckResult = {
  errors: LispError[]
  warnings: LispError[]
  /** Effects the form surely uses, through calls the checker could follow. */
  effects: Set<string>
  /** Whether it may also call procedures whose effects are unknown. */
  hasUnknownEffects: boolean
}

/**
 * Checks a top-level form against everything already loaded: arity and argument types of calls to known procedures, a declared result type,
 * and a declared effect row. Untyped code is checked only where types are known, so it loads as long as nothing surely mismatches.
 */
export function check(node: Node, known: Known, schemas: Schemas): CheckResult {
  const result: CheckResult = { errors: [], warnings: [], effects: new Set(), hasUnknownEffects: false }
  const self = node.op === "define" && !node.isLocal ? node : undefined
  const selfSignature = self?.value.op === "lambda" ? self.value.signature : undefined
  const locals = new Set<string>()
  infer(node, new Map())
  return result

  function infer(node: Node, env: Map<string, Type>): Type {
    switch (node.op) {
      case "const":
        return typeOfValue(node.value)
      case "local":
        return env.get(node.name) ?? ANY
      case "global":
        if (node.name === self?.name) return selfSignature ?? ANY
        if (!known.isBound(node.name) && !locals.has(node.name)) result.warnings.push(errorAt(`${node.name} is not defined yet`, node.site))
        return known.signatureOf(node.name) ?? ANY
      case "if":
        infer(node.test, env)
        return union(infer(node.then, env), node.else ? infer(node.else, env) : { t: "void" })
      case "seq":
        return node.body.map((item) => infer(item, env)).at(-1) ?? { t: "void" }
      case "and":
      case "or":
        for (const item of node.items) infer(item, env)
        return ANY
      case "vector":
        for (const item of node.items) infer(item, env)
        return { t: "list", of: ANY }
      case "map": {
        const types = node.items.map((item) => infer(item, env))
        const keys = node.items.filter((_, i) => i % 2 === 0)
        if (!keys.every((key) => key.op === "const" && isKeyword(key.value))) return { t: "map" }
        return {
          t: "record",
          fields: keys.map((key, i) => ({ key: (key as { value: { name: string } }).value.name, type: types[2 * i + 1], isOptional: false })),
        }
      }
      case "define":
        if (!node.isLocal) locals.add(node.name)
        env.set(node.name, infer(node.value, env))
        return { t: "void" }
      case "set":
        infer(node.value, env)
        return { t: "void" }
      case "defmacro":
        infer(node.value, env)
        return { t: "void" }
      case "try":
        return union(infer(node.body, env), infer(node.handler, new Map([...env, [node.name, { t: "string" }]])))
      case "lambda":
        return lambda(node, env)
      case "app":
        return app(node, env)
    }
  }

  function lambda(node: Extract<Node, { op: "lambda" }>, outer: Map<string, Type>): Type {
    const { signature } = node
    const env = new Map(outer)
    node.params.forEach((param, i) => env.set(param, signature?.params[i] ?? ANY))
    if (node.rest) env.set(node.rest, { t: "list", of: signature?.rest ?? ANY })
    const before = new Set(result.effects)
    const wasUnknown = result.hasUnknownEffects
    result.hasUnknownEffects = false
    const body = infer(node.body, env)
    if (signature && !consistent(body, signature.ret, schemas))
      result.errors.push(errorAt(`${node.name ?? "procedure"} should return ${showType(signature.ret)} but returns ${showType(body)}`, node.site))
    if (signature?.effects) {
      const extra = [...result.effects].filter((effect) => !before.has(effect) && !signature.effects!.includes(effect))
      if (extra.length)
        result.errors.push(
          errorAt(
            `${node.name ?? "procedure"} uses effect${extra.length > 1 ? "s" : ""} ${extra.join(" ")} but declares ! ${signature.effects.length ? `(${signature.effects.join(" ")})` : "pure"}`,
            node.site,
          ),
        )
    }
    result.hasUnknownEffects ||= wasUnknown
    return signature ?? { t: "fn", params: node.params.map(() => ANY), rest: node.rest ? ANY : undefined, ret: body }
  }

  function app(node: Extract<Node, { op: "app" }>, env: Map<string, Type>): Type {
    const callee = infer(node.fn, env)
    const args = node.args.map((arg) => infer(arg, env))
    noteEffects(node.fn)
    if (callee.t !== "fn") return ANY
    const name = node.fn.op === "global" || node.fn.op === "local" ? node.fn.name : "procedure"
    const { params, rest } = callee
    if (args.length < params.length || (!rest && args.length > params.length))
      result.errors.push(errorAt(`${name} takes ${rest ? `at least ${params.length}` : params.length} arguments, got ${args.length}`, node.site))
    for (const [i, arg] of args.entries()) {
      const expected = i < params.length ? params[i] : rest
      if (expected && !consistent(arg, expected, schemas))
        result.errors.push(errorAt(`argument ${i + 1} of ${name} should be ${showType(expected)}, got ${showType(arg)}`, node.args[i].site))
    }
    return callee.ret
  }

  function noteEffects(fn: Node) {
    if (fn.op === "lambda") return
    const effects = fn.op === "global" ? (fn.name === self?.name ? (selfSignature?.effects ?? []) : known.effectsOf(fn.name)) : undefined
    if (fn.op === "const" && typeof fn.value === "object" && !Array.isArray(fn.value) && fn.value.tag === "primitive")
      return fn.value.effects.forEach((effect) => result.effects.add(effect))
    if (!effects) result.hasUnknownEffects = true
    else for (const effect of effects) result.effects.add(effect)
  }
}

function union(a: Type, b: Type): Type {
  if (a.t === "any" || b.t === "any") return ANY
  if (JSON.stringify(a) === JSON.stringify(b)) return a
  return { t: "or", options: [...(a.t === "or" ? a.options : [a]), ...(b.t === "or" ? b.options : [b])] }
}
