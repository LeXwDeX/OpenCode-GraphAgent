import * as fs from "node:fs/promises"
import path from "node:path"
import { NODE_SCHEMA_WORKER_NAME } from "../../opencode/script/schema-worker-build"

export async function copyServerAssets(source: string, destination: string) {
  await fs.mkdir(destination, { recursive: true })
  // A missing worker must fail the build, rather than shipping a backend
  // whose first otherwise-valid submit_result cannot run validation.
  await fs.copyFile(path.join(source, NODE_SCHEMA_WORKER_NAME), path.join(destination, NODE_SCHEMA_WORKER_NAME))
  for (const name of await fs.readdir(source)) {
    if (!name.endsWith(".wasm")) continue
    await fs.copyFile(path.join(source, name), path.join(destination, name))
  }
}
