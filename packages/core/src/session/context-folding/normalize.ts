export type NormalizedParameters =
  | Readonly<{
      ok: true
      value: string
    }>
  | Readonly<{
      ok: false
    }>

const encodeString = (value: string) => `${value.length}:${value}`

const encode = (value: unknown, ancestors: Set<object>): string | undefined => {
  if (value === null) return "null;"

  switch (typeof value) {
    case "boolean":
      return value ? "bool:1;" : "bool:0;"
    case "number":
      if (!Number.isFinite(value)) return undefined
      return `number:${Object.is(value, -0) ? "-0" : String(value)};`
    case "string":
      return `string:${encodeString(value)};`
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return undefined
    case "object":
      break
  }

  if (ancestors.has(value)) return undefined
  ancestors.add(value)

  try {
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return undefined

      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.some((key) => typeof key === "symbol")) return undefined

      const expectedKeys = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))])
      if (ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) return undefined

      const items: string[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !("value" in descriptor)) return undefined
        const item = encode(descriptor.value, ancestors)
        if (item === undefined) return undefined
        items.push(item)
      }
      return `array:${value.length}:[${items.join("")}]`
    }

    if (prototype !== Object.prototype && prototype !== null) return undefined

    const ownKeys = Reflect.ownKeys(value)
    const keys: string[] = []
    for (const key of ownKeys) {
      if (typeof key !== "string") return undefined
      keys.push(key)
    }
    keys.sort()
    const entries: string[] = []

    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return undefined
      const item = encode(descriptor.value, ancestors)
      if (item === undefined) return undefined
      entries.push(`key:${encodeString(key)};${item}`)
    }

    return `object:${keys.length}:{${entries.join("")}}`
  } catch {
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Produces a deterministic, lossless representation of JSON-like tool parameters.
 * Unsupported values, accessors, sparse arrays, cycles, exotic prototypes, and throwing proxies fail closed.
 */
export const normalizeParameters = (value: unknown): NormalizedParameters => {
  try {
    const normalized = encode(value, new Set())
    if (normalized === undefined) return { ok: false }
    return { ok: true, value: normalized }
  } catch {
    return { ok: false }
  }
}
