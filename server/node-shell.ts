import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Shell } from "../src/environment/buffers.ts"

/** A command still running after this is stopped. */
const TIMEOUT_MS = 10 * 60_000

/**
 * Runs each command in its own `bash -c`, with no input attached, so a command that would wait for a keypress ends instead. Each runs in its
 * own process group, so stopping it stops whatever it started too.
 * A marker line printed after the command carries the directory it ended in, so `cd` carries over to the next command.
 */
export const nodeShell: Shell = ({ command, cwd, signal, onOutput }) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const marker = `__spacemacship_cwd_${randomUUID()}__`
    const script = `${command}\n__status=$?\nprintf '%s%s\\n' '${marker}' "$PWD"\nexit $__status`
    const child = spawn("bash", ["-c", script], {
      cwd,
      env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    let pending = ""
    let endCwd = cwd
    const flush = (isEnd: boolean) => {
      const lines = pending.split("\n")
      pending = isEnd ? "" : lines.pop()!
      const complete = isEnd ? lines.filter((line, i) => i < lines.length - 1 || line) : lines
      let text = ""
      for (const line of complete) {
        const at = line.indexOf(marker)
        if (at === -1) text += `${line}\n`
        else {
          text += line.slice(0, at)
          endCwd = line.slice(at + marker.length)
        }
      }
      if (text) onOutput(text)
    }
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk
      flush(false)
    })
    child.stderr.setEncoding("utf8").on("data", onOutput)
    const stop = () => {
      try {
        process.kill(-child.pid!, "SIGTERM")
      } catch {
        child.kill("SIGTERM")
      }
    }
    const timer = setTimeout(stop, TIMEOUT_MS)
    signal.addEventListener("abort", stop, { once: true })
    child.on("error", reject)
    child.on("close", (code, killedBy) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
      flush(true)
      if (signal.aborted) reject(signal.reason)
      else resolve({ exitCode: code ?? (killedBy ? 128 : 1), cwd: endCwd })
    })
  })
