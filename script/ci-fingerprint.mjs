import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

// Hash Git objects, including modes and submodules, without checkout or newline
// normalization. Only the ordinary root delivery record is not a product input.
export function fingerprint(ref = "HEAD", cwd = process.cwd()) {
  const tree = execFileSync("git", ["ls-tree", "-rz", "--full-tree", ref], { cwd })
  const hash = createHash("sha256")
  let start = 0
  for (let end = 0; end < tree.length; end++) {
    if (tree[end] !== 0) continue
    const entry = tree.subarray(start, end)
    const tab = entry.indexOf(9)
    if (tab < 0) throw new Error("Invalid Git tree entry")
    const record = entry.subarray(tab + 1).equals(Buffer.from(".specgit.yaml"))
    if (!record || !entry.subarray(0, 12).equals(Buffer.from("100644 blob "))) {
      hash.update(entry)
      hash.update(Buffer.from([0]))
    }
    start = end + 1
  }
  return hash.digest("hex")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = fingerprint()
  const day = new Date().toISOString().slice(0, 10)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `fingerprint=${value}\nday=${day}\n`)
  }
  console.log(value)
}
