// Laya MCP server — pure Node, stdio transport, fully offline.
//
// Exposes the same tool surface as upstream's Python `laya-mcp-server`
// (laya_status / laya_route / laya_predict / laya_preset) but wraps laya-ts +
// local ONNX exports, so no Python and no network are needed.
//
// Register with Claude Code:
//   claude mcp add laya -- node /path/to/server/mcp.mjs
//
// Env: LAYA_MODELS_DIR (default: ./models next to this file),
//      LAYA_DEFAULT (checkpoint for undetectable short text, default english).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  Agent,
  Router,
  triageQuestions,
  emailQuestions,
  guardQuestions,
  moderationQuestions,
  routerQuestions,
} from "laya-ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = process.env.LAYA_MODELS_DIR ?? join(HERE, "models");
const MODEL_NAMES = ["english", "multilingual"];

const PRESET_FNS = {
  triage: triageQuestions,
  email: emailQuestions,
  guard: guardQuestions,
  moderation: moderationQuestions,
  router: routerQuestions,
};

// Lazy loading: laya_route and laya_status answer instantly with nothing in
// memory; the first laya_predict loads the routed checkpoint (~5s on CPU).
const router = new Router({
  default: process.env.LAYA_DEFAULT ?? "english",
  loader: async (name) => {
    const dir = join(MODELS_DIR, name);
    if (!existsSync(join(dir, "encoder.onnx"))) {
      throw new Error(
        `checkpoint '${name}' not found at ${dir} — run export-models.sh first (see README)`,
      );
    }
    return Agent.load(dir);
  },
});

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function fail(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: msg }], isError: true };
}

// Accept a state as either a plain string or a JSON-encoded object; MCP clients
// often stringify structured payloads.
function parseState(state) {
  if (typeof state !== "string") return state;
  const t = state.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch { /* treat as plain text */ }
  }
  return state;
}

const questionsSchema = z
  .record(z.string(), z.object({
    type: z.enum(["choice", "score", "noul"]),
    instructions: z.string(),
    criteria: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional(),
    labels: z.array(z.string()).length(2).optional(),
  }).passthrough())
  .describe("Typed questions keyed by id. choice: criteria = {label: description}; score: criteria = [level descriptions, low to high]; noul: yes/no, no criteria needed.");

const stateSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe("Text to decide over: a plain string or an object of named fields (e.g. {from, subject, body}). Question instructions may reference field names in backticks.");

const server = new McpServer({ name: "laya", version: "0.1.0" });

server.registerTool(
  "laya_status",
  {
    title: "Laya status",
    description: "Report which Laya checkpoints exist on disk and which are loaded in memory. Costs nothing.",
    inputSchema: {},
  },
  async () => {
    const available = MODEL_NAMES.filter((n) => existsSync(join(MODELS_DIR, n, "encoder.onnx")));
    return ok({
      models_dir: MODELS_DIR,
      available,
      loaded: MODEL_NAMES.filter((n) => router._agents.has(n)),
      default: router.default,
      runtime: `node ${process.version} / onnxruntime`,
    });
  },
);

server.registerTool(
  "laya_route",
  {
    title: "Route only (no inference)",
    description:
      "Decide which Laya checkpoint (english or multilingual) would handle this state, with the language-detection reasoning. Pure JS, sub-millisecond, never loads a model. Use to check routing or detect non-English text.",
    inputSchema: { state: stateSchema },
  },
  async ({ state }) => {
    try {
      return ok(router.route(parseState(state), {}));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "laya_predict",
  {
    title: "Typed decision (single forward pass)",
    description:
      "Answer typed questions (choice / score / noul) about a text with calibrated probabilities in one local forward pass — no generation, nothing to parse, ~50-250 ms on CPU. Ideal for classification, triage, routing, guardrail gates, and yes/no checks over any of 100+ languages. Returns per-question answers with full probability distributions and calibrated confidence; route by confidence (act when high, escalate when low). First call loads the checkpoint (~5 s).",
    inputSchema: {
      state: stateSchema,
      questions: questionsSchema,
      model: z.enum(["english", "multilingual"]).optional()
        .describe("Pin a checkpoint instead of routing by detected language."),
      lang: z.string().optional()
        .describe("BCP-47 language code to override detection, e.g. 'de' or 'en_US'."),
    },
  },
  async ({ state, questions, model, lang }) => {
    try {
      const opts = {};
      if (model) opts.model = model;
      if (lang) opts.lang = lang;
      return ok(await router.predict(parseState(state), questions, opts));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "laya_preset",
  {
    title: "Run a built-in workflow preset",
    description:
      "Run one of Laya's ready-made question sets over a state: 'triage' (customer-message intent/urgency/frustration/churn, expects field `message`), 'email' (category/urgency/reply-needed, expects `body`), 'guard' (jailbreak & prompt-injection detection, expects `prompt`), 'moderation' (toxicity/harassment, expects `post`), 'router' (which model tier a request needs, expects `request`). Pass the text as {\"<expected field>\": \"...\"} or as a plain string.",
    inputSchema: {
      preset: z.enum(["triage", "email", "guard", "moderation", "router"]),
      state: stateSchema,
      categories: z.array(z.string()).optional()
        .describe("email preset only: category labels (default billing/technical/sales/other)."),
    },
  },
  async ({ preset, state, categories }) => {
    try {
      const questions = preset === "email" && categories
        ? PRESET_FNS.email(Object.fromEntries(categories.map((c) => [c, c])))
        : PRESET_FNS[preset]();
      return ok(await router.predict(parseState(state), questions, {}));
    } catch (e) { return fail(e); }
  },
);

await server.connect(new StdioServerTransport());
console.error(`laya mcp server ready (models: ${MODELS_DIR})`);
