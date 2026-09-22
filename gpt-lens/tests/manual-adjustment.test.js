const fs = require("fs");
const vm = require("vm");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../src/model-utils.js"), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(src, context);
const S = context.globalThis.ModelLensShared;

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const now = Date.now();
const ts = new Date(now - 10_000).toISOString();
const events = [
  { id: "real-1", frontendModel: "gpt-6-pro", timestamp: ts },
  { id: "manual-plus", frontendModel: "gpt-6-pro", timestamp: new Date(now - 5_000).toISOString(), manualAdjustment: true, manualDelta: 1 },
  { id: "manual-minus", frontendModel: "gpt-6-pro", timestamp: ts, manualAdjustment: true, manualDelta: -1, targetEventId: "real-1" }
];
assert(S.countModel(events, "gpt-6-pro", 168, now) === 1, "signed manual adjustments should affect model count");
assert(S.countRule(events, S.PLAN_PROFILES.prox5.rules[0], now) === 1, "signed manual adjustments should affect quota rules");
console.log("manual adjustment tests passed");
