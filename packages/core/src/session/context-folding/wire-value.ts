import { ContextFoldingPolicy } from "./policy"
import {
  consumeContainerEntries,
  consumeNode,
  consumeOutputCharacters,
  consumeString,
  createWorkBudget,
  type WorkBudget,
} from "./work-budget"

export type WireValueFailure = "unknown-content" | "work-limit"

export type WireValueResult<T> =
  | Readonly<{ ok: true; value: T; inputBytes: number }>
  | Readonly<{ ok: false; reason: WireValueFailure }>

const failure = (budget: WorkBudget): WireValueResult<never> => ({
  ok: false,
  reason: budget.exceeded ? "work-limit" : "unknown-content",
})

const escapedStringLength = (value: string) => {
  let length = 2
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      length += 2
    } else if (
      code <= 0x1f ||
      (code >= 0xd800 &&
        code <= 0xdfff &&
        !(
          code <= 0xdbff &&
          index + 1 < value.length &&
          value.charCodeAt(index + 1) >= 0xdc00 &&
          value.charCodeAt(index + 1) <= 0xdfff
        ))
    ) {
      length += 6
    } else {
      if (code >= 0xd800 && code <= 0xdbff) {
        length += 2
        index++
      } else length += 1
    }
  }
  return length
}

const encodeString = (value: string, budget: WorkBudget) => {
  if (!consumeString(budget, value)) return undefined
  const length = escapedStringLength(value)
  if (!consumeOutputCharacters(budget, length)) return undefined
  return JSON.stringify(value)
}

const serialize = (value: unknown, ancestors: Set<object>, budget: WorkBudget, depth: number): string | undefined => {
  if (!consumeNode(budget, depth)) return undefined

  if (value === null) {
    if (!consumeString(budget, "null") || !consumeOutputCharacters(budget, 4)) return undefined
    return "null"
  }

  switch (typeof value) {
    case "boolean": {
      const result = value ? "true" : "false"
      if (!consumeString(budget, result) || !consumeOutputCharacters(budget, result.length)) return undefined
      return result
    }
    case "number": {
      if (!Number.isFinite(value)) return undefined
      const result = Object.is(value, -0) ? "0" : String(value)
      if (!consumeString(budget, result) || !consumeOutputCharacters(budget, result.length)) return undefined
      return result
    }
    case "string":
      return encodeString(value, budget)
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
      if (prototype !== Array.prototype || !consumeContainerEntries(budget, value.length)) return undefined
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key === "symbol")) return undefined

      const items: string[] = []
      let length = 2
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !("value" in descriptor)) return undefined
        const item = serialize(descriptor.value, ancestors, budget, depth + 1)
        if (item === undefined) return undefined
        items.push(item)
        length += item.length + (index === 0 ? 0 : 1)
      }
      if (!consumeOutputCharacters(budget, length)) return undefined
      return `[${items.join(",")}]`
    }

    if (prototype !== Object.prototype && prototype !== null) return undefined
    const ownKeys = Reflect.ownKeys(value)
    if (!consumeContainerEntries(budget, ownKeys.length)) return undefined
    const keys: string[] = []
    for (const key of ownKeys) {
      if (typeof key !== "string") return undefined
      keys.push(key)
    }
    keys.sort()

    const entries: string[] = []
    let length = 2
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return undefined
      const encodedKey = encodeString(key, budget)
      const encodedValue = serialize(descriptor.value, ancestors, budget, depth + 1)
      if (encodedKey === undefined || encodedValue === undefined) return undefined
      const entryLength = encodedKey.length + 1 + encodedValue.length
      if (!consumeOutputCharacters(budget, entryLength)) return undefined
      entries.push(`${encodedKey}:${encodedValue}`)
      length += entryLength + (entries.length === 1 ? 0 : 1)
    }
    if (!consumeOutputCharacters(budget, length)) return undefined
    return `{${entries.join(",")}}`
  } catch {
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

export const serializeWireValue = (value: unknown): WireValueResult<string> => {
  const budget = createWorkBudget(ContextFoldingPolicy.workLimits)
  try {
    const serialized = serialize(value, new Set(), budget, 0)
    if (serialized === undefined) return failure(budget)
    return { ok: true, value: serialized, inputBytes: budget.inputBytes }
  } catch {
    return failure(budget)
  }
}

const CLONE_FAILED = Symbol("context-folding-clone-failed")
type CloneValue = null | boolean | number | string | object | typeof CLONE_FAILED

const clone = (
  value: unknown,
  ancestors: Set<object>,
  copies: WeakMap<object, CloneValue>,
  budget: WorkBudget,
  depth: number,
): CloneValue => {
  if (!consumeNode(budget, depth)) return CLONE_FAILED
  if (value === null) return null

  switch (typeof value) {
    case "boolean":
      return value
    case "number":
      return Number.isFinite(value) ? value : CLONE_FAILED
    case "string":
      return consumeString(budget, value) ? value : CLONE_FAILED
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return CLONE_FAILED
    case "object":
      break
  }

  if (ancestors.has(value)) return CLONE_FAILED
  const existing = copies.get(value)
  if (existing !== undefined) return existing
  ancestors.add(value)

  try {
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || !consumeContainerEntries(budget, value.length)) return CLONE_FAILED
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key === "symbol")) return CLONE_FAILED
      const result: unknown[] = []
      result.length = value.length
      copies.set(value, result)
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !("value" in descriptor)) return CLONE_FAILED
        const item = clone(descriptor.value, ancestors, copies, budget, depth + 1)
        if (item === CLONE_FAILED) return CLONE_FAILED
        result[index] = item
      }
      return result
    }

    if (prototype !== Object.prototype && prototype !== null) return CLONE_FAILED
    const ownKeys = Reflect.ownKeys(value)
    if (!consumeContainerEntries(budget, ownKeys.length)) return CLONE_FAILED
    const result: Record<string, unknown> = prototype === null ? Object.create(null) : {}
    copies.set(value, result)
    for (const key of ownKeys) {
      if (typeof key !== "string" || !consumeString(budget, key)) return CLONE_FAILED
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return CLONE_FAILED
      const item = clone(descriptor.value, ancestors, copies, budget, depth + 1)
      if (item === CLONE_FAILED) return CLONE_FAILED
      result[key] = item
    }
    return result
  } catch {
    return CLONE_FAILED
  } finally {
    ancestors.delete(value)
  }
}

export function cloneWireValue<Value>(value: Value): WireValueResult<Value>
export function cloneWireValue(value: unknown): WireValueResult<unknown> {
  const budget = createWorkBudget(ContextFoldingPolicy.workLimits)
  try {
    const copy = clone(value, new Set(), new WeakMap(), budget, 0)
    if (copy === CLONE_FAILED) return failure(budget)
    return { ok: true, value: copy, inputBytes: budget.inputBytes }
  } catch {
    return failure(budget)
  }
}

export type WirePathSegment = string | number

export const readWirePath = (root: unknown, path: readonly WirePathSegment[]): WireValueResult<unknown> => {
  let value = root
  try {
    for (const segment of path) {
      if (!value || typeof value !== "object") return { ok: false, reason: "unknown-content" }
      if (Array.isArray(value)) {
        if (!Number.isSafeInteger(segment) || typeof segment !== "number" || segment < 0 || segment >= value.length) {
          return { ok: false, reason: "unknown-content" }
        }
      } else if (typeof segment !== "string") return { ok: false, reason: "unknown-content" }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(segment))
      if (!descriptor || !("value" in descriptor)) return { ok: false, reason: "unknown-content" }
      value = descriptor.value
    }
    return { ok: true, value, inputBytes: 0 }
  } catch {
    return { ok: false, reason: "unknown-content" }
  }
}

export const writeWirePath = (root: unknown, path: readonly WirePathSegment[], replacement: string) => {
  if (path.length === 0) return false
  let value = root
  try {
    for (let index = 0; index < path.length - 1; index++) {
      const segment = path[index]
      if (!value || typeof value !== "object") return false
      const descriptor = Object.getOwnPropertyDescriptor(value, String(segment))
      if (!descriptor || !("value" in descriptor)) return false
      value = descriptor.value
    }
    if (!value || typeof value !== "object") return false
    const key = path.at(-1)!
    const descriptor = Object.getOwnPropertyDescriptor(value, String(key))
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return false
    return Reflect.set(value, key, replacement)
  } catch {
    return false
  }
}
