// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Schemaless report nodes submit one absolute file path. New submissions
 * freeze the bytes under Global data and return a managed integrity receipt;
 * downstream execution and result/recovery boundaries verify that receipt.
 * Legacy references and inline/schema outputs remain readable unchanged.
 */

import { appendFile, readFile, stat, open, mkdir, link, unlink, lstat, chmod } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Global } from "@opencode-ai/core/global"

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

export interface ArtifactProvenance {
  workflow_id: string
  node_id: string
  child_session_id: string
  replan_attempt: number
  graph_rev?: number
}

export interface ManagedOutputFileRef extends OutputFileRef {
  storage: "managed-v1"
  source_path: string
  provenance: ArtifactProvenance
}

export function isManagedOutputFileRef(value: unknown): value is ManagedOutputFileRef {
  return (
    isOutputFileRef(value) &&
    "storage" in value &&
    value.storage === "managed-v1" &&
    "source_path" in value &&
    typeof value.source_path === "string" &&
    "provenance" in value &&
    isRecord(value.provenance) &&
    typeof value.provenance.workflow_id === "string" &&
    typeof value.provenance.node_id === "string" &&
    typeof value.provenance.child_session_id === "string" &&
    Number.isSafeInteger(value.provenance.replan_attempt)
  )
}

function artifactPath(digest: string) {
  return path.join(Global.Path.data, "workflow-artifacts", "objects", digest.slice(0, 2), digest, "content.txt")
}

/** Old receipts remain readable as legacy references. Managed receipts must
 * resolve to their content-addressed object and match the committed bytes. */
export function verifyOutputFileRef(value: unknown): Effect.Effect<void, Error> {
  if (!isRecord(value) || value.storage !== "managed-v1") return Effect.void
  return Effect.tryPromise({
    try: () => verifyManagedFile(value),
    catch: (cause) => new Error(`Managed DAG artifact unavailable: ${String(value.path)} (${String(cause)})`),
  })
}

async function verifyManagedFile(value: unknown) {
  if (
    !isManagedOutputFileRef(value) ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.path !== artifactPath(value.sha256) ||
    value.content_ref !== value.path ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > FILE_REF_MAX_BYTES
  )
    throw new Error("invalid managed receipt")
  const info = await lstat(value.path)
  if (!info.isFile() || info.size !== value.size) throw new Error("missing or changed object size")
  const bytes = await readBoundedFile(value.path)
  if (!bytes || Hash.sha256(bytes) !== value.sha256) throw new Error("object digest mismatch")
}

async function readBoundedFile(candidate: string): Promise<Buffer | undefined> {
  const file = await open(candidate, "r")
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size <= 0 || info.size > FILE_REF_MAX_BYTES) return undefined
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) throw new Error("source shrank during capture")
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
      throw new Error("source changed during capture")
    return bytes
  } finally {
    await file.close()
  }
}

/** Freeze a recognized file before recording success. Invalid legacy path
 * submissions still remain inline; once a file is recognized, commit failures
 * propagate instead of claiming that its mutable source is durable. */
export function commitOutputFileRef(
  rawText: string,
  provenance: ArtifactProvenance,
  authorizeSource?: (source: string) => Effect.Effect<void, Error>,
): Effect.Effect<ManagedOutputFileRef | undefined, Error> {
  const candidate = rawText.trim()
  if (!candidate || candidate.length > MAX_PATH_CHARS || /[\r\n]/.test(candidate) || !path.isAbsolute(candidate))
    return Effect.succeed(undefined)
  return Effect.gen(function* () {
    // Freeze the Windows identity while the source still exists. Receipts
    // must retain permission matching after its worktree or alias is deleted.
    const source = process.platform === "win32" ? FSUtil.normalizePath(candidate) : candidate
    const info = yield* Effect.promise(() => stat(source).catch(() => undefined))
    if (!info?.isFile() || info.size <= 0 || info.size > FILE_REF_MAX_BYTES) return undefined
    if (authorizeSource) yield* authorizeSource(source)
    return yield* Effect.tryPromise({
      try: async () => {
        const bytes = await readBoundedFile(source)
        if (!bytes) throw new Error("source became unavailable during capture")
        const digest = Hash.sha256(bytes)
        const destination = artifactPath(digest)
        const directory = path.dirname(destination)
        const text = new TextDecoder().decode(bytes.subarray(0, SUMMARY_DECODE_BYTES))
        const ref: ManagedOutputFileRef = {
          kind: "file_ref",
          storage: "managed-v1",
          source_path: source,
          provenance,
          path: destination,
          content_ref: destination,
          size: bytes.byteLength,
          sha256: digest,
          summary: text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}\u2026` : text,
        }
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const temporary = path.join(directory, `.pending-${randomUUID()}`)
        const file = await open(temporary, "wx", 0o600)
        try {
          try {
            await file.writeFile(bytes)
            if (process.platform !== "win32") await file.chmod(0o444)
            await file.sync()
          } finally {
            await file.close()
          }
          // A hard link publishes the flushed file atomically without replacing
          // an existing object. Concurrent identical captures share the bytes.
          await link(temporary, destination).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error
          })
          if (process.platform !== "win32") {
            // Flush the newly created object hierarchy as well as the final
            // directory entry. Windows does not support opening directories.
            for (let current = directory; FSUtil.contains(Global.Path.data, current); current = path.dirname(current)) {
              const parent = await open(current, "r")
              try {
                await parent.sync()
              } finally {
                await parent.close()
              }
              if (current === Global.Path.data) break
            }
          }
        } finally {
          await unlink(temporary)
        }
        // Windows cannot unlink a read-only hard link; freeze the published
        // object only after its temporary sibling has been removed.
        if (process.platform === "win32") await chmod(destination, 0o444)
        await verifyManagedFile(ref)
        return ref
      },
      catch: (cause) => new Error(`DAG artifact commit failed for ${candidate}: ${String(cause)}`),
    })
  })
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
  const reportArea = FSUtil.normalizePath(path.join(directory, REPORT_AREA))
  if (!FSUtil.contains(reportArea, FSUtil.normalizePath(refPath))) return Effect.void
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
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to ensure the workflow-reports gitignore entry", { directory, cause }),
    ),
  )
}
