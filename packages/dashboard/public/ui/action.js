// 操作の送信。POST /api/action に契約の ActionRequest を送り、X-Agent-Graph-Token を付ける
export const TOKEN_META_NAME = "agent-graph-token";
export const TOKEN_HEADER = "X-Agent-Graph-Token";
// 契約の ActionRequest にある項目だけを送る
const REQUEST_KEYS = ["action", "repo", "graphId", "taskId", "sessionId", "turnId", "delegationId", "model", "effort", "client"];

export function readToken(doc = globalThis.document) {
  const meta = doc && doc.querySelector ? doc.querySelector(`meta[name="${TOKEN_META_NAME}"]`) : null;
  return (meta && meta.content) || "";
}

// 403 やエラーページで JSON を読めないことがある。文面に落として画面を止めない
async function readResult(res) {
  try {
    const body = await res.json();
    return { ok: res.ok && body.ok === true, message: body.message || body.error || `HTTP ${res.status}`,
      ...(typeof body.key === "string" ? { key: body.key } : {}), ...(body.cancelled === true ? { cancelled: true } : {}) };
  } catch {
    return { ok: false, message: `Server error ${res.status}` };
  }
}

// 結果は { ok, message }。失敗は notify に "Failed: ..." で渡す。成功は message をそのまま渡す
export async function sendAction(body, { fetch: fetchFn = (...args) => globalThis.fetch(...args), token = "", notify = () => {} } = {}) {
  return sendPost("/api/action", body, { fetch: fetchFn, token, notify });
}

// POST /api/say。Claude セッションへメッセージを送る。応答は ActionResult と同じ形。
export async function sendSay(body, { fetch: fetchFn = (...args) => globalThis.fetch(...args), token = "", notify = () => {} } = {}) {
  return sendPost("/api/say", body, { fetch: fetchFn, token, notify });
}

// POST /api/projects。pick なら macOS のフォルダ選択を開き、path ならそのフォルダを追加する。
// 取り消しは通知しない
export async function sendAddProject(body, { fetch: fetchFn = (...args) => globalThis.fetch(...args), token = "", notify = () => {} } = {}) {
  return sendPost("/api/projects", body, { fetch: fetchFn, token, notify: (message) => { if (message !== "Failed: Cancelled") notify(message); } });
}

const BODY_KEYS = { "/api/say": ["repo", "sessionId", "text"], "/api/projects": ["pick", "path"] };

async function sendPost(path, body, { fetch: fetchFn, token, notify }) {
  const request = {};
  for (const key of BODY_KEYS[path] || REQUEST_KEYS) if (body[key] !== undefined) request[key] = body[key];
  try {
    const res = await fetchFn(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify(request),
    });
    const result = await readResult(res);
    notify(result.ok ? result.message : `Failed: ${result.message}`);
    return result;
  } catch (error) {
    const message = `Failed: ${error && error.message ? error.message : String(error)}`;
    notify(message);
    return { ok: false, message };
  }
}
