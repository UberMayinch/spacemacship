import { isList, type Value } from "./values.ts"

const QUOTES: Record<string, string> = { quote: "'", quasiquote: "`", unquote: ",", "unquote-splicing": ",@" }

/** Prints a value so the reader reads it back, unless `readable` is false, where strings print bare (as `display` does). */
export function show(value: Value, readable = true): string {
  if (value === undefined) return "#<void>"
  if (typeof value === "boolean") return value ? "#t" : "#f"
  if (typeof value === "number") return Number.isInteger(value) || !Number.isFinite(value) ? String(value) : String(Number(value.toPrecision(12)))
  if (typeof value === "string") return readable ? JSON.stringify(value) : value
  if (isList(value)) {
    const [head, inner] = value
    if (value.length === 2 && typeof head === "object" && !isList(head) && head?.tag === "sym" && head.name in QUOTES)
      return QUOTES[head.name] + show(inner, readable)
    return `(${value.map((item) => show(item, readable)).join(" ")})`
  }
  switch (value.tag) {
    case "sym":
      return value.name
    case "kw":
      return `:${value.name}`
    case "vector":
      return `[${value.items.map((item) => show(item, readable)).join(" ")}]`
    case "map":
      return `{${[...value.entries.values()].map(([key, item]) => `${show(key, readable)} ${show(item, readable)}`).join(" ")}}`
    case "closure":
      return value.name ? `#<procedure ${value.name}>` : "#<procedure>"
    case "primitive":
      return `#<primitive ${value.name}>`
    case "macro":
      return `#<macro ${value.name}>`
    case "stream":
      return "#<stream>"
  }
}
