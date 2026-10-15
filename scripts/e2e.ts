/**
 * End-to-end smoke test against a real, private `opencode serve` instance.
 *
 *   bun scripts/e2e.ts <empty-project-dir> [provider/model] [condition]
 *
 * Writes `.opencode/opencode.json` loading this plugin into the project, starts a standalone server there (your
 * background service is untouched), runs `/goal` through the API and follows the loop until the goal resolves.
 */
import { OpenCode } from "@opencode/client"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs"
import path from "node:path"
import { renderTranscript } from "../src/core/transcript.ts"
import { GoalRpc } from "../src/rpc.ts"

const [projectArg, modelArg = "opencode/deepseek-v4.1-flash-free", conditionArg] = process.argv.slice(2)
if (!projectArg) throw new Error("usage: bun scripts/e2e.ts <empty-project-dir> [provider/model] [condition]")
const project = path.resolve(projectArg)
const pluginRoot = path.resolve(import.meta.dir, "..")
const port = 4700 + Math.floor(Math.random() * 200)
const baseUrl = `http://127.0.0.1:${port}`
const condition =
  conditionArg ??
  "notes/plan.md exists with exactly three numbered steps for brewing tea, and notes/done.txt contains the single word DONE. Prove both by printing the files."
const TIMEOUT_MS = 10 * 60_000
const password = crypto.randomUUID()
const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }

mkdirSync(path.join(project, ".opencode"), { recursive: true })
writeFileSync(path.join(project, ".opencode", "opencode.json"), JSON.stringify({ plugins: [process.env.E2E_PLUGIN ?? pluginRoot.replaceAll("\\", "/")] }, null, 2))

const log = createWriteStream(path.join(project, "server.log"))
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "info"], {
  cwd: project,
  shell: process.platform === "win32",
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
})
server.stdout.pipe(log)
server.stderr.pipe(log)

const stamp = () => new Date().toISOString().slice(11, 19)
const say = (...args: unknown[]) => console.log(stamp(), ...args)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let exitCode = 1

try {
  const client = OpenCode.make({ baseUrl, headers })
  for (let i = 0; ; i++) {
    if (await client.server.info().then(() => true, () => false)) break
    if (i > 120) throw new Error("server did not start")
    await sleep(500)
  }
  say(`server up on ${baseUrl}`)
  const location = { directory: project }
  const slash = modelArg.indexOf("/")
  const session = await client.session.create({
    location,
    title: "goal e2e",
    model: { providerID: modelArg.slice(0, slash), id: modelArg.slice(slash + 1) },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  })
  const sessionID = session.id
  say("session", sessionID)

  const plugins = await client.plugin.list({ location }).catch((error) => String(error))
  const ours = JSON.stringify(plugins).match(/[^{}]*OpenCodeGoal[^{}]*/i)?.[0]
  say("plugin:", ours ?? JSON.stringify(plugins).slice(0, 600))
  // Plugins activate in the background after the location boots; wait for the command to appear.
  let registered = false
  for (let i = 0; i < 60 && !registered; i++) {
    const commands = await client.command.list({ location }).catch(() => undefined)
    registered = /"name":"goal"/.test(JSON.stringify(commands ?? ""))
    if (!registered) await sleep(1_000)
  }
  say("goal command registered:", registered)
  if (!registered) throw new Error("plugin did not register /goal (see server.log)")

  const abort = new AbortController()
  void (async () => {
    for await (const event of client.event.subscribe({ signal: abort.signal })) {
      const data = (event as { data?: Record<string, any> }).data ?? {}
      if (data.sessionID && data.sessionID !== sessionID) continue
      switch (event.type) {
        case "session.execution.started":
        case "session.execution.succeeded":
          say(event.type)
          break
        case "session.execution.failed":
          say(event.type, JSON.stringify(data.error))
          break
        case "session.execution.interrupted":
          say(event.type, data.reason)
          break
        case "session.tool.called":
          say("  tool", JSON.stringify(data.input).slice(0, 120))
          break
        case "rpc.goal.notice":
          say(`NOTICE [${data.level}] ${data.title}: ${String(data.message).replace(/\s+/g, " ").slice(0, 200)}`)
          break
      }
    }
  })().catch(() => {})

  const goal = client.rpc(GoalRpc)
  await client.session.command({ sessionID, name: "goal", text: condition })
  say("/goal sent")

  const started = Date.now()
  let last: any
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(3_000)
    last = ((await goal.get({ sessionID }, { location })) as { goal: any }).goal
    if (last && !["active"].includes(last.status)) break
  }
  abort.abort()
  say("final", JSON.stringify({ status: last?.status, turns: last?.turns, reason: last?.reason, spend: last?.spend, history: last?.history?.map((h: any) => `${h.turn}:${h.verdict}`) }))

  // The independent evaluator's digest, rendered from the real session context.
  const digest = renderTranscript(await client.session.context({ sessionID }), { maxChars: 60_000 })
  say(`digest: ${digest.length} chars`, JSON.stringify(digest.slice(0, 1500)))
  await client.session.command({ sessionID, name: "goal", text: "" })
  for (const file of ["notes/plan.md", "notes/done.txt"]) {
    const full = path.join(project, file)
    say(file, existsSync(full) ? JSON.stringify(readFileSync(full, "utf8")) : "(missing)")
  }
  exitCode = last?.status === "achieved" ? 0 : 1
} catch (error) {
  console.error(error)
} finally {
  // On Windows the server runs under a shell wrapper: kill the whole tree first, or the server outlives us.
  if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" })
  else server.kill()
  await sleep(500)
  process.exit(exitCode)
}
