# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically when run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull requests are delivery artifacts, not incoming requests. `/triage` does not include them in its queue.

GitHub shares one number space across issues and PRs. Resolve an ambiguous `#42` with `gh pr view 42`, then fall back to `gh issue view 42`.

## Skill operations

- When a skill says **publish to the issue tracker**, create a GitHub issue.
- When a skill says **fetch the relevant ticket**, run `gh issue view <number> --comments`.
- Use GitHub's native blocking relationships when available. If unavailable, put `Blocked by: #<n>` at the top of the issue body.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding Notes, Decisions-so-far, and Fog.
- **Child ticket**: a GitHub sub-issue labelled `wayfinder:<type>` where type is `research`, `prototype`, `grilling`, or `task`. If sub-issues are unavailable, link it from a task list in the map and put `Part of #<map>` at the top of the child body.
- **Blocking**: prefer GitHub native issue dependencies. Use the blocker's numeric database ID with the dependencies API, not its issue number or node ID. Fall back to a `Blocked by:` line only when native dependencies are unavailable.
- **Frontier query**: select the first open, unassigned child in map order whose blockers are all closed.
- **Claim**: `gh issue edit <n> --add-assignee @me` is the working session's first write.
- **Resolve**: comment with the decision, close the child, and add its context pointer to the map's Decisions-so-far.
