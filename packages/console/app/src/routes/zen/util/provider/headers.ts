// Forward only protocol negotiation. Authentication belongs to the selected provider.
export function providerRequestHeaders(incoming: Headers) {
  const headers = new Headers()
  for (const name of ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta"]) {
    const value = incoming.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}
