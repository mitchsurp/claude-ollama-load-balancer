const BASE = "/admin";

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  status:        ()                          => req("GET",    "/status"),
  logs:          (limit = 200)               => req("GET",    `/logs?limit=${limit}`),
  addBackend:    (url)                       => req("POST",   "/backends",            { url }),
  removeBackend: (id)                        => req("DELETE", `/backends/${id}`),
  toggleBackend: (id, enabled)               => req("PATCH",  `/backends/${id}`,      { enabled }),
  checkBackend:  (id)                        => req("POST",   `/backends/${id}/check`),
  checkAll:      ()                          => req("POST",   "/backends/check-all"),
  setStrategy:   (strategy)                  => req("PUT",    "/strategy",            { strategy }),
  models:        ()                          => req("GET",    "/models"),
  sync:          (model)                     => req("POST",   "/sync",                { model }),
  sessions:      ()                          => req("GET",    "/sessions"),
  deleteSession: (id)                        => req("DELETE", `/sessions/${encodeURIComponent(id)}`),
  extendSession: (id)                        => req("POST",   `/sessions/${encodeURIComponent(id)}/extend`, {}),
  shodan:        (apiKey, query, limit = 5, page = 1)  => req("POST",   "/shodan",              { apiKey, query, limit, page }),
  updateVersion: (version)                             => req("PUT",    "/version",             { version }),
};
