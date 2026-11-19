import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, watch, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { resolve } from "node:path"
import { createEnvironment, type Command } from "../src/environment/environment.ts"
import { nodeShell } from "./node-shell.ts"

/**
 * The kernel process: one live environment on this machine, with real terminals. It listens on localhost only and answers only requests
 * carrying the token it writes to `.kernel-token`, which the Vite dev server adds when it proxies `/kernel`; a page never sees the token.
 */
const ROOT = resolve(import.meta.dirname, "..")
const PORT = Number(process.env.SPACEMACSHIP_PORT ?? 7878)
const HOME = resolve(process.env.SPACEMACSHIP_HOME ?? process.cwd())
const CONFIG_FILE = resolve(ROOT, "environment.scm")
const TOKEN_FILE = resolve(ROOT, ".kernel-token")
const SNAPSHOT_MS = 50
const MAX_BODY_BYTES = 1_000_000

const token = randomBytes(24).toString("hex")
writeFileSync(TOKEN_FILE, token, { mode: 0o600 })

const clients = new Set<ServerResponse>()
let snapshotTimer: NodeJS.Timeout | undefined
const environment = await createEnvironment({ shell: nodeShell, home: HOME, config: readFileSync(CONFIG_FILE, "utf8"), onChange: scheduleSnapshot })
if (process.env.CEREBRAS_API_KEY) await environment.command({ type: "key", key: process.env.CEREBRAS_API_KEY })

let reloadTimer: NodeJS.Timeout | undefined
watch(CONFIG_FILE, () => {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => environment.load(readFileSync(CONFIG_FILE, "utf8")), 100)
})

createServer(handle).listen(PORT, "127.0.0.1", () => {
  console.log(`spacemacship kernel on http://127.0.0.1:${PORT}, terminals start in ${HOME}`)
})

async function handle(request: IncomingMessage, response: ServerResponse) {
  if (!isAuthorized(request)) return send(response, 403, { error: "missing kernel token, or a request from another origin" })
  const path = new URL(request.url ?? "/", "http://localhost").pathname
  if (request.method === "GET" && path === "/kernel/events") return subscribe(response)
  if (request.method === "POST" && path === "/kernel/command") {
    if (!request.headers["content-type"]?.startsWith("application/json")) return send(response, 415, { error: "send JSON" })
    try {
      const command = JSON.parse(await bodyOf(request)) as Command
      const result = await environment.command(command)
      return send(response, 200, { ok: true, result: result ?? null })
    } catch (error) {
      return send(response, 400, { error: (error as Error).message })
    }
  }
  send(response, 404, { error: "not found" })
}

function subscribe(response: ServerResponse) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
  response.write(`data: ${JSON.stringify(environment.snapshot())}\n\n`)
  clients.add(response)
  response.on("close", () => clients.delete(response))
}

/** Changes come in bursts (every character of a streaming action is one); clients get at most one snapshot per `SNAPSHOT_MS`. */
function scheduleSnapshot() {
  snapshotTimer ??= setTimeout(() => {
    snapshotTimer = undefined
    const message = `data: ${JSON.stringify(environment.snapshot())}\n\n`
    for (const client of clients) client.write(message)
  }, SNAPSHOT_MS)
}

/** The token proves the request came through the dev server; the origin check keeps other local pages, on other ports, from using it. */
function isAuthorized(request: IncomingMessage) {
  const given = Buffer.from(String(request.headers["x-kernel-token"] ?? ""))
  const expected = Buffer.from(token)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  const origin = request.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

function bodyOf(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) request.destroy(new Error("body too large"))
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(body))
}
