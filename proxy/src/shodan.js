// ── Shodan search integration ──────────────────────────────────────────────
// Uses the Shodan REST API to search for publicly accessible Ollama instances.
// API docs: https://developer.shodan.io/api

import fetch from "node-fetch";

const SHODAN_API_BASE = "https://api.shodan.io";
const DEFAULT_QUERY = '"ollama is running" -org:"Amazon" -org:"Amazon.com, Inc." -org:"Amazon"';

// Emoji flag from ISO 3166-1 alpha-2 country code (same logic as geo.js)
function countryFlag(code) {
  if (!code || code.length !== 2) return null;
  const cp = [...code.toUpperCase()].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...cp);
}

/**
 * Search Shodan for Ollama instances.
 * Returns up to `limit` results in a normalized shape.
 */
export async function shodanSearch({ apiKey, query = DEFAULT_QUERY, limit = 5, page = 1 } = {}) {
  if (!apiKey) throw new Error("Shodan API key required");

  const params = new URLSearchParams({
    key: apiKey,
    query,
    page: page.toString(),
    minify: "false",
  });

  const url = `${SHODAN_API_BASE}/shodan/host/search?${params}`;

  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `Shodan API error ${res.status}`);
    }
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Shodan request timed out");
    throw e;
  }

  const matches = data.matches || [];

  // Normalise results — take the first `limit` entries
  const results = matches.slice(0, limit).map((m) => {
    const ip = m.ip_str;
    // Shodan results can list multiple open ports; find the Ollama one
    // (usually 11434, but could be custom). Fall back to first HTTP port.
    const port = m.port || 11434;
    const countryCode = m.location?.country_code || null;
    const country = m.location?.country_name || null;
    const flag = countryFlag(countryCode);
    const org = m.org || m.isp || null;
    const hostnames = m.hostnames || [];
    const timestamp = m.timestamp || null;

    // Try to extract the Ollama version from the banner/data
    let ollamaVersion = null;
    const raw = m.data || "";
    const vMatch = raw.match(/Ollama\s+is\s+running/i);
    const verMatch = raw.match(/"version"\s*:\s*"([^"]+)"/);
    if (verMatch) ollamaVersion = verMatch[1];

    return {
      ip,
      port,
      url: `http://${ip}:${port}`,
      shodanUrl: `https://www.shodan.io/host/${ip}`,
      countryCode,
      country,
      flag,
      org,
      hostnames,
      timestamp,
      ollamaVersion,
      raw: raw.slice(0, 500), // truncated banner for display
    };
  });

  return {
    total: data.total || 0,
    query,
    results,
  };
}

export { DEFAULT_QUERY };
