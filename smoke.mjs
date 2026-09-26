// Offline smoke test: loads both local checkpoints directly (no HTTP, no network)
// and runs one English and one non-English prediction through the Router.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent, Router } from "laya-ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const questions = {
  department: {
    type: "choice",
    instructions: "Which department should handle this?",
    criteria: {
      billing: "invoices, payments, refunds",
      technical: "bugs, outages, system errors",
      other: "everything else",
    },
  },
  urgency: { type: "score", instructions: "How urgent is this?", criteria: ["not urgent", "soon", "blocking"] },
  churn_risk: { type: "noul", instructions: "Does the user threaten to cancel or leave?" },
};

const t0 = performance.now();
const [english, multilingual] = await Promise.all([
  Agent.load(join(HERE, "models", "english")),
  Agent.load(join(HERE, "models", "multilingual")),
]);
console.log(`load: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const router = new Router();
router.attach("english", english);
router.attach("multilingual", multilingual);

const cases = [
  ["en", "Hi, we were billed twice in March. Please refund the duplicate today or we will cancel our plan."],
  ["hi", "मुझसे मार्च में दो बार शुल्क लिया गया, कृपया डुप्लिकेट राशि वापस करें।"],
  ["es", "La aplicación se cierra cada vez que abro la configuración."],
];

let failures = 0;
for (const [tag, text] of cases) {
  const t = performance.now();
  const r = await router.predict({ body: text }, questions);
  const ms = (performance.now() - t).toFixed(0);
  const dep = r.answers.department;
  console.log(
    `[${tag}] routed=${r.routing.model} dept=${dep.choice} (${dep.answer_confidence?.toFixed(2) ?? "?"})` +
      ` urgency=${r.answers.urgency.score?.toFixed(2)} churn=${r.answers.churn_risk.noul?.toFixed(2)} ${ms}ms`,
  );
  if (!dep.choice) failures += 1;
}

const en = await router.predict({ body: cases[0][1] }, questions);
if (en.routing.model !== "english") { console.error("FAIL: English text did not route to english"); failures += 1; }
if (en.answers.department.choice !== "billing") { console.error(`FAIL: expected billing, got ${en.answers.department.choice}`); failures += 1; }
const hi = await router.predict({ body: cases[1][1] }, questions);
if (hi.routing.model !== "multilingual") { console.error("FAIL: Hindi text did not route to multilingual"); failures += 1; }

console.log(failures === 0 ? "SMOKE OK" : `SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
