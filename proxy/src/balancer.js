import { randomUUID } from "crypto";
import fetch from "node-fetch";
import { geoBackend } from "./geo.js";
import { purgeBackendSessions } from "./sessions.js";

const VALID_STRATEGIES = ["round-robin", "least-busy", "random"];

export function createBalancer(config) {
  let strategy = config.strategy || "round-robin";
  let backends = (config.backends || []).map(normalizeBackend);
  let rrIndex = 0;
  const stats = { totalRequests: 0, totalErrors: 0 };
  let emulatedVersion = config.emulatedVersion || null;

  function normalizeBackend(b) {
    return {
      id: b.id || randomUUID(),
      url: b.url.replace(/\/$/, ""),
      enabled: b.enabled !== false,
      status: b.status || "unknown",
      activeRequests: 0,
      totalRequests: b.totalRequests || 0,
      totalErrors: b.totalErrors || 0,
      lastLatency: b.lastLatency || null,
      lastChecked: b.lastChecked || null,
      addedAt: b.addedAt || new Date().toISOString(),
      geo: b.geo || null,
    };
  }

  function getOnline() {
    return backends.filter((b) => b.enabled && b.status === "online");
  }

  // Pick a backend that can serve the given model (has it in its tag list).
  // Falls back to any online backend if none specifically has it (shouldn't happen in practice).
  function pickForModel(model, excludeIds = []) {
    const online = getOnline().filter((b) => !excludeIds.includes(b.id));
    if (online.length === 0) return null;

    // Prefer backends that have the model cached
    const capable = online.filter((b) => b._modelCache && b._modelCache.has(model));
    const pool = capable.length > 0 ? capable : online;

    if (strategy === "round-robin") {
      const b = pool[rrIndex % pool.length];
      rrIndex++;
      return b;
    }
    if (strategy === "least-busy") {
      return pool.reduce((a, b) => (a.activeRequests <= b.activeRequests ? a : b));
    }
    if (strategy === "random") {
      return pool[Math.floor(Math.random() * pool.length)];
    }
    return pool[0];
  }

  // Plain pick — no model preference
  function pick() {
    return pickForModel(null);
  }

  function getBackend(id) {
    return backends.find((b) => b.id === id);
  }

  // Refresh model cache for a backend
  async function refreshModelCache(b) {
    try {
      const r = await fetch(`${b.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const data = await r.json();
        b._modelCache = new Set((data.models || []).map((m) => m.name));
      }
    } catch {}
  }

  async function checkBackend(id) {
    const b = getBackend(id);
    if (!b) return null;
    b.status = "checking";
    const start = Date.now();
    try {
      const res = await fetch(`${b.url}/api/version`, { signal: AbortSignal.timeout(5000) });
      const latency = Date.now() - start;
      if (res.ok) {
        const data = await res.json();
        b.status = "online";
        b.lastLatency = latency;
        b.ollamaVersion = data.version;
        // Refresh model cache when coming online
        await refreshModelCache(b);
      } else {
        b.status = "offline";
      }
    } catch {
      b.status = "offline";
    }
    b.lastChecked = new Date().toISOString();
    return { ...b };
  }

  async function checkAll() {
    return Promise.all(backends.map((b) => checkBackend(b.id)));
  }

  function addBackend(url) {
    const clean = url.trim().replace(/\/$/, "");
    if (backends.find((b) => b.url === clean)) throw new Error("Backend already exists");
    const b = normalizeBackend({ url: clean });
    backends.push(b);
    // Health check + geo lookup async
    checkBackend(b.id).catch(() => {});
    geoBackend(clean).then((geo) => { if (geo) b.geo = geo; }).catch(() => {});
    return { ...b };
  }

  function removeBackend(id) {
    const idx = backends.findIndex((b) => b.id === id);
    if (idx === -1) return false;
    purgeBackendSessions(id);
    backends.splice(idx, 1);
    return true;
  }

  function updateBackend(id, patch) {
    const b = getBackend(id);
    if (!b) return null;
    if (patch.enabled === false) purgeBackendSessions(id);
    Object.assign(b, patch);
    return { ...b };
  }

  function setStrategy(s) {
    if (!VALID_STRATEGIES.includes(s)) throw new Error(`Invalid strategy. Must be one of: ${VALID_STRATEGIES.join(", ")}`);
    strategy = s;
    rrIndex = 0;
  }

  function getStrategy() { return strategy; }

  function getEmulatedVersion() { return emulatedVersion; }
  function setEmulatedVersion(v) { emulatedVersion = v || null; }

  function getBackends() {
    return backends.map(({ _modelCache, ...b }) => ({
      ...b,
      modelCount: _modelCache?.size ?? null,
    }));
  }

  function getStats() {
    return { ...stats, backends: backends.length, online: getOnline().length };
  }

  function recordRequest(id, { latency, error }) {
    const b = getBackend(id);
    if (!b) return;
    b.totalRequests++;
    if (error) b.totalErrors++;
    if (latency != null) b.lastLatency = latency;
    stats.totalRequests++;
    if (error) stats.totalErrors++;
  }

  function incrementActive(id) {
    const b = getBackend(id);
    if (b) b.activeRequests = Math.max(0, (b.activeRequests || 0) + 1);
  }

  function decrementActive(id) {
    const b = getBackend(id);
    if (b) b.activeRequests = Math.max(0, (b.activeRequests || 0) - 1);
  }

  function serialize() {
    return {
      strategy,
      emulatedVersion,
      backends: backends.map(({ activeRequests, _modelCache, ...rest }) => rest),
    };
  }

  // Enrich geo on startup for existing backends
  for (const b of backends) {
    if (!b.geo) geoBackend(b.url).then((geo) => { if (geo) b.geo = geo; }).catch(() => {});
  }

  return {
    pick,
    pickForModel,
    checkBackend,
    checkAll,
    addBackend,
    removeBackend,
    updateBackend,
    setStrategy,
    getStrategy,
    getEmulatedVersion,
    setEmulatedVersion,
    getBackends,
    getStats,
    recordRequest,
    incrementActive,
    decrementActive,
    serialize,
  };
}
