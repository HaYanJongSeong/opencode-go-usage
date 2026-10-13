import { collectUsage, usageMarkdown } from "./usage.mjs"
import { QuotaRpc } from "./quota-rpc.mjs"

export async function setupUsage(ctx, { fetcher = globalThis.fetch } = {}) {
  await ctx.rpc.register(QuotaRpc, {
    read: async (_input, context) => collectUsage(ctx, { fetcher, signal: context.signal }),
  })
  await ctx.command.transform((editor) => {
    for (const name of ["사용량", "left"]) editor.add({
      name,
      description: "Go/Codex 사용량 조회 (현재 모델 응답 1회 비용 발생). test: 모의 테스트만 실행",
      execute: async ({ sessionID, prompt, delivery }) => {
        const text = String(prompt?.text ?? "").trim()
        const prefix = new RegExp(`^/?${name}(?:\\s+|$)`, "i")
        const arg = text.replace(prefix, "").trim()
        if ((arg && arg !== "test") || prompt?.files?.length || prompt?.agents?.length || prompt?.skills?.length) {
          throw new Error("사용법: /사용량 또는 /left 또는 /left test. 첨부는 지원하지 않습니다.")
        }
        if (arg === "test") {
          const { runTests } = await import("./usage.test.mjs")
          await runTests()
          return
        }
        const markdown = usageMarkdown(await collectUsage(ctx, { fetcher }))
        await ctx.session.prompt({
          sessionID,
          delivery,
          text: `다음 Markdown을 정확히 그대로 한 번만 출력하세요. 도구 호출, 계산, 추정, 설명 추가, 요약, 코드 블록 감싸기를 하지 마세요.\n\n${markdown}`,
        })
      },
    })
  })
  await ctx.tool.transform((editor) => editor.add({
    name: "usage_status",
    description: "선택된 Go/Codex 연결의 사용량을 읽기 전용으로 조회합니다. 비밀정보나 로컬 추정값은 반환하지 않습니다.",
    input: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_input, context) => ({ content: JSON.stringify(await collectUsage(ctx, { fetcher, signal: context.signal })) }),
  }))
}

export default { id: "go-codex-usage", setup: (ctx) => setupUsage(ctx) }
