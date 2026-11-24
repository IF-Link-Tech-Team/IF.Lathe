/**
 * A chat model behind an OpenAI-compatible `/chat/completions` endpoint
 * (DeepSeek by default), asked for one JSON object per call.
 *
 * DeepSeek's reasoning mode spends max_tokens on thinking and sometimes
 * returns tool-call markup or nothing instead of the object, so thinking is
 * off and an unusable reply is asked for once more with the same prompt.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmResult<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
}

export const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com";

export async function askJson<T>(
  config: LlmConfig,
  system: string,
  user: string,
  validate: (value: unknown) => T | null,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmResult<T>> {
  let inputTokens = 0;
  let outputTokens = 0;
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: 0.2,
        max_tokens: config.maxTokens ?? 4000,
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 180_000),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`模型接口 HTTP ${res.status}：${String(body?.error?.message ?? "").slice(0, 200)}`);
    inputTokens += Number(body?.usage?.prompt_tokens ?? 0);
    outputTokens += Number(body?.usage?.completion_tokens ?? 0);
    last = String(body?.choices?.[0]?.message?.content ?? "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(last);
    } catch {
      parsed = null;
    }
    const value = parsed === null ? null : validate(parsed);
    if (value !== null) return { value, inputTokens, outputTokens };
  }
  throw new Error(`模型两次都没有给出可用的 JSON（最后一次：${last.slice(0, 120) || "空"}）`);
}

/**
 * Model text goes onto GitHub as markdown: no HTML, no links or images it
 * could use to send a reader elsewhere, bounded length.
 */
export function plainMarkdown(text: unknown, max = 2000): string {
  return String(text ?? "")
    .replace(/<[^>]{0,200}>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, "[链接已移除]")
    .trim()
    .slice(0, max);
}
