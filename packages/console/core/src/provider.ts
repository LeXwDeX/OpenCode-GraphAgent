import { z } from "zod"
import { fn } from "./util/fn"
import { Actor } from "./actor"
import { and, Database, eq, isNull } from "./drizzle"
import { Identifier } from "./identifier"
import { ProviderTable } from "./schema/provider.sql"

export namespace Provider {
  export const list = fn(z.void(), () =>
    Database.use((tx) =>
      tx
        .select({
          id: ProviderTable.id,
          provider: ProviderTable.provider,
          credentials: ProviderTable.credentials,
        })
        .from(ProviderTable)
        .where(and(eq(ProviderTable.workspaceID, Actor.workspace()), isNull(ProviderTable.timeDeleted))),
    ).then((providers) =>
      providers.map(({ credentials, ...provider }) => ({
        ...provider,
        credentialsDisplay:
          credentials.length > 24 ? `${credentials.slice(0, 4)}...${credentials.slice(-4)}` : "********",
      })),
    ),
  )

  export const create = fn(
    z.object({
      provider: z.string().min(1).max(64),
      credentials: z.string(),
    }),
    async ({ provider, credentials }) => {
      Actor.assertAdmin()
      return Database.use((tx) =>
        tx
          .insert(ProviderTable)
          .values({
            id: Identifier.create("provider"),
            workspaceID: Actor.workspace(),
            provider,
            credentials,
          })
          .onDuplicateKeyUpdate({
            set: {
              credentials,
              timeDeleted: null,
            },
          }),
      )
    },
  )

  export const remove = fn(
    z.object({
      provider: z.string(),
    }),
    async ({ provider }) => {
      Actor.assertAdmin()
      return Database.use((tx) =>
        tx
          .delete(ProviderTable)
          .where(and(eq(ProviderTable.provider, provider), eq(ProviderTable.workspaceID, Actor.workspace()))),
      )
    },
  )
}
