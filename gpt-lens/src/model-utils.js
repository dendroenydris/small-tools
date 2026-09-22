(() => {
  const MODEL_LABELS = {
    "gpt-6-pro": "GPT-6 Pro",
    "gpt-5.6-sol-pro": "GPT-5.6 Sol Pro",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.6": "GPT-5.6",
    "gpt-4o": "GPT-4o",
    "o3": "o3",
    "o3-pro": "o3 Pro",
    "o4-mini": "o4-mini",
    "o4-mini-high": "o4-mini-high",
    "deep-research": "Deep Research"
  };

  function normalizeSlug(slug) {
    return String(slug || "").trim().toLowerCase().replace(/_/g, "-");
  }

  function canonicalModel(slug) {
    const s = normalizeSlug(slug);
    if (!s) return "";

    if (/^gpt-6(?:-thinking)?-pro$/.test(s) || s === "gpt-6-pro") return "gpt-6-pro";
    if (/^gpt-5[-.]?6(?:-thinking)?-pro$/.test(s) || s === "gpt-5-6-pro") return "gpt-5.6-sol-pro";
    if (/^gpt-5[-.]?6-(thinking|sol)$/.test(s) || s === "gpt-5-6-thinking") return "gpt-5.6-sol";
    if (/^gpt-5[-.]?6-(instant|luna)$/.test(s) || s === "gpt-5-6-instant") return "gpt-5.6-luna";
    if (s === "gpt-5-6" || s === "gpt-5.6") return "gpt-5.6";

    if (/^gpt-4o/.test(s)) return "gpt-4o";
    if (s === "o3") return "o3";
    if (s === "o3-pro") return "o3-pro";
    if (s === "o4-mini") return "o4-mini";
    if (s === "o4-mini-high") return "o4-mini-high";
    if (s.includes("deep-research")) return "deep-research";
    return s;
  }

  function modelLabel(slug) {
    const c = canonicalModel(slug);
    return MODEL_LABELS[c] || slug || "—";
  }

  const PLAN_PROFILES = {
    free: {
      label: "Free",
      rules: [
        { id: "free-56", label: "GPT-5.6", models: ["gpt-5.6", "gpt-5.6-luna"], limit: 10, hours: 5 },
        { id: "free-56-thinking", label: "GPT-5.6 Thinking", models: ["gpt-5.6-sol"], limit: 1, hours: 24 }
      ]
    },
    go: {
      label: "Go",
      rules: [
        { id: "go-instant", label: "GPT-5.6 Luna", models: ["gpt-5.6-luna"], limit: 160, hours: 3 },
        { id: "go-thinking", label: "GPT-5.6 Sol", models: ["gpt-5.6-sol"], limit: 10, hours: 168 }
      ]
    },
    plus: {
      label: "Plus",
      rules: [
        { id: "plus-4o", label: "GPT-4o", models: ["gpt-4o"], limit: 80, hours: 3 },
        { id: "plus-instant", label: "GPT-5.6 Luna", models: ["gpt-5.6-luna"], limit: 160, hours: 3 },
        { id: "plus-thinking", label: "GPT-5.6 Sol", models: ["gpt-5.6-sol"], limit: 3000, hours: 168 },
        { id: "plus-o3", label: "o3", models: ["o3"], limit: 100, hours: 168 },
        { id: "plus-o3-pro", label: "o3 Pro", models: ["o3-pro"], limit: 50, hours: 168 },
        { id: "plus-deep", label: "Deep Research", models: ["deep-research"], limit: 25, hours: 720 }
      ]
    },
    team: {
      label: "Team",
      rules: [
        { id: "team-thinking", label: "GPT-5.6 Sol", models: ["gpt-5.6-sol"], limit: 3000, hours: 168 },
        { id: "team-pro", label: "GPT-5.6 Sol Pro", models: ["gpt-5.6-sol-pro"], limit: 15, hours: 720 },
        { id: "team-o3", label: "o3", models: ["o3"], limit: 100, hours: 168 },
        { id: "team-o3-pro", label: "o3 Pro", models: ["o3-pro"], limit: 50, hours: 168 },
        { id: "team-deep", label: "Deep Research", models: ["deep-research"], limit: 25, hours: 720 }
      ]
    },
    pro: {
      label: "Pro",
      rules: [
        { id: "pro-o3", label: "o3", models: ["o3"], limit: 500, hours: 168 },
        { id: "pro-o3-pro", label: "o3 Pro", models: ["o3-pro"], limit: 100, hours: 24 },
        { id: "pro-deep", label: "Deep Research", models: ["deep-research"], limit: 120, hours: 720 }
      ]
    },
    prox5: {
      label: "Pro ×5",
      rules: [
        {
          id: "prox5-pro-combined-week",
          label: "GPT-6 Pro + GPT-5.6 Sol Pro",
          models: ["gpt-6-pro", "gpt-5.6-sol-pro"],
          limit: 50,
          hours: 168,
          note: "combined / week"
        }
      ]
    },
    prox20: {
      label: "Pro ×20",
      rules: [
        { id: "prox20-6pro-week", label: "GPT-6 Pro", models: ["gpt-6-pro"], limit: 200, hours: 168, note: "week" },
        { id: "prox20-56pro-day", label: "GPT-5.6 Sol Pro", models: ["gpt-5.6-sol-pro"], limit: 170, hours: 24, note: "day" },
        {
          id: "prox20-pro-combined-day",
          label: "GPT-6 Pro + GPT-5.6 Sol Pro",
          models: ["gpt-6-pro", "gpt-5.6-sol-pro"],
          limit: 200,
          hours: 24,
          note: "combined / day"
        }
      ]
    }
  };

  function eventWeight(event) {
    if (typeof event?.manualDelta === "number") return event.manualDelta;
    return 1;
  }

  function countRule(events, rule, now = Date.now()) {
    const cutoff = now - rule.hours * 3600_000;
    const modelSet = new Set(rule.models);
    const total = (events || []).reduce((sum, event) => {
      const ts = new Date(event.timestamp || 0).getTime();
      const model = canonicalModel(event.frontendModel);
      if (!Number.isFinite(ts) || ts < cutoff || !modelSet.has(model)) return sum;
      return sum + eventWeight(event);
    }, 0);
    return Math.max(0, total);
  }

  function countModel(events, model, hours, now = Date.now()) {
    const canonical = canonicalModel(model);
    const cutoff = now - hours * 3600_000;
    const total = (events || []).reduce((sum, event) => {
      const ts = new Date(event.timestamp || 0).getTime();
      if (!Number.isFinite(ts) || ts < cutoff || canonicalModel(event.frontendModel) !== canonical) return sum;
      return sum + eventWeight(event);
    }, 0);
    return Math.max(0, total);
  }

  function compareModels(frontend, backend) {
    if (!frontend || !backend) return "unverified";
    return canonicalModel(frontend) === canonicalModel(backend) ? "normal" : "mismatch";
  }

  globalThis.ModelLensShared = {
    MODEL_LABELS,
    PLAN_PROFILES,
    normalizeSlug,
    canonicalModel,
    modelLabel,
    eventWeight,
    countRule,
    countModel,
    compareModels
  };
})();
