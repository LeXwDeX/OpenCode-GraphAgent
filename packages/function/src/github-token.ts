import type { createAppAuth } from "@octokit/auth-app"

export function repositoryToken(auth: ReturnType<typeof createAppAuth>, installationId: number, repo: string) {
  return auth({ type: "installation", installationId, repositoryNames: [repo] })
}
