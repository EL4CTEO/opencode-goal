/**
 * Loads a TUI entry the way OpenCode's CLI does (host runtime modules + OpenTUI runtime plugin support), from any
 * path. Point it at an installed copy under node_modules to catch packaging bugs that a local checkout hides.
 *
 *   bun scripts/tui-load-check.ts <path/to/node_modules/pkg/tui.ts>
 */
import { ensurePluginRuntime, provides } from "@opencode/plugin/runtime"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import path from "node:path"
import { pathToFileURL } from "node:url"

const target = process.argv[2]
if (!target) throw new Error("usage: bun scripts/tui-load-check.ts <tui entry>")

ensurePluginRuntime()
ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } }, preserve: provides })

try {
  const module = await import(pathToFileURL(path.resolve(target)).href)
  const plugin = module.default as { id?: unknown; setup?: unknown } | undefined
  if (typeof plugin?.id !== "string" || typeof plugin.setup !== "function") throw new Error("default export is not a TUI plugin")
  console.log(`ok: loaded TUI plugin "${plugin.id}"`)
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
