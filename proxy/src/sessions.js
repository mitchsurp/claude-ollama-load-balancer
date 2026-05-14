// ── Session affinity store ─────────────────────────────────────────────────
// Key: `${clientIp}:${modelName}`
// Value: { backendId, backendUrl, model, clientIp, createdAt, lastSeenAt, expiresAt }
//
// Sessions expire after SESSION_TTL_MS of inactivity (not wall-clock from creation).
// Each request touching a session resets lastSeenAt and extends expiry.

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const sessions = new Map(); // key → session

function sessionKey(clientIp, model) {
  return `${clientIp}::${model}`;
}

function now() { return Date.now(); }

// Get a live session, or null if missing/expired
export function getSession(clientIp, model) {
  const key = sessionKey(clientIp, model);
  const s = sessions.get(key);
  if (!s) return null;
  if (now() > s.expiresAt) {
    sessions.delete(key);
    return null;
  }
  return s;
}

// Touch an existing session (extend expiry on activity)
export function touchSession(clientIp, model) {
  const key = sessionKey(clientIp, model);
  const s = sessions.get(key);
  if (!s) return null;
  s.lastSeenAt = now();
  s.expiresAt = now() + SESSION_TTL_MS;
  return s;
}

// Create or refresh a session binding a client+model to a backend
export function setSession(clientIp, model, backend) {
  const key = sessionKey(clientIp, model);
  const existing = sessions.get(key);
  const t = now();
  const s = {
    id: existing?.id || key,
    clientIp,
    model,
    backendId: backend.id,
    backendUrl: backend.url,
    createdAt: existing?.createdAt || t,
    lastSeenAt: t,
    expiresAt: t + SESSION_TTL_MS,
  };
  sessions.set(key, s);
  return s;
}

// Extend a session's expiry by extraMs milliseconds
export function extendSession(id, extraMs) {
  const s = sessions.get(id);
  if (!s) return null;
  s.expiresAt += extraMs;
  return s;
}

// Manually expire a session
export function deleteSession(clientIp, model) {
  const key = sessionKey(clientIp, model);
  return sessions.delete(key);
}

export function deleteSessionById(id) {
  // id IS the key
  return sessions.delete(id);
}

// Return all live sessions (expired ones purged lazily here too)
export function listSessions() {
  const t = now();
  const live = [];
  for (const [key, s] of sessions) {
    if (t > s.expiresAt) { sessions.delete(key); continue; }
    live.push({ ...s, ttlMs: s.expiresAt - t });
  }
  return live.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

// Purge all sessions for a given backendId (used when backend removed/disabled)
export function purgeBackendSessions(backendId) {
  for (const [key, s] of sessions) {
    if (s.backendId === backendId) sessions.delete(key);
  }
}
