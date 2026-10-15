/**
 * Precompiles the TUI entry to dist/tui.js.
 *
 * OpenCode compiles plugin JSX with OpenTUI's Solid transform, but that transform skips every file under
 * node_modules, so an installed package must ship already-compiled Solid output. Host-provided modules stay
 * external: OpenCode rewrites them to its own runtime instances at load time.
 */
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "tui.tsx")],
  outdir: path.join(root, "dist"),
  target: "bun",
  format: "esm",
  external: ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"],
  plugins: [createSolidTransformPlugin({ moduleName: "@opentui/solid" })],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const output of result.outputs) console.log(`built ${path.relative(root, output.path)} (${output.size} bytes)`)

await Bun.write(
  path.join(root, "dist", "tui.d.ts"),
  'import type { Definition } from "@opencode/plugin/tui/plugin"\ndeclare const plugin: Definition\nexport default plugin\n',
)
