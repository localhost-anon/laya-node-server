# laya-node-server

Pure-Node.js [Laya](https://github.com/NandhaKishorM/laya) decision server. **No Python at
runtime, fully offline** — the model weights (ONNX), the tokenizers, the `laya-ts` package
(vendored tarball in `vendor/`), and `node_modules` are all local to this directory.

## Layout

```
server.mjs                  HTTP server (node:http, zero web-framework deps)
mcp.mjs                     MCP server (stdio) — Laya as tools for Claude Code & other agents
playground.mjs              web UI served at GET / + preset workflows (from laya-ts presets)
smoke.mjs                   offline end-to-end test (loads models, runs predictions)
models/english/             ModernBERT-large checkpoint → encoder.onnx + head.onnx + tokenizer
models/multilingual/        mmBERT-base checkpoint (100+ languages, 8k context)
vendor/laya-ts-0.1.0.tgz    laya-ts built from the repo clone at ../laya/laya-ts
node_modules/               vendored (onnxruntime-node + laya-ts)
```

## Setup (fresh clone)

The ONNX model files (~2.8 GB) are too large for GitHub and are not committed. Generate
them once with the helper script — the only step that needs Python; it clones upstream
laya into a temp dir, runs its verified exporter (torch-vs-ONNX match within 1e-4), and
cleans up after itself:

```bash
npm install          # restores node_modules (laya-ts is vendored in vendor/)
./export-models.sh   # writes models/english + models/multilingual (~3 GB download, one time)
```

After that, no network is ever needed again.

## Run

```bash
node server.mjs          # http://127.0.0.1:8000
node smoke.mjs           # offline sanity check, no server needed
```

Open <http://127.0.0.1:8000> for the **playground UI**: pick a preset (triage, email,
guard, moderation, router — questions come from laya-ts's real preset functions), edit the
state/questions JSON, run with Ctrl/Cmd+Enter, and read each answer's full probability
distribution with calibrated confidence. "Copy curl" turns the current request into a
shell command.

Both checkpoints are preloaded at startup; requests route automatically by language
(English → english checkpoint, everything else → multilingual), same logic as the Python
`Router`.

## API (wire-compatible with `laya-serve` / TypeSafe Jev)

```bash
curl -s localhost:8000/v1/systemone -H 'content-type: application/json' -d '{
  "state": {"body": "We were billed twice in March. Please refund it today."},
  "questions": {
    "department": {"type": "choice", "instructions": "Which department should handle this?",
                   "criteria": {"billing": "invoices, payments, refunds", "other": "everything else"}},
    "urgency":    {"type": "score", "instructions": "How urgent is this?",
                   "criteria": ["not urgent", "soon", "critical"]},
    "churn_risk": {"type": "noul", "instructions": "Does the user threaten to cancel?"}
  }
}'
```

- `POST /v1/systemone` (alias `/predict`) — body `{state, questions[, model][, lang]}` →
  `{model, answers, usage, routing}`. Optional `model` pins `english`/`multilingual`;
  optional `lang` (BCP-47 code) overrides language detection.
- `GET /health`

Env vars: `LAYA_HOST` (127.0.0.1), `LAYA_PORT` (8000), `LAYA_API_KEY` (enables
`Authorization: Bearer` auth), `LAYA_DEFAULT` (checkpoint for undetectable short text,
default `english`), `LAYA_MAX_CONCURRENT` (admission limit, default 2 — excess load gets 503).

## MCP server (Claude Code integration)

`mcp.mjs` exposes Laya as MCP tools over stdio — same tool surface as upstream's Python
`laya-mcp-server`, but pure Node and fully offline:

```bash
claude mcp add laya -- node /absolute/path/to/server/mcp.mjs
```

- `laya_status` — checkpoints on disk / loaded in memory
- `laya_route` — routing decision + language detection only (sub-ms, never loads a model)
- `laya_predict` — typed decisions (choice/score/noul) with calibrated probabilities
- `laya_preset` — one-call workflows: triage, email, guard (jailbreak/prompt-injection
  detection), moderation, router

Models load lazily: registering the server costs nothing; the first `laya_predict` loads
the routed checkpoint (~5 s), after which calls take ~50–250 ms on CPU. This lets Claude
delegate bulk classification, triage, and guardrail gates to a local model — sensitive
text never leaves the machine and no tokens are spent. Env: `LAYA_MODELS_DIR`,
`LAYA_DEFAULT`.

## Using it as a library instead

```js
import { Agent, Router, decide } from "laya-ts";
const agent = await Agent.load("./models/english");
const out = await agent.predict("charged twice, refund please", {
  intent: { type: "choice", instructions: "What does the customer want?",
            criteria: { refund: "money back", other: "anything else" } },
});
```

`decide(agent, state, jsonSchema)` maps a JSON Schema (enum→choice, bool→noul,
bounded int→score) onto typed values — see the
[laya-ts README](https://github.com/NandhaKishorM/laya/tree/main/laya-ts).

## License

Apache-2.0. This project vendors [laya-ts](https://github.com/NandhaKishorM/laya)
(Apache-2.0, © Convai Innovations) and runs the Laya model checkpoints published at
[huggingface.co/convaiinnovations](https://huggingface.co/convaiinnovations/laya).
