import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { marked } from "marked"
import { codeToHtml } from "shiki"
import { sanitizeMarkdown } from "../src/components/share/sanitize-markdown"

test("server rendering without a DOM fails closed", () => {
  expect(sanitizeMarkdown('<img src=x onerror="alert(1)">')).toBe("")
})

async function fixture(svg = false) {
  // Reuse the repository's installed browser harness instead of a second Playwright dependency.
  const require = createRequire(new URL("../../app/package.json", import.meta.url))
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/components/share/sanitize-markdown.ts", import.meta.url))],
    target: "browser",
    format: "esm",
  })
  if (!built.success) throw new Error(built.logs.map(String).join("\n"))
  const source = await built.outputs[0].text()
  const fragments = await Promise.all(
    [
      '<img src=x onerror="window.__shareXss=true">',
      ...(svg ? ['<svg onload="window.__shareXss=true"><script>window.__shareXss=true</script></svg>'] : []),
      '<iframe srcdoc="<script>parent.__shareXss=true</script>"></iframe>',
      "[execute](javascript:alert(1))",
      '<a href="https://example.com/" target="_blank" rel="noopener noreferrer">safe link</a>',
    ].map(async (value) => marked.parse(value)),
  )
  const highlighted = await codeToHtml("const value = '<script>'", { lang: "javascript", theme: "github-light" })
  return { require, source, fragments, highlighted, html: fragments.join("\n\n") + highlighted }
}

const browserTest = process.env.OPENCODE_TEST_BROWSER === "1" ? test : test.skip
browserTest(
  "browser rendering blocks executable share HTML and preserves safe links and highlighted code",
  async () => {
    const { require, source, html } = await fixture(true)
    const { chromium, webkit } = require("@playwright/test")
    const engine = process.env.OPENCODE_TEST_BROWSER_ENGINE === "webkit" ? webkit : chromium
    const browser = await engine.launch({
      headless: true,
      ...(engine === chromium ? { executablePath: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE } : {}),
    })
    try {
      const page = await browser.newPage()
      const result = await page.evaluate(
        async ({ source, html }: { source: string; html: string }) => {
          const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
          try {
            const { sanitizeMarkdown } = await import(url)
            document.body.innerHTML = sanitizeMarkdown(html)
            await new Promise((resolve) => setTimeout(resolve, 50))
            const links = Array.from(document.querySelectorAll("a"))
            return {
              executed: Boolean(Reflect.get(window, "__shareXss")),
              executableElements: document.querySelectorAll("script,iframe,svg,[onerror],[onload]").length,
              dangerousLinks: links.some((link) => ["javascript:", "data:", "vbscript:"].includes(link.protocol)),
              safeLink: links.some((link) => link.href === "https://example.com/" && link.rel.includes("noopener")),
              code: document.querySelector("pre code")?.textContent,
              highlighted: Boolean(document.querySelector("pre code span[style]")),
            }
          } finally {
            URL.revokeObjectURL(url)
          }
        },
        { source, html },
      )
      expect(result).toEqual({
        executed: false,
        executableElements: 0,
        dangerousLinks: false,
        safeLink: true,
        code: "const value = '<script>'",
        highlighted: true,
      })
    } finally {
      await browser.close()
    }
  },
  30000,
)
