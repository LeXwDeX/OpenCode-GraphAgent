export const hookCommand = (program: string) => {
  const quote = (value: string) =>
    process.platform === "win32" ? '"' + value.replaceAll('"', '\\"') + '"' : "'" + value.replaceAll("'", "'\\''") + "'"
  return `${quote(process.execPath)} -e ${quote(program.replaceAll("\n", " "))}`
}

// A strict Claude-style consumer: wrong casing/Read path silently produces no context.
export const claudeHookCommand = hookCommand(`
  const input = JSON.parse(await Bun.stdin.text());
  if (["Bash", "Read", "Write", "Edit", "Grep", "Glob"].includes(input.tool_name)
      && (input.tool_name !== "Read" || input.tool_input.file_path)) {
    console.log(JSON.stringify({hookSpecificOutput: {
      hookEventName: input.hook_event_name,
      additionalContext: "CLAUDE_CONTEXT:" + JSON.stringify(input)
    }}));
  }
`)

export const nativeHookCommand = hookCommand(`
  const input = JSON.parse(await Bun.stdin.text());
  console.log(JSON.stringify({hookSpecificOutput: {
    hookEventName: input.hook_event_name,
    additionalContext: "NATIVE_CONTEXT:" + JSON.stringify(input)
  }}));
`)
