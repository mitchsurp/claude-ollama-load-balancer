import { randomUUID } from "crypto";
import fetch from "node-fetch";
import { geoBackend } from "./geo.js";
import { purgeBackendSessions } from "./sessions.js";
import { normalizeModelName, estimateRequirement, fmtBytes, BLOCK_TTL_MS } from "./memory.js";
import { verifyCanary } from "./canary.js";

const VALID_STRATEGIES = ["round-robin", "least-busy", "random"];

export function createBalancer(config) {
  let strategy = config.strategy || "round-robin";
  let backends = (config.backends || []).map(normalizeBackend);
  let rrIndex = 0;
  const stats = { totalRequests: 0, totalErrors: 0 };
  let emulatedVersion = config.emulatedVersion || null;
  // Exact memory requirements learned from Ollama OOM errors: normalized model → bytes
  const modelRequirements = new Map(Object.entries(config.modelRequirements || {}));

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
      checkNote: b.checkNote || null,
      addedAt: b.addedAt || new Date().toISOString(),
      geo: b.geo || null,
      memory: {
        manualLimitBytes: b.memory?.manualLimitBytes ?? null,
        learnedAvailableBytes: b.memory?.learnedAvailableBytes ?? null,
        learnedAt: b.memory?.learnedAt ?? null,
        maxObservedBytes: b.memory?.maxObservedBytes ?? null,
        blocked: b.memory?.blocked || {},
      },
    };
  }

  function getOnline() {
    return backends.filter((b) => b.enabled && b.status === "online");
  }

  // ── Memory fit ───────────────────────────────────────────────────────────
  // Weight size of a model as reported by /api/tags on any node that has it
  function modelWeightBytes(model) {
    const norm = normalizeModelName(model);
    for (const b of backends) {
      const size = b._modelSizes?.get(norm);
      if (size) return size;
    }
    return null;
  }

  function modelRequirementBytes(model, weightBytesHint = null) {
    const norm = normalizeModelName(model);
    return modelRequirements.get(norm) ?? estimateRequirement(weightBytesHint ?? modelWeightBytes(model));
  }

  // Best known memory ceiling for a node, or null if nothing is known yet.
  // maxObserved alone is only a lower bound, so it never acts as a limit by itself.
  function effectiveLimit(b) {
    const m = b.memory;
    if (m.manualLimitBytes) return { bytes: m.manualLimitBytes, source: "manual" };
    if (m.learnedAvailableBytes) {
      return { bytes: Math.max(m.learnedAvailableBytes, m.maxObservedBytes || 0), source: "learned" };
    }
    return { bytes: null, source: null };
  }

  function activeBlock(b, model) {
    const entry = b.memory.blocked[normalizeModelName(model)];
    if (!entry) return null;
    if (Date.now() - entry.at > BLOCK_TTL_MS) {
      delete b.memory.blocked[normalizeModelName(model)];
      return null;
    }
    return entry;
  }

  // fits: true | false | null (unknown — not enough information to decide)
  function fitFor(b, model, weightBytesHint = null) {
    const limit = effectiveLimit(b);
    const requiredBytes = modelRequirementBytes(model, weightBytesHint);
    const block = activeBlock(b, model);
    const base = { requiredBytes, limitBytes: limit.bytes, limitSource: limit.source };

    // A manual limit is the operator's word and overrides a learned block
    if (block && limit.source !== "manual") {
      return { ...base, fits: false, reason: `Out-of-memory on this node ${new Date(block.at).toISOString()}: ${block.message}` };
    }
    if (limit.bytes == null || requiredBytes == null) {
      return { ...base, fits: null, reason: limit.bytes == null ? "Node memory unknown" : "Model size unknown" };
    }
    if (requiredBytes > limit.bytes) {
      return { ...base, fits: false, reason: `Needs ~${fmtBytes(requiredBytes)}, node has ~${fmtBytes(limit.bytes)} (${limit.source})` };
    }
    return { ...base, fits: true, reason: `Needs ~${fmtBytes(requiredBytes)}, node has ~${fmtBytes(limit.bytes)} (${limit.source})` };
  }

  function fitForId(id, model, weightBytesHint) {
    const b = getBackend(id);
    return b ? fitFor(b, model, weightBytesHint) : null;
  }

  function recordMemoryError(id, model, parsed) {
    const b = getBackend(id);
    if (!b) return;
    const norm = normalizeModelName(model);
    if (parsed.availableBytes) {
      b.memory.learnedAvailableBytes = parsed.availableBytes;
      b.memory.learnedAt = new Date().toISOString();
    }
    if (parsed.requiredBytes) modelRequirements.set(norm, parsed.requiredBytes);
    b.memory.blocked[norm] = {
      requiredBytes: parsed.requiredBytes ?? modelRequirementBytes(model),
      availableBytes: parsed.availableBytes,
      message: parsed.message,
      at: Date.now(),
    };
  }

  function setMemoryLimit(id, gib) {
    const b = getBackend(id);
    if (!b) return null;
    b.memory.manualLimitBytes = gib ? Math.round(gib * 1024 ** 3) : null;
    return { ...b.memory };
  }

  function clearMemoryBlocks(id) {
    const b = getBackend(id);
    if (!b) return null;
    b.memory.blocked = {};
    b.memory.learnedAvailableBytes = null;
    b.memory.learnedAt = null;
    return { ...b.memory };
  }

  // Pick a backend that can serve the given model (has it in its tag list).
  // Falls back to any online backend if none specifically has it (shouldn't happen in practice).
  function pickForModel(model, excludeIds = []) {
    const online = getOnline().filter((b) => !excludeIds.includes(b.id));
    if (online.length === 0) return null;

    // Prefer backends that have the model cached
    const capable = online.filter((b) => b._modelCache && b._modelCache.has(model));
    let pool = capable.length > 0 ? capable : online;

    // Skip nodes known to lack memory for this model. If every candidate is
    // excluded, keep the original pool — routing never gets worse than before.
    if (model) {
      const roomy = pool.filter((b) => fitFor(b, model).fits !== false);
      if (roomy.length > 0) pool = roomy;
    }

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
        b._rawModels = data.models || [];
        b._modelCache = new Set((data.models || []).map((m) => m.name));
        b._modelSizes = new Map((data.models || []).map((m) => [normalizeModelName(m.name), m.size]));
      }
    } catch {}
  }

  // Track the largest model seen loaded — proof the node can hold at least that much
  async function refreshLoadedModels(b) {
    try {
      const r = await fetch(`${b.url}/api/ps`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      const data = await r.json();
      const loaded = (data.models || []).reduce((sum, m) => sum + (m.size || 0), 0);
      if (loaded > (b.memory.maxObservedBytes || 0)) b.memory.maxObservedBytes = loaded;
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
      if (!res.ok) {
        b.status = "offline";
        b.checkNote = `HTTP ${res.status} on /api/version`;
      } else {
        const data = await res.json().catch(() => ({}));
        b.ollamaVersion = data.version;

        // Refresh model cache when coming online
        await Promise.all([refreshModelCache(b), refreshLoadedModels(b)]);

        const rawModels = b._rawModels || [];
        if (rawModels.length === 0) {
          b.status = "offline";
          b.checkNote = "No models available in /api/tags";
        } else {
          // Perform canary challenge to detect honeypots / fake responses
          const canary = await verifyCanary(b.url, rawModels);
          if (canary.ok) {
            b.status = "online";
            b.lastLatency = canary.latency || latency;
            b.checkNote = null;
          } else if (canary.honeypot) {
            b.status = "honeypot";
            b.lastLatency = canary.latency;
            b.checkNote = canary.reason;
          } else {
            b.status = "offline";
            b.checkNote = canary.reason;
          }
        }
      }
    } catch (e) {
      b.status = "offline";
      b.checkNote = e.message;
    }
    b.lastChecked = new Date().toISOString();
    return { ...b };
  }

  async function checkAll(concurrency = 5) {
    const results = [];
    const queue = [...backends];
    async function worker() {
      while (queue.length > 0) {
        const b = queue.shift();
        if (b) {
          try {
            results.push(await checkBackend(b.id));
          } catch {}
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, backends.length) }, worker));
    return results;
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
    return backends.map(({ _modelCache, _modelSizes, _rawModels, ...b }) => {
      const limit = effectiveLimit(b);
      const blocked = Object.entries(b.memory.blocked)
        .filter(([, e]) => Date.now() - e.at <= BLOCK_TTL_MS)
        .map(([model, e]) => ({ model, ...e }));
      return {
        ...b,
        memory: { ...b.memory, limitBytes: limit.bytes, limitSource: limit.source, blockedList: blocked },
        modelCount: _modelCache?.size ?? null,
      };
    });
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
      modelRequirements: Object.fromEntries(modelRequirements),
      backends: backends.map(({ activeRequests, _modelCache, _modelSizes, _rawModels, ...rest }) => rest),
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
    fitForId,
    modelWeightBytes,
    recordMemoryError,
    setMemoryLimit,
    clearMemoryBlocks,
  };
}
