import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "./api.js";

const C = {
  bg: "#020810", surface: "#0a0f1a", panel: "#0f172a",
  border: "#1a2332", borderBright: "#1e293b",
  muted: "#334155", dim: "#64748b", text: "#94a3b8",
  bright: "#e2e8f0", white: "#f8fafc",
  blue: "#0ea5e9", green: "#22c55e", red: "#ef4444",
  amber: "#f59e0b", purple: "#a855f7", teal: "#2dd4bf",
};
const mono = "'JetBrains Mono','Fira Mono',monospace";
const sans = "'Inter',system-ui,sans-serif";

// ── Tiny helpers ───────────────────────────────────────────────────────────
function Pulse({ color, size = 8 }) {
  return <span style={{
    display: "inline-block", width: size, height: size, borderRadius: "50%",
    background: color, flexShrink: 0,
    boxShadow: color === C.green ? `0 0 0 2px ${C.bg},0 0 8px ${C.green}88` : "none",
    animation: color === C.amber ? "blink 1.4s infinite" : "none",
  }} />;
}

function statusColor(s) {
  return s === "online" ? C.green : s === "offline" ? C.red : s === "checking" ? C.amber : C.muted;
}

function fmtSize(bytes) {
  if (!bytes) return null;
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

function fmtTime(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtRelative(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function fmtCountdown(ms) {
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Btn({ children, onClick, variant = "default", small, disabled, title, style: sx }) {
  const v = {
    default: { bg: C.panel, border: C.border, color: C.text },
    primary: { bg: C.blue, border: C.blue, color: "#fff" },
    danger:  { bg: "transparent", border: "#3f1515", color: C.red },
    ghost:   { bg: "transparent", border: C.border, color: C.dim },
    success: { bg: "#14532d33", border: "#166534", color: "#86efac" },
    warn:    { bg: "#2d1a0033", border: "#92400e", color: C.amber },
    sync:    { bg: "#0c3a5f", border: C.blue, color: C.blue },
  }[variant] || {};
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      background: disabled ? C.panel : v.bg, border: `1px solid ${disabled ? C.muted : v.border}`,
      color: disabled ? C.muted : v.color, borderRadius: 6,
      padding: small ? "3px 9px" : "7px 16px", cursor: disabled ? "not-allowed" : "pointer",
      fontFamily: mono, fontSize: small ? 11 : 13, fontWeight: 500,
      transition: "all 0.12s", whiteSpace: "nowrap", ...sx,
    }}>{children}</button>
  );
}

function Card({ children, style }) {
  return <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, ...style }}>{children}</div>;
}

function SectionLabel({ children }) {
  return <div style={{ color: C.muted, fontSize: 10, fontFamily: mono, letterSpacing: "0.12em", marginBottom: 10 }}>{children}</div>;
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px", flex: 1, minWidth: 100 }}>
      <div style={{ fontSize: 22, fontFamily: mono, fontWeight: 700, color: color || C.white }}>{value ?? "—"}</div>
      <div style={{ fontSize: 10, fontFamily: mono, color: C.muted, letterSpacing: "0.1em", marginTop: 3 }}>{label}</div>
      {sub != null && <div style={{ fontSize: 11, fontFamily: mono, color: C.dim, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Backends tab ───────────────────────────────────────────────────────────
function BackendRow({ backend, onRemove, onToggle, onCheck, checking }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "9px 14px",
      background: backend.enabled ? C.panel : C.bg,
      border: `1px solid ${backend.enabled ? C.border : "#111827"}`,
      borderRadius: 8, opacity: backend.enabled ? 1 : 0.55, transition: "all 0.15s",
    }}>
      <Pulse color={statusColor(backend.status)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {backend.geo?.flag && (
            <span title={backend.geo.country} style={{ fontSize: 16, lineHeight: 1 }}>{backend.geo.flag}</span>
          )}
          <span style={{ fontFamily: mono, fontSize: 13, color: backend.enabled ? C.text : C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {backend.url}
          </span>
          {backend.geo?.country && !backend.geo?.flag && (
            <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>{backend.geo.country}</span>
          )}
        </div>
      </div>
      {backend.ollamaVersion && <Chip>{`v${backend.ollamaVersion}`}</Chip>}
      {backend.modelCount != null && <Chip>{backend.modelCount} models</Chip>}
      {backend.activeRequests > 0 && <Chip accent>{backend.activeRequests} active</Chip>}
      {backend.totalRequests > 0 && <Chip>{backend.totalRequests} req</Chip>}
      {backend.lastLatency != null && <Chip>{backend.lastLatency}ms</Chip>}
      <Btn small onClick={() => onCheck(backend.id)} disabled={checking}>{checking ? "…" : "ping"}</Btn>
      <Btn small variant={backend.enabled ? "success" : "ghost"} onClick={() => onToggle(backend.id, !backend.enabled)}>
        {backend.enabled ? "on" : "off"}
      </Btn>
      <Btn small variant="danger" onClick={() => onRemove(backend.id)}>✕</Btn>
    </div>
  );
}

function Chip({ children, accent }) {
  return <span style={{
    display: "inline-block", background: accent ? "#0c3a5f" : C.panel,
    border: `1px solid ${accent ? C.blue : C.border}`,
    color: accent ? C.blue : C.text,
    fontSize: 10, fontFamily: mono, padding: "1px 6px", borderRadius: 4,
    letterSpacing: "0.04em", whiteSpace: "nowrap",
  }}>{children}</span>;
}

// ── Sessions tab ───────────────────────────────────────────────────────────
function SessionsTab() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState({});
  const [extending, setExtending] = useState({});
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSessions(await api.sessions()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Tick every second for countdown refresh
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Auto-reload when sessions expire
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function deleteSession(id) {
    setDeleting((d) => ({ ...d, [id]: true }));
    try { await api.deleteSession(id); await load(); } catch {}
    setDeleting((d) => ({ ...d, [id]: false }));
  }

  async function extendSession(id) {
    setExtending((e) => ({ ...e, [id]: true }));
    try { await api.extendSession(id); await load(); } catch {}
    setExtending((e) => ({ ...e, [id]: false }));
  }

  if (sessions.length === 0 && !loading) {
    return (
      <Card>
        <div style={{ fontFamily: mono, fontSize: 12, color: C.muted, textAlign: "center", padding: "30px 0", lineHeight: 2 }}>
          No active sessions.<br />
          <span style={{ color: C.dim, fontSize: 11 }}>Sessions are created when a client makes an inference request. They expire after 2 hours of inactivity.</span>
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: mono, fontSize: 11, color: C.muted, letterSpacing: "0.08em" }}>
          {sessions.length} ACTIVE SESSION{sessions.length !== 1 ? "S" : ""} · auto-refresh 15s
        </div>
        <Btn small onClick={load} disabled={loading}>{loading ? "…" : "↺ refresh"}</Btn>
      </div>

      {sessions.map((s) => {
        const ttlMs = s.ttlMs;
        const pct = Math.max(0, Math.min(100, (ttlMs / (2 * 60 * 60 * 1000)) * 100));
        const ttlColor = ttlMs < 10 * 60000 ? C.red : ttlMs < 30 * 60000 ? C.amber : C.green;
        return (
          <div key={s.id} style={{
            background: C.panel, border: `1px solid ${C.border}`,
            borderRadius: 10, overflow: "hidden",
          }}>
            {/* TTL progress bar */}
            <div style={{ height: 2, background: C.muted, position: "relative" }}>
              <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: ttlColor, transition: "width 1s linear" }} />
            </div>

            <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
              {/* Client info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <span style={{ fontFamily: mono, fontSize: 12, color: C.blue }}>{s.clientIp}</span>
                  <span style={{ fontFamily: mono, fontSize: 11, color: C.muted }}>→</span>
                  <span style={{ fontFamily: mono, fontSize: 12, color: C.bright, fontWeight: 600 }}>{s.model}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: mono, fontSize: 10, color: C.dim }}>
                    pinned to <span style={{ color: C.text }}>{s.backendUrl.replace(/^https?:\/\//, "")}</span>
                  </span>
                  <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>
                    created {fmtRelative(s.createdAt)}
                  </span>
                  <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>
                    last seen {fmtRelative(s.lastSeenAt)}
                  </span>
                </div>
              </div>

              {/* Countdown + extend */}
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontFamily: mono, fontSize: 13, color: ttlColor, fontWeight: 600 }}>
                  {fmtCountdown(ttlMs)}
                </div>
                <div style={{ fontFamily: mono, fontSize: 9, color: C.muted, marginTop: 2 }}>remaining</div>
                <button
                  onClick={() => extendSession(s.id)}
                  disabled={extending[s.id]}
                  title="Extend session by 1 hour"
                  style={{
                    marginTop: 5, background: "none",
                    border: `1px solid ${C.border}`, color: extending[s.id] ? C.muted : C.dim,
                    borderRadius: 4, padding: "2px 7px", cursor: extending[s.id] ? "not-allowed" : "pointer",
                    fontFamily: mono, fontSize: 10, transition: "color 0.15s",
                  }}
                  onMouseEnter={(e) => { if (!extending[s.id]) e.target.style.color = C.teal; }}
                  onMouseLeave={(e) => { e.target.style.color = extending[s.id] ? C.muted : C.dim; }}
                >{extending[s.id] ? "…" : "+1h"}</button>
              </div>

              {/* Delete */}
              <button
                onClick={() => deleteSession(s.id)}
                disabled={deleting[s.id]}
                title="Expire this session"
                style={{
                  background: "none", border: "none", cursor: deleting[s.id] ? "not-allowed" : "pointer",
                  color: deleting[s.id] ? C.muted : C.dim, fontSize: 16, padding: "4px 6px",
                  borderRadius: 4, transition: "color 0.15s", flexShrink: 0,
                  lineHeight: 1,
                }}
                onMouseEnter={(e) => { if (!deleting[s.id]) e.target.style.color = C.red; }}
                onMouseLeave={(e) => { e.target.style.color = deleting[s.id] ? C.muted : C.dim; }}
              >🗑</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Models tab ─────────────────────────────────────────────────────────────
function NodePip({ url, latency, geo, has }) {
  const label = url.replace(/^https?:\/\//, "");
  const tip = `${label}${latency != null ? ` · ${latency}ms` : ""}${geo?.country ? ` · ${geo.country}` : ""}`;
  return (
    <span title={tip} style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      background: has ? "#0d2a0d" : C.surface,
      border: `1px solid ${has ? "#166534" : C.muted}`,
      borderRadius: 5, padding: "2px 7px",
      fontFamily: mono, fontSize: 10,
      color: has ? C.green : C.muted,
      whiteSpace: "nowrap",
    }}>
      {geo?.flag ? <span style={{ fontSize: 12 }}>{geo.flag}</span> : null}
      <span>{label}</span>
      {has && latency != null && <span style={{ color: C.dim, marginLeft: 2 }}>{latency}ms</span>}
      {!has && <span style={{ color: C.red, marginLeft: 2 }}>missing</span>}
    </span>
  );
}

function ModelsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState({});
  const [syncResult, setSyncResult] = useState({});
  const [sortBy, setSortBy] = useState("availability");

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.models()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function doSync(model) {
    setSyncing((s) => ({ ...s, [model]: true }));
    try {
      const r = await api.sync(model);
      setSyncResult((x) => ({
        ...x, [model]: r.status === "already_synced"
          ? { ok: true, msg: "Already on all nodes." }
          : { ok: true, msg: `Pulling to ${r.targets.length} node(s)…` },
      }));
      if (r.status !== "already_synced") setTimeout(load, 6000);
    } catch (e) {
      setSyncResult((x) => ({ ...x, [model]: { ok: false, msg: e.message } }));
    }
    setSyncing((s) => ({ ...s, [model]: false }));
  }

  if (loading && !data) {
    return <Card><div style={{ fontFamily: mono, fontSize: 12, color: C.muted, padding: "20px 0", textAlign: "center" }}>Querying backends…</div></Card>;
  }
  if (!data) return null;

  const { models, onlineBackendCount } = data;
  const everywhere = models.filter((m) => m.available);
  const partial = models.filter((m) => !m.available && m.presentCount > 0);
  const sortedEverywhere = [...everywhere].sort((a, b) => a.name.localeCompare(b.name));
  const sortedPartial = sortBy === "availability"
    ? [...partial].sort((a, b) => b.presentCount - a.presentCount || a.name.localeCompare(b.name))
    : [...partial].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <StatCard label="TOTAL MODELS" value={models.length} sub="union across all nodes" />
        <StatCard label="ON ALL NODES" value={everywhere.length} color={C.green} sub="fully replicated" />
        <StatCard label="PARTIAL" value={partial.length} color={partial.length > 0 ? C.amber : C.dim} sub={partial.length > 0 ? "some nodes missing" : "none"} />
        <StatCard label="ONLINE NODES" value={onlineBackendCount} />
      </div>

      {/* Sort control */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
        <span style={{ fontFamily: mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em" }}>SORT</span>
        {[["availability", "availability ↓"], ["name", "name A→Z"]].map(([id, label]) => (
          <button key={id} onClick={() => setSortBy(id)} style={{
            background: sortBy === id ? C.blue : "transparent",
            border: `1px solid ${sortBy === id ? C.blue : C.border}`,
            color: sortBy === id ? "#fff" : C.dim,
            borderRadius: 5, padding: "2px 9px", cursor: "pointer",
            fontFamily: mono, fontSize: 11, transition: "all 0.12s",
          }}>{label}</button>
        ))}
      </div>

      {/* Note about union behaviour */}
      <Card style={{ borderColor: "#1a2a3a", padding: "12px 16px" }}>
        <div style={{ fontFamily: mono, fontSize: 12, color: C.dim, lineHeight: 1.8 }}>
          <span style={{ color: C.bright }}>All models are advertised to clients</span> — the LB returns the union of every node's models via{" "}
          <span style={{ color: C.teal }}>/api/tags</span>. When a client requests a model, the LB routes only to nodes that have it,
          and pins that client's conversation to the same node for up to 2 hours.
          Partial models are available now but only served from nodes that have them.
        </div>
      </Card>

      {/* Fully available */}
      {everywhere.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Pulse color={C.green} />
            <span style={{ fontFamily: mono, fontSize: 11, color: C.green, letterSpacing: "0.1em" }}>ON ALL NODES</span>
            <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>({everywhere.length})</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {sortedEverywhere.map((m) => (
              <div key={m.name} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", background: C.panel,
                border: `1px solid ${C.border}`, borderRadius: 8,
              }}>
                <span style={{ fontFamily: mono, fontSize: 13, color: C.bright, fontWeight: 500, flex: 1 }}>{m.name}</span>
                {fmtSize(m.size) && <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>{fmtSize(m.size)}</span>}
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {m.presentOn.map((b, i) => <NodePip key={i} {...b} has />)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Partial */}
      {partial.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Pulse color={C.amber} />
            <span style={{ fontFamily: mono, fontSize: 11, color: C.amber, letterSpacing: "0.1em" }}>PARTIAL — not on all nodes</span>
            <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>({partial.length})</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sortedPartial.map((m) => {
              const res = syncResult[m.name];
              return (
                <div key={m.name} style={{
                  background: C.surface, border: `1px solid #3a2e0a`,
                  borderRadius: 10, overflow: "hidden",
                }}>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "11px 14px", borderBottom: `1px solid #2a2200`,
                  }}>
                    <span style={{ fontFamily: mono, fontSize: 13, color: C.bright, fontWeight: 600, flex: 1 }}>{m.name}</span>
                    {fmtSize(m.size) && <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>{fmtSize(m.size)}</span>}
                    <span style={{ fontFamily: mono, fontSize: 11, color: C.amber }}>{m.presentCount}/{onlineBackendCount} nodes</span>
                  </div>
                  <div style={{ padding: "12px 14px", display: "flex", gap: 16, alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: mono, fontSize: 11, color: C.amber, marginBottom: 8 }}>
                        Available from {m.presentCount} node{m.presentCount !== 1 ? "s" : ""}, but {m.missingOn.length} node{m.missingOn.length !== 1 ? "s are" : " is"} missing it.
                        Requests will only go to nodes that have it.
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {m.presentOn.map((b, i) => <NodePip key={i} {...b} has />)}
                        {m.missingOn.map((b, i) => <NodePip key={i} {...b} has={false} />)}
                      </div>
                      {res && (
                        <div style={{ marginTop: 8, fontFamily: mono, fontSize: 11, color: res.ok ? C.teal : C.red }}>
                          {res.ok ? "↑ " : "✗ "}{res.msg}
                        </div>
                      )}
                    </div>
                    <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                      <Btn variant="sync" onClick={() => doSync(m.name)} disabled={syncing[m.name]}>
                        {syncing[m.name] ? "pulling…" : `↓ Pull to ${m.missingOn.length} missing node${m.missingOn.length !== 1 ? "s" : ""}`}
                      </Btn>
                      <span style={{ fontFamily: mono, fontSize: 10, color: C.muted, textAlign: "right", maxWidth: 180, lineHeight: 1.5 }}>
                        Fully replicated models route to any node.
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {models.length === 0 && (
        <Card>
          <div style={{ fontFamily: mono, fontSize: 12, color: C.muted, textAlign: "center", padding: "30px 0" }}>
            No models found. Pull one to get started:
            <pre style={{ marginTop: 12, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 16px", color: "#86efac", fontSize: 12, display: "inline-block" }}>
              OLLAMA_HOST=http://localhost:11434 ollama pull llama3
            </pre>
          </div>
        </Card>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {partial.length > 0 && (
          <Btn variant="warn" small onClick={() => partial.forEach((m) => doSync(m.name))} disabled={partial.some((m) => syncing[m.name])}>
            Pull all partial to all nodes
          </Btn>
        )}
        <Btn small onClick={load} disabled={loading}>{loading ? "…" : "↺ refresh"}</Btn>
      </div>
    </div>
  );
}

// ── Logs tab ───────────────────────────────────────────────────────────────
function LogRow({ entry }) {
  const sc = entry.status >= 200 && entry.status < 300 ? C.green : entry.status >= 400 ? C.red : C.amber;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0", borderBottom: `1px solid #0a0f1a`, fontSize: 11, fontFamily: mono }}>
      <span style={{ color: C.muted, width: 76, flexShrink: 0, fontSize: 10 }}>{new Date(entry.time).toLocaleTimeString()}</span>
      <span style={{ color: sc, width: 32, flexShrink: 0 }}>{entry.status || "—"}</span>
      <span style={{ color: C.dim, width: 46, flexShrink: 0 }}>{entry.method}</span>
      <span style={{ color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {entry.path}
        {entry.note && <span style={{ color: C.purple, marginLeft: 6 }}>({entry.note})</span>}
      </span>
      {entry.backend && <>
        <span style={{ color: C.muted }}>→</span>
        <span style={{ color: C.blue, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entry.backend.replace(/^https?:\/\//, "")}
        </span>
      </>}
      {entry.latency != null && <span style={{ color: C.purple, flexShrink: 0, width: 52, textAlign: "right" }}>{entry.latency}ms</span>}
    </div>
  );
}


// ── Discover tab (Shodan) ──────────────────────────────────────────────────
const DEFAULT_SHODAN_QUERY = '"ollama is running" -org:"Amazon" -org:"Amazon.com, Inc." -org:"Amazon"';

function DiscoverTab({ onAddBackend, existingUrls }) {
  const [apiKey, setApiKey]   = useState(() => localStorage.getItem("shodan_api_key") || "");
  const [query, setQuery]     = useState(DEFAULT_SHODAN_QUERY);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]     = useState(null);
  const [adding, setAdding]   = useState({});
  const [added, setAdded]     = useState({});
  const [pingStatus, setPingStatus] = useState({});
  const [page, setPage]       = useState(1);
  const [countryFilter, setCountryFilter] = useState("");

  function saveKey(k) {
    setApiKey(k);
    if (k) localStorage.setItem("shodan_api_key", k);
    else localStorage.removeItem("shodan_api_key");
  }

  async function runSearch() {
    if (!apiKey.trim()) { setError("Enter your Shodan API key first."); return; }
    setLoading(true); setError(null); setResults(null);
    setPingStatus({}); setAdded({}); setPage(1); setCountryFilter("");
    try {
      const data = await api.shodan(apiKey.trim(), query.trim() || DEFAULT_SHODAN_QUERY, 20, 1);
      setResults(data);
      // Ping all discovered instances in background
      data.results.forEach((r) => pingInstance(r.url, r.ip));
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  async function loadMore() {
    if (loadingMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const data = await api.shodan(apiKey.trim(), query.trim() || DEFAULT_SHODAN_QUERY, 20, nextPage);
      setResults((prev) => ({
        ...data,
        results: [...prev.results, ...data.results]
      }));
      setPage(nextPage);
      data.results.forEach((r) => pingInstance(r.url, r.ip));
    } catch (e) {
      setError(e.message);
    }
    setLoadingMore(false);
  }

  async function pingInstance(url, key) {
    setPingStatus((p) => ({ ...p, [key]: "checking" }));
    try {
      const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        setPingStatus((p) => ({ ...p, [key]: { online: true, version: data.version } }));
      } else {
        setPingStatus((p) => ({ ...p, [key]: { online: false } }));
      }
    } catch {
      setPingStatus((p) => ({ ...p, [key]: { online: false } }));
    }
  }

  async function addNode(result) {
    setAdding((a) => ({ ...a, [result.ip]: true }));
    try {
      await onAddBackend(result.url);
      setAdded((a) => ({ ...a, [result.ip]: true }));
    } catch {}
    setAdding((a) => ({ ...a, [result.ip]: false }));
  }

  const alreadyAdded = (url) => existingUrls.includes(url);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* API key + query */}
      <Card>
        <SectionLabel>SHODAN DISCOVERY</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* API key row */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, whiteSpace: "nowrap", width: 72 }}>API KEY</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => saveKey(e.target.value)}
              placeholder="Your Shodan API key"
              style={{ flex: 1, background: C.panel, border: `1px solid ${C.borderBright}`, color: C.white, borderRadius: 6, padding: "7px 12px", fontFamily: mono, fontSize: 13, outline: "none" }}
            />
            <a href="https://account.shodan.io/" target="_blank" rel="noopener noreferrer"
              style={{ fontFamily: mono, fontSize: 11, color: C.blue, whiteSpace: "nowrap", textDecoration: "none" }}>
              Get key ↗
            </a>
          </div>

          {/* Query row */}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, whiteSpace: "nowrap", width: 72, paddingTop: 8 }}>QUERY</span>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={2}
              style={{ flex: 1, background: C.panel, border: `1px solid ${C.borderBright}`, color: C.teal, borderRadius: 6, padding: "7px 12px", fontFamily: mono, fontSize: 12, outline: "none", resize: "vertical", lineHeight: 1.6 }}
            />
            <button onClick={() => setQuery(DEFAULT_SHODAN_QUERY)}
              title="Reset to default query"
              style={{ background: "none", border: `1px solid ${C.border}`, color: C.dim, borderRadius: 5, padding: "7px 10px", cursor: "pointer", fontFamily: mono, fontSize: 11, whiteSpace: "nowrap", alignSelf: "flex-start" }}>
              reset
            </button>
          </div>

          {/* Warning */}
          <div style={{ fontFamily: mono, fontSize: 11, color: "#92400e", background: "#1a1100", border: "1px solid #3a2800", borderRadius: 6, padding: "8px 12px", lineHeight: 1.7 }}>
            ⚠ These are <strong style={{ color: C.amber }}>publicly exposed</strong> Ollama instances found on the open internet.
            Only add nodes you own or have explicit permission to use. Ping status is checked automatically.
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="primary" onClick={runSearch} disabled={loading}>
              {loading ? "Searching…" : "🔍 Search Shodan"}
            </Btn>
          </div>
        </div>
      </Card>

      {/* Error */}
      {error && (
        <div style={{ background: "#1a0606", border: "1px solid #5a1515", borderRadius: 8, padding: "12px 14px", fontFamily: mono, fontSize: 12, color: C.red }}>
          ✗ {error}
        </div>
      )}

      {/* Results */}
      {results && (() => {
        const countries = [...new Set(results.results.map((r) => r.country).filter(Boolean))].sort();
        const displayResults = countryFilter
          ? results.results.filter((r) => r.country === countryFilter)
          : results.results;
        return (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: mono, fontSize: 11, color: C.muted, letterSpacing: "0.08em" }}>
              RESULTS — {countryFilter
                ? `${displayResults.length} in ${countryFilter} · ${results.total.toLocaleString()} total`
                : `showing ${results.results.length} of ${results.total.toLocaleString()} total matches`}
            </span>
            {countries.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                <span style={{ fontFamily: mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em" }}>COUNTRY</span>
                <select
                  value={countryFilter}
                  onChange={(e) => setCountryFilter(e.target.value)}
                  style={{ background: C.panel, border: `1px solid ${C.border}`, color: C.text, borderRadius: 5, padding: "3px 8px", fontFamily: mono, fontSize: 11, cursor: "pointer", outline: "none" }}
                >
                  <option value="">All ({results.results.length})</option>
                  {countries.map((c) => {
                    const count = results.results.filter((r) => r.country === c).length;
                    const flag = results.results.find((r) => r.country === c)?.flag || "";
                    return <option key={c} value={c}>{flag} {c} ({count})</option>;
                  })}
                </select>
                {countryFilter && (
                  <button onClick={() => setCountryFilter("")} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 14, padding: "2px 4px", lineHeight: 1 }}>✕</button>
                )}
              </div>
            )}
          </div>

          {displayResults.length === 0 ? (
            <Card>
              <div style={{ fontFamily: mono, fontSize: 12, color: C.muted, textAlign: "center", padding: "20px 0" }}>
                No results found for this query.
              </div>
            </Card>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {displayResults.map((r) => {
                const ping = pingStatus[r.ip];
                const isOnline  = ping?.online === true;
                const isOffline = ping?.online === false;
                const isChecking = ping === "checking";
                const already = alreadyAdded(r.url) || added[r.ip];

                const pingColor  = isOnline ? C.green : isOffline ? C.red : isChecking ? C.amber : C.muted;
                const pingLabel  = isOnline ? "online" : isOffline ? "unreachable" : isChecking ? "pinging…" : "not pinged";

                return (
                  <div key={r.ip} style={{
                    background: C.panel,
                    border: `1px solid ${isOnline ? "#166534" : isOffline ? "#3f1515" : C.border}`,
                    borderRadius: 10, overflow: "hidden",
                    opacity: isOffline ? 0.65 : 1,
                    transition: "border-color 0.3s",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>

                      {/* Ping dot */}
                      <Pulse color={pingColor} size={9} />

                      {/* Flag + IP */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                          {r.flag && <span style={{ fontSize: 18, lineHeight: 1 }}>{r.flag}</span>}
                          <a
                            href={r.shodanUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontFamily: mono, fontSize: 14, color: C.blue, fontWeight: 600, textDecoration: "none" }}
                            title="View on Shodan"
                          >
                            {r.ip}
                          </a>
                          <span style={{ fontFamily: mono, fontSize: 11, color: C.muted }}>:{r.port}</span>
                          {r.ollamaVersion && (
                            <span style={{ fontFamily: mono, fontSize: 10, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 6px" }}>
                              v{r.ollamaVersion}
                            </span>
                          )}
                          {ping?.version && !r.ollamaVersion && (
                            <span style={{ fontFamily: mono, fontSize: 10, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 6px" }}>
                              v{ping.version}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                          {r.country && (
                            <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>{r.country}</span>
                          )}
                          {r.org && (
                            <span style={{ fontFamily: mono, fontSize: 11, color: C.muted }}>· {r.org}</span>
                          )}
                          {r.hostnames.length > 0 && (
                            <span style={{ fontFamily: mono, fontSize: 11, color: C.muted }}>· {r.hostnames[0]}</span>
                          )}
                          {r.timestamp && (
                            <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>
                              seen {new Date(r.timestamp).toLocaleDateString()}
                            </span>
                          )}
                          <span style={{ fontFamily: mono, fontSize: 10, color: pingColor }}>
                            {pingLabel}
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
                        <button
                          onClick={() => pingInstance(r.url, r.ip)}
                          disabled={isChecking}
                          style={{ background: "none", border: `1px solid ${C.border}`, color: C.dim, borderRadius: 5, padding: "4px 10px", cursor: isChecking ? "not-allowed" : "pointer", fontFamily: mono, fontSize: 11 }}>
                          {isChecking ? "…" : "ping"}
                        </button>
                        <Btn
                          variant={already ? "success" : isOffline ? "ghost" : "primary"}
                          small
                          disabled={already || adding[r.ip]}
                          onClick={() => addNode(r)}
                          title={already ? "Already added" : isOffline ? "Node appears unreachable — add anyway?" : "Add to load balancer"}
                        >
                          {already ? "✓ added" : adding[r.ip] ? "adding…" : "+ Add node"}
                        </Btn>
                      </div>
                    </div>

                    {/* Banner snippet */}
                    {r.raw && (
                      <div style={{ borderTop: `1px solid ${C.border}`, padding: "8px 14px" }}>
                        <pre style={{ margin: 0, fontFamily: mono, fontSize: 10, color: C.muted, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 60, overflow: "hidden" }}>
                          {r.raw}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}

              {results.results.length < results.total && (
                <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
                  <Btn onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? "Loading more…" : "Load more results"}
                  </Btn>
                </div>
              )}
            </div>
          )}
        </div>
        );
      })()}
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
const STRATEGIES = ["round-robin", "least-busy", "random"];

export default function App() {
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [tab, setTab] = useState("backends");
  const [newUrl, setNewUrl] = useState("http://");
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState({});
  const [adding, setAdding] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [editingVersion, setEditingVersion] = useState(false);
  const [versionInput, setVersionInput] = useState("");
  const logRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try { setStatus(await api.status()); setError(null); }
    catch (e) { setError("Cannot reach proxy: " + e.message); }
  }, []);

  const fetchLogs = useCallback(async () => {
    try { setLogs(await api.logs(300)); } catch {}
  }, []);

  useEffect(() => {
    fetchStatus(); fetchLogs();
    const t = setInterval(() => { fetchStatus(); if (tab === "logs") fetchLogs(); }, 3000);
    return () => clearInterval(t);
  }, [fetchStatus, fetchLogs, tab]);

  useEffect(() => { if (tab === "logs") fetchLogs(); }, [tab, fetchLogs]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  async function addBackend() {
    const url = newUrl.trim().replace(/\/$/, "");
    if (!url || url === "http://" || url === "https://") return;
    setAdding(true);
    try { await api.addBackend(url); setNewUrl("http://"); await fetchStatus(); }
    catch (e) { setError(e.message); }
    setAdding(false);
  }

  async function removeBackend(id) {
    try { await api.removeBackend(id); await fetchStatus(); } catch (e) { setError(e.message); }
  }

  async function toggleBackend(id, enabled) {
    try { await api.toggleBackend(id, enabled); await fetchStatus(); } catch (e) { setError(e.message); }
  }

  async function checkBackend(id) {
    setChecking((c) => ({ ...c, [id]: true }));
    try { await api.checkBackend(id); await fetchStatus(); } catch (e) { setError(e.message); }
    setChecking((c) => ({ ...c, [id]: false }));
  }

  async function checkAll() {
    setCheckingAll(true);
    try { await api.checkAll(); await fetchStatus(); } catch (e) { setError(e.message); }
    setCheckingAll(false);
  }

  async function setStrategy(s) {
    try { await api.setStrategy(s); await fetchStatus(); } catch (e) { setError(e.message); }
  }

  async function saveVersion(v) {
    try { await api.updateVersion(v || null); await fetchStatus(); } catch (e) { setError(e.message); }
    setEditingVersion(false);
  }

  const backends = status?.backends || [];
  const onlineCount = backends.filter((b) => b.enabled && b.status === "online").length;
  const enabledCount = backends.filter((b) => b.enabled).length;
  const totalReq = status?.stats?.totalRequests || 0;
  const totalErr = status?.stats?.totalErrors || 0;

  const tabs = [
    { id: "backends", label: "Backends" },
    { id: "models",   label: "Models" },
    { id: "sessions", label: "Sessions" },
    { id: "discover", label: "Discover" },
    { id: "logs",     label: `Logs${logs.length > 0 ? ` (${logs.length})` : ""}` },
    { id: "config",   label: "Config" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.bright, fontFamily: sans }}>

      {/* Header */}
      <header style={{
        borderBottom: `1px solid ${C.border}`, padding: "0 28px",
        display: "flex", alignItems: "center", gap: 16, height: 54,
        background: C.bg, position: "sticky", top: 0, zIndex: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginRight: 8 }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: `linear-gradient(135deg,${C.blue},#6366f1)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>⚖</div>
          <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: C.white, letterSpacing: "0.05em" }}>
            ollama<span style={{ color: C.blue }}>-lb</span>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: C.muted, fontSize: 10, fontFamily: mono, letterSpacing: "0.1em" }}>STRATEGY</span>
          {STRATEGIES.map((s) => (
            <button key={s} onClick={() => setStrategy(s)} style={{
              background: status?.strategy === s ? C.blue : "transparent",
              border: `1px solid ${status?.strategy === s ? C.blue : C.border}`,
              color: status?.strategy === s ? "#fff" : C.dim,
              borderRadius: 5, padding: "2px 9px", cursor: "pointer",
              fontFamily: mono, fontSize: 11, transition: "all 0.12s",
            }}>{s}</button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Emulated version chip */}
        {status && !editingVersion && (
          <div
            onClick={() => { setEditingVersion(true); setVersionInput(status?.emulatedVersion || ""); }}
            title="Set the Ollama version this proxy reports to clients"
            style={{ display: "flex", alignItems: "center", gap: 5, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}
          >
            <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>ollama</span>
            <span style={{ fontFamily: mono, fontSize: 12, color: status?.emulatedVersion ? C.teal : C.dim }}>
              {status?.emulatedVersion ? `v${status.emulatedVersion}` : "auto"}
            </span>
            <span style={{ fontSize: 10, color: C.muted }}>✎</span>
          </div>
        )}
        {editingVersion && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>ollama</span>
            <input
              autoFocus
              value={versionInput}
              onChange={(e) => setVersionInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveVersion(versionInput); if (e.key === "Escape") setEditingVersion(false); }}
              placeholder="e.g. 0.6.8"
              style={{ width: 90, background: C.panel, border: `1px solid ${C.blue}`, color: C.white, borderRadius: 5, padding: "3px 8px", fontFamily: mono, fontSize: 12, outline: "none" }}
            />
            <Btn small onClick={() => saveVersion(versionInput)}>set</Btn>
            <Btn small variant="ghost" onClick={() => saveVersion(null)}>auto</Btn>
            <Btn small variant="danger" onClick={() => setEditingVersion(false)}>✕</Btn>
          </div>
        )}

        {status && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 12px" }}>
            <Pulse color={onlineCount > 0 ? C.green : enabledCount > 0 ? C.red : C.muted} />
            <span style={{ fontFamily: mono, fontSize: 12, color: C.dim }}>
              <span style={{ color: onlineCount > 0 ? C.green : C.red }}>{onlineCount}</span>/{enabledCount} online
            </span>
          </div>
        )}

        {error && (
          <div style={{ background: "#1a0606", border: `1px solid #5a1515`, borderRadius: 6, padding: "4px 12px", fontFamily: mono, fontSize: 11, color: C.red }}>
            ⚠ {error}
          </div>
        )}
      </header>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, padding: "0 28px", background: C.bg }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: "none", border: "none",
            borderBottom: tab === t.id ? `2px solid ${C.blue}` : "2px solid transparent",
            color: tab === t.id ? C.bright : C.dim,
            padding: "10px 16px", cursor: "pointer", fontFamily: mono, fontSize: 13, marginBottom: -1, transition: "color 0.12s",
          }}>{t.label}</button>
        ))}
      </div>

      <main style={{ maxWidth: 980, margin: "0 auto", padding: "24px 28px" }}>

        {/* BACKENDS */}
        {tab === "backends" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <StatCard label="BACKENDS" value={backends.length} />
              <StatCard label="ONLINE" value={onlineCount} color={onlineCount > 0 ? C.green : C.red} />
              <StatCard label="REQUESTS" value={totalReq.toLocaleString()} />
              <StatCard label="ERRORS" value={totalErr} color={totalErr > 0 ? C.red : C.dim}
                sub={totalReq > 0 ? `${((totalErr / totalReq) * 100).toFixed(1)}%` : null} />
            </div>
            <Card>
              <SectionLabel>ADD BACKEND</SectionLabel>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addBackend()}
                  placeholder="http://192.168.1.10:11434"
                  style={{ flex: 1, background: C.panel, border: `1px solid ${C.borderBright}`, color: C.white, borderRadius: 6, padding: "8px 12px", fontFamily: mono, fontSize: 13, outline: "none" }}
                />
                <Btn variant="primary" onClick={addBackend} disabled={adding}>{adding ? "Adding…" : "+ Add"}</Btn>
              </div>
            </Card>
            <Card style={{ padding: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: backends.length > 0 ? `1px solid ${C.border}` : "none" }}>
                <SectionLabel style={{ margin: 0 }}>{backends.length} BACKEND{backends.length !== 1 ? "S" : ""}</SectionLabel>
                <Btn small onClick={checkAll} disabled={checkingAll || backends.length === 0}>{checkingAll ? "checking…" : "check all"}</Btn>
              </div>
              {backends.length === 0
                ? <div style={{ padding: "40px 20px", textAlign: "center", fontFamily: mono, fontSize: 12, color: C.muted }}>No backends configured.</div>
                : <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px" }}>
                    {backends.map((b) => (
                      <BackendRow key={b.id} backend={b}
                        onRemove={removeBackend} onToggle={toggleBackend}
                        onCheck={checkBackend} checking={checking[b.id]} />
                    ))}
                  </div>
              }
            </Card>
          </div>
        )}

        {tab === "models"   && <ModelsTab />}
        {tab === "sessions" && <SessionsTab />}
        {tab === "discover" && <DiscoverTab onAddBackend={async (url) => { try { await api.addBackend(url); await fetchStatus(); } catch(e) { setError(e.message); } }} existingUrls={backends.map(b => b.url)} />}

        {/* LOGS */}
        {tab === "logs" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: mono, fontSize: 11, color: C.muted, letterSpacing: "0.1em" }}>
                LIVE ACCESS LOG · {logs.length} entries · auto-refresh 3s
              </span>
              <Btn small onClick={fetchLogs}>↺ refresh</Btn>
            </div>
            <Card style={{ padding: "10px 14px" }}>
              <div style={{ display: "flex", gap: 10, padding: "0 0 6px", borderBottom: `1px solid ${C.border}`, fontSize: 9, fontFamily: mono, color: C.muted, letterSpacing: "0.1em" }}>
                <span style={{ width: 76 }}>TIME</span>
                <span style={{ width: 32 }}>CODE</span>
                <span style={{ width: 46 }}>METHOD</span>
                <span style={{ flex: 1 }}>PATH</span>
                <span style={{ width: 180 }}>BACKEND</span>
                <span style={{ width: 52, textAlign: "right" }}>LATENCY</span>
              </div>
              <div ref={logRef} style={{ maxHeight: "60vh", overflowY: "auto", paddingTop: 4 }}>
                {logs.length === 0
                  ? <div style={{ fontFamily: mono, fontSize: 12, color: C.muted, padding: "20px 0" }}>No requests yet…</div>
                  : logs.map((e, i) => <LogRow key={e.id ?? i} entry={e} />)}
              </div>
            </Card>
          </div>
        )}

        {/* CONFIG */}
        {tab === "config" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Card>
              <SectionLabel>LIVE CONFIG</SectionLabel>
              <pre style={{ margin: 0, color: C.teal, fontFamily: mono, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 300, overflowY: "auto" }}>
                {status ? JSON.stringify({ strategy: status.strategy, backends: status.backends?.map(({ activeRequests, ...b }) => b) }, null, 2) : "Loading…"}
              </pre>
            </Card>
            <Card>
              <SectionLabel>USAGE</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { label: "ollama CLI", code: `OLLAMA_HOST=http://localhost:11434 ollama run llama3` },
                  { label: "Python", code: `import ollama\nclient = ollama.Client(host="http://localhost:11434")\nresp = client.chat(model="llama3", messages=[{"role":"user","content":"hi"}])` },
                  { label: "curl", code: `curl http://localhost:11434/api/tags` },
                ].map(({ label, code }) => (
                  <div key={label}>
                    <div style={{ fontFamily: mono, fontSize: 10, color: C.dim, letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
                    <pre style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", color: "#86efac", fontFamily: mono, fontSize: 12, margin: 0, whiteSpace: "pre-wrap" }}>{code}</pre>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </main>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
        input:focus { border-color: ${C.blue} !important; }
      `}</style>
    </div>
  );
}
