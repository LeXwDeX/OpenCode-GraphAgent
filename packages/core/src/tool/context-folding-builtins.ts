export * as ContextFoldingBuiltins from "./context-folding-builtins"

import { Context, Effect, Scope } from "effect"
import { Tool } from "./tool"

export interface Interface {
  /**
   * Host-internal registration capability for shipped context-folding built-ins.
   * Ordinary Location, plugin, and application tools must use their public registration surface.
   */
  readonly register: (
    tools: Readonly<Record<string, Tool.AnyTool>>,
  ) => Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ContextFoldingBuiltins") {}
