// ── Node memory awareness ──────────────────────────────────────────────────
// Ollama exposes no endpoint for host RAM/VRAM, so per-node capacity is
// assembled from three signals:
//   1. Ollama's own OOM error text, which carries exact numbers:
//      "model requires more system memory (12.5 GiB) than is available (7.9 GiB)"
//   2. /api/ps — the largest model observed loaded (proven to fit)
//   3. A manual per-node limit set by the operator
// Model requirements come from learned OOM numbers, else weight size × overhead.

import fetch from "node-fetch";

// Weights → resident memory heuristic (KV cache, compute graph, runtime overhead)
const OVERHEAD_FACTOR = 1.2;
const OVERHEAD_FIXED_BYTES = 512 * 1024 ** 2;

// Blocked (model, node) pairs expire — available memory changes as other models unload
export const BLOCK_TTL_MS = 12 * 60 * 60 * 1000;

const UNIT = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };

function toBytes(num, unit) {
  const mult = UNIT[unit.toUpperCase()];
  return mult ? Math.round(parseFloat(num) * mult) : null;
}

// Parse an Ollama error body. Returns null if it isn't a memory error.
export function parseMemoryError(text) {
  if (!text) return null;
  const exact = text.match(
    /requires more (?:system )?memory \(([\d.]+)\s*([KMGT]i?B)\) than is available \(([\d.]+)\s*([KMGT]i?B)\)/i
  );
  if (exact) {
    return {
      requiredBytes: toBytes(exact[1], exact[2]),
      availableBytes: toBytes(exact[3], exact[4]),
      message: exact[0],
    };
  }
  if (/out of memory|cudaMalloc failed|unable to allocate .*buffer|insufficient memory|signal: killed|requires more (?:system )?memory/i.test(text)) {
    return { requiredBytes: null, availableBytes: null, message: text.slice(0, 200) };
  }
  return null;
}

export function normalizeModelName(name) {
  if (!name) return name;
  const last = name.split("/").pop();
  return last.includes(":") ? name : `${name}:latest`;
}

export function estimateRequirement(weightBytes) {
  if (!weightBytes) return null;
  return Math.round(weightBytes * OVERHEAD_FACTOR + OVERHEAD_FIXED_BYTES);
}

// Registry manifest lookup for models not yet present on any node
const registryCache = new Map(); // normalized name → { bytes, at }
const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;

export function estimateFromParamTag(name) {
  if (!name) return null;
  // Match e.g. :70b, :8b, -32b, :1.5b, :8x7b
  const moe = name.match(/(?:[:\-_])(\d+)x(\d+(?:\.\d+)?)b\b/i);
  if (moe) {
    const paramsB = parseFloat(moe[1]) * parseFloat(moe[2]) * 0.85;
    return Math.round(paramsB * 0.62 * 1024 ** 3);
  }
  const m = name.match(/(?:[:\-_])(\d+(?:\.\d+)?)b\b/i);
  if (m) {
    const paramsB = parseFloat(m[1]);
    return Math.round(paramsB * 0.62 * 1024 ** 3);
  }
  return null;
}

export async function registryWeightBytes(name) {
  const norm = normalizeModelName(name);
  const cached = registryCache.get(norm);
  if (cached && Date.now() - cached.at < REGISTRY_TTL_MS) return cached.bytes;

  // Only registry.ollama.ai names are resolvable (skip hf.co/… and other hosts)
  const [path, tag] = norm.split(/:(?=[^/]*$)/);
  const parts = path.split("/");
  if (parts.length > 2 || parts[0].includes(".")) return estimateFromParamTag(norm);
  const repo = parts.length === 1 ? `library/${parts[0]}` : path;

  try {
    const r = await fetch(`https://registry.ollama.ai/v2/${repo}/manifests/${tag}`, {
      headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return estimateFromParamTag(norm);
    const m = await r.json();
    const bytes = (m.layers || [])
      .filter((l) => /image\.(model|projector)$/.test(l.mediaType || ""))
      .reduce((sum, l) => sum + (l.size || 0), 0);
    const result = bytes > 0 ? bytes : estimateFromParamTag(norm);
    registryCache.set(norm, { bytes: result, at: Date.now() });
    return result;
  } catch {
    return estimateFromParamTag(norm);
  }
}

export function fmtBytes(bytes) {
  if (bytes == null) return "unknown";
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
