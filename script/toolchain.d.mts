export interface ToolchainVersions {
  bun: string
  node: string
  go: string
  turbo: string
  rust: string
}
export function readToolchain(directory?: string): ToolchainVersions
export function resolveDependencyVersion(name: string, spec: string | undefined, directory?: string): string
export function assertRuntimeVersions(
  expected: ToolchainVersions | Partial<ToolchainVersions>,
  actual: Partial<Record<keyof ToolchainVersions, string | undefined>>,
): void
export function checkToolchain(options?: {
  go?: boolean
  rust?: boolean
  bunOnly?: boolean
}): Partial<ToolchainVersions>
