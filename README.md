# claude-ollama-load-balancer

A transparent load balancer for [Ollama](https://ollama.ai) with a web admin UI.

Clients connect to it exactly as they would to a normal Ollama instance — native Ollama API and OpenAI-compatible API both work out of the box. Requests are distributed across your pool of Ollama backends using your chosen strategy.

---

## Quick Start

```bash
git clone https://github.com/mitchsurp/claude-ollama-load-balancer.git
cd claude-ollama-load-balancer
docker compose up --build -d
```

| Service | URL | Purpose |
|---------|-----|---------|
| Load balancer | `http://localhost:11434` | Ollama-compatible API for clients |
| Admin UI | `http://localhost:8080` | Manage backends, view logs, tune strategy |

---

## Adding Backends

**Via the UI** — open `http://localhost:8080`, go to **Backends**, enter a URL and click **+ Add**.

**Via the API:**
```bash
curl -X POST http://localhost:11434/admin/backends \
  -H 'Content-Type: application/json' \
  -d '{"url": "http://192.168.1.10:11434"}'
```

**Via config file** — edit `/data/config.json` inside the proxy container (or mount your own):
```json
{
  "strategy": "round-robin",
  "backends": [
    { "url": "http://192.168.1.10:11434", "enabled": true },
    { "url": "http://192.168.1.11:11434", "enabled": true }
  ]
}
```

---

## Load Balancing Strategies

| Strategy | Description |
|----------|-------------|
| `round-robin` | Cycles through online backends in order (default) |
| `least-busy` | Routes to backend with fewest active connections |
| `random` | Picks a random online backend |

Change strategy via the UI header or:
```bash
curl -X PUT http://localhost:11434/admin/strategy \
  -H 'Content-Type: application/json' \
  -d '{"strategy": "least-busy"}'
```

---

## Pointing Clients at the LB

Anything that talks to Ollama works unchanged — just swap the host:

```bash
# Ollama CLI
OLLAMA_HOST=http://localhost:11434 ollama run llama3

# Python (Ollama client)
import ollama
client = ollama.Client(host="http://localhost:11434")

# curl (Ollama API)
curl http://localhost:11434/api/tags

# Open WebUI (set OLLAMA_BASE_URL=http://ollama-lb-proxy:11434 if on same Docker network)
```

OpenAI-compatible clients also work against `/v1/`:

```bash
# OpenAI Python SDK
from openai import OpenAI
client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")

# Codex CLI
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 codex

# curl
curl http://localhost:11434/v1/models
```

The LB transparently translates the OpenAI [Responses API](https://platform.openai.com/docs/api-reference/responses) (`POST /v1/responses`) to Ollama's Chat Completions endpoint, so tools like Codex that use the Responses API work without any extra configuration.

---

## Admin API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/status` | All backends + stats |
| GET | `/admin/logs?limit=200` | Recent access log |
| POST | `/admin/backends` | Add backend `{"url":"..."}` |
| DELETE | `/admin/backends/:id` | Remove backend |
| PATCH | `/admin/backends/:id` | Update backend `{"enabled":false}` |
| POST | `/admin/backends/:id/check` | Health check one backend |
| POST | `/admin/backends/check-all` | Health check all backends |
| PUT | `/admin/strategy` | Set strategy `{"strategy":"..."}` |

---

## Streaming

Long-running streaming responses (e.g. `/api/generate`, `/api/chat`) are fully supported.
The proxy pipes the upstream response body directly without buffering.

---

## Persistence

Backend config is saved to `/data/config.json` inside the `lb-data` Docker volume
after every mutation. It's automatically reloaded on restart.

---

## Docker Compose on the Same Network as Ollama

If your Ollama instances are also running in Docker, add them to the same network:

```yaml
# In your Ollama service(s):
networks:
  - ollama-net

# In ollama-lb docker-compose.yml, add:
networks:
  default:
    name: ollama-net
    external: true
```

Then use container names as backend URLs: `http://ollama1:11434`, `http://ollama2:11434`.
