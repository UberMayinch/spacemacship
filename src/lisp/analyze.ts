import { show } from "./printer.ts"
import { metaOf, type Site } from "./reader.ts"
import { parseSignature, type FnType } from "./types.ts"
import { isKeyword, isList, isMap, isSym, isVector, sym, type LispError, type Macro, type Value } from "./values.ts"

export type Node =
  | { op: "const"; value: Value; site: Site }
  | { op: "local" | "global"; name: string; site: Site }
  | { op: "set"; name: string; isLocal: boolean; value: Node; site: Site }
  | { op: "define"; name: string; isLocal: boolean; isSource: boolean; doc?: string; value: Node; site: Site }
  | { op: "if"; test: Node; then: Node; else?: Node; site: Site }
  | { op: "lambda"; name?: string; params: string[]; rest?: string; locals: string[]; body: Node; signature?: FnType; site: Site }
  | { op: "seq"; body: Node[]; site: Site }
  | { op: "app"; fn: Node; args: Node[]; site: Site }
  | { op: "and" | "or"; items: Node[]; site: Site }
  | { op: "vector"; items: Node[]; site: Site }
  | { op: "map"; items: Node[]; site: Site }
  | { op: "try"; body: Node; name: string; handler: Node; site: Site }
  | { op: "defmacro"; name: string; value: Node; site: Site }

export type AnalyzeHost = {
  macro(name: string): Macro | undefined
  expand(macro: Macro, args: Value[]): Promise<Value>
  builtin(name: string): Value
}

type Scope = { names: Set<string>; parent?: Scope }

/** Forms whose head is one of these are analyzed specially, unless a local binding shadows the name. */
const SPECIAL = new Set([
  "quote",
  "quasiquote",
  "if",
  "define",
  "define-source",
  "set!",
  "lambda",
  "fn",
  "begin",
  "let",
  "let*",
  "letrec",
  "cond",
  "and",
  "or",
  "when",
  "unless",
  "define-macro",
  "try",
])

/** Turns a form into a node tree, expanding macros on the way. Errors carry the site of the form at fault. */
export async function analyze(form: Value, site: Site, host: AnalyzeHost): Promise<Node> {
  return analyzeForm(form, site, undefined)

  async function analyzeForm(form: Value, site: Site, scope: Scope | undefined): Promise<Node> {
    if (isSym(form)) return { op: isLocal(form.name, scope) ? "local" : "global", name: form.name, site }
    if (isVector(form)) return { op: "vector", items: await analyzeEach(form.items, form, site, scope), site }
    if (isMap(form)) return { op: "map", items: await analyzeEach([...form.entries.values()].flat(), form, site, scope), site }
    if (!isList(form)) return { op: "const", value: form, site }
    if (!form.length) return { op: "const", value: form, site }

    const sites = childSites(form, site)
    const [head, ...args] = form
    if (isSym(head) && !isLocal(head.name, scope)) {
      if (SPECIAL.has(head.name)) return special(head.name, args, sites.slice(1), site, scope)
      const macro = host.macro(head.name)
      if (macro) return analyzeForm(await expand(macro, args, site), site, scope)
    }
    const [fn, ...rest] = await analyzeEach(form, form, site, scope)
    return { op: "app", fn, args: rest, site }
  }

  async function special(name: string, args: Value[], sites: Site[], site: Site, scope: Scope | undefined): Promise<Node> {
    const sub = (index: number, inner = scope) => analyzeForm(args[index], sites[index] ?? site, inner)
    switch (name) {
      case "quote":
        expectCount(args, 1, 1, "quote", site)
        return { op: "const", value: args[0], site }
      case "quasiquote":
        expectCount(args, 1, 1, "quasiquote", site)
        return analyzeForm(quasi(args[0], 1), sites[0] ?? site, scope)
      case "if":
        expectCount(args, 2, 3, "if", site)
        return { op: "if", test: await sub(0), then: await sub(1), else: args.length === 3 ? await sub(2) : undefined, site }
      case "define":
      case "define-source":
        return define(args, sites, site, scope, name === "define-source")
      case "set!": {
        expectCount(args, 2, 2, "set!", site)
        const target = symbolName(args[0], sites[0] ?? site, "set!")
        return { op: "set", name: target, isLocal: isLocal(target, scope), value: await sub(1), site }
      }
      case "lambda":
      case "fn":
        if (!args.length) throw errorAt(`${name} needs parameters`, site)
        return lambda(undefined, args[0], sites[0] ?? site, args.slice(1), sites.slice(1), site, scope)
      case "begin":
        return { op: "seq", body: await Promise.all(args.map((_, i) => sub(i))), site }
      case "let":
        return isSym(args[0]) ? namedLet(args, sites, site, scope) : let_(args, sites, site, scope)
      case "let*": {
        const bindings = bindingsOf(args[0], sites[0] ?? site)
        if (bindings.length <= 1) return let_(args, sites, site, scope)
        const [first, ...others] = bindings
        const inner = [sym("let*"), others.map((binding) => binding.form), ...args.slice(1)]
        return let_([[first.form], inner], [sites[0] ?? site, site], site, scope)
      }
      case "letrec": {
        const bindings = bindingsOf(args[0], sites[0] ?? site)
        const body = [...bindings.map(({ name, value }) => [sym("define"), sym(name), value]), ...args.slice(1)]
        return analyzeForm([[sym("lambda"), [], ...body]], site, scope)
      }
      case "cond":
        return analyzeForm(condToIf(args, site), site, scope)
      case "and":
      case "or":
        return { op: name, items: await Promise.all(args.map((_, i) => sub(i))), site }
      case "when":
      case "unless": {
        if (!args.length) throw errorAt(`${name} needs a test`, site)
        const body = await Promise.all(args.slice(1).map((_, i) => sub(i + 1)))
        const branch: Node = { op: "seq", body, site }
        const test = await sub(0)
        return name === "when" ? { op: "if", test, then: branch, site } : { op: "if", test, then: { op: "const", value: undefined, site }, else: branch, site }
      }
      case "define-macro": {
        const [signature, ...body] = args
        if (!isList(signature) || !isSym(signature[0])) throw errorAt("define-macro takes (name . params) and a body", site)
        const macroName = signature[0].name
        const value = await lambda(macroName, signature.slice(1), sites[0] ?? site, body, sites.slice(1), site, scope)
        return { op: "defmacro", name: macroName, value, site }
      }
      case "try": {
        const handler = args.at(-1)
        if (!isList(handler) || !isSym(handler[0]) || handler[0].name !== "catch" || !isSym(handler[1]))
          throw errorAt("try ends with (catch name handler...)", site)
        const handlerSites = childSites(handler, sites[args.length - 1] ?? site)
        const inner: Scope = { names: new Set([handler[1].name]), parent: scope }
        return {
          op: "try",
          body: { op: "seq", body: await Promise.all(args.slice(0, -1).map((_, i) => sub(i))), site },
          name: handler[1].name,
          handler: { op: "seq", body: await analyzeEach(handler.slice(2), undefined, site, inner, handlerSites.slice(2)), site },
          site,
        }
      }
    }
    throw errorAt(`unknown special form ${name}`, site)
  }

  async function define(args: Value[], sites: Site[], site: Site, scope: Scope | undefined, isSource: boolean): Promise<Node> {
    const [target, ...rest] = args
    const isLocalDefine = scope !== undefined
    if (isList(target)) {
      const [nameForm, ...params] = target
      const name = symbolName(nameForm, sites[0] ?? site, "define")
      const value = await lambda(name, params, sites[0] ?? site, rest, sites.slice(1), site, scope)
      const doc = value.op === "lambda" ? docOf(rest) : undefined
      return { op: "define", name, isLocal: isLocalDefine, isSource, doc, value, site }
    }
    if (isSource) throw errorAt("define-source takes (name params...) and a body", site)
    const name = symbolName(target, sites[0] ?? site, "define")
    expectCount(args, 1, 3, "define", site)
    const doc = args.length === 3 && typeof args[1] === "string" ? args[1] : undefined
    const valueIndex = args.length === 3 ? 2 : 1
    const value: Node = args.length === 1 ? { op: "const", value: undefined, site } : await analyzeForm(args[valueIndex], sites[valueIndex] ?? site, scope)
    if (value.op === "lambda") value.name ??= name
    return { op: "define", name, isLocal: isLocalDefine, isSource: false, doc, value, site }
  }

  async function lambda(name: string | undefined, paramForm: Value, paramSite: Site, body: Value[], bodySites: Site[], site: Site, scope: Scope | undefined) {
    const { params, rest } = paramsOf(paramForm, paramSite)
    const inner: Scope = { names: new Set([...params, ...(rest ? [rest] : [])]), parent: scope }
    let forms = body
    let sites = bodySites
    let signature: FnType | undefined
    if (isAnnotation(forms[0])) {
      signature = signatureAt(forms[0] as Value[], sites[0] ?? site)
      const arity = signature.params.length
      if (arity !== params.length || Boolean(signature.rest) !== Boolean(rest))
        throw errorAt(`the signature has ${arity}${signature.rest ? "+" : ""} parameters, the definition ${params.length}${rest ? "+" : ""}`, sites[0] ?? site)
      forms = forms.slice(1)
      sites = sites.slice(1)
    }
    if (typeof forms[0] === "string" && forms.length > 1) {
      forms = forms.slice(1)
      sites = sites.slice(1)
    }
    const locals = forms.flatMap((form) => definedName(form, inner))
    for (const local of locals) inner.names.add(local)
    const nodes = await analyzeEach(forms, undefined, site, inner, sites)
    const node: Node = { op: "lambda", name, params, rest, locals, body: { op: "seq", body: nodes, site }, signature, site }
    return node
  }

  async function let_(args: Value[], sites: Site[], site: Site, scope: Scope | undefined) {
    const bindings = bindingsOf(args[0], sites[0] ?? site)
    const fn = await lambda(
      undefined,
      bindings.map(({ name }) => sym(name)),
      sites[0] ?? site,
      args.slice(1),
      sites.slice(1),
      site,
      scope,
    )
    const values = await Promise.all(bindings.map(({ value, site: valueSite }) => analyzeForm(value, valueSite, scope)))
    return { op: "app", fn, args: values, site } satisfies Node
  }

  async function namedLet(args: Value[], sites: Site[], site: Site, scope: Scope | undefined) {
    const [loop, bindingForms, ...body] = args
    const bindings = bindingsOf(bindingForms, sites[1] ?? site)
    const name = (loop as { name: string }).name
    const form = [
      [sym("lambda"), [], [sym("define"), [loop, ...bindings.map(({ name }) => sym(name))], ...body], [loop, ...bindings.map(({ value }) => value)]],
    ]
    const node = await analyzeForm(form, site, scope)
    if (node.op === "app" && node.fn.op === "lambda") {
      const inner = node.fn.body.op === "seq" ? node.fn.body.body[0] : undefined
      if (inner?.op === "define" && inner.value.op === "lambda") inner.value.name = name
    }
    return node
  }

  async function analyzeEach(forms: Value[], parent: Value | undefined, site: Site, scope: Scope | undefined, sites = parent ? childSites(parent, site) : []) {
    const nodes: Node[] = []
    for (const [i, form] of forms.entries()) nodes.push(await analyzeForm(form, sites[i] ?? site, scope))
    return nodes
  }

  async function expand(macro: Macro, args: Value[], site: Site) {
    try {
      return await host.expand(macro, args)
    } catch (error) {
      throw errorAt(`in macro ${macro.name}: ${(error as Error).message}`, site)
    }
  }

  /** Quasiquote as calls that build the same shape; `,x` evaluates, `,@xs` splices. Nested quasiquotes keep their own unquotes. */
  function quasi(form: Value, depth: number): Value {
    if (isVector(form)) return [host.builtin("list->vector"), quasi(form.items, depth)]
    if (isMap(form)) return [host.builtin("hash-map"), ...[...form.entries.values()].flat().map((item) => quasi(item, depth))]
    if (!isList(form)) return isSym(form) ? [sym("quote"), form] : form
    if (!form.length) return [sym("quote"), form]
    const [head, inner] = form
    if (isSym(head) && head.name === "unquote") return depth === 1 ? inner : [host.builtin("list"), [sym("quote"), head], quasi(inner, depth - 1)]
    if (isSym(head) && head.name === "quasiquote") return [host.builtin("list"), [sym("quote"), head], quasi(inner, depth + 1)]
    const isSplice = (item: Value) => depth === 1 && isList(item) && isSym(item[0]) && item[0].name === "unquote-splicing"
    if (!form.some(isSplice)) return [host.builtin("list"), ...form.map((item) => quasi(item, depth))]
    return [host.builtin("append"), ...form.map((item) => (isSplice(item) ? (item as Value[])[1] : [host.builtin("list"), quasi(item, depth)]))]
  }
}

export function errorAt(message: string, site: Site): LispError {
  return Object.assign(new Error(message), { site })
}

export function childSites(form: Value, fallback: Site): Site[] {
  const meta = metaOf(form)
  const count = isList(form) ? form.length : isVector(form) ? form.items.length : isMap(form) ? form.entries.size * 2 : 0
  return Array.from({ length: count }, (_, i) => meta?.children[i] ?? fallback)
}

function isLocal(name: string, scope: Scope | undefined): boolean {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true
  return false
}

function isAnnotation(form: Value) {
  return isList(form) && isSym(form[0]) && form[0].name === ":"
}

function signatureAt(form: Value[], site: Site) {
  try {
    return parseSignature(form.slice(1))
  } catch (error) {
    throw errorAt((error as Error).message, site)
  }
}

function docOf(body: Value[]) {
  const forms = isAnnotation(body[0]) ? body.slice(1) : body
  return typeof forms[0] === "string" && forms.length > 1 ? forms[0] : undefined
}

function definedName(form: Value, scope: Scope): string[] {
  if (!isList(form) || !isSym(form[0]) || isLocal(form[0].name, scope)) return []
  if (form[0].name !== "define" && form[0].name !== "define-source") return []
  const target = isList(form[1]) ? form[1][0] : form[1]
  return isSym(target) ? [target.name] : []
}

function paramsOf(form: Value, site: Site): { params: string[]; rest?: string } {
  if (isSym(form)) return { params: [], rest: form.name }
  if (!isList(form)) throw errorAt(`parameters are a list of symbols, got ${show(form)}`, site)
  const names = form.map((item) => symbolName(item, site, "parameter list"))
  const dot = names.indexOf(".")
  if (dot === -1) return { params: names }
  if (dot !== names.length - 2) throw errorAt("a dotted parameter list ends with . rest", site)
  return { params: names.slice(0, dot), rest: names[dot + 1] }
}

function bindingsOf(form: Value, site: Site) {
  if (!isList(form)) throw errorAt(`bindings are a list of (name value), got ${show(form)}`, site)
  const sites = childSites(form, site)
  return form.map((binding, i) => {
    if (!isList(binding) || binding.length !== 2) throw errorAt(`a binding is (name value), got ${show(binding)}`, sites[i])
    return { name: symbolName(binding[0], sites[i], "binding"), value: binding[1], site: childSites(binding, sites[i])[1], form: binding }
  })
}

function condToIf(clauses: Value[], site: Site): Value {
  if (!clauses.length) return undefined
  const [clause, ...rest] = clauses
  if (!isList(clause) || !clause.length) throw errorAt(`a cond clause is (test body...), got ${show(clause)}`, site)
  const [test, ...body] = clause
  const branch = body.length ? [sym("begin"), ...body] : test
  if (isSym(test) && test.name === "else") return branch
  return [sym("if"), test, branch, condToIf(rest, site)]
}

function symbolName(form: Value, site: Site, where: string) {
  if (isSym(form)) return form.name
  if (isKeyword(form)) throw errorAt(`${where} expects a symbol, got the keyword ${show(form)}`, site)
  throw errorAt(`${where} expects a symbol, got ${show(form)}`, site)
}

function expectCount(args: Value[], min: number, max: number, name: string, site: Site) {
  if (args.length < min || args.length > max)
    throw errorAt(`${name} takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, got ${args.length}`, site)
}
