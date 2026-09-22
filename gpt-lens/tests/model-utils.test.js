const fs = require("fs");
const vm = require("vm");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../src/model-utils.js"), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(src, context);
const S = context.globalThis.ModelLensShared;

function assert(cond, msg) { if (!cond) throw new Error(msg); }
assert(S.canonicalModel("gpt-5-6-thinking") === "gpt-5.6-sol", "5.6 thinking canonicalization");
assert(S.canonicalModel("gpt-5-6-thinking-pro") === "gpt-5.6-sol-pro", "5.6 pro canonicalization");
assert(S.canonicalModel("gpt-6-pro") === "gpt-6-pro", "6 pro canonicalization");
assert(S.compareModels("gpt-5-6-thinking", "gpt-5.6-sol") === "normal", "alias equality");
assert(S.compareModels("gpt-5-6-thinking", "gpt-6-pro") === "mismatch", "mismatch");
assert(S.compareModels("gpt-5-6-thinking", null) === "unverified", "missing backend");

const now = Date.now();
const events = [
  { frontendModel: "gpt-6-pro", timestamp: new Date(now - 1000).toISOString() },
  { frontendModel: "gpt-5-6-thinking-pro", timestamp: new Date(now - 2000).toISOString() },
  { frontendModel: "gpt-6-pro", timestamp: new Date(now - 8 * 24 * 3600_000).toISOString() }
];
const rule = S.PLAN_PROFILES.prox5.rules[0];
assert(S.countRule(events, rule, now) === 2, "rolling quota count");
console.log("model-utils tests passed");
