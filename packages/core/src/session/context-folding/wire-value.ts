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

const clone = (value: unknown, seen: WeakSet<object>, budget: WorkBudget, depth: number): CloneValue => {
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

  // Final provider requests must be trees. Reject cycles and shared aliases so a selected write can never mutate an
  // unselected path in the private copy.
  if (seen.has(value)) return CLONE_FAILED
  seen.add(value)

  try {
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || !consumeContainerEntries(budget, value.length)) return CLONE_FAILED
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key === "symbol")) return CLONE_FAILED
      const result: unknown[] = []
      result.length = value.length
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !("value" in descriptor)) return CLONE_FAILED
        const item = clone(descriptor.value, seen, budget, depth + 1)
        if (item === CLONE_FAILED) return CLONE_FAILED
        result[index] = item
      }
      return result
    }

    if (prototype !== Object.prototype && prototype !== null) return CLONE_FAILED
    const ownKeys = Reflect.ownKeys(value)
    if (!consumeContainerEntries(budget, ownKeys.length)) return CLONE_FAILED
    const result: Record<string, unknown> = prototype === null ? Object.create(null) : {}
    for (const key of ownKeys) {
      if (typeof key !== "string" || !consumeString(budget, key)) return CLONE_FAILED
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return CLONE_FAILED
      const item = clone(descriptor.value, seen, budget, depth + 1)
      if (item === CLONE_FAILED) return CLONE_FAILED
      Object.defineProperty(result, key, {
        value: item,
        enumerable: descriptor.enumerable,
        writable: true,
        configurable: true,
      })
    }
    return result
  } catch {
    return CLONE_FAILED
  }
}

export function cloneWireValue<Value>(value: Value): WireValueResult<Value>
export function cloneWireValue(value: unknown): WireValueResult<unknown> {
  const budget = createWorkBudget(ContextFoldingPolicy.workLimits)
  try {
    const copy = clone(value, new WeakSet(), budget, 0)
    if (copy === CLONE_FAILED) return failure(budget)
    return { ok: true, value: copy, inputBytes: budget.inputBytes }
  } catch {
    return failure(budget)
  }
}

export type WirePathSegment = string | number

export type WireValueChange = Readonly<{
  path: readonly WirePathSegment[]
  before: string
  after: string
}>

type ChangeTrie = {
  readonly children: Map<string, Readonly<{ segment: WirePathSegment; node: ChangeTrie }>>
  change?: WireValueChange
}

const emptyChangeTrie = (): ChangeTrie => ({ children: new Map() })
const EMPTY_CHANGE_TRIE = emptyChangeTrie()
const segmentKey = (segment: WirePathSegment) =>
  typeof segment === "number" ? `n:${segment}` : `s:${segment.length}:${segment}`

const buildChangeTrie = (changes: readonly WireValueChange[], budget: WorkBudget): ChangeTrie | undefined => {
  if (!consumeContainerEntries(budget, changes.length)) return undefined
  const root = emptyChangeTrie()

  for (const change of changes) {
    if (
      !Array.isArray(change.path) ||
      change.path.length === 0 ||
      change.path.length > budget.limits.maxDepth ||
      !consumeContainerEntries(budget, change.path.length) ||
      !consumeString(budget, change.before) ||
      !consumeString(budget, change.after)
    ) {
      return undefined
    }

    let node = root
    for (const segment of change.path) {
      if (
        (typeof segment !== "string" && typeof segment !== "number") ||
        (typeof segment === "number" && (!Number.isSafeInteger(segment) || segment < 0)) ||
        (typeof segment === "string" && !consumeString(budget, segment)) ||
        node.change
      ) {
        return undefined
      }
      const key = segmentKey(segment)
      let child = node.children.get(key)
      if (!child) {
        child = { segment, node: emptyChangeTrie() }
        node.children.set(key, child)
      }
      node = child.node
    }
    if (node.change || node.children.size > 0) return undefined
    node.change = change
  }

  return root
}

const sameWireValue = (
  original: unknown,
  projected: unknown,
  trie: ChangeTrie,
  originalSeen: WeakSet<object>,
  projectedSeen: WeakSet<object>,
  originalBudget: WorkBudget,
  projectedBudget: WorkBudget,
  depth: number,
  matched: { count: number },
): boolean => {
  if (!consumeNode(originalBudget, depth) || !consumeNode(projectedBudget, depth)) return false

  if (trie.change) {
    if (trie.children.size > 0 || original !== trie.change.before || projected !== trie.change.after) return false
    if (
      typeof original !== "string" ||
      typeof projected !== "string" ||
      !consumeString(originalBudget, original) ||
      !consumeString(projectedBudget, projected)
    ) {
      return false
    }
    matched.count++
    return true
  }

  if (original === null || projected === null) return original === projected && trie.children.size === 0
  if (typeof original !== typeof projected) return false

  switch (typeof original) {
    case "boolean":
      return original === projected && trie.children.size === 0
    case "number":
      return Object.is(original, projected) && Number.isFinite(original) && trie.children.size === 0
    case "string":
      return (
        original === projected &&
        trie.children.size === 0 &&
        consumeString(originalBudget, original) &&
        consumeString(projectedBudget, projected)
      )
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return false
    case "object":
      break
  }

  if (!projected || typeof projected !== "object" || originalSeen.has(original) || projectedSeen.has(projected)) {
    return false
  }
  originalSeen.add(original)
  projectedSeen.add(projected)

  try {
    const originalPrototype = Object.getPrototypeOf(original)
    const projectedPrototype = Object.getPrototypeOf(projected)
    if (originalPrototype !== projectedPrototype) return false

    if (Array.isArray(original)) {
      if (
        !Array.isArray(projected) ||
        originalPrototype !== Array.prototype ||
        original.length !== projected.length ||
        !consumeContainerEntries(originalBudget, original.length) ||
        !consumeContainerEntries(projectedBudget, projected.length)
      ) {
        return false
      }
      const originalKeys = Reflect.ownKeys(original)
      const projectedKeys = Reflect.ownKeys(projected)
      if (originalKeys.length !== original.length + 1 || projectedKeys.length !== projected.length + 1) return false

      let visitedChildren = 0
      for (let index = 0; index < original.length; index++) {
        const originalDescriptor = Object.getOwnPropertyDescriptor(original, String(index))
        const projectedDescriptor = Object.getOwnPropertyDescriptor(projected, String(index))
        if (
          !originalDescriptor ||
          !("value" in originalDescriptor) ||
          !projectedDescriptor ||
          !("value" in projectedDescriptor) ||
          originalDescriptor.enumerable !== projectedDescriptor.enumerable
        ) {
          return false
        }
        const child = trie.children.get(segmentKey(index))
        if (child) visitedChildren++
        if (
          !sameWireValue(
            originalDescriptor.value,
            projectedDescriptor.value,
            child?.node ?? EMPTY_CHANGE_TRIE,
            originalSeen,
            projectedSeen,
            originalBudget,
            projectedBudget,
            depth + 1,
            matched,
          )
        ) {
          return false
        }
      }
      return visitedChildren === trie.children.size
    }

    if (Array.isArray(projected) || (originalPrototype !== Object.prototype && originalPrototype !== null)) return false
    const originalKeys = Reflect.ownKeys(original)
    const projectedKeys = Reflect.ownKeys(projected)
    if (
      originalKeys.length !== projectedKeys.length ||
      !consumeContainerEntries(originalBudget, originalKeys.length) ||
      !consumeContainerEntries(projectedBudget, projectedKeys.length)
    ) {
      return false
    }

    let visitedChildren = 0
    for (let index = 0; index < originalKeys.length; index++) {
      const key = originalKeys[index]
      const projectedKey = projectedKeys[index]
      if (
        typeof key !== "string" ||
        projectedKey !== key ||
        !consumeString(originalBudget, key) ||
        !consumeString(projectedBudget, key)
      ) {
        return false
      }
      const originalDescriptor = Object.getOwnPropertyDescriptor(original, key)
      const projectedDescriptor = Object.getOwnPropertyDescriptor(projected, key)
      if (
        !originalDescriptor ||
        !("value" in originalDescriptor) ||
        !projectedDescriptor ||
        !("value" in projectedDescriptor) ||
        originalDescriptor.enumerable !== projectedDescriptor.enumerable
      ) {
        return false
      }
      const child = trie.children.get(segmentKey(key))
      if (child) visitedChildren++
      if (
        !sameWireValue(
          originalDescriptor.value,
          projectedDescriptor.value,
          child?.node ?? EMPTY_CHANGE_TRIE,
          originalSeen,
          projectedSeen,
          originalBudget,
          projectedBudget,
          depth + 1,
          matched,
        )
      ) {
        return false
      }
    }
    return visitedChildren === trie.children.size
  } catch {
    return false
  }
}

/** Verifies every non-selected field and prototype while allowing only the declared string replacements. */
export const verifyWireValueChanges = (
  original: unknown,
  projected: unknown,
  changes: readonly WireValueChange[],
): WireValueResult<boolean> => {
  const pathBudget = createWorkBudget(ContextFoldingPolicy.workLimits)
  const originalBudget = createWorkBudget(ContextFoldingPolicy.workLimits)
  const projectedBudget = createWorkBudget(ContextFoldingPolicy.workLimits)

  try {
    const trie = buildChangeTrie(changes, pathBudget)
    if (!trie) return failure(pathBudget)
    const matched = { count: 0 }
    const same = sameWireValue(
      original,
      projected,
      trie,
      new WeakSet(),
      new WeakSet(),
      originalBudget,
      projectedBudget,
      0,
      matched,
    )
    if (originalBudget.exceeded) return failure(originalBudget)
    if (projectedBudget.exceeded) return failure(projectedBudget)
    return {
      ok: true,
      value: same && matched.count === changes.length,
      inputBytes: originalBudget.inputBytes + projectedBudget.inputBytes,
    }
  } catch {
    if (pathBudget.exceeded) return failure(pathBudget)
    if (originalBudget.exceeded) return failure(originalBudget)
    if (projectedBudget.exceeded) return failure(projectedBudget)
    return { ok: false, reason: "unknown-content" }
  }
}

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
