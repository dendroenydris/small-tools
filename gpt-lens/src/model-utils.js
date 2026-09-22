(() => {
  function normalizeSlug(slug) {
    return String(slug || "")
      .trim()
      .toLowerCase()
      .replace(/_/g, "-")
      .replace(/^gpt-5\.([356])/, "gpt-5-$1");
  }

  function canonicalModel(slug) {
    const s = normalizeSlug(slug);
    if (!s) return "";

    const aliases = {
      "gpt-6-pro": "gpt-6-astra-pro",
      "gpt-6-astra": "gpt-6-astra-pro",
      "gpt-5-6-luna": "gpt-5-6-instant",
      "gpt-5-6-sol": "gpt-5-6-thinking",
      "gpt-5-6-sol-pro": "gpt-5-6-pro",
      "gpt-5-6-thinking-pro": "gpt-5-6-pro",
      "gpt-5-5-thinking-pro": "gpt-5-5-pro",
      "gpt-5-5-sol-pro": "gpt-5-5-pro"
    };
    return aliases[s] || s;
  }

  function modelLabel(slug) {
    const c = canonicalModel(slug);
    if (!c) return "—";
    if (c === "gpt-6-astra-pro") return "gpt-6-astra-pro";
    if (c === "gpt-5-6-pro") return "gpt-5.6-sol-pro";
    if (c === "deep-research") return "Deep Research";
    if (c === "gpt-4o") return "GPT-4o";
    return c;
  }

  const MODEL_GROUPS = {
    astraPro: ["gpt-6-astra-pro"],
    solPro: ["gpt-5-6-pro", "gpt-5-5-pro"],
    thinkingShared: [
      "gpt-5-6",
      "gpt-5-6-auto",
      "gpt-5-6-thinking",
      "gpt-5-5-thinking"
    ],
    instantShared: [
      "gpt-5-5",
      "gpt-5-5-instant",
      "gpt-5-3",
      "gpt-5-3-instant"
    ]
  };

  const GROUP_LABELS = {
    astraPro: "GPT-6 Astra Pro",
    solPro: "GPT-5.6 Sol / GPT-5.5 Pro",
    thinkingShared: "GPT-5.6 Sol / GPT-5.5 Thinking — shared",
    instantShared: "GPT-5.5 / GPT-5.3 Instant — shared"
  };

  function makeRule(id, label, models, options = {}) {
    return {
      id,
      label,
      models: models.map(canonicalModel),
      limit: typeof options.limit === "number" ? options.limit : null,
      hours: typeof options.hours === "number" ? options.hours : null,
      period: options.period || "",
      unknown: !!options.unknown,
      unavailable: !!options.unavailable,
      softUnlimited: !!options.softUnlimited,
      uncertain: !!options.uncertain,
      sharedCap: !!options.sharedCap
    };
  }

  function groupRule(group, options = {}) {
    return makeRule(
      options.id || group,
      options.label || GROUP_LABELS[group],
      MODEL_GROUPS[group],
      options
    );
  }

  function unavailable(group) {
    return groupRule(group, { unavailable: true });
  }

  function unknown(group) {
    return groupRule(group, { unknown: true });
  }

  function softUnlimited(group) {
    return groupRule(group, { softUnlimited: true });
  }

  function numeric(group, limit, hours, period, extra = {}) {
    return groupRule(group, { limit, hours, period, ...extra });
  }

  const PLAN_PROFILES = {
    default: {
      label: "Unknown plan",
      hidden: true,
      rules: [
        unknown("astraPro"),
        unknown("solPro"),
        unknown("thinkingShared"),
        unknown("instantShared")
      ]
    },

    free: {
      label: "Free",
      rules: [
        unavailable("astraPro"),
        unavailable("solPro"),
        unknown("thinkingShared"),
        unknown("instantShared")
      ]
    },

    go: {
      label: "Go",
      rules: [
        unavailable("astraPro"),
        unavailable("solPro"),
        unknown("thinkingShared"),
        unknown("instantShared")
      ]
    },

    plus: {
      label: "Plus",
      rules: [
        unavailable("astraPro"),
        unavailable("solPro"),
        numeric("thinkingShared", 3000, 168, "week", { uncertain: true }),
        softUnlimited("instantShared")
      ]
    },

    business: {
      label: "Business",
      rules: [
        unavailable("astraPro"),
        numeric("solPro", 15, 720, "month"),
        numeric("thinkingShared", 3000, 168, "week"),
        softUnlimited("instantShared")
      ]
    },

    businessPremium: {
      label: "Business Premium",
      rules: [
        unavailable("astraPro"),
        numeric("solPro", 50, 168, "week"),
        softUnlimited("thinkingShared"),
        softUnlimited("instantShared")
      ]
    },

    prox5: {
      label: "Pro 5x",
      rules: [
        unavailable("astraPro"),
        numeric("solPro", 50, 168, "week"),
        softUnlimited("thinkingShared"),
        softUnlimited("instantShared")
      ]
    },

    prox20: {
      label: "Pro 20x",
      rules: [
        numeric("astraPro", 200, 168, "week"),
        numeric("solPro", 170, 24, "day", { uncertain: true }),
        makeRule(
          "prox20-pro-shared-day",
          "Additional shared Pro cap",
          [...MODEL_GROUPS.astraPro, ...MODEL_GROUPS.solPro],
          { limit: 200, hours: 24, period: "day", sharedCap: true }
        ),
        softUnlimited("thinkingShared"),
        softUnlimited("instantShared")
      ]
    }
  };

  function normalizePlanType(plan) {
    const p = String(plan || "").trim().toLowerCase().replace(/_/g, "-");
    if (!p) return "";
    if (PLAN_PROFILES[p]) return p;
    if (p.includes("free")) return "free";
    if (p === "go" || p.includes("chatgpt-go")) return "go";
    if (p.includes("plus")) return "plus";
    if (p.includes("business-premium") || p.includes("businesspremium")) return "businessPremium";
    if (p.includes("business") || p.includes("team")) return "business";
    if (p.includes("20x") || p.includes("x20") || p.includes("prox20")) return "prox20";
    if (p.includes("5x") || p.includes("x5") || p.includes("prox5")) return "prox5";
    if (p === "pro" || p.includes("chatgpt-pro")) return "businessPremium";
    return "default";
  }

  function eventWeight(event) {
    if (typeof event?.manualDelta === "number") return event.manualDelta;
    return 1;
  }

  function countRule(events, rule, now = Date.now()) {
    if (!rule || !rule.hours) return 0;
    const cutoff = now - rule.hours * 3600_000;
    const modelSet = new Set(rule.models.map(canonicalModel));
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

  function ruleKind(rule) {
    if (!rule) return "unknown";
    if (rule.unavailable) return "unavailable";
    if (rule.unknown) return "unknown";
    if (rule.softUnlimited) return "soft-unlimited";
    if (typeof rule.limit === "number") return "numeric";
    return "unknown";
  }

  function ruleLimitText(rule) {
    const kind = ruleKind(rule);
    if (kind === "unavailable") return "Unavailable";
    if (kind === "unknown") return "Unknown";
    if (kind === "soft-unlimited") return "Soft unlimited";
    if (kind === "numeric") return `${rule.limit}${rule.uncertain ? " ?" : ""}`;
    return "Unknown";
  }

  function ruleRatio(count, rule) {
    if (ruleKind(rule) !== "numeric" || !rule.limit || rule.limit <= 0) return 0;
    return Math.min(1, count / rule.limit);
  }

  globalThis.ModelLensShared = {
    MODEL_GROUPS,
    GROUP_LABELS,
    PLAN_PROFILES,
    normalizeSlug,
    canonicalModel,
    modelLabel,
    normalizePlanType,
    eventWeight,
    countRule,
    countModel,
    compareModels,
    ruleKind,
    ruleLimitText,
    ruleRatio
  };
})();
