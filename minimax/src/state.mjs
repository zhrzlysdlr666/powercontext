// PowerContext 状态存取：任务进展与验证结果保存在 PowerContext，模块重启后读回并继续使用。
const BASE = process.env.POWECONTEXT_URL || process.env.POWERCONTEXT_URL || "http://127.0.0.1:8787";
const SCOPE_TITLE = "SDD 上下文模块 T-1042";
const SCOPE_KEY = "sdd-minimax-t1042-v1";

async function req(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`PowerContext ${path} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

export async function ensureScope() {
  // 列表接口的 query 必须与 query_field 成对出现，这里直接取全量再按标题精确匹配
  const list = await req("/v1/scopes");
  const existing = (list.items || list.scopes || []).find((s) => s.title === SCOPE_TITLE);
  if (existing) return existing.scope_id;
  const created = await req("/v1/scopes", {
    method: "POST",
    body: JSON.stringify({
      title: SCOPE_TITLE,
      summary: "MiniMax 赛题 T-1042：SDD 工程上下文模块的任务状态与验证记录",
      idempotency_key: SCOPE_KEY,
    }),
  });
  return created.scope_id;
}

export async function saveState(scopeId, taskId, state) {
  const text = JSON.stringify({ task_id: taskId, ...state, saved_at: new Date().toISOString() });
  const body = await req("/v1/memory/remember", {
    method: "POST",
    body: JSON.stringify({
      scope_id: scopeId,
      kind: `task-state:${taskId}`,
      text,
      description: `${taskId} 进展：${(state.todo || []).length} 项待办`,
    }),
  });
  return body.records?.[0]?.artifact || null;
}

export async function loadState(scopeId, taskId) {
  const body = await req("/v1/memory/entries/list", {
    method: "POST",
    body: JSON.stringify({ scope_id: scopeId, limit: 100 }),
  });
  const rows = (body.entries || []).filter((e) => e.kind === `task-state:${taskId}` && e.state === "active");
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  try {
    return { ...JSON.parse(last.text), artifact: last.artifact };
  } catch {
    return { raw: last.text, artifact: last.artifact };
  }
}
