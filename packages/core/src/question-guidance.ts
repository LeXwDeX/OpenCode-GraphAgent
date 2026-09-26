/** Shared model-facing question contract for the V1 and V2 tool paths. */
export interface Prompt {
  readonly question: string
  readonly options: ReadonlyArray<{ readonly label: string }>
  readonly multiple?: boolean
}

export const description = `Use this tool when a decision changes scope, authorization, acceptance criteria, or an irreversible outcome and existing instructions do not resolve it. For an ordinary preference with a reasonable default, choose that default, state the assumption, and continue.

A question blocks until answered or until \`question_timeout\` seconds pass (default 60). After the user starts answering, inactivity times out after \`question_timeout\` seconds and the response phase ends after five minutes. Every question with \`options\` SHOULD put exactly one "(Recommended)" option first as the unanswered fallback. That fallback must stay within existing authorization; silence never grants new scope or permission for an irreversible action. When the required decision has no safe affirmative fallback, recommend deferring that step and continue other authorized work. A dismissed question means the user declined to answer: do not ask it again in the same turn; continue independent authorized work and report the blocked step.

Usage notes:
- When \`custom\` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set \`multiple: true\` to allow selecting more than one
- Even with \`multiple: true\`, timeout offers only one fallback candidate; only the user can select additional options
- If several options carry "(Recommended)", the first marked option is the candidate. If none is marked, the first option is the candidate. A free-form question has no fallback candidate.
- A candidate is never automatic permission: defer the dependent step if it is unsafe or outside existing authorization.`

export const rejectedOutput =
  "The user dismissed the question without answering. Do not repeat this question in this turn or treat dismissal as consent. Defer its dependent step, continue independent authorized work, and report what requires an explicit answer."

export function timeoutOutput(questions: ReadonlyArray<Prompt>) {
  const choices = questions.map((question, index) => {
    const candidate =
      question.options.find((option) => option.label.trimEnd().endsWith("(Recommended)")) ?? question.options[0]
    return candidate
      ? `Question ${index + 1} fallback candidate: ${JSON.stringify(candidate.label)}${question.multiple ? " (single selection only)" : ""}.`
      : `Question ${index + 1} has no option fallback candidate.`
  })
  return [
    "The user is temporarily away and did not answer.",
    ...choices,
    "Continue authorized work now. Apply each listed candidate only when already authorized and safe; silence never grants new scope or permission for an irreversible action. Defer any dependent step with an unsafe candidate or no candidate, continue independent authorized work, and report the blocker. State adopted assumptions without claiming the user answered.",
  ].join(" ")
}

export function answeredOutput(questions: ReadonlyArray<Prompt>, answers: ReadonlyArray<ReadonlyArray<string>>) {
  const formatted = questions
    .map(
      (question, index) =>
        `${JSON.stringify(question.question)}=${JSON.stringify(answers[index]?.length ? answers[index].join(", ") : "Unanswered")}`,
    )
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}
