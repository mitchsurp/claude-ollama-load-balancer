import { randomUUID } from "crypto";
import fetch from "node-fetch";
import { logger } from "./logger.js";
import { getSession, setSession, touchSession, deleteSessionById } from "./sessions.js";

// Per-request timeout; generous default for LLM inference but still catches dead backends
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "300000", 10);

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host",
]);

const BROADCAST_PATHS = new Set(["/api/pull", "/api/delete", "/api/copy", "/api/push"]);

// Requests that carry a model name and should trigger session affinity
const INFERENCE_PATHS = new Set([
  "/api/chat", "/api/generate", "/api/embeddings", "/api/embed",
  "/v1/chat/completions", "/v1/completions", "/v1/embeddings",
]);

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function clientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// /api/tags — union of all online backends, enriched with per-model availability
async function handleTags(backends, res) {
  const online = backends.filter((b) => b.enabled && b.status === "online");
  if (online.length === 0) return res.status(503).json({ error: "No online backends" });

  const results = await Promise.all(
    online.map(async (b) => {
      try {
        const start = Date.now();
        const r = await fetch(`${b.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        const latency = Date.now() - start;
        if (!r.ok) return { backend: b, models: [], latency };
        const data = await r.json();
        return { backend: b, models: data.models || [], latency };
      } catch {
        return { backend: b, models: [], latency: null };
      }
    })
  );

  // Build union, tracking which backends have each model
  const modelMap = new Map(); // name → { model, backends: [{id,url,latency}] }
  for (const { backend, models, latency } of results) {
    for (const m of models) {
      if (!modelMap.has(m.name)) {
        modelMap.set(m.name, { ...m, _backends: [] });
      }
      modelMap.get(m.name)._backends.push({ id: backend.id, url: backend.url, latency });
    }
  }

  // Return standard Ollama shape — clients see the full union
  const models = [...modelMap.values()].map(({ _backends, ...m }) => m);
  res.json({ models });
}

// /v1/models — union of all online backends, OpenAI list format
async function handleV1Models(backends, res) {
  const online = backends.filter((b) => b.enabled && b.status === "online");
  if (online.length === 0) return res.status(503).json({ error: "No online backends" });

  const results = await Promise.all(
    online.map(async (b) => {
      try {
        const r = await fetch(`${b.url}/v1/models`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return [];
        const data = await r.json();
        return data.data || [];
      } catch {
        return [];
      }
    })
  );

  const seen = new Set();
  const data = [];
  for (const models of results) {
    for (const m of models) {
      if (!seen.has(m.id)) { seen.add(m.id); data.push(m); }
    }
  }

  res.json({ object: "list", data });
}

// Strip Anthropic-only fields and normalize for Ollama's OpenAI-compatible API.
function normalizeForOllama(body) {
  if (!body || typeof body !== "object") return body;
  // "thinking" = Anthropic format; "reasoning" = OpenAI o-series format (what claude-code-router sends)
  const { thinking, betas, reasoning, ...rest } = body;
  // Ollama requires tool_choice: "auto" to actually invoke tools; without it models respond in prose.
  if (rest.tools?.length && rest.tool_choice === undefined) {
    rest.tool_choice = "auto";
  }
  // Local models miss the CWD buried in Claude Code's long system prompt. Extract it and prepend
  // a short reminder to the last user message so the model sees it immediately before responding.
  if (Array.isArray(rest.messages)) {
    const systemMsg = rest.messages.find((m) => m.role === "system");
    const systemText = typeof systemMsg?.content === "string"
      ? systemMsg.content
      : systemMsg?.content?.map?.((c) => c.text || "").join("") || "";
    const cwdMatch = systemText.match(/Primary working directory:\s*(\S+)/);
    if (cwdMatch) {
      const cwd = cwdMatch[1];
      const messages = [...rest.messages];
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
      if (lastUserIdx !== -1) {
        const msg = messages[lastUserIdx];
        const originalContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        messages[lastUserIdx] = {
          ...msg,
          content: `[Working directory: ${cwd}]\n${originalContent}`,
        };
        rest.messages = messages;
      }
    }
  }
  return rest;
}

// Single-backend proxy with session tracking
async function proxyToOne(backend, req, res, balancer, sessionKey) {
  balancer.incrementActive(backend.id);
  const start = Date.now();

  try {
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") body = JSON.stringify(normalizeForOllama(req.body));

    const upstreamRes = await fetch(`${backend.url}${req.originalUrl}`, {
      method: req.method,
      headers: {
        ...filterHeaders(req.headers),
        host: new URL(backend.url).host,
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const latency = Date.now() - start;
    balancer.decrementActive(backend.id);
    balancer.recordRequest(backend.id, { latency });

    res.status(upstreamRes.status);
    for (const [k, v] of upstreamRes.headers.entries()) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) try { res.setHeader(k, v); } catch {}
    }

    logger.log({
      method: req.method, path: req.originalUrl,
      status: upstreamRes.status, backend: backend.url, latency,
      sessionKey: sessionKey || null,
    });

    upstreamRes.body.pipe(res);

  } catch (err) {
    const latency = Date.now() - start;
    balancer.decrementActive(backend.id);
    balancer.recordRequest(backend.id, { latency, error: true });

    // Drop the session so the next request picks a healthy backend
    if (sessionKey) deleteSessionById(sessionKey);

    logger.log({
      method: req.method, path: req.originalUrl,
      status: 502, backend: backend.url, latency, error: err.message,
    });

    if (!res.headersSent) {
      res.status(502).json({ error: "Bad gateway", message: `${backend.url}: ${err.message}` });
    }
  }
}

// Broadcast to all enabled backends
async function broadcastToAll(backends, req, res, balancer) {
  if (backends.length === 0) return res.status(503).json({ error: "No enabled backends" });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.status(200);

  const body = JSON.stringify(req.body);
  const emit = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };

  emit({ status: `Broadcasting to ${backends.length} backend(s)…` });

  await Promise.all(backends.map(async (backend) => {
    const start = Date.now();
    balancer.incrementActive(backend.id);
    try {
      const r = await fetch(`${backend.url}${req.originalUrl}`, {
        method: req.method,
        headers: { ...filterHeaders(req.headers), host: new URL(backend.url).host, "content-type": "application/json" },
        body,
      });
      const text = await r.text();
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try { emit({ backend: backend.url, ...JSON.parse(t) }); }
        catch { emit({ backend: backend.url, status: t }); }
      }
      const latency = Date.now() - start;
      balancer.decrementActive(backend.id);
      balancer.recordRequest(backend.id, { latency });
      logger.log({ method: req.method, path: req.originalUrl, status: r.status, backend: backend.url, latency, note: "broadcast" });
      emit({ backend: backend.url, status: "done" });
    } catch (err) {
      const latency = Date.now() - start;
      balancer.decrementActive(backend.id);
      balancer.recordRequest(backend.id, { latency, error: true });
      logger.log({ method: req.method, path: req.originalUrl, status: 502, backend: backend.url, latency, error: err.message, note: "broadcast" });
      emit({ backend: backend.url, error: err.message });
    }
  }));

  emit({ status: "All backends complete." });
  res.end();
}

// ── Responses API ↔ Chat Completions translation ──────────────────────────
// Codex CLI uses POST /v1/responses (OpenAI Responses API). Ollama only speaks
// Chat Completions. We translate in both directions so sessions and routing work.

function translateInputItem(item) {
  if (item.type === "function_call") {
    return {
      role: "assistant", content: null,
      tool_calls: [{
        id: item.call_id || item.id || `call_${randomUUID()}`,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "" },
      }],
    };
  }
  if (item.type === "function_call_output") {
    return {
      role: "tool",
      tool_call_id: item.call_id,
      content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
    };
  }
  if (item.role) {
    let content;
    if (typeof item.content === "string") {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      const allText = item.content.every((c) => ["input_text", "output_text", "text"].includes(c.type));
      if (allText) {
        content = item.content.map((c) => c.text).join("\n");
      } else {
        content = item.content.map((c) => {
          if (["input_text", "output_text", "text"].includes(c.type)) return { type: "text", text: c.text };
          if (c.type === "input_image") return { type: "image_url", image_url: c.image_url || { url: c.url } };
          return c;
        });
      }
    } else {
      content = "";
    }
    return { role: item.role, content };
  }
  return null;
}

function translateTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => {
    if (t.type === "function" && !t.function) {
      return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
    }
    return t;
  });
}

function responsesToChatBody(body) {
  const { input, instructions, max_output_tokens, store, previous_response_id,
          conversation, context_management, include, background, text, tools, ...rest } = body;

  const messages = [];
  if (instructions) messages.push({ role: "system", content: instructions });

  if (Array.isArray(input)) {
    for (const item of input) {
      const msg = translateInputItem(item);
      if (msg) messages.push(msg);
    }
  } else if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  }

  const out = { ...rest, messages };
  if (max_output_tokens !== undefined) out.max_tokens = max_output_tokens;
  if (tools) out.tools = translateTools(tools);
  return out;
}

function chatToResponsesBody(chatResp, model, respId) {
  const choice = chatResp.choices?.[0];
  const message = choice?.message || {};
  const output = [];
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  if (message.content) {
    output.push({
      type: "message", id: msgId, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: message.content }],
    });
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }

  return {
    id: respId, object: "response",
    created_at: chatResp.created || Math.floor(Date.now() / 1000),
    status: "completed", model: chatResp.model || model, output,
    ...(chatResp.usage && {
      usage: {
        input_tokens: chatResp.usage.prompt_tokens ?? 0,
        output_tokens: chatResp.usage.completion_tokens ?? 0,
        total_tokens: chatResp.usage.total_tokens ?? 0,
      },
    }),
  };
}

function translateResponsesStream(upstream, res, model) {
  const respId = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const msgId  = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const baseResp = {
    id: respId, object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress", model, output: [],
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.status(200);

  let seq = 0;
  let prologueSent = false;
  let finished = false;
  let fullText = "";
  const toolsByIndex = {};
  let buf = "";

  function emit(type, extra) {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...extra })}\n\n`);
    } catch {}
  }

  function ensurePrologue() {
    if (prologueSent) return;
    prologueSent = true;
    emit("response.created",      { response: baseResp });
    emit("response.in_progress",  { response: baseResp });
    emit("response.output_item.added", {
      output_index: 0,
      item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    emit("response.content_part.added", {
      item_id: msgId, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "" },
    });
  }

  function finish() {
    if (finished) return;
    finished = true;
    ensurePrologue();

    if (fullText) {
      emit("response.output_text.done",  { item_id: msgId, output_index: 0, content_index: 0, text: fullText });
      emit("response.content_part.done", { item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: fullText } });
    }

    const finalOutput = fullText ? [{
      type: "message", id: msgId, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: fullText }],
    }] : [];

    emit("response.output_item.done", {
      output_index: 0,
      item: fullText
        ? { id: msgId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: fullText }] }
        : { id: msgId, type: "message", status: "completed", role: "assistant", content: [] },
    });

    for (const tc of Object.values(toolsByIndex)) {
      emit("response.function_call_arguments.done", { item_id: tc.id, output_index: tc.outIdx, arguments: tc.arguments });
      emit("response.output_item.done", {
        output_index: tc.outIdx,
        item: { type: "function_call", id: tc.id, call_id: tc.callId, name: tc.name, arguments: tc.arguments },
      });
      finalOutput.push({ type: "function_call", id: tc.id, call_id: tc.callId, name: tc.name, arguments: tc.arguments });
    }

    emit("response.completed", { response: { ...baseResp, status: "completed", output: finalOutput } });
    res.end();
  }

  upstream.body.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") { finish(); return; }

      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        ensurePrologue();
        fullText += delta.content;
        emit("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index;
          if (!toolsByIndex[i]) {
            const outIdx = 1 + Object.keys(toolsByIndex).length;
            toolsByIndex[i] = {
              id: tc.id || `fc_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
              callId: tc.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
              name: tc.function?.name || "",
              arguments: "",
              outIdx,
            };
            emit("response.output_item.added", {
              output_index: outIdx,
              item: { type: "function_call", id: toolsByIndex[i].id, call_id: toolsByIndex[i].callId, name: toolsByIndex[i].name, arguments: "" },
            });
          }
          const entry = toolsByIndex[i];
          if (tc.function?.name && !entry.name) entry.name = tc.function.name;
          if (tc.function?.arguments) {
            entry.arguments += tc.function.arguments;
            emit("response.function_call_arguments.delta", { item_id: entry.id, output_index: entry.outIdx, delta: tc.function.arguments });
          }
        }
      }

      if (choice.finish_reason) finish();
    }
  });

  upstream.body.on("end", () => { finish(); });
  upstream.body.on("error", () => { if (!res.writableEnded) res.end(); });
}

async function handleResponsesAPI(req, res, balancer) {
  const ip    = clientIp(req);
  const model = req.body?.model;
  if (!model) return res.status(400).json({ error: "model is required" });

  // Session affinity — same logic as INFERENCE_PATHS block
  let backend;
  const existing = getSession(ip, model);
  if (existing) {
    const pinned = balancer.getBackends().find(
      (b) => b.id === existing.backendId && b.enabled && b.status === "online"
    );
    if (pinned) { touchSession(ip, model); backend = pinned; }
  }
  if (!backend) {
    backend = balancer.pickForModel(model);
    if (!backend) return res.status(503).json({ error: "No backends available for model", model });
    setSession(ip, model, backend);
  }

  const chatBody = normalizeForOllama(responsesToChatBody(req.body));
  const isStreaming = chatBody.stream === true;
  balancer.incrementActive(backend.id);
  const start = Date.now();

  try {
    const upstream = await fetch(`${backend.url}/v1/chat/completions`, {
      method: "POST",
      headers: { ...filterHeaders(req.headers), host: new URL(backend.url).host, "content-type": "application/json" },
      body: JSON.stringify(chatBody),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const latency = Date.now() - start;
    balancer.decrementActive(backend.id);
    balancer.recordRequest(backend.id, { latency });
    logger.log({ method: "POST", path: "/v1/responses", status: upstream.status, backend: backend.url, latency, sessionKey: `${ip}::${model}`, note: "responses→chat" });

    if (!upstream.ok) {
      const errText = await upstream.text();
      if (!res.headersSent) res.status(upstream.status).send(errText);
      return;
    }

    if (isStreaming) {
      translateResponsesStream(upstream, res, model);
    } else {
      const chatResp = await upstream.json();
      const respId = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      res.json(chatToResponsesBody(chatResp, model, respId));
    }
  } catch (err) {
    const latency = Date.now() - start;
    balancer.decrementActive(backend.id);
    balancer.recordRequest(backend.id, { latency, error: true });
    deleteSessionById(`${ip}::${model}`);
    logger.log({ method: "POST", path: "/v1/responses", status: 502, backend: backend.url, latency, error: err.message });
    if (!res.headersSent) res.status(502).json({ error: "Bad gateway", message: err.message });
  }
}

export function createProxy(balancer) {
  return async function proxyHandler(req, res) {
    if (req.path.startsWith("/admin")) return;

    // Intercept /api/version — return emulated version if configured
    if (req.path === "/api/version" && req.method === "GET") {
      const v = balancer.getEmulatedVersion();
      if (v) return res.json({ version: v });
    }

    // Intercept /api/tags — return union of all backends
    if (req.path === "/api/tags" && req.method === "GET") {
      return handleTags(balancer.getBackends(), res);
    }

    // Intercept /v1/models — return union of all backends in OpenAI list format
    if (req.path === "/v1/models" && req.method === "GET") {
      return handleV1Models(balancer.getBackends(), res);
    }

    // Intercept /v1/responses — translate Responses API to Chat Completions for Ollama
    if (req.path === "/v1/responses" && req.method === "POST") {
      return handleResponsesAPI(req, res, balancer);
    }

    // Broadcast model-management to all backends
    if (BROADCAST_PATHS.has(req.path)) {
      return broadcastToAll(balancer.getBackends().filter((b) => b.enabled), req, res, balancer);
    }

    // ── Session affinity for inference requests ─────────────────────────
    if (INFERENCE_PATHS.has(req.path) && req.method === "POST") {
      const ip = clientIp(req);
      const model = req.body?.model;

      if (model) {
        // Check for an existing live session
        const existing = getSession(ip, model);
        if (existing) {
          // Verify the pinned backend is still online
          const pinned = balancer.getBackends().find(
            (b) => b.id === existing.backendId && b.enabled && b.status === "online"
          );
          if (pinned) {
            touchSession(ip, model);
            logger.log({ method: req.method, path: req.originalUrl, status: 0, backend: pinned.url, latency: 0, note: `session:${ip}` });
            return proxyToOne(pinned, req, res, balancer, `${ip}::${model}`);
          }
          // Pinned backend went offline — fall through to pick a new one
        }

        // No session or backend went offline — pick best backend for this model
        const backend = balancer.pickForModel(model);
        if (!backend) {
          return res.status(503).json({ error: "No backends available for model", model });
        }

        // Create session binding this client+model to this backend
        setSession(ip, model, backend);
        return proxyToOne(backend, req, res, balancer, `${ip}::${model}`);
      }
    }

    // Default: plain load-balanced routing
    const backend = balancer.pick();
    if (!backend) {
      logger.log({ method: req.method, path: req.originalUrl, status: 503, backend: null, latency: 0, error: "No online backends" });
      return res.status(503).json({ error: "No online backends available" });
    }

    return proxyToOne(backend, req, res, balancer, null);
  };
}
