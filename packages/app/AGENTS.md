## Priorities

- Prioritise, in this order: stability, simplicity, performance.
- Before changing session or timeline code, record a production benchmark baseline and compare it after the change.

## Debugging

- Preserve the user's running app and server processes. Start separate task-owned processes for validation. Stop only the test processes you started, and clean them up when done.

## Local Dev

- `bun dev web` from the repository root starts the backend and opens its web interface. Use the app dev server below to verify local UI/CSS changes.
- For local UI changes, run the backend and app dev servers separately.
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- App (from `packages/app`): `bun dev -- --port 4444`
- Open `http://localhost:4444` to verify UI changes. A fresh browser profile defaults to `http://localhost:4096`; a saved default server takes precedence. Confirm the selected server before testing. Override the dev default with `VITE_OPENCODE_SERVER_HOST` / `VITE_OPENCODE_SERVER_PORT` when using another backend port.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
