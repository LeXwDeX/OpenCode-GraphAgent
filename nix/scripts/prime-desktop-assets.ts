import path from "node:path"

const archive = process.argv[2]
if (!archive) throw new Error("A fixed-output ripgrep archive is required")
const root = process.cwd()
const { prepareDesktopRuntimeAssets } = await import(path.join(root, "packages/desktop/scripts/runtime-assets.ts"))
// Use the existing receipt and archive verification with bytes already fetched
// by Nix. The following ordinary desktop prebuild then resolves its local cache.
await prepareDesktopRuntimeAssets({
  directory: process.argv[3] ?? path.join(root, "packages/desktop/resources/runtime-assets"),
  fetch: async () => new Response(await Bun.file(archive).arrayBuffer()),
})
