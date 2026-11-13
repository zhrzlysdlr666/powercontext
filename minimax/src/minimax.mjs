// MiniMax 调用封装（Anthropic 兼容通道），每次调用都落一条可核查记录到 evidence/。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join(ROOT, "evidence");
const BASE = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/anthropic";
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-M3.1-Flash";

function apiKey() {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY.trim();
  for (const p of [
    path.join(ROOT, "..", ".secrets", "minimax_key.txt"),
    path.join(ROOT, ".secrets", "minimax_key.txt"),
  ]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  throw new Error("缺少 MiniMax API Key：设置 MINIMAX_API_KEY 或写入 .secrets/minimax_key.txt");
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

export async function askMiniMax({ system, prompt, maxTokens = 2048, tag = "dev" }) {
  const key = apiKey();
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const body = await res.json();
  const ms = Date.now() - started;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const record = {
    at: new Date().toISOString(),
    tag,
    model: MODEL,
    endpoint: `${BASE}/v1/messages`,
    prompt_sha256: sha(prompt),
    prompt_chars: prompt.length,
    latency_ms: ms,
    http_status: res.status,
    usage: body.usage || null,
    request_id: body.id || null,
    ok: res.ok,
  };
  fs.appendFileSync(path.join(EVIDENCE_DIR, "minimax-calls.jsonl"), JSON.stringify(record) + "\n");
  if (!res.ok) {
    throw new Error(`MiniMax ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  const text = (body.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { text, usage: body.usage || null, requestId: body.id || null };
}
