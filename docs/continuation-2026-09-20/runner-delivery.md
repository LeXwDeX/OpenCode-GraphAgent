# Trusted runner delivery boundary

Issue #612 completes the repository-runner route only for trusted workflow
events. The manual release workflow has no pull-request trigger: version
resolution, template packaging, Linux builds, release-candidate preparation,
optional publication, and the push-only registration job use
`[self-hosted, Linux, X64]`; Windows builds use
`[self-hosted, Windows, X64]`. macOS remains on `macos-latest`. The dev issue
helper runs only for a merged pull request whose base is `dev`, consumes the
event payload through environment variables, and never checks out PR code.

`release-fork.yml` defaults `create_release` to `false`. Every manual dispatch
still downloads the selected platform archives and template package, records
template provenance, generates and verifies `SHA256SUMS`, validates the release
notes fail-closed, and uploads one candidate bundle. The prepare path inherits
`contents: read`; only `publish-release` has `contents: write` and receives
`GH_TOKEN`. Repository and config checkouts use `persist-credentials: false`.
The checkout, upload, and download actions touched by this migration are pinned
to reviewed commit SHAs.

After this change reaches `dev`, non-publishing acceptance must dispatch the
exact `dev` head with `create_release=false` and `platforms=linux,windows`.
Record the run and job IDs, head SHA, runner IDs/names, and confirm that
`publish-release` is skipped while `prepare-release` succeeds. Download the
candidate bundle, independently verify `SHA256SUMS`, inspect the template
provenance and rendered notes, and run `--version`/`--help` smoke checks from
both native archives. Confirm no tag or GitHub Release was created. Local
workflow tests cannot substitute for this native evidence.
