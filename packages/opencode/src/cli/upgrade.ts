import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"

// This fork never auto-updates: it only checks the fork's GitHub releases and
// notifies. `autoupdate: false` (or OPENCODE_DISABLE_AUTOUPDATE) silences the
// notification entirely.
export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const latest = await Installation.latest().catch(() => {})
  if (!latest) return

  if (!Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE && InstallationVersion === latest) return

  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Installation.Event.UpdateAvailable.type,
      properties: { version: latest },
    },
  })
}
