export * as PluginSdk from "./plugin-sdk"

import path from "path"

export const packageName = "@opencode-ai/plugin"
export const vendorPath = path.join("vendor", "npm", "@opencode-ai", "plugin")

export function bundledPath(base = path.dirname(process.execPath)) {
  if (process.env.OPENCODE_PLUGIN_SDK_PATH) return process.env.OPENCODE_PLUGIN_SDK_PATH
  return path.join(base, vendorPath)
}
