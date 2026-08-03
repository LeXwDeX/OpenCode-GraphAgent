import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"

async function loadModelsData() {
  if (process.env.MODELS_DEV_API_JSON) {
    console.log("Loaded models.dev snapshot from MODELS_DEV_API_JSON")
    return Bun.file(process.env.MODELS_DEV_API_JSON).text()
  }

  const response = await fetch(`${modelsUrl}/api.json`).catch(() => undefined)
  if (response?.ok) {
    console.log("Loaded models.dev snapshot from api.json")
    return response.text()
  }

  const snapshotSpecifier = "@opencode-ai/models/snapshot"
  const snapshot = await import(snapshotSpecifier).catch(() => undefined)
  if (snapshot) {
    console.log("Loaded models.dev snapshot from @opencode-ai/models")
    return JSON.stringify(snapshot.providers)
  }

  console.log("Loaded no models.dev snapshot")
  return "undefined"
}

export const modelsData = await loadModelsData()

/**
 * DAG reference templates compiled into the binary so air-gapped installs
 * ship the curated workflows without network access. The release pipeline
 * clones opencode-dag-config and points DAG_TEMPLATES_DIR at it; when absent
 * (local dev), the binary has no builtin templates and falls back to the
 * project/global workflow library scopes.
 */
async function loadDagTemplatesData() {
  const templatesDir = process.env.DAG_TEMPLATES_DIR
  if (!templatesDir) {
    console.log("Loaded no dag templates snapshot (DAG_TEMPLATES_DIR unset)")
    return "undefined"
  }
  const templates: Record<string, string> = {}
  for (const file of await Array.fromAsync(new Bun.Glob("*.yaml").scan({ cwd: templatesDir }))) {
    const name = file.replace(/\.ya?ml$/, "")
    templates[name] = await Bun.file(path.join(templatesDir, file)).text()
  }
  console.log(`Loaded dag templates snapshot from ${templatesDir}: ${Object.keys(templates).length} templates`)
  return JSON.stringify(templates)
}

export const dagTemplatesData = await loadDagTemplatesData()
