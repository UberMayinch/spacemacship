import { keyword, makeMap, mapKeyOf, sym, type LispError, type Value } from "./values.ts"

/** Where a form came from: its buffer, its character span, and an id unique for this page. */
export type Site = { origin: string; start: number; end: number; id: number }

/** A compound form's site, with the site of each item (map keys and values alternate). */
export type Meta = Site & { children: Site[] }

export type ReadForm = { form: Value; site: Site }

const DELIMITERS = new Set([..."()[]{}\"';`,"])
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
const PREFIXES: Record<string, string> = { "'": "quote", "`": "quasiquote", ",": "unquote", ",@": "unquote-splicing" }

const metas = new WeakMap<object, Meta>()
let nextId = 1

export function metaOf(form: Value): Meta | undefined {
  return typeof form === "object" && form !== null ? metas.get(form) : undefined
}

export function withMeta<T extends Value>(form: T, meta: Meta): T {
  if (typeof form === "object" && form !== null && !metas.has(form)) metas.set(form, meta)
  return form
}

export function siteAt(origin: string, start: number, end: number): Site {
  return { origin, start, end, id: nextId++ }
}

/**
 * Reads every form in `text` that starts in `from` to `to`, up to `maxForms` of them; sites count from the start of `text`.
 * Throws a `LispError` with the site of the problem; `isIncomplete` when the text ends inside a form.
 */
export function readAll(text: string, origin: string, from = 0, to = text.length, maxForms = Infinity): ReadForm[] {
  let i = from
  const forms: ReadForm[] = []
  while (true) {
    skipBlank()
    if (i >= text.length || i >= to || forms.length >= maxForms) return forms
    forms.push(read())
  }

  function read(): ReadForm {
    skipBlank()
    if (i >= text.length) throw readError("unexpected end of input", i, i, true)
    const start = i
    const c = text[i]
    if (c in CLOSERS) return readCompound(c, start)
    if (c === ")" || c === "]" || c === "}") throw readError(`unexpected ${c}`, i, i + 1)
    const prefix = text.startsWith(",@", i) ? ",@" : c in PREFIXES ? c : undefined
    if (prefix) {
      i += prefix.length
      const head = siteAt(origin, start, i)
      const inner = read()
      const site = siteAt(origin, start, inner.site.end)
      return { form: withMeta([sym(PREFIXES[prefix]), inner.form], { ...site, children: [head, inner.site] }), site }
    }
    if (c === '"') return readString(start)
    return readAtom(start)
  }

  function readCompound(open: string, start: number): ReadForm {
    const close = CLOSERS[open]
    i++
    const items: ReadForm[] = []
    while (true) {
      skipBlank()
      if (i >= text.length) throw readError(`missing ${close}`, start, i, true)
      if (text[i] === close) break
      if (text[i] === ")" || text[i] === "]" || text[i] === "}") throw readError(`expected ${close}, got ${text[i]}`, i, i + 1)
      items.push(read())
    }
    i++
    const site = siteAt(origin, start, i)
    const meta = { ...site, children: items.map((item) => item.site) }
    const forms = items.map((item) => item.form)
    if (open === "(") return { form: withMeta(forms, meta), site }
    if (open === "[") return { form: withMeta({ tag: "vector", items: forms }, meta), site }
    if (forms.length % 2) throw readError("a map needs a value for every key", start, i)
    for (const [index, key] of forms.entries()) {
      if (index % 2) continue
      try {
        mapKeyOf(key)
      } catch (error) {
        throw readError((error as Error).message, items[index].site.start, items[index].site.end)
      }
    }
    const pairs = Array.from({ length: forms.length / 2 }, (_, k): [Value, Value] => [forms[2 * k], forms[2 * k + 1]])
    return { form: withMeta(makeMap(pairs), meta), site }
  }

  function readString(start: number): ReadForm {
    i++
    let value = ""
    while (true) {
      if (i >= text.length) throw readError("unterminated string", start, i, true)
      const c = text[i++]
      if (c === '"') break
      if (c !== "\\") {
        value += c
        continue
      }
      if (i >= text.length) throw readError("unterminated string", start, i, true)
      const escaped = text[i++]
      value += { n: "\n", t: "\t", r: "\r", "0": "\0" }[escaped] ?? escaped
    }
    return { form: value, site: siteAt(origin, start, i) }
  }

  function readAtom(start: number): ReadForm {
    while (i < text.length && !/\s/.test(text[i]) && !DELIMITERS.has(text[i])) i++
    const token = text.slice(start, i)
    return { form: atomOf(token), site: siteAt(origin, start, i) }
  }

  function skipBlank() {
    while (i < text.length) {
      if (/\s/.test(text[i])) i++
      else if (text[i] === ";") while (i < text.length && text[i] !== "\n") i++
      else if (text.startsWith("#|", i)) {
        const end = text.indexOf("|#", i + 2)
        if (end === -1) throw readError("unterminated block comment", i, text.length, true)
        i = end + 2
      } else if (text.startsWith("#;", i)) {
        i += 2
        read()
      } else return
    }
  }

  function readError(message: string, start: number, end: number, isIncomplete = false): LispError {
    return Object.assign(new Error(message), { site: siteAt(origin, start, end), isIncomplete })
  }
}

function atomOf(token: string): Value {
  if (NUMBER.test(token)) return Number(token)
  if (token === "#t" || token === "#true") return true
  if (token === "#f" || token === "#false") return false
  if (token.length > 1 && token.startsWith(":")) return keyword(token.slice(1))
  return sym(token)
}
