import { Hono } from "hono"
import { DurableObject } from "cloudflare:workers"
import { jwtVerify, createRemoteJWKSet } from "jose"
import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import { Resource } from "sst"
import { assertShareOwner, clearShare, createShare, ShareAlreadyExistsError } from "./share-storage"
import { repositoryToken } from "./github-token"
import { feishuResponse } from "./feishu"

type Env = {
  SYNC_SERVER: DurableObjectNamespace<SyncServer>
  Bucket: R2Bucket
  WEB_DOMAIN: string
}

export class SyncServer extends DurableObject<Env> {
  #pending: Promise<unknown> = Promise.resolve()

  // Durable Object storage gates do not cover R2 awaits. Keep every mutation,
  // including its authorization, in one object-local FIFO operation.
  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation)
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
  async fetch() {
    console.log("SyncServer subscribe")

    const webSocketPair = new WebSocketPair()
    const [client, server] = Object.values(webSocketPair)

    this.ctx.acceptWebSocket(server)

    const data = await this.ctx.storage.list()
    Array.from(data.entries())
      .filter(([key, _]) => key.startsWith("session/"))
      .map(([key, content]) => server.send(JSON.stringify({ key, content })))

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    ws.close(code, "Durable Object is closing WebSocket")
  }

  async publish(sessionID: string, secret: string, key: string, content: any) {
    return this.#mutate(async () => {
      await assertShareOwner(this.ctx.storage, sessionID, secret)
      if (
        typeof key !== "string" ||
        (key !== `session/info/${sessionID}` &&
          !key.startsWith(`session/message/${sessionID}/`) &&
          !key.startsWith(`session/part/${sessionID}/`))
      )
        return false

      // store message
      await this.env.Bucket.put(`share/${key}.json`, JSON.stringify(content), {
        httpMetadata: {
          contentType: "application/json",
        },
      })
      await this.ctx.storage.put(key, content)
      const clients = this.ctx.getWebSockets()
      console.log("SyncServer publish", key, "to", clients.length, "subscribers")
      for (const client of clients) {
        client.send(JSON.stringify({ key, content }))
      }
      return true
    })
  }

  public async share(sessionID: string) {
    return this.#mutate(() => {
      if (typeof sessionID !== "string" || !sessionID) throw new Error("Invalid session ID")
      return createShare(this.ctx.storage, sessionID)
    })
  }

  public async getData(): Promise<string> {
    const data = await this.ctx.storage.list()
    return JSON.stringify(
      Array.from(data.entries())
        .filter(([key, _]) => key.startsWith("session/"))
        .map(([key, content]) => ({ key, content })),
    )
  }

  async #clear(sessionID: string | undefined) {
    if (sessionID) await clearShare(this.env.Bucket, sessionID)
    await this.ctx.storage.deleteAll()
  }

  async clear(sessionID: string, secret: string) {
    return this.#mutate(async () => {
      await assertShareOwner(this.ctx.storage, sessionID, secret)
      await this.#clear(sessionID)
    })
  }

  async clearAdmin(adminSecret: string) {
    return this.#mutate(async () => {
      if (typeof adminSecret !== "string" || !adminSecret || adminSecret !== Resource.ADMIN_SECRET.value)
        throw new Error("Invalid admin secret")
      await this.#clear(await this.ctx.storage.get<string>("sessionID"))
    })
  }

  static shortName(id: string) {
    return id.substring(id.length - 8)
  }
}

export default new Hono<{ Bindings: Env }>()
  .get("/", (c) => c.text("Hello, world!"))
  .post("/share_create", async (c) => {
    const body = await c.req.json<{ sessionID: string }>()
    const sessionID = body.sessionID
    if (typeof sessionID !== "string" || !sessionID) return c.json({ error: "Session ID is required" }, 400)
    const short = SyncServer.shortName(sessionID)
    const id = c.env.SYNC_SERVER.idFromName(short)
    const stub = c.env.SYNC_SERVER.get(id)
    const secret = await stub.share(sessionID).catch((error) => {
      if (error instanceof ShareAlreadyExistsError || error.message === "Share already exists") return undefined
      throw error
    })
    if (!secret) return c.json({ error: "Share already exists" }, 409)
    return c.json({
      secret,
      url: `https://${c.env.WEB_DOMAIN}/s/${short}`,
    })
  })
  .post("/share_delete", async (c) => {
    const body = await c.req.json<{ sessionID: string; secret: string }>()
    const sessionID = body.sessionID
    const secret = body.secret
    const id = c.env.SYNC_SERVER.idFromName(SyncServer.shortName(sessionID))
    const stub = c.env.SYNC_SERVER.get(id)
    await stub.clear(sessionID, secret)
    return c.json({})
  })
  .post("/share_delete_admin", async (c) => {
    const body = await c.req.json<{ sessionShortName: string; adminSecret: string }>()
    const sessionShortName = body.sessionShortName
    const adminSecret = body.adminSecret
    if (adminSecret !== Resource.ADMIN_SECRET.value) throw new Error("Invalid admin secret")
    const id = c.env.SYNC_SERVER.idFromName(sessionShortName)
    const stub = c.env.SYNC_SERVER.get(id)
    await stub.clearAdmin(adminSecret)
    return c.json({})
  })
  .post("/share_sync", async (c) => {
    const body = await c.req.json<{
      sessionID: string
      secret: string
      key: string
      content: any
    }>()
    const name = SyncServer.shortName(body.sessionID)
    const id = c.env.SYNC_SERVER.idFromName(name)
    const stub = c.env.SYNC_SERVER.get(id)
    const published = await stub.publish(body.sessionID, body.secret, body.key, body.content)
    if (!published) return c.json({ error: "Invalid key" }, 400)
    return c.json({})
  })
  .get("/share_poll", async (c) => {
    const upgradeHeader = c.req.header("Upgrade")
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return c.text("Error: Upgrade header is required", { status: 426 })
    }
    const id = c.req.query("id")
    console.log("share_poll", id)
    if (!id) return c.text("Error: Share ID is required", { status: 400 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(id))
    return stub.fetch(c.req.raw)
  })
  .get("/share_data", async (c) => {
    const id = c.req.query("id")
    console.log("share_data", id)
    if (!id) return c.text("Error: Share ID is required", { status: 400 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(id))
    const data: unknown = JSON.parse(await stub.getData())
    if (!Array.isArray(data)) return c.json({ error: "Invalid share data" }, 500)

    let info: unknown
    const messages: Record<string, any> = {}
    data.forEach((d) => {
      const content = d.content
      if (typeof content !== "object" || content === null || Array.isArray(content)) return
      const [root, type] = d.key.split("/")
      if (root !== "session") return
      if (type === "info") {
        info = content
        return
      }
      if (type === "message") {
        if (!("id" in content) || typeof content.id !== "string") return
        messages[content.id] = {
          parts: [],
          ...content,
        }
      }
      if (type === "part") {
        if (!("messageID" in content) || typeof content.messageID !== "string") return
        const message = messages[content.messageID]
        if (message && Array.isArray(message.parts)) message.parts.push(content)
      }
    })

    return c.json({ info, messages })
  })
  .post("/feishu", async (c) => {
    let verificationToken: string | undefined
    try {
      verificationToken = Resource.FEISHU_VERIFICATION_TOKEN.value
    } catch {
      // Missing linked configuration must reject events instead of allowing an unauthenticated relay.
    }
    return feishuResponse(await c.req.json().catch(() => undefined), verificationToken, async (message) => {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${Resource.DISCORD_SUPPORT_CHANNEL_ID.value}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bot ${Resource.DISCORD_SUPPORT_BOT_TOKEN.value}`,
          },
          body: JSON.stringify({ content: message }),
        },
      )
      return response.ok
    })
  })
  /**
   * Used by the GitHub action to get GitHub installation access token given the OIDC token
   */
  .post("/exchange_github_app_token", async (c) => {
    const EXPECTED_AUDIENCE = "opencode-github-action"
    const GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
    const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`

    // get Authorization header
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "")
    if (!token) return c.json({ error: "Authorization header is required" }, { status: 401 })

    // verify token
    const JWKS = createRemoteJWKSet(new URL(JWKS_URL))
    let owner: string
    let repo: string
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: GITHUB_ISSUER,
        audience: EXPECTED_AUDIENCE,
      })
      const match = /^repo:([^:/]+)\/([^:/]+):/.exec(payload.sub ?? "")
      if (!match) throw new Error("Invalid repository subject")
      owner = match[1]
      repo = match[2]
    } catch (err) {
      console.error("Token verification failed:", err)
      return c.json({ error: "Invalid or expired token" }, { status: 403 })
    }

    // Create app JWT token
    const auth = createAppAuth({
      appId: Resource.GITHUB_APP_ID.value,
      privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
    })
    const appAuth = await auth({ type: "app" })

    // Lookup installation
    const octokit = new Octokit({ auth: appAuth.token })
    const { data: installation } = await octokit.apps.getRepoInstallation({
      owner,
      repo,
    })

    // Get installation token
    const installationAuth = await repositoryToken(auth, installation.id, repo)

    return c.json({ token: installationAuth.token })
  })
  /**
   * Used by the GitHub action to get GitHub installation access token given user PAT token (used when testing `opencode github run` locally)
   */
  .post("/exchange_github_app_token_with_pat", async (c) => {
    const body = await c.req.json<{ owner: string; repo: string }>()
    const owner = body.owner
    const repo = body.repo

    try {
      // get Authorization header
      const authHeader = c.req.header("Authorization")
      const token = authHeader?.replace(/^Bearer /, "")
      if (!token) throw new Error("Authorization header is required")

      // Verify permissions
      const userClient = new Octokit({ auth: token })
      const { data: repoData } = await userClient.repos.get({ owner, repo })
      if (!repoData.permissions?.admin && !repoData.permissions?.push && !repoData.permissions?.maintain)
        throw new Error("User does not have write permissions")

      // Get installation token
      const auth = createAppAuth({
        appId: Resource.GITHUB_APP_ID.value,
        privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
      })
      const appAuth = await auth({ type: "app" })

      // Lookup installation
      const appClient = new Octokit({ auth: appAuth.token })
      const { data: installation } = await appClient.apps.getRepoInstallation({
        owner,
        repo,
      })

      // Get installation token
      const installationAuth = await repositoryToken(auth, installation.id, repo)

      return c.json({ token: installationAuth.token })
    } catch (e: any) {
      let error = e
      if (e instanceof Error) {
        error = e.message
      }

      return c.json({ error }, { status: 401 })
    }
  })
  /**
   * Used by the opencode CLI to check if the GitHub app is installed
   */
  .get("/get_github_app_installation", async (c) => {
    const owner = c.req.query("owner")
    const repo = c.req.query("repo")
    if (!owner || !repo) return c.json({ error: "Owner and repository are required" }, 400)

    const auth = createAppAuth({
      appId: Resource.GITHUB_APP_ID.value,
      privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
    })
    const appAuth = await auth({ type: "app" })

    // Lookup installation
    const octokit = new Octokit({ auth: appAuth.token })
    let installation
    try {
      const ret = await octokit.apps.getRepoInstallation({ owner, repo })
      installation = ret.data
    } catch (err) {
      if (err instanceof Error && err.message.includes("Not Found")) {
        // not installed
      } else {
        throw err
      }
    }

    return c.json({ installation })
  })
  .all("*", (c) => c.text("Not Found"))
