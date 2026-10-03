import { validatePayloadAsync, registerCaptureSlot, clearCaptureSlot } from "../../../src/dag/runtime/capture"

const session = "budget-subprocess"
registerCaptureSlot(session, { type: "string", pattern: "^(a+)\\1$" })
const normal = await validatePayloadAsync(session, "aaaa", new AbortController().signal)
if (!normal.ok || normal.payload !== "aaaa") throw new Error(`worker compatibility failed: ${JSON.stringify(normal)}`)
registerCaptureSlot(session, { type: "null" })
const nullable = await validatePayloadAsync(session, null, new AbortController().signal)
if (!nullable.ok || nullable.payload !== null) throw new Error(`worker null failed: ${JSON.stringify(nullable)}`)
registerCaptureSlot(session, { type: "string", pattern: "^(a|a?)+$" })
let beats = 0
const timer = setInterval(() => beats++, 10)
const start = performance.now()
const result = await validatePayloadAsync(session, "a".repeat(99_999) + "!", new AbortController().signal)
clearInterval(timer)
clearCaptureSlot(session)
const elapsed = performance.now() - start
console.log(JSON.stringify({ result, beats, elapsed }))
if (result.ok || !result.error.includes("host resource budget") || beats < 5 || elapsed > 1_000) process.exit(1)
