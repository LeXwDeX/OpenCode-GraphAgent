const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
// Latch over the raw millisecond value, shared by both directions. The prefix
// is the full 48-bit timestamp with no shift so it only wraps after 2^48 ms
// (~8925 years); without the latch, same-millisecond bursts would collide and
// clock regression would emit out-of-order ids. Historical ids (pre
// 2026-08-14) encoded (ts mod 2^36) << 12 and sort above new ids, so
// lexicographic id comparison across that boundary is invalid by design —
// ordering must always come from time.created.
let lastValue = 0n

export function ascending() {
  return create(false)
}

export function descending() {
  return create(true)
}

export function create(descending: boolean, timestamp = Date.now()) {
  const current = BigInt(timestamp)
  const value = current > lastValue ? current : lastValue + 1n
  lastValue = value
  const out = descending ? ~value : value
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((out >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12))
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}
