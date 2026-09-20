# Runner GitHub CLI dependency

Issue #617 follows the first non-publishing release dispatch after the trusted-runner migration. Run
`35496465661` reached the read-only `Prepare Release Candidate` job on the trusted Linux runner, then
failed before candidate verification because `gh` was not installed on the host. The preserved job log
has SHA-256 `68021519b3881c5c5598413e17809d34c4908cd9091e6c90de7c88c48358b99d`.

The workflows now install GitHub CLI `2.101.0` into a unique directory under `RUNNER_TEMP`. Linux X64
and Windows X64 archives use their fixed official SHA-256 digests and are verified before extraction.
Downloads are anonymous, bounded and retried; the helper changes only `GITHUB_PATH`. Unsupported
platforms fail closed. Windows extraction uses `powershell.exe Expand-Archive` with paths passed through
environment variables after `cygpath` conversion.

Jobs that already check out trusted repository content use the shared local action before CI evidence
reuse or release preparation. The publication and dev issue auto-close jobs retain their no-checkout
boundary and use the same pinned Linux bootstrap inline, before the separate token-bearing step. No host
package, service, global configuration or credential is modified.

Local acceptance covers Linux and simulated Windows ZIP installation, checksum rejection, unsupported
platform rejection, workflow wiring, token separation, inline-bootstrap equality, shell lint and action
lint. A current-head native CI run and a new non-publishing release dispatch are still required to prove
the trusted Linux/Windows runners and release candidate path after delivery.
