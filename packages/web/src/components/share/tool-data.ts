export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

export function diagnosticsForFile(value: unknown, file: unknown) {
  if (!isRecord(value) || typeof file !== "string") return []
  const diagnostics = value[file]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics.flatMap((diagnostic: unknown) => {
    if (!isRecord(diagnostic) || diagnostic.severity !== 1 || typeof diagnostic.message !== "string") return []
    const range = diagnostic.range
    if (!isRecord(range) || !isRecord(range.start)) return []
    const { line, character } = range.start
    if (
      typeof line !== "number" ||
      !Number.isSafeInteger(line) ||
      line < 0 ||
      typeof character !== "number" ||
      !Number.isSafeInteger(character) ||
      character < 0
    )
      return []
    return [{ line: line + 1, column: character + 1, message: diagnostic.message }]
  })
}

interface SharedTodo {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed"
}

export function todos(value: unknown): SharedTodo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((todo: unknown) => {
    if (!isRecord(todo) || typeof todo.id !== "string" || typeof todo.content !== "string") return []
    const status = todo.status
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return []
    return [{ id: todo.id, content: todo.content, status }]
  })
}
