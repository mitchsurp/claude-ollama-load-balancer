import fetch from "node-fetch";

export const HONEYPOT_PATTERNS = [
  /let me think about this carefully/i,
  /several important aspects to consider/i,
  /hello,?\s*i am a helpful assistant/i,
  /this is a common scenario/i,
  /interaction between multiple system components/i,
  /open-webui at :8888/i,
  /inference layer \(ollama at :11434\)/i,
  /would you like me to elaborate on any particular part/i,
  /let me know if you(?:'d| would) like me to dive deeper/i,
];

/**
 * Verifies if an Ollama node is actually responding to chat requests
 * by issuing a canary nonce challenge.
 *
 * @param {string} url - Backend base URL
 * @param {Array<{name: string, size?: number}|string>} models - Available models
 * @param {number} [timeoutMs=15000] - Timeout in milliseconds
 * @returns {Promise<{ok: boolean, honeypot?: boolean, reason?: string, latency?: number, model?: string}>}
 */
export async function verifyCanary(url, models = [], timeoutMs = 15000) {
  // Exclude cloud proxies, stubs, and embedding models
  const chatModels = models.filter((m) => {
    const name = (typeof m === "string" ? m : m.name || "").toLowerCase();
    const size = typeof m === "object" && m.size ? m.size : null;
    if (size != null && size < 50_000_000) return false; // Skip manifest stubs / cloud pointers
    if (name.includes(":cloud") || name.endsWith("-cloud")) return false;
    return (
      !name.includes("embed") &&
      !name.includes("bge-") &&
      !name.includes("rerank") &&
      !name.includes("minilm")
    );
  });

  if (chatModels.length === 0) {
    return { ok: false, honeypot: false, reason: "No local chat models available to test" };
  }

  // Sort by model size ascending (test smaller model first to minimize load latency)
  chatModels.sort((a, b) => ((a.size || Infinity) - (b.size || Infinity)));

  // Try up to 2 candidate models in case one has a specific configuration issue
  const candidates = chatModels.slice(0, 2);
  let lastError = null;

  for (const candidate of candidates) {
    const testModel = typeof candidate === "string" ? candidate : candidate.name;
    const nonce = `CANARY_${Math.floor(10000 + Math.random() * 90000)}`;
    const start = Date.now();

    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: "user", content: `Repeat this token and nothing else: ${nonce}` }],
          stream: false,
          options: { num_predict: 30, temperature: 0 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const latency = Date.now() - start;

      if (!res.ok) {
        lastError = { ok: false, honeypot: false, reason: `Chat failed: HTTP ${res.status}`, latency, model: testModel };
        continue; // Try next candidate if available
      }

      const data = await res.json().catch(() => null);
      if (!data) {
        lastError = { ok: false, honeypot: false, reason: "Invalid JSON response from chat endpoint", latency, model: testModel };
        continue;
      }

      const content = data?.message?.content || "";

      // Check for common honeypot boilerplate phrases
      for (const pattern of HONEYPOT_PATTERNS) {
        if (pattern.test(content)) {
          return {
            ok: false,
            honeypot: true,
            reason: `Honeypot pattern matched: "${content.trim().slice(0, 60)}..."`,
            latency,
            model: testModel,
          };
        }
      }

      // Verify presence of the random canary token
      if (!content.toUpperCase().includes(nonce)) {
        return {
          ok: false,
          honeypot: true,
          reason: `Canary token missing: "${content.trim().slice(0, 60)}..."`,
          latency,
          model: testModel,
        };
      }

      // Node passed canary test!
      return { ok: true, honeypot: false, latency, model: testModel };
    } catch (err) {
      lastError = { ok: false, honeypot: false, reason: err.message, latency: Date.now() - start, model: testModel };
    }
  }

  return lastError || { ok: false, honeypot: false, reason: "Canary test failed" };
}
