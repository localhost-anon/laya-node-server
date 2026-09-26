// Laya decision server — pure Node.js, fully offline.
//
// Serves the same wire protocol as Python's `laya-serve` (and TypeSafe's hosted
// Jev API): POST /v1/systemone with {state, questions[, model]} returns
// {model, answers, usage, routing}. GET /health reports loaded checkpoints.
//
// Both checkpoints (english + multilingual) are loaded from ./models at startup
// from local ONNX exports — no network access is ever needed.
//
// Env:
//   LAYA_HOST (default 127.0.0.1)   LAYA_PORT (default 8000)
//   LAYA_API_KEY  — when set, requests must send "Authorization: Bearer <key>"
//   LAYA_DEFAULT  — default checkpoint for undetectable text (english|multilingual)

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent, Router } from "laya-ts";
import { PRESETS, INDEX_HTML } from "./playground.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.LAYA_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LAYA_PORT ?? 8000);
const API_KEY = process.env.LAYA_API_KEY ?? null;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// --- load both checkpoints up front (preload semantics: no cold start per request)
console.log("loading checkpoints from ./models ...");
const t0 = performance.now();
const [english, multilingual] = await Promise.all([
  Agent.load(join(HERE, "models", "english")),
  Agent.load(join(HERE, "models", "multilingual")),
]);
const router = new Router({ default: process.env.LAYA_DEFAULT ?? "english" });
router.attach("english", english);
router.attach("multilingual", multilingual);
console.log(`checkpoints ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// --- helpers
function checkAuth(req) {
  if (API_KEY === null) return true;
  const supplied = Buffer.from(req.headers["authorization"] ?? "", "utf8");
  const expected = Buffer.from("Bearer " + API_KEY, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) return reject(Object.assign(new Error("request body too large"), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(Object.assign(new Error("request body too large"), { status: 413 }));
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// One admission slot per CPU-ish: refuse excess load instead of queueing,
// matching laya-serve's 503 behaviour. ONNX inference is CPU-bound.
const MAX_CONCURRENT = Number(process.env.LAYA_MAX_CONCURRENT ?? 2);
let inflight = 0;

async function handleSystemOne(req, res) {
  if (!checkAuth(req)) return send(res, 401, { detail: "invalid or missing bearer token" });
  if (inflight >= MAX_CONCURRENT) return send(res, 503, { detail: "server busy, try again later" });
  inflight += 1;
  try {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8"));
    } catch (e) {
      return send(res, e.status ?? 400, { detail: e.status ? e.message : "request body must be valid JSON" });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body) || !("questions" in body)) {
      return send(res, 400, { detail: "request body must be an object with a 'questions' field" });
    }
    const opts = {};
    if (typeof body.model === "string" && body.model) opts.model = body.model;
    if (typeof body.lang === "string" && body.lang) opts.lang = body.lang;
    const t = performance.now();
    let result;
    try {
      result = await router.predict(body.state, body.questions, opts);
    } catch (e) {
      // Validation errors from laya-ts name the offending question: safe for clients.
      const msg = e instanceof Error ? e.message : String(e);
      const isClientError = /question|criteria|instructions|type|model|state/i.test(msg);
      if (isClientError) return send(res, 422, { detail: msg });
      console.error("inference failed:", e);
      return send(res, 500, { detail: "inference failed" });
    }
    const ms = (performance.now() - t).toFixed(2);
    return send(res, 200, result, {
      "server-timing": `inference;dur=${ms}`,
      "x-inference-time-ms": ms,
    });
  } finally {
    inflight -= 1;
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(INDEX_HTML);
    }
    if (req.method === "GET" && req.url === "/presets") {
      return send(res, 200, PRESETS);
    }
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, {
        status: "ok",
        loaded: ["english", "multilingual"],
        runtime: "node/onnxruntime",
        node: process.version,
      });
    }
    if (req.method === "POST" && (req.url === "/v1/systemone" || req.url === "/predict")) {
      return await handleSystemOne(req, res);
    }
    send(res, 404, { detail: "not found" });
  } catch (e) {
    console.error("unhandled:", e);
    if (!res.headersSent) send(res, 500, { detail: "internal error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`laya-node-server listening on http://${HOST}:${PORT}`);
  console.log(`  GET  /               playground UI`);
  console.log(`  POST /v1/systemone   (Jev-compatible; also aliased at /predict)`);
  console.log(`  GET  /health  /presets`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
