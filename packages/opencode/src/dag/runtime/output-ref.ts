// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Node-output file references (v1.0.15 Train B ledger B1–B4).
 *
 * A long-report node without an output_schema may submit an absolute file
 * path instead of inlining its text. When the submitted string IS an
 * absolute path, the runtime validates existence + size>0 at submit time and
 * records `{content_ref, size, sha256}` — plus the summary the result seam
 * serves — in captured_output: an integrity receipt for later verification
 * (B2). output_schema nodes are untouched (inline JSON, B1) and existing
 * inline outputs coexist with no migration (B3): any anomaly (missing file,
 * empty file, directory, prose around the path) simply leaves the legacy
 * inline behavior.
 *
 * Report-area convention: `<project>/.opencode/workflow-reports/` (named
 * after the existing `.opencode/workflow-drafts/` area). On the first
 * capture into the area the runtime ensures the project `.gitignore` carries
 * the area entry — append-only, idempotent, never overwrite (B4).
 */

import { appendFile, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"

export interface OutputFileRef {
  /** Discriminator against output_schema captured payloads (inline JSON). */
  kind: "file_ref"
  /** Durable reference for the result seam — the parent agent fetches content itself. */
  content_ref: string
  /** Absolute path the read tool fetches. */
  path: string
  /** Byte size at submit time. */
  size: number
  /** SHA-256 of the file bytes at submit time (integrity for later verification). */
  sha256: string
  /** First ~200 chars of content at submit time — stable even if the file drifts later. */
  summary: string
}

const SUMMARY_CHARS = 200
// The summary only needs the leading chars; decoding a bounded prefix keeps a
// giant report from being copied twice (once for the digest, once for text).
const SUMMARY_DECODE_BYTES = 4096
// #349/CAP-02: whole-file capture bound — a giant or sparse referenced file
// must not spike memory; larger files fall back to the inline path
// (returning undefined here is the designed degradation).
const FILE_REF_MAX_BYTES = 64 * 1024 * 1024
const MAX_PATH_CHARS = 4096

export const REPORT_AREA = path.join(".opencode", "workflow-reports")
// Gitignore patterns are slash-separated on every platform.
const REPORT_GITIGNORE_ENTRY = ".opencode/workflow-reports/"

export function isOutputFileRef(value: unknown): value is OutputFileRef {
  if (!isRecord(value)) return false
  return (
    value.kind === "file_ref" &&
    typeof value.content_ref === "string" &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    typeof value.sha256 === "string" &&
    typeof value.summary === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Submit-time detection: the trimmed reply must BE one absolute path (no
 * surrounding prose, no inner whitespace — the single-token contract keeps a
 * sentence that mentions a path inline). Existence + regular file + size>0
 * are validated at submit time; every anomaly resolves to `undefined` so the
 * caller falls back to the exact legacy inline behavior (never fails the
 * node — the capture is audit metadata, not the settlement).
 */
export function captureOutputFileRef(rawText: string): Effect.Effect<OutputFileRef | undefined> {
  const candidate = rawText.trim()
  if (
    candidate.length === 0 ||
    candidate.length > MAX_PATH_CHARS ||
    /\s/.test(candidate) ||
    !path.isAbsolute(candidate)
  ) {
    return Effect.succeed(undefined)
  }
  return Effect.gen(function* () {
    const info = yield* Effect.promise(() => stat(candidate).catch(() => undefined))
    if (!info || !info.isFile() || info.size === 0) return undefined
    // #349/CAP-02: refuse oversized refs — stat already told us the size, so
    // the read never happens for a pathological file.
    if (info.size > FILE_REF_MAX_BYTES) return undefined
    const bytes = yield* Effect.promise(() =>
      Bun.file(candidate)
        .arrayBuffer()
        .catch(() => undefined),
    )
    if (!bytes || bytes.byteLength === 0) return undefined
    const text = new TextDecoder().decode(bytes.slice(0, SUMMARY_DECODE_BYTES))
    const summary = text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}\u2026` : text
    return {
      kind: "file_ref" as const,
      content_ref: candidate,
      path: candidate,
      size: bytes.byteLength,
      sha256: Hash.sha256(Buffer.from(bytes)),
      summary,
    }
  }).pipe(Effect.orElseSucceed(() => undefined))
}

/**
 * First-write gitignore guarantee for the project `.opencode/` report area
 * (B4). Fires only when the captured ref lies inside
 * `<directory>/.opencode/workflow-reports/` — cross-worktree refs
 * (/private/tmp/...) have no project gitignore to touch. Append-only and
 * idempotent: an existing entry (or an already-covering `.opencode/` rule)
 * leaves the file untouched; pre-existing entries are preserved. Best-effort
 * — a permission blip must never fail the node completion.
 */
export function ensureReportAreaGitignore(directory: string, refPath: string): Effect.Effect<void> {
  if (!FSUtil.contains(path.join(directory, REPORT_AREA), refPath)) return Effect.void
  const gitignorePath = path.join(directory, ".gitignore")
  return Effect.gen(function* () {
    const existing = yield* Effect.promise(() => readFile(gitignorePath, "utf8").catch(() => undefined))
    const covered = existing
      ?.split("\n")
      .map((line) => line.trim())
      .some((line) => [REPORT_GITIGNORE_ENTRY, ".opencode/workflow-reports", ".opencode/", ".opencode"].includes(line))
    if (covered) return
    const separator = existing === undefined || existing.length === 0 || existing.endsWith("\n") ? "" : "\n"
    yield* Effect.promise(() => appendFile(gitignorePath, `${separator}${REPORT_GITIGNORE_ENTRY}\n`))
  }  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to ensure the workflow-reports gitignore entry", { directory, cause }),
    ),
  )
}
