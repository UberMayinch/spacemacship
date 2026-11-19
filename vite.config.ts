import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig, type Plugin } from "vite"

const KERNEL_TOKEN_FILE = resolve(import.meta.dirname, ".kernel-token")
const KERNEL_URL = `http://127.0.0.1:${process.env.SPACEMACSHIP_PORT ?? 7878}`

/** The Lisp files the REPL pane may write, by name. */
const CONFIG_FILES = new Set(["config.scm", "workspace.scm"])
const MAX_CONFIG_BYTES = 1_000_000

/** Dev only: the REPL pane saves its Lisp file here, and the file change comes back to the page as a hot update. */
function saveConfig(): Plugin {
  return {
    name: "spacemacship-save-config",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__spacemacship/save", (request, response) => {
        if (request.method !== "POST") return void ((response.statusCode = 405), response.end())
        // A custom header forces a CORS preflight, which the dev server does not grant, so other sites cannot write the file.
        if (request.headers["x-spacemacship"] !== "save") return void ((response.statusCode = 403), response.end())
        const file = new URL(request.url ?? "", "http://localhost").searchParams.get("file") ?? ""
        if (!CONFIG_FILES.has(file)) return void ((response.statusCode = 400), response.end("unknown file"))
        let body = ""
        request.setEncoding("utf8")
        request.on("data", (chunk: string) => {
          body += chunk
          if (body.length > MAX_CONFIG_BYTES) request.destroy()
        })
        request.on("end", () => {
          writeFileSync(resolve(import.meta.dirname, file), body)
          response.end("saved")
        })
      })
    },
  }
}

export default defineConfig({
  base: "/spaceship/",
  plugins: [saveConfig()],
  server: {
    proxy: {
      // The kernel process; the token is added here, read fresh each time since the kernel writes a new one on every start.
      "/kernel": {
        target: KERNEL_URL,
        configure: (proxy) =>
          proxy.on("proxyReq", (request) => {
            if (existsSync(KERNEL_TOKEN_FILE)) request.setHeader("x-kernel-token", readFileSync(KERNEL_TOKEN_FILE, "utf8").trim())
          }),
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        workspace: resolve(import.meta.dirname, "workspace.html"),
        environment: resolve(import.meta.dirname, "environment.html"),
        ...Object.fromEntries(
          readdirSync(resolve(import.meta.dirname, "extra"))
            .filter((file) => file.endsWith(".html"))
            .map((file) => [`extra/${file.slice(0, -".html".length)}`, resolve(import.meta.dirname, "extra", file)]),
        ),
      },
    },
  },
})
