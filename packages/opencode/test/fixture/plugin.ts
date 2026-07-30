import { mkdir } from "fs/promises"
import path from "path"

export async function markPluginDependenciesReady(dir: string) {
  const plugin = path.join(dir, "node_modules", "@opencode-ai", "plugin")
  await mkdir(plugin, { recursive: true })
  await Bun.write(path.join(plugin, "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", version: "0.0.0" }))
  await Bun.write(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ packages: { "": { dependencies: { "@opencode-ai/plugin": "0.0.0" } } } }),
  )
}
