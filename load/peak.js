// Load test: the spec peak, 200 events/s for 5 minutes on POST /api/events (NFR-2, P-7), and the p95
// of that endpoint under load against the NFR-6 target. Plan: docs/plans/part2-stage-9-load.md.
// Usage: k6 run -e BASE=<url> -e RUN=<id> --summary-export <file> load/peak.js. RATE, DURATION and USERS
// override the defaults. Each event is a valid step_answered of the demo flow for one user of a pool;
// the report funnel does not read that type, so the run leaves the demo report as it was.
import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter } from "k6/metrics";

const BASE = (__ENV.BASE || "http://localhost:8787").replace(/\/$/, "");
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || "5m";
const USERS = Number(__ENV.USERS || 1000);
// Tags every visit_id as load-<RUN>-<user>, so the stored rows of one run can be counted apart.
const RUN = __ENV.RUN || String(Date.now());
if (!/^[A-Za-z0-9]{1,20}$/.test(RUN)) throw new Error("RUN must be 1 to 20 letters or digits");

// The answered steps of config/prelanders/demo.json; step 3 is the email and is never sent.
const ANSWERS = [
  { step: 1, question_key: "gender", values: ["women", "men"] },
  { step: 2, question_key: "ethnicity", values: ["asia", "europe", "latam"] },
];

function seconds(text) {
  const match = /^(\d+)(s|m)$/.exec(text);
  if (!match) throw new Error("DURATION must look like 20s or 5m");
  return Number(match[1]) * (match[2] === "m" ? 60 : 1);
}

const planned = RATE * seconds(DURATION);

export const options = {
  scenarios: {
    peak: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.max(10, Math.ceil(RATE / 4)),
      maxVUs: Math.max(50, RATE * 2),
    },
  },
  thresholds: {
    // The worker_5xx_rate alert fires above 1%; here any status other than 2xx or 3xx counts, 429 too.
    http_req_failed: ["rate<0.01"],
    // More than 1% of the planned iterations not started means the laptop did not hold the rate.
    dropped_iterations: [`count<${Math.max(1, Math.ceil(planned * 0.01))}`],
  },
  // The p95 is reported, not a threshold: k6 measures the round trip, NFR-6 the server side.
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const accepted = new Counter("events_accepted");
const throttled = new Counter("events_throttled");
const blocked1015 = new Counter("events_cf_1015");
const unavailable = new Counter("events_unavailable");
const rejected = new Counter("events_rejected");

export function setup() {
  console.log(`run ${RUN}: ${RATE}/s for ${DURATION}, ${planned} events, ${USERS} users, ${BASE}`);
  // A UUID v4 passes the identity middleware (src/routes/identity.ts) as a returning user.
  return {
    users: Array.from({ length: USERS }, (_, i) => ({
      uid: crypto.randomUUID(),
      visit: `load-${RUN}-${i}`,
    })),
  };
}

export default function (data) {
  const n = exec.scenario.iterationInTest;
  const user = data.users[n % USERS];
  const round = Math.floor(n / USERS);
  const answer = ANSWERS[round % ANSWERS.length];
  const body = JSON.stringify({
    event_id: crypto.randomUUID(),
    schema_version: 1,
    type: "step_answered",
    client_time: Date.now(),
    visit_id: user.visit,
    seq: (round % 10000) + 1,
    prelander_id: "demo",
    payload: {
      step: answer.step,
      question_key: answer.question_key,
      value: answer.values[n % answer.values.length],
    },
  });

  const res = http.post(`${BASE}/api/events`, body, {
    headers: { "content-type": "application/json" },
    // replace: the VU cookie jar holds the uid of the previous user this VU sent for.
    cookies: { uid: { value: user.uid, replace: true } },
    tags: { name: "POST /api/events" },
    timeout: "10s",
  });

  if (res.status === 202) accepted.add(1);
  else if (res.status === 429) {
    throttled.add(1);
    if (typeof res.body === "string" && res.body.includes("1015")) blocked1015.add(1);
  } else if (res.status === 503) unavailable.add(1);
  else if (res.status === 400 || res.status === 413) rejected.add(1);
  check(res, { "status is 202": (r) => r.status === 202 });
}
