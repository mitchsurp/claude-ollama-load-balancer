// ── IP geolocation via ip-api.com (free, no key, 45 req/min) ──────────────
// Caches results indefinitely since IPs don't change location often.
// Returns { country, countryCode, flag } or null.

import fetch from "node-fetch";

const cache = new Map();
const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^::1$/, /^fc/, /^fd/,
];

function isPrivate(ip) {
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

// Emoji flag from ISO 3166-1 alpha-2 country code
function countryFlag(code) {
  if (!code || code.length !== 2) return null;
  const cp = [...code.toUpperCase()].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...cp);
}

export async function geoLookup(ip) {
  if (!ip || isPrivate(ip)) return null;
  if (cache.has(ip)) return cache.get(ip);

  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.status !== "success") return null;
    const result = {
      country: data.country,
      countryCode: data.countryCode,
      flag: countryFlag(data.countryCode),
    };
    cache.set(ip, result);
    return result;
  } catch {
    return null;
  }
}

// Lookup an Ollama backend URL's host IP
export async function geoBackend(url) {
  try {
    const host = new URL(url).hostname;
    // If it's already an IP, use directly; otherwise resolve via ip-api
    const ipPattern = /^\d+\.\d+\.\d+\.\d+$/;
    if (ipPattern.test(host)) return geoLookup(host);
    // Try hostname lookup via ip-api
    const r = await fetch(`http://ip-api.com/json/${host}?fields=status,country,countryCode`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.status !== "success") return null;
    const result = {
      country: data.country,
      countryCode: data.countryCode,
      flag: countryFlag(data.countryCode),
    };
    cache.set(host, result);
    return result;
  } catch {
    return null;
  }
}
