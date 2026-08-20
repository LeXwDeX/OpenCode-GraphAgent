# Release Notes Series Files

One markdown file per release series — `.github/releases/vX.Y.Z.md` — is the
source of truth for the GitHub Release body. The `dev` prereleases
(`X.Y.Z-dev.1 … dev.N`) and the `main` stable promotion (`X.Y.Z`) of a series
all render the **same** file; only the channel word differs.

The release job (`.github/workflows/release-fork.yml`) renders and validates
the file **before** `gh release create` and fails closed on any violation — a
release can never ship with placeholder notes.

## Lifecycle

1. **Series starts** — when `X.Y.Z` becomes the next version, the release job
   looks for `.github/releases/vX.Y.Z.md`. Until that file is committed, every
   release attempt of the series fails; the validator error names the exact
   expected path. This is intentional.
2. **Dev prereleases** — each `X.Y.Z-dev.N` build re-renders the current file
   content. Update the file as the series evolves.
3. **Stable promotion** — the `main` release of `X.Y.Z` renders the same file;
   `{Prerelease/Stable}` becomes `Stable`. The compare range always spans from
   the last stable tag, not from the previous `-dev.N`.
4. **Series closes** — after the stable release ships, the file remains as the
   historical record. The next series needs its own new `vX.Y.(Z+1).md`.

## Placeholders

Five tokens are machine-substituted at render time:

| Token                | Replaced with                                              |
| -------------------- | --------------------------------------------------------- |
| `{VERSION}`          | bare semver, e.g. `1.0.10` (no `v` prefix)                 |
| `{Prerelease/Stable}` | `Prerelease` on `dev`, `Stable` on `main`                 |
| `{branch}`           | releasing branch name (`dev` or `main`)                    |
| `{previous_tag}`     | latest existing stable tag, e.g. `graphagent-v1.0.9`       |
| `{current_tag}`      | the tag being released, e.g. `graphagent-v1.0.10`          |

The template also contains authoring-guidance braces (`{Feature name}`,
`{module}`, `{One-sentence summary …}`). These are **not** substituted —
replace every one of them with real content. The validator fails on any
residual `{` or `}` in the rendered notes.

## Authoring rules (enforced fail-closed)

- Start from `.github/RELEASE_NOTES_TEMPLATE.md` and keep the exact `### `
  emoji headings, their canonical order, and the `---` separators between
  sections. Omit sections that have no content — do not leave empty headers.
- Copy the emoji headings verbatim from the template; never retype them. The
  🏗️ (Architecture / Refactor) and ⚙️ (CI / Engineering) headings end with an
  invisible U+FE0F variation selector that editors and copy-paste can strip.
- Prose must be ASCII everywhere except the emoji headings themselves.
- `### 🧪 Test Summary` and `### 🔍 Verification` are mandatory in every
  release; the Test Summary body needs at least one fenced code block.
- The final line is the full-changelog compare link with the repository slug
  written out literally (`https://github.com/LeXwDeX/OpenCode-GraphAgent/compare/{previous_tag}...{current_tag}`).
  A repository rename fails validation on purpose — update the series file.

The grammar is implemented in `packages/opencode/script/release-notes.ts`
(rule errors are prefixed `[release-notes]`).
