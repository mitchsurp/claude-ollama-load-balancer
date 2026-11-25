# claude-ollama-load-balancer

A transparent, memory-aware load balancer for [Ollama](https://ollama.ai) with an automated honeypot catcher, session affinity, and web admin UI.

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
| Admin UI | `http://localhost:8080` | Manage backends, view logs, memory guards & strategy |
| Mobile UI | `http://localhost:8080/mobile` | Mobile-optimized cluster monitoring dashboard |

---

## Key Features

### 🛡️ Automated Canary & Honeypot Catcher
Publicly discovered Ollama endpoints (e.g. from Shodan or public port scans) frequently run mock tarpits or honeypots that reply with `200 OK` on `/api/version` and `/api/tags`, but return canned boilerplate (*"Let me think about this carefully..."*, *"Hello, I am a helpful assistant"*, etc.) instead of running actual GPU/CPU inference.
- **Dynamic Nonce Challenge**: Health checks send a one-shot chat request with a randomized canary token (`CANARY_<random>`) and verify the model actually executes inference and echoes the nonce.
- **Pattern Matching**: Automatically flags known boilerplate and honeypot response templates.
- **Automated Quarantine**: Any backend failing the canary challenge is marked `status: "honeypot"` with a descriptive reason, completely isolating it from receiving client traffic.
- **Shodan Discovery Verification**: The Canary challenge is integrated directly into the Shodan ping scanner, warning you before you add a fake node.

### 🧠 Memory Guard & OOM Learning
Ollama does not expose a native host RAM/VRAM capacity API. The load balancer dynamically learns node limits:
- **OOM Learning**: Intercepts and parses exact memory figures from Ollama OOM error responses (`requires more system memory (X GiB) than is available (Y GiB)`) to learn the node's ceiling and model requirements.
- **Observed VRAM Baseline**: Tracks models loaded in `/api/ps` to establish verified lower bounds.
- **Pre-flight Routing**: Prevents routing requests to nodes that lack sufficient memory to run the requested model.
- **Smart Pull Protection**: Warns or blocks model pulls that would exceed a node's known RAM/VRAM capacity (with manual override option).
- **Manual Overrides**: Operators can set an explicit RAM/VRAM ceiling (GiB) per node directly in the UI.

### 📱 Responsive Desktop & Mobile UI
- Full desktop management dashboard at `http://localhost:8080`.
- Lightweight, touch-friendly mobile dashboard at `http://localhost:8080/mobile` for quick status checks, node toggles, and memory stats.

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
  "strategy": "least-busy",
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
| `least-busy` | Routes to backend with fewest active connections (recommended) |
| `round-robin` | Cycles through online backends in order |
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
OLLAMA_HOST=http://localhost:11434 ollama run llama3.1:8b

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

# Claude Code / Codex CLI
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 codex

# curl
curl http://localhost:11434/v1/models
```

The LB transparently translates the OpenAI [Responses API](https://platform.openai.com/docs/api-reference/responses) (`POST /v1/responses`) to Ollama's Chat Completions endpoint, so tools like Claude Code and Codex work without extra configuration.

---

## Admin API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/status` | All backends, memory stats, and cluster telemetry |
| GET | `/admin/logs?limit=200` | Recent access and error logs |
| POST | `/admin/backends` | Add a backend `{"url":"..."}` (runs canary check async) |
| DELETE | `/admin/backends/:id` | Remove a backend |
| PATCH | `/admin/backends/:id` | Update backend state `{"enabled":false}` |
| POST | `/admin/backends/:id/check` | Run health & canary check on one backend |
| POST | `/admin/backends/check-all` | Run concurrent health & canary checks across all backends |
| POST | `/admin/backends/:id/memory` | Set manual RAM limit (`manualLimitGiB`) or clear OOM blocks |
| POST | `/admin/backends/:id/pull` | Pull model with memory guard check `{"model":"...", "force":false}` |
| GET | `/admin/memory-check?model=...` | Check if a model fits across online backends |
| POST | `/admin/ping-url` | Ping & canary verify any URL `{"url":"...", "timeout":10000}` |
| GET | `/admin/sessions` | View active client sessions & live prompts |
| POST | `/admin/sessions/:id/extend` | Extend session affinity timeout |
| POST | `/admin/sync` | Pull a model across all online nodes |
| POST | `/admin/shodan` | Query Shodan for Ollama nodes `{"apiKey":"...", "query":"..."}` |
| PUT | `/admin/strategy` | Set routing strategy `{"strategy":"least-busy"}` |

---

## Streaming & Persistence

- **Streaming**: Streaming responses (e.g. `/api/generate`, `/api/chat`, `/v1/chat/completions`) are piped directly without buffering.
- **Persistence**: Backend configuration and learned memory constraints are saved to `/data/config.json` inside the `lb-data` Docker volume on every change.

---

## Docker Compose on the Same Network as Ollama

If your Ollama instances are running in Docker, add them to the same network:

```yaml
# In your Ollama service(s):
networks:
  - ollama-net

# In ollama-lb docker-compose.yml:
networks:
  default:
    name: ollama-net
    external: true
```

Then use container names as backend URLs: `http://ollama1:11434`, `http://ollama2:11434`.
