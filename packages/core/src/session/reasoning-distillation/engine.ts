import { LLM, LLMResponse, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { Duration, Effect } from "effect"
import type { OrganizeCall } from "./organize"
import { ReasoningDistillationPolicy } from "./policy"

/** `default` keeps the model's own reasoning settings; `none`/`low` are translated for the routed protocol. */
export type OrganizerEffort = "default" | "none" | "low"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Whether a resolved engine model already disables reasoning through its declared request defaults. */
export const declaresNoReasoning = (model: LLMRequest["model"]) =>
  [model.route.defaults.http?.body, model.defaults?.http?.body].some(
    (body) =>
      isRecord(body) &&
      (body.reasoning_effort === "none" ||
        body.reasoningEffort === "none" ||
        (isRecord(body.reasoning) && body.reasoning.effort === "none") ||
        (isRecord(body.thinking) && body.thinking.type === "disabled")),
  )

/** The organizer's output cap, lowered to the model's declared output limit so capped providers accept the call. */
export const organizerMaxTokens = (model: LLMRequest["model"]) => {
  const limit = model.defaults?.limits?.output ?? model.route.defaults.limits?.output
  const cap = ReasoningDistillationPolicy.tokens.maxOutputTokens
  return limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.min(limit, cap) : cap
}

const effortBody = (protocol: string, effort: "none" | "low") =>
  protocol === "openai-responses"
    ? { reasoning: { effort } }
    : protocol === "openai-chat" || protocol === "openai-compatible-chat"
      ? { reasoning_effort: effort }
      : undefined

/**
 * Organizer transport over the `@opencode-ai/llm` engine: one request, no tools, temperature 0, no automatic retries.
 * Provider SDKs are not involved; the routed protocol lowers the request.
 */
export const engineOrganizerCall = (input: {
  llm: LLMClientShape
  model: LLMRequest["model"]
  effort: OrganizerEffort
  timeoutMs: number
  signal?: AbortSignal
}): OrganizeCall => {
  const effort = input.effort === "default" ? undefined : input.effort
  return async ({ prompt }) => {
    const request = LLM.request({
      model: input.model,
      prompt,
      tools: [],
      toolChoice: "none",
      generation: { temperature: 0, maxTokens: organizerMaxTokens(input.model) },
      ...(effort ? { providerOptions: { openai: { reasoningEffort: effort } } } : {}),
      http: {
        timeout: Duration.millis(input.timeoutMs),
        body: effort ? effortBody(input.model.route.protocol, effort) : undefined,
      },
      metadata: { purpose: "auxiliary", feature: "reasoning-distillation" },
    })
    const response = await Effect.runPromise(
      input.llm.generate(request).pipe(Effect.provideService(RequestExecutor.MaxRetries, 0)),
      input.signal ? { signal: input.signal } : undefined,
    )
    return {
      text: LLMResponse.text(response),
      usageTokens: LLMResponse.usage(response)?.totalTokens,
      finishReason: response.finishReason,
    }
  }
}
