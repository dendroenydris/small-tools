const fs = require("fs");
const vm = require("vm");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../src/model-utils.js"), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(src, context);
const S = context.globalThis.ModelLensShared;

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function findRule(plan, model) {
  const canonical = S.canonicalModel(model);
  return S.PLAN_PROFILES[plan].rules.find((rule) => rule.models.includes(canonical));
}

assert(S.canonicalModel("gpt-6-pro") === "gpt-6-astra-pro", "Astra Pro alias");
assert(S.canonicalModel("gpt-5.6-sol") === "gpt-5-6-thinking", "Sol thinking alias");
assert(S.canonicalModel("gpt-5.6-sol-pro") === "gpt-5-6-pro", "Sol Pro alias");
assert(S.compareModels("gpt-5-6-thinking", "gpt-5.6-sol") === "normal", "thinking alias equality");
assert(S.compareModels("gpt-6-pro", "gpt-6-astra-pro") === "normal", "Astra alias equality");
assert(S.compareModels("gpt-5-6-thinking", "gpt-6-astra-pro") === "mismatch", "mismatch");
assert(S.compareModels("gpt-5-6-thinking", null) === "unverified", "missing backend");

assert(findRule("free", "gpt-5-6-thinking").unknown === true, "Free thinking unknown");
assert(findRule("free", "gpt-5-5-instant").unknown === true, "Free instant unknown");
assert(findRule("free", "gpt-5-6-pro").unavailable === true, "Free Pro unavailable");

assert(findRule("go", "gpt-5-6-thinking").unknown === true, "Go thinking unknown");
assert(findRule("go", "gpt-5-5-instant").unknown === true, "Go instant unknown");

const plusThinking = findRule("plus", "gpt-5-6-thinking");
assert(plusThinking.limit === 3000 && plusThinking.hours === 168 && plusThinking.uncertain === true, "Plus thinking 3000/week ?");
assert(findRule("plus", "gpt-5-5-instant").softUnlimited === true, "Plus instant soft unlimited");

const businessPro = findRule("business", "gpt-5-6-pro");
assert(businessPro.limit === 15 && businessPro.hours === 720, "Business Pro 15/month");
assert(findRule("business", "gpt-5-6-thinking").limit === 3000, "Business thinking 3000/week");
assert(findRule("business", "gpt-5-5-instant").softUnlimited === true, "Business instant soft unlimited");

const premiumPro = findRule("businessPremium", "gpt-5-6-pro");
assert(premiumPro.limit === 50 && premiumPro.hours === 168, "Business Premium Pro 50/week");
assert(findRule("businessPremium", "gpt-5-6-thinking").softUnlimited === true, "Business Premium thinking soft unlimited");

const pro5 = findRule("prox5", "gpt-5-6-pro");
assert(pro5.limit === 50 && pro5.hours === 168, "Pro 5x Pro 50/week");
assert(findRule("prox5", "gpt-5-6-thinking").softUnlimited === true, "Pro 5x thinking soft unlimited");

const astra20 = findRule("prox20", "gpt-6-astra-pro");
assert(astra20.limit === 200 && astra20.hours === 168, "Pro 20x Astra 200/week");
const sol20 = findRule("prox20", "gpt-5-6-pro");
assert(sol20.limit === 170 && sol20.hours === 24 && sol20.uncertain === true, "Pro 20x Sol Pro 170/day ?");
const shared20 = S.PLAN_PROFILES.prox20.rules.find((rule) => rule.sharedCap);
assert(shared20.limit === 200 && shared20.hours === 24, "Pro 20x additional shared 200/day");
assert(findRule("prox20", "gpt-5-6-thinking").softUnlimited === true, "Pro 20x thinking soft unlimited");

assert(S.normalizePlanType("team") === "business", "Team maps to Business");
assert(S.normalizePlanType("business_premium") === "businessPremium", "Business Premium normalization");
assert(S.normalizePlanType("pro") === "businessPremium", "legacy Pro maps to Business Premium");
assert(S.normalizePlanType("prox20") === "prox20", "Pro 20x normalization");

const now = Date.now();
const events = [
  { frontendModel: "gpt-5-6", timestamp: new Date(now - 1000).toISOString() },
  { frontendModel: "gpt-5-5-thinking", timestamp: new Date(now - 2000).toISOString() },
  { frontendModel: "gpt-5-6-thinking", timestamp: new Date(now - 8 * 24 * 3600_000).toISOString() }
];
assert(S.countRule(events, plusThinking, now) === 2, "shared thinking rule counts routed/current models in window");
console.log("model-utils tests passed");
