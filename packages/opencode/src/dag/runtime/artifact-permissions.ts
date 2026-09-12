// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path"
import { Effect } from "effect"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Permission } from "@/permission"
import type { ManagedOutputFileRef } from "./output-ref"
import type { Session } from "@/session/session"
import type { Agent } from "@/agent/agent"
import { SessionID } from "@/session/schema"

function directoryGlob(directory: string) {
  return process.platform === "win32"
    ? FSUtil.normalizePathPattern(path.join(directory, "*"))
    : path.join(directory, "*").replaceAll("\\", "/")
}

/** Permit only verified input objects. Preserve source read restrictions when
 * copying to content.txt, and never override an explicit external deny. */
export function artifactReadPermissions(
  refs: readonly ManagedOutputFileRef[],
  worktree: string,
  ...rulesets: PermissionV1.Ruleset[]
): PermissionV1.Ruleset {
  return refs.flatMap((ref): PermissionV1.Ruleset => {
    const directory = path.dirname(ref.path)
    const glob = directoryGlob(directory)
    const denied = rulesets
      .flat()
      .some(
        (rule) =>
          rule.action === "deny" &&
          [glob, directoryGlob(path.dirname(ref.source_path))].some(
            (target) => Permission.evaluate("external_directory", target, [rule]).action === "deny",
          ),
      )
    const sourceRead = Permission.evaluate("read", path.relative(worktree, ref.source_path), ...rulesets)
    const targetRead = Permission.evaluate("read", path.relative(worktree, ref.path), ...rulesets)
    const readAction: PermissionV1.Rule["action"] =
      sourceRead.action === "deny" || targetRead.action === "deny" ? "deny" : sourceRead.action
    return [
      { permission: "external_directory", pattern: glob, action: denied ? "deny" : "allow" },
      ...(readAction !== "allow"
        ? [
            {
              permission: "read",
              pattern: path.relative(worktree, ref.path),
              action: readAction,
            } satisfies PermissionV1.Rule,
          ]
        : []),
      { permission: "edit", pattern: path.join(path.relative(worktree, directory), "*"), action: "deny" },
    ]
  })
}

/** Runtime capture is a read too. Use the current child session restrictions,
 * in the same agent-then-session order as tool execution, before copying bytes. */
export function makeArtifactSourceAuthorizer(
  sessions: Session.Interface,
  agents: Agent.Interface,
  worktree: string,
  permissions?: Permission.Interface,
) {
  return (childSessionID: string, source: string, workerType?: string): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const child = yield* sessions.get(SessionID.make(childSessionID))
      const agent = yield* agents.get(child.agent ?? workerType ?? "build")
      if (!agent) return yield* Effect.fail(new Error("DAG artifact source permission could not be resolved"))
      const rules = [agent.permission, child.permission ?? []]
      const requests = [
        ...(!FSUtil.contains(worktree, source)
          ? [{ permission: "external_directory", pattern: directoryGlob(path.dirname(source)) }]
          : []),
        { permission: "read", pattern: path.relative(worktree, source) },
      ]
      for (const request of requests) {
        const action = Permission.evaluate(request.permission, request.pattern, ...rules).action
        if (action === "deny")
          return yield* Effect.fail(new Error(`DAG artifact source ${request.permission} denied: ${source}`))
        if (action === "allow") continue
        if (!permissions)
          return yield* Effect.fail(new Error(`DAG artifact source requires ${request.permission} approval: ${source}`))
        yield* permissions.ask({
          sessionID: SessionID.make(childSessionID),
          permission: request.permission,
          patterns: [request.pattern],
          always: [request.pattern],
          metadata: { filepath: source, operation: "artifact_capture" },
          ruleset: Permission.merge(...rules),
        })
      }
    })
}
