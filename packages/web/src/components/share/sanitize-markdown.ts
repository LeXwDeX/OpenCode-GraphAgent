import DOMPurify from "dompurify"

export function sanitizeMarkdown(html: string) {
  if (typeof window === "undefined" || !DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ["style"],
    FORBID_CONTENTS: ["style", "script"],
    ADD_ATTR: ["target"],
  })
}
