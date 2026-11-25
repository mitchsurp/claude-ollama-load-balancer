import { useState, useEffect, useCallback } from "react";
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

function Pulse({ color, size = 9, pulse = false }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size, borderRadius: "50%",
      background: color, flexShrink: 0,
      boxShadow: color === C.green || pulse ? `0 0 0 2px ${C.bg}, 0 0 10px ${color}aa` : "none",
      animation: pulse ? "mPulse 1.1s infinite ease-in-out" : "none",
    }} />
  );
}

function fmtRelative(ts) {
  if (!ts) return "—";
  const diff = Math.max(0, Date.now() - new Date(ts).getTime());
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function fmtCountdown(ms) {
  if (!ms || ms <= 0) return "expired";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function cleanHost(url) {
  if (!url) return "—";
  return url.replace(/^https?:\/\//, "");
}

export default function MobileApp() {
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState("overview"); // "overview" | "nodes"
  const [nodeFilter, setNodeFilter] = useState("all"); // "all" | "online" | "busy" | "offline"
  const [peekSessionId, setPeekSessionId] = useState(null);
  const [peekTab, setPeekTab] = useState("live"); // "live" | "prompt" | "history"
  const [error, setError] = useState(null);
  const [, setTick] = useState(0);

  const loadAll = useCallback(async () => {
    try {
      const [st, sess, lg] = await Promise.all([
        api.status(),
        api.sessions(),
        api.logs(40),
      ]);
      setStatus(st);
      setSessions(sess || []);
      setLogs(lg || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 1500);
    return () => clearInterval(id);
  }, [loadAll]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const backends = status?.backends || [];
  const enabledBackends = backends.filter((b) => b.enabled);
  const onlineBackends = enabledBackends.filter((b) => b.status === "online");
  const offlineBackends = enabledBackends.filter((b) => b.status !== "online");
  const busyBackends = backends.filter((b) => (b.activeRequests || 0) > 0);
  const totalActiveReqs = backends.reduce((sum, b) => sum + (b.activeRequests || 0), 0);

  const busySessions = sessions.filter((s) => (s.activeCount || 0) > 0 || s.lastActivity?.status === "streaming");
  const uniqueClients = [...new Set(sessions.map((s) => s.clientIp))];

  const peekSession = sessions.find((s) => s.id === peekSessionId) || null;

  const filteredNodes = backends
    .slice()
    .sort((a, b) => (b.activeRequests || 0) - (a.activeRequests || 0) || (a.status === "online" ? -1 : 1))
    .filter((b) => {
      if (nodeFilter === "online") return b.enabled && b.status === "online";
      if (nodeFilter === "busy") return (b.activeRequests || 0) > 0;
      if (nodeFilter === "offline") return !b.enabled || b.status !== "online";
      return true;
    });

  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: C.bright,
      fontFamily: sans, paddingBottom: 76, WebkitTapHighlightColor: "transparent",
    }}>
      {/* Sticky Top App Bar */}
      <header style={{
        position: "sticky", top: 0, zIndex: 30,
        background: "#020810ee", backdropFilter: "blur(10px)",
        borderBottom: `1px solid ${C.border}`,
        padding: "12px 16px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: `linear-gradient(135deg, ${C.blue}, #6366f1)`,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15,
          }}>⚖</div>
          <div>
            <div style={{ fontFamily: mono, fontSize: 14, fontWeight: 700, color: C.white, lineHeight: 1.1 }}>
              ollama<span style={{ color: C.blue }}>-lb</span>
              <span style={{
                marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 4,
                background: C.panel, border: `1px solid ${C.border}`, color: C.teal, verticalAlign: "middle",
              }}>LIVE</span>
            </div>
            <div style={{ fontFamily: mono, fontSize: 10, color: C.dim, marginTop: 2 }}>
              {status?.strategy || "least-busy"} · {status?.stats?.totalRequests?.toLocaleString() || 0} reqs
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {totalActiveReqs > 0 ? (
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "#2d1a0066", border: `1px solid ${C.amber}`,
              borderRadius: 20, padding: "4px 10px",
            }}>
              <Pulse color={C.amber} size={8} pulse />
              <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, color: C.amber }}>
                {totalActiveReqs} BUSY
              </span>
            </div>
          ) : (
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 20, padding: "4px 10px",
            }}>
              <Pulse color={onlineBackends.length > 0 ? C.green : C.red} size={8} />
              <span style={{ fontFamily: mono, fontSize: 11, color: C.text }}>
                {onlineBackends.length}/{enabledBackends.length} up
              </span>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div style={{
          margin: "10px 14px 0", padding: "10px 12px", borderRadius: 8,
          background: "#1a0606", border: "1px solid #5a1515",
          fontFamily: mono, fontSize: 11, color: C.red,
        }}>
          ⚠ {error}
        </div>
      )}

      {/* Main Content Container */}
      <main style={{ padding: "14px", maxWidth: 600, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Top 4 Summary KPI Pills (Always visible) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          <div onClick={() => { setPage("nodes"); setNodeFilter("online"); }} style={{
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 8px", textAlign: "center", cursor: "pointer",
          }}>
            <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 700, color: C.green }}>{onlineBackends.length}</div>
            <div style={{ fontFamily: mono, fontSize: 9, color: C.dim, marginTop: 2 }}>ONLINE</div>
          </div>

          <div onClick={() => { setPage("nodes"); setNodeFilter("offline"); }} style={{
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 8px", textAlign: "center", cursor: "pointer",
          }}>
            <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 700, color: offlineBackends.length > 0 ? C.red : C.dim }}>{offlineBackends.length}</div>
            <div style={{ fontFamily: mono, fontSize: 9, color: C.dim, marginTop: 2 }}>OFFLINE</div>
          </div>

          <div onClick={() => setPage("overview")} style={{
            background: totalActiveReqs > 0 ? "#1f1200" : C.surface,
            border: `1px solid ${totalActiveReqs > 0 ? C.amber : C.border}`,
            borderRadius: 10, padding: "10px 8px", textAlign: "center", cursor: "pointer",
          }}>
            <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 700, color: totalActiveReqs > 0 ? C.amber : C.white }}>{totalActiveReqs}</div>
            <div style={{ fontFamily: mono, fontSize: 9, color: totalActiveReqs > 0 ? C.amber : C.dim, marginTop: 2 }}>ANSWERING</div>
          </div>

          <div onClick={() => setPage("overview")} style={{
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 8px", textAlign: "center", cursor: "pointer",
          }}>
            <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 700, color: sessions.length > 0 ? C.blue : C.dim }}>{sessions.length}</div>
            <div style={{ fontFamily: mono, fontSize: 9, color: C.dim, marginTop: 2 }}>SESSIONS</div>
          </div>
        </div>

        {/* ── PAGE 1: LIVE ACTIVITY & SESSIONS ───────────────────────────── */}
        {page === "overview" && (
          <>
            {/* Busy / Answering Banner if any node is currently answering */}
            {busyBackends.length > 0 && (
              <div style={{
                background: "linear-gradient(180deg, #1e1304 0%, #0f172a 100%)",
                border: `1px solid ${C.amber}`, borderRadius: 12, padding: 12,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <Pulse color={C.amber} size={9} pulse />
                  <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, color: C.amber, letterSpacing: "0.08em" }}>
                    NODES BUSY ANSWERING ({busyBackends.length})
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {busyBackends.map((b) => {
                    const nodeSess = sessions.find((s) => s.backendId === b.id && (s.activeCount > 0 || s.lastActivity?.status === "streaming"));
                    return (
                      <div key={b.id} onClick={() => nodeSess && setPeekSessionId(nodeSess.id)} style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        background: "#090d16", border: `1px solid ${C.borderBright}`, borderRadius: 8, padding: "8px 10px",
                        cursor: nodeSess ? "pointer" : "default",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          {b.geo?.flag && <span style={{ fontSize: 16 }}>{b.geo.flag}</span>}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontFamily: mono, fontSize: 12, color: C.white, fontWeight: 600 }}>
                              {cleanHost(b.url)}
                            </div>
                            {nodeSess && (
                              <div style={{ fontFamily: mono, fontSize: 10, color: C.teal }}>
                                {nodeSess.model} · {nodeSess.clientIp}
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{
                            fontFamily: mono, fontSize: 10, background: "#2d1a00",
                            border: `1px solid ${C.amber}`, color: C.amber, padding: "2px 7px", borderRadius: 5,
                          }}>
                            {b.activeRequests} active
                          </span>
                          {nodeSess && (
                            <span style={{ fontFamily: mono, fontSize: 11, color: C.blue, fontWeight: 600 }}>
                              Peek →
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Connected Clients & Active Sessions */}
            <div style={{
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em" }}>
                  CLIENT SESSIONS ({sessions.length}) · {uniqueClients.length} CLIENT{uniqueClients.length !== 1 ? "S" : ""}
                </div>
                <span style={{ fontFamily: mono, fontSize: 10, color: C.dim }}>tap to peek</span>
              </div>

              {sessions.length === 0 ? (
                <div style={{
                  padding: "24px 12px", textAlign: "center",
                  fontFamily: mono, fontSize: 12, color: C.muted, lineHeight: 1.7,
                }}>
                  No active client sessions right now.<br />
                  <span style={{ fontSize: 10, color: C.dim }}>
                    When a client connects and runs a model, live thought & response streams will appear here.
                  </span>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {sessions.map((s) => {
                    const isBusy = (s.activeCount || 0) > 0 || s.lastActivity?.status === "streaming";
                    const act = s.lastActivity;
                    const backend = backends.find((b) => b.id === s.backendId);
                    const hasPeekData = Boolean(act && (act.prompt || act.thinking || act.response || (act.messages && act.messages.length)));

                    return (
                      <div
                        key={s.id}
                        onClick={() => setPeekSessionId(s.id)}
                        style={{
                          background: C.panel,
                          border: `1px solid ${isBusy ? C.amber : C.borderBright}`,
                          borderRadius: 10, padding: 12, cursor: "pointer",
                          transition: "border-color 0.2s",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                            <Pulse color={isBusy ? C.amber : C.green} size={8} pulse={isBusy} />
                            <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: C.white, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {s.model}
                            </span>
                          </div>
                          <span style={{
                            fontFamily: mono, fontSize: 10, padding: "2px 7px", borderRadius: 4,
                            background: isBusy ? "#2d1a00" : "#0c2e1a",
                            border: `1px solid ${isBusy ? C.amber : "#166534"}`,
                            color: isBusy ? C.amber : C.green, fontWeight: 600, flexShrink: 0,
                          }}>
                            {isBusy ? "⚡ ANSWERING" : `IDLE · ${fmtCountdown(s.ttlMs)}`}
                          </span>
                        </div>

                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontFamily: mono, fontSize: 11, color: C.dim, marginBottom: act ? 8 : 0 }}>
                          <span>Client: <strong style={{ color: C.blue }}>{s.clientIp.replace(/^::ffff:/, "")}</strong></span>
                          <span>Node: <strong style={{ color: C.text }}>{backend?.geo?.flag || ""} {cleanHost(s.backendUrl)}</strong></span>
                          <span>Seen: {fmtRelative(s.lastSeenAt)}</span>
                        </div>

                        {/* Live Inline Preview of Request / Thought / Response */}
                        {act && (
                          <div style={{
                            background: C.bg, border: `1px solid ${C.border}`,
                            borderRadius: 8, padding: "8px 10px", marginTop: 6,
                            display: "flex", flexDirection: "column", gap: 6,
                          }}>
                            {act.prompt && (
                              <div style={{ fontFamily: mono, fontSize: 11, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                <span style={{ color: C.blue, fontWeight: 600 }}>REQ: </span>
                                {act.prompt}
                              </div>
                            )}
                            {act.thinking && (
                              <div style={{
                                fontFamily: mono, fontSize: 11, color: C.purple,
                                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                                background: "#160926", padding: "4px 7px", borderRadius: 5, borderLeft: `2px solid ${C.purple}`,
                              }}>
                                <span style={{ fontWeight: 700 }}>💭 THOUGHT: </span>
                                {act.thinking}
                              </div>
                            )}
                            {act.response && (
                              <div style={{
                                fontFamily: mono, fontSize: 11, color: C.teal,
                                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                              }}>
                                <span style={{ fontWeight: 700, color: C.green }}>RES: </span>
                                {act.response}
                              </div>
                            )}
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 2 }}>
                              <span style={{ fontFamily: mono, fontSize: 9, color: C.muted }}>
                                {act.status === "streaming"
                                  ? `Streaming for ${((Date.now() - act.startedAt) / 1000).toFixed(1)}s…`
                                  : `Completed in ${act.latencyMs ? `${(act.latencyMs / 1000).toFixed(1)}s` : "—"}`}
                              </span>
                              <span style={{ fontFamily: mono, fontSize: 10, color: C.blue, fontWeight: 600 }}>
                                {hasPeekData ? "🔍 Tap to inspect full thought/IO" : "Tap to inspect"}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Compact Nodes Snapshot on Page 1 */}
            <div style={{
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontFamily: mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em" }}>
                  NODES HEALTH ({onlineBackends.length} ONLINE / {offlineBackends.length} OFFLINE)
                </span>
                <button
                  onClick={() => { setPage("nodes"); setNodeFilter("all"); }}
                  style={{
                    background: "none", border: "none", color: C.blue,
                    fontFamily: mono, fontSize: 11, cursor: "pointer", fontWeight: 600,
                  }}
                >
                  All nodes →
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 7 }}>
                {backends.slice(0, 10).map((b) => {
                  const isBusy = (b.activeRequests || 0) > 0;
                  const isOnline = b.enabled && b.status === "online";
                  return (
                    <div key={b.id} style={{
                      background: C.panel,
                      border: `1px solid ${isBusy ? C.amber : isOnline ? C.border : "#2a1215"}`,
                      borderRadius: 8, padding: "7px 9px",
                      display: "flex", alignItems: "center", gap: 7, opacity: isOnline ? 1 : 0.6,
                    }}>
                      <Pulse color={isBusy ? C.amber : isOnline ? C.green : C.red} size={7} pulse={isBusy} />
                      <span style={{ fontSize: 13 }}>{b.geo?.flag || "🌐"}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontFamily: mono, fontSize: 11, color: C.bright, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {cleanHost(b.url).split(":")[0]}
                        </div>
                        <div style={{ fontFamily: mono, fontSize: 9, color: isBusy ? C.amber : C.dim }}>
                          {isBusy ? `${b.activeRequests} busy` : isOnline ? `${b.lastLatency ?? "—"}ms · ${b.modelCount ?? 0}m` : "offline"}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {backends.length > 10 && (
                <button
                  onClick={() => setPage("nodes")}
                  style={{
                    width: "100%", marginTop: 8, padding: "7px", borderRadius: 7,
                    background: C.panel, border: `1px solid ${C.border}`,
                    color: C.dim, fontFamily: mono, fontSize: 11, cursor: "pointer",
                  }}
                >
                  View all {backends.length} nodes
                </button>
              )}
            </div>
          </>
        )}

        {/* ── PAGE 2: FULL NODES & TRAFFIC STREAM ────────────────────────── */}
        {page === "nodes" && (
          <>
            {/* Filter Pills */}
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
              {[
                { id: "all", label: `All (${backends.length})` },
                { id: "online", label: `Online (${onlineBackends.length})` },
                { id: "busy", label: `Busy (${busyBackends.length})` },
                { id: "offline", label: `Offline (${offlineBackends.length})` },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => setNodeFilter(f.id)}
                  style={{
                    background: nodeFilter === f.id ? C.blue : C.surface,
                    border: `1px solid ${nodeFilter === f.id ? C.blue : C.border}`,
                    color: nodeFilter === f.id ? "#fff" : C.text,
                    borderRadius: 20, padding: "6px 12px", fontFamily: mono, fontSize: 11,
                    fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Nodes List */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filteredNodes.map((b) => {
                const isOnline = b.enabled && b.status === "online";
                const isBusy = (b.activeRequests || 0) > 0;
                const pinnedSessions = sessions.filter((s) => s.backendId === b.id);
                return (
                  <div key={b.id} style={{
                    background: C.surface,
                    border: `1px solid ${isBusy ? C.amber : isOnline ? C.border : "#2a1215"}`,
                    borderRadius: 10, padding: "10px 12px",
                    opacity: b.enabled ? 1 : 0.5,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <Pulse color={isBusy ? C.amber : isOnline ? C.green : C.red} size={9} pulse={isBusy} />
                        {b.geo?.flag && <span style={{ fontSize: 16 }}>{b.geo.flag}</span>}
                        <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, color: C.white, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {cleanHost(b.url)}
                        </span>
                      </div>
                      <span style={{
                        fontFamily: mono, fontSize: 10, padding: "2px 7px", borderRadius: 4,
                        background: isBusy ? "#2d1a00" : isOnline ? "#0c2e1a" : "#2a0d0d",
                        color: isBusy ? C.amber : isOnline ? C.green : C.red,
                        border: `1px solid ${isBusy ? C.amber : isOnline ? "#166534" : "#5a1515"}`,
                      }}>
                        {isBusy ? `${b.activeRequests} BUSY` : isOnline ? "ONLINE" : "OFFLINE"}
                      </span>
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: 6, fontFamily: mono, fontSize: 10, color: C.dim }}>
                      {b.geo?.country && <span>{b.geo.country}</span>}
                      {b.lastLatency != null && <span>Ping: <strong style={{ color: C.text }}>{b.lastLatency}ms</strong></span>}
                      {b.modelCount != null && <span>Models: <strong style={{ color: C.text }}>{b.modelCount}</strong></span>}
                      {b.ollamaVersion && <span>v{b.ollamaVersion}</span>}
                      <span>Reqs: {b.totalRequests || 0}</span>
                    </div>

                    {pinnedSessions.length > 0 && (
                      <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${C.border}`, display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {pinnedSessions.map((ps) => (
                          <span
                            key={ps.id}
                            onClick={() => setPeekSessionId(ps.id)}
                            style={{
                              fontFamily: mono, fontSize: 10, background: C.panel,
                              border: `1px solid ${C.blue}`, color: C.blue,
                              padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                            }}
                          >
                            📌 {ps.clientIp.replace(/^::ffff:/, "")} ({ps.model}) 🔍
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Recent Traffic Log Stream */}
            <div style={{
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginTop: 4,
            }}>
              <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", marginBottom: 8 }}>
                RECENT REQUESTS ({logs.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 260, overflowY: "auto" }}>
                {logs.slice().reverse().slice(0, 20).map((e, idx) => {
                  const ok = e.status >= 200 && e.status < 300;
                  return (
                    <div key={e.id ?? idx} style={{
                      display: "flex", alignItems: "center", gap: 6,
                      fontFamily: mono, fontSize: 10, padding: "4px 0",
                      borderBottom: `1px solid ${C.bg}`,
                    }}>
                      <span style={{ color: ok ? C.green : C.red, width: 26, fontWeight: 700 }}>{e.status || "—"}</span>
                      <span style={{ color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {e.path}
                      </span>
                      <span style={{ color: C.blue, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {cleanHost(e.backend).split(":")[0]}
                      </span>
                      <span style={{ color: C.purple, width: 44, textAlign: "right" }}>
                        {e.latency != null ? `${e.latency}ms` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </main>

      {/* ── SESSION PEEK DRAWER / MODAL ──────────────────────────────────── */}
      {peekSession && (
        <div
          onClick={() => setPeekSessionId(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            background: "rgba(2, 8, 16, 0.82)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "flex-end", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 600, maxHeight: "88vh",
              background: C.surface, borderTop: `1px solid ${C.borderBright}`,
              borderTopLeftRadius: 18, borderTopRightRadius: 18,
              display: "flex", flexDirection: "column", overflow: "hidden",
              boxShadow: "0 -10px 30px rgba(0,0,0,0.6)",
            }}
          >
            {/* Modal Header */}
            <div style={{
              padding: "14px 16px", borderBottom: `1px solid ${C.border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: C.panel,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Pulse
                    color={(peekSession.activeCount || 0) > 0 ? C.amber : C.green}
                    size={9}
                    pulse={(peekSession.activeCount || 0) > 0}
                  />
                  <span style={{ fontFamily: mono, fontSize: 14, fontWeight: 700, color: C.white }}>
                    {peekSession.model}
                  </span>
                </div>
                <div style={{ fontFamily: mono, fontSize: 10, color: C.dim, marginTop: 3 }}>
                  Client {peekSession.clientIp.replace(/^::ffff:/, "")} → {cleanHost(peekSession.backendUrl)}
                </div>
              </div>
              <button
                onClick={() => setPeekSessionId(null)}
                style={{
                  background: C.surface, border: `1px solid ${C.border}`,
                  color: C.text, borderRadius: 8, padding: "6px 12px",
                  fontFamily: mono, fontSize: 12, cursor: "pointer",
                }}
              >
                ✕ Close
              </button>
            </div>

            {/* Modal Sub-Tabs */}
            <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, background: C.bg, padding: "0 12px" }}>
              {[
                { id: "live", label: "💭 Thought & Output" },
                { id: "prompt", label: "📨 Request / Context" },
                { id: "history", label: `🕓 History (${peekSession.history?.length || 0})` },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setPeekTab(t.id)}
                  style={{
                    flex: 1, background: "none", border: "none",
                    borderBottom: peekTab === t.id ? `2px solid ${C.blue}` : "2px solid transparent",
                    color: peekTab === t.id ? C.white : C.dim,
                    padding: "10px 6px", fontFamily: mono, fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Modal Body */}
            <div style={{ padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
              {!peekSession.lastActivity ? (
                <div style={{ fontFamily: mono, fontSize: 12, color: C.muted, textAlign: "center", padding: "30px 0" }}>
                  No captured payload yet for this session.
                </div>
              ) : (
                <>
                  {peekTab === "live" && (
                    <>
                      {/* Status bar */}
                      <div style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        background: C.panel, padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}`,
                        fontFamily: mono, fontSize: 11,
                      }}>
                        <span style={{ color: peekSession.lastActivity.status === "streaming" ? C.amber : C.green, fontWeight: 700 }}>
                          {peekSession.lastActivity.status === "streaming" ? "⚡ STREAMING LIVE…" : "✓ COMPLETED"}
                        </span>
                        <span style={{ color: C.dim }}>
                          {peekSession.lastActivity.path} ·{" "}
                          {peekSession.lastActivity.status === "streaming"
                            ? `${((Date.now() - peekSession.lastActivity.startedAt) / 1000).toFixed(1)}s`
                            : `${((peekSession.lastActivity.latencyMs || 0) / 1000).toFixed(2)}s`}
                        </span>
                      </div>

                      {/* Last user prompt quick view */}
                      {peekSession.lastActivity.prompt && (
                        <div>
                          <div style={{ fontFamily: mono, fontSize: 10, color: C.blue, letterSpacing: "0.08em", marginBottom: 5 }}>
                            USER PROMPT
                          </div>
                          <pre style={{
                            margin: 0, background: C.bg, border: `1px solid ${C.border}`,
                            borderRadius: 8, padding: 10, fontFamily: mono, fontSize: 11,
                            color: C.bright, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 110, overflowY: "auto",
                          }}>
                            {peekSession.lastActivity.prompt}
                          </pre>
                        </div>
                      )}

                      {/* Thought Process */}
                      <div>
                        <div style={{ fontFamily: mono, fontSize: 10, color: C.purple, letterSpacing: "0.08em", marginBottom: 5 }}>
                          💭 THOUGHT PROCESS / REASONING
                        </div>
                        <pre style={{
                          margin: 0, background: "#12071f", border: `1px solid #3b1763`,
                          borderRadius: 8, padding: 12, fontFamily: mono, fontSize: 11,
                          color: "#e9d5ff", whiteSpace: "pre-wrap", wordBreak: "break-word",
                          maxHeight: 220, overflowY: "auto", lineHeight: 1.5,
                        }}>
                          {peekSession.lastActivity.thinking || "No separate reasoning/thinking tokens emitted by model."}
                        </pre>
                      </div>

                      {/* Response Output */}
                      <div>
                        <div style={{ fontFamily: mono, fontSize: 10, color: C.green, letterSpacing: "0.08em", marginBottom: 5 }}>
                          💬 MODEL RESPONSE
                        </div>
                        <pre style={{
                          margin: 0, background: C.bg, border: `1px solid ${C.borderBright}`,
                          borderRadius: 8, padding: 12, fontFamily: mono, fontSize: 12,
                          color: C.teal, whiteSpace: "pre-wrap", wordBreak: "break-word",
                          maxHeight: 280, overflowY: "auto", lineHeight: 1.5,
                        }}>
                          {peekSession.lastActivity.response || (peekSession.lastActivity.status === "streaming" ? "Waiting for response tokens…" : "Empty response")}
                        </pre>
                      </div>
                    </>
                  )}

                  {peekTab === "prompt" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>
                        RECENT CONVERSATION MESSAGES ({peekSession.lastActivity.messages?.length || 0})
                      </div>
                      {(peekSession.lastActivity.messages || []).map((m, idx) => (
                        <div key={idx} style={{
                          background: C.bg, border: `1px solid ${C.border}`,
                          borderRadius: 8, padding: 10,
                        }}>
                          <div style={{
                            fontFamily: mono, fontSize: 10, fontWeight: 700, marginBottom: 4,
                            color: m.role === "user" ? C.blue : m.role === "assistant" ? C.green : C.amber,
                            textTransform: "uppercase",
                          }}>
                            {m.role}
                          </div>
                          <pre style={{
                            margin: 0, fontFamily: mono, fontSize: 11, color: C.text,
                            whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto",
                          }}>
                            {m.content}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}

                  {peekTab === "history" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {(peekSession.history || []).length === 0 ? (
                        <div style={{ fontFamily: mono, fontSize: 11, color: C.muted, textAlign: "center", padding: "20px 0" }}>
                          No completed turns in history yet.
                        </div>
                      ) : (
                        peekSession.history.map((h, i) => (
                          <div key={h.reqId || i} style={{
                            background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10,
                            display: "flex", flexDirection: "column", gap: 6,
                          }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 10, color: C.dim }}>
                              <span>{new Date(h.startedAt).toLocaleTimeString()} · {h.path}</span>
                              <span>{h.latencyMs ? `${(h.latencyMs / 1000).toFixed(1)}s` : ""}</span>
                            </div>
                            {h.prompt && (
                              <div style={{ fontFamily: mono, fontSize: 11, color: C.blue }}>
                                <strong>Q:</strong> {h.prompt.slice(0, 200)}
                              </div>
                            )}
                            {h.thinking && (
                              <div style={{ fontFamily: mono, fontSize: 10, color: C.purple, background: "#12071f", padding: 6, borderRadius: 4 }}>
                                <strong>💭:</strong> {h.thinking.slice(0, 300)}
                              </div>
                            )}
                            {h.response && (
                              <div style={{ fontFamily: mono, fontSize: 11, color: C.teal }}>
                                <strong>A:</strong> {h.response.slice(0, 300)}
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Fixed Bottom 2-Page Switcher Bar */}
      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 40,
        background: "#0a0f1aee", backdropFilter: "blur(12px)",
        borderTop: `1px solid ${C.borderBright}`,
        display: "flex", height: 60, maxWidth: 600, margin: "0 auto",
      }}>
        <button
          onClick={() => setPage("overview")}
          style={{
            flex: 1, background: "none", border: "none",
            borderTop: page === "overview" ? `2px solid ${C.blue}` : "2px solid transparent",
            color: page === "overview" ? C.white : C.dim,
            fontFamily: mono, fontSize: 12, fontWeight: 600, cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
          }}
        >
          <span>⚡ Live & Sessions</span>
          <span style={{ fontSize: 9, color: busySessions.length > 0 ? C.amber : C.muted }}>
            {sessions.length} sess · {totalActiveReqs} busy
          </span>
        </button>

        <button
          onClick={() => setPage("nodes")}
          style={{
            flex: 1, background: "none", border: "none",
            borderTop: page === "nodes" ? `2px solid ${C.blue}` : "2px solid transparent",
            color: page === "nodes" ? C.white : C.dim,
            fontFamily: mono, fontSize: 12, fontWeight: 600, cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
          }}
        >
          <span>🖥 Nodes & Logs</span>
          <span style={{ fontSize: 9, color: C.green }}>
            {onlineBackends.length} online / {offlineBackends.length} off
          </span>
        </button>
      </nav>

      <style>{`
        @keyframes mPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.92); }
        }
      `}</style>
    </div>
  );
}
