import { basename } from "path"

// Command name to surface in user-facing prompts (e.g. "opencodeg" for the
// opencodeg binary), derived from the current executable path.
export const commandName = () => basename(process.execPath)

export * as CommandName from "./command-name"
