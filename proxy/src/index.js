import express from "express";
import cors from "cors";
import { createServer } from "http";
import fetch from "node-fetch";
import { loadConfig, saveConfig } from "./config.js";
import { createBalancer } from "./balancer.js";
import { createProxy } from "./proxy.js";
import { logger } from "./logger.js";
import { listSessions, deleteSessionById, purgeBackendSessions, extendSession } from "./sessions.js";
import { shodanSearch } from "./shodan.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const config = loadConfig();
const balancer = createBalancer(config);
const proxyHandler = createProxy(balancer);

// ── Admin: status ──────────────────────────────────────────────────────────
app.get("/admin/status", (req, res) => {
  res.json({ strategy: balancer.getStrategy(), backends: balancer.getBackends(), stats: balancer.getStats(), emulatedVersion: balancer.getEmulatedVersion() });
});

app.put("/admin/version", (req, res) => {
  const { version } = req.body;
  balancer.setEmulatedVersion(version || null);
  saveConfig(balancer);
  res.json({ version: balancer.getEmulatedVersion() });
});

app.get("/admin/logs", (req, res) => {
  res.json(logger.getLogs(parseInt(req.query.limit) || 200));
});

// ── Admin: backends ────────────────────────────────────────────────────────
app.post("/admin/backends", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  try { res.json(balancer.addBackend(url)); saveConfig(balancer); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/admin/backends/:id", (req, res) => {
  if (!balancer.removeBackend(req.params.id)) return res.status(404).json({ error: "not found" });
  saveConfig(balancer);
  res.json({ ok: true });
});

app.patch("/admin/backends/:id", (req, res) => {
  const backend = balancer.updateBackend(req.params.id, req.body);
  if (!backend) return res.status(404).json({ error: "not found" });
  saveConfig(balancer);
  res.json(backend);
});

app.post("/admin/ping-url", async (req, res) => {
  const { url, timeout = 10000, retries = 2 } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  const cleanUrl = url.trim().replace(/\/$/, "");
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const start = Date.now();
    try {
      const response = await fetch(`${cleanUrl}/api/version`, { signal: AbortSignal.timeout(timeout) });
      const latency = Date.now() - start;
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        return res.json({ online: true, version: data.version || null, latency, attempt });
      }
    } catch (e) {
      if (attempt === retries + 1) {
        return res.json({ online: false, error: e.message, attempts: attempt });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});

app.post("/admin/backends/:id/check", async (req, res) => {
  const result = await balancer.checkBackend(req.params.id);
  if (!result) return res.status(404).json({ error: "not found" });
  saveConfig(balancer);
  res.json(result);
});

app.post("/admin/backends/:id/pull", async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: "model required" });
  const backend = balancer.getBackends().find((b) => b.id === req.params.id);
  if (!backend) return res.status(404).json({ error: "not found" });
  if (!backend.enabled || backend.status !== "online") return res.status(400).json({ error: "backend is offline" });

  res.json({ status: "pulling", model, backend: backend.url });

  fetch(`${backend.url}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model, stream: false }),
  })
    .then(() => logger.log({ method: "POST", path: "/api/pull", status: 200, backend: backend.url, latency: 0, note: `pull:${model}` }))
    .catch((e) => logger.log({ method: "POST", path: "/api/pull", status: 502, backend: backend.url, latency: 0, error: e.message, note: `pull:${model}` }));
});

app.post("/admin/backends/check-all", async (req, res) => {
  const results = await balancer.checkAll();
  saveConfig(balancer);
  res.json(results);
});

app.put("/admin/strategy", (req, res) => {
  try { balancer.setStrategy(req.body.strategy); saveConfig(balancer); res.json({ strategy: req.body.strategy }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Admin: sessions ────────────────────────────────────────────────────────
app.get("/admin/sessions", (req, res) => {
  res.json(listSessions());
});

app.delete("/admin/sessions/:id", (req, res) => {
  const ok = deleteSessionById(decodeURIComponent(req.params.id));
  res.json({ ok });
});

app.post("/admin/sessions/:id/extend", (req, res) => {
  const extraMs = req.body?.ms ?? 60 * 60 * 1000;
  const s = extendSession(decodeURIComponent(req.params.id), extraMs);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, expiresAt: s.expiresAt });
});

// ── Admin: model inventory ─────────────────────────────────────────────────
app.get("/admin/models", async (req, res) => {
  const backends = balancer.getBackends().filter((b) => b.enabled);

  const inventories = await Promise.all(
    backends.map(async (b) => {
      if (b.status !== "online") return { ...b, models: [], error: "offline" };
      try {
        const start = Date.now();
        const r = await fetch(`${b.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        const latency = Date.now() - start;
        if (!r.ok) return { ...b, models: [], latency, error: `HTTP ${r.status}` };
        const data = await r.json();
        return { ...b, models: data.models || [], latency };
      } catch (e) {
        return { ...b, models: [], error: e.message };
      }
    })
  );

  const onlineInventories = inventories.filter((b) => !b.error);
  const onlineCount = onlineInventories.length;

  // Union of all model names
  const allNames = [...new Set(inventories.flatMap((b) => b.models.map((m) => m.name)))].sort();

  // Check tool compatibility via /api/show — look for .Tools in the model template
  const toolCompatMap = {};
  await Promise.all(allNames.map(async (name) => {
    const source = inventories.find((b) => !b.error && b.models.some((m) => m.name === name));
    if (!source) { toolCompatMap[name] = false; return; }
    try {
      const r = await fetch(`${source.url}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) { toolCompatMap[name] = false; return; }
      const data = await r.json();
      toolCompatMap[name] = (data.template || "").includes(".Tools");
    } catch {
      toolCompatMap[name] = false;
    }
  }));

  const models = allNames.map((name) => {
    const presentOn = inventories
      .filter((b) => b.models.some((m) => m.name === name))
      .map((b) => ({
        backendId: b.id,
        url: b.url,
        geo: b.geo,
        latency: b.latency,
        model: b.models.find((m) => m.name === name),
      }));

    const missingOn = inventories
      .filter((b) => !b.error && !b.models.some((m) => m.name === name))
      .map((b) => ({ backendId: b.id, url: b.url, geo: b.geo }));

    const size = presentOn.reduce((max, b) => Math.max(max, b.model?.size || 0), 0);
    const bestLatency = presentOn.reduce((min, b) => b.latency != null ? Math.min(min, b.latency) : min, Infinity);

    return {
      name, size,
      toolCompatible: toolCompatMap[name] ?? false,
      modifiedAt: presentOn[0]?.model?.modified_at || null,
      presentCount: presentOn.length,
      totalOnline: onlineCount,
      available: presentOn.length === onlineCount && onlineCount > 0,
      presentOn,
      missingOn,
      bestLatency: isFinite(bestLatency) ? bestLatency : null,
    };
  });

  res.json({ backends: inventories, models, onlineBackendCount: onlineCount });
});

// Sync (pull to missing backends)
app.post("/admin/sync", async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: "model required" });

  const backends = balancer.getBackends().filter((b) => b.enabled && b.status === "online");
  const inventory = await Promise.all(
    backends.map(async (b) => {
      try {
        const r = await fetch(`${b.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        const data = await r.json();
        return { ...b, hasModel: (data.models || []).some((m) => m.name === model) };
      } catch { return { ...b, hasModel: false }; }
    })
  );

  const missing = inventory.filter((b) => !b.hasModel);
  if (missing.length === 0) return res.json({ status: "already_synced", model });

  res.json({ status: "pulling", model, targets: missing.map((b) => b.url) });

  for (const b of missing) {
    fetch(`${b.url}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model, stream: false }),
    })
      .then(() => logger.log({ method: "POST", path: "/api/pull", status: 200, backend: b.url, latency: 0, note: `sync:${model}` }))
      .catch((e) => logger.log({ method: "POST", path: "/api/pull", status: 502, backend: b.url, latency: 0, error: e.message, note: `sync:${model}` }));
  }
});


// ── Admin: Shodan discovery ────────────────────────────────────────────────
app.post("/admin/shodan", async (req, res) => {
  const { apiKey, query, limit = 5, page = 1 } = req.body;
  if (!apiKey) return res.status(400).json({ error: "apiKey required" });
  try {
    const results = await shodanSearch({ apiKey, query, limit, page });
    res.json(results);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Ollama proxy catch-all ─────────────────────────────────────────────────
app.use("/", proxyHandler);

const PORT = process.env.PORT || 11434;
const server = createServer(app);
server.setTimeout(0);

server.listen(PORT, () => {
  console.log(`ollama-lb listening on :${PORT}`);
  balancer.checkAll().catch(() => {});
});
