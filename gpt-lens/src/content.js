(() => {
  if (window.__MODEL_LENS_UI_INSTALLED__) return;
  window.__MODEL_LENS_UI_INSTALLED__ = true;

  const CHANNEL = "__MODEL_LENS__";
  const S = globalThis.ModelLensShared;
  const STORAGE_KEYS = ["modelLensEvents", "modelLensSettings", "modelLensDetectedPlan", "modelLensSyncMeta"];
  const DEFAULT_SETTINGS = {
    panelMode: "peek",
    panelYRatio: 0.42,
    panelPositionVersion: 1,
    view: "monitor",
    quotaProfile: "free",
    autoUseDetectedPlan: true,
    updatedAt: new Date().toISOString()
  };
  const PANEL_MODES = new Set(["dock", "peek", "full"]);

  let settingsViewOpen = false;

  let state = {
    events: [],
    settings: { ...DEFAULT_SETTINGS },
    detectedPlan: null,
    syncMeta: {},
    exportTurns: [],
    selectedTurnIds: new Set()
  };

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function currentConversationId() {
    return location.pathname.match(/\/c\/([0-9a-z-]+)/i)?.[1] || null;
  }

  function hasTrustedBackendEvidence(event) {
    if (!event?.backendModel) return true;
    const source = String(event.backendSource || "").split(" · ").pop();
    if (event.backendEvidenceVersion === 3) {
      const parts = source.split(" + ").map((part) => part.trim()).filter(Boolean);
      return parts.length > 0 && parts.every((part) =>
        /^(?:resolved_model_slug|server_ste_metadata\.model_slug|assistant\.metadata\.model_slug)$/.test(part)
      );
    }
    if (event.backendEvidenceVersion === 2) {
      return /^(?:assistant\.metadata|response(?:\.metadata)?)\.(?:backend_model|backend_model_slug|served_model|model_slug|model)$/.test(source);
    }
    return false;
  }

  async function loadState() {
    const data = await chrome.storage.local.get(STORAGE_KEYS);
    const storedEvents = Array.isArray(data.modelLensEvents) ? data.modelLensEvents : [];
    let sanitized = false;
    state.events = storedEvents.map((event) => {
      if (hasTrustedBackendEvidence(event)) return event;
      sanitized = true;
      return {
        ...event,
        backendModel: null,
        backendSource: null,
        backendConfidence: null,
        backendObservedAt: null,
        status: "unverified"
      };
    });
    const storedSettings = data.modelLensSettings || {};
    const { collapsed: legacyCollapsed, ...settings } = storedSettings;
    const migrateLegacyCenter =
      storedSettings.panelPositionVersion == null &&
      Number(storedSettings.panelYRatio) === 0.5;
    state.settings = { ...DEFAULT_SETTINGS, ...settings };
    const panelYRatio = migrateLegacyCenter
      ? DEFAULT_SETTINGS.panelYRatio
      : Number(state.settings.panelYRatio);
    state.settings.panelYRatio = Number.isFinite(panelYRatio)
      ? Math.min(1, Math.max(0, panelYRatio))
      : DEFAULT_SETTINGS.panelYRatio;
    state.settings.panelPositionVersion = 1;
    if (migrateLegacyCenter) {
      chrome.storage.local.set({ modelLensSettings: state.settings }).catch(() => {});
    }
    state.settings.quotaProfile = S.normalizePlanType(state.settings.quotaProfile) || "free";
    if (!PANEL_MODES.has(state.settings.panelMode)) {
      state.settings.panelMode = legacyCollapsed ? "dock" : "peek";
    }
    state.detectedPlan = S.normalizePlanType(data.modelLensDetectedPlan) || null;
    if (state.settings.autoUseDetectedPlan && state.detectedPlan && S.PLAN_PROFILES[state.detectedPlan]) {
      state.settings.quotaProfile = state.detectedPlan;
    }
    state.syncMeta = data.modelLensSyncMeta || {};
    if (sanitized) chrome.storage.local.set({ modelLensEvents: state.events }).catch(() => {});
  }

  async function saveEvents() {
    await chrome.storage.local.set({ modelLensEvents: state.events });
  }

  async function saveSettings(patch) {
    state.settings = { ...state.settings, ...patch, updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ modelLensSettings: state.settings });
    if (!settingsViewOpen) render();
  }

  function mostRecentEvent() {
    const cid = currentConversationId();
    return [...state.events]
      .filter((e) => !e.manualAdjustment)
      .filter((e) => !cid || !e.conversationId || e.conversationId === cid)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null;
  }

  function findEventForBackend(payload) {
    if (payload.requestId) {
      const exact = state.events.find((event) => event.requestId === payload.requestId);
      if (exact) return exact;
    }
    const now = Date.now();
    return [...state.events]
      .filter((e) => {
        const age = now - new Date(e.timestamp).getTime();
        if (age > 20 * 60_000) return false;
        if (payload.conversationId && e.conversationId && payload.conversationId !== e.conversationId) return false;
        return !e.backendModel || e.status === "unverified";
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null;
  }

  async function recordFrontend(payload) {
    if (!payload.frontendModel) return;
    if (payload.requestId && state.events.some((event) => event.requestId === payload.requestId)) return;
    const event = {
      id: uid(),
      requestId: payload.requestId || null,
      timestamp: payload.timestamp || new Date().toISOString(),
      conversationId: payload.conversationId || currentConversationId(),
      parentMessageId: payload.parentMessageId || null,
      frontendModel: payload.frontendModel,
      captureSource: payload.captureSource || null,
      backendModel: null,
      backendSource: null,
      backendConfidence: null,
      thinkingEffort: payload.thinkingEffort || null,
      status: "unverified"
    };
    state.events.push(event);
    if (state.events.length > 10000) state.events = state.events.slice(-10000);
    await saveEvents();
    render();
  }

  async function recordBackend(payload) {
    if (!payload.backendModel || payload.confidence !== "strong") return;
    if (!/^(?:assistant\.metadata|response(?:\.metadata)?)\.(?:backend_model|backend_model_slug|served_model|model_slug|model)$/.test(String(payload.sourceField || ""))) return;
    const event = findEventForBackend(payload);
    if (!event) return;
    if (event.backendModel || event.backendObservedAt) return;
    event.backendModel = payload.backendModel;
    event.backendSource = `${payload.source || "server"}${payload.sourceField ? ` · ${payload.sourceField}` : ""}`;
    event.backendConfidence = payload.confidence || "strong";
    event.backendEvidenceVersion = 2;
    if (!event.conversationId && payload.conversationId) event.conversationId = payload.conversationId;
    event.status = event.backendConfidence === "strong"
      ? S.compareModels(event.frontendModel, event.backendModel)
      : "unverified";
    event.backendObservedAt = payload.timestamp || new Date().toISOString();
    await saveEvents();
    render();
  }

  function routeStatus(verdict) {
    if (verdict === "normal") return "normal";
    if (verdict === "mismatch") return "mismatch";
    if (verdict === "conflict") return "conflict";
    if (verdict === "auto_reasoning") return "auto_reasoning";
    return "unverified";
  }

  async function recordRouteObservation(payload) {
    const captureId = payload?.captureId;
    if (!captureId) return;

    let event = state.events.find((candidate) => candidate.captureId === captureId);
    if (!event) {
      if (!payload.requestedModel) return;
      event = {
        id: uid(),
        captureId,
        requestId: payload.requestId || null,
        timestamp: payload.startedAt || payload.observedAt || new Date().toISOString(),
        conversationId: payload.conversationId || currentConversationId(),
        parentMessageId: null,
        frontendModel: payload.requestedModel,
        captureSource: "conversation.payload.model",
        backendModel: null,
        backendSource: null,
        backendConfidence: null,
        backendEvidenceVersion: null,
        thinkingEffort: payload.thinkingEffort || null,
        status: "unverified",
        routePhase: payload.phase || "requested"
      };
      state.events.push(event);
      if (state.events.length > 10000) state.events = state.events.slice(-10000);
    }

    if (payload.requestedModel) event.frontendModel = payload.requestedModel;
    if (payload.requestId) event.requestId = payload.requestId;
    if (payload.conversationId) event.conversationId = payload.conversationId;
    if (payload.thinkingEffort) event.thinkingEffort = payload.thinkingEffort;
    event.routePhase = payload.phase || event.routePhase;

    const status = routeStatus(payload.verdict);
    const sourceField = Array.isArray(payload.routeSources) && payload.routeSources.length
      ? payload.routeSources.join(" + ")
      : payload.backendSource || null;

    if (payload.backendModel) {
      event.backendModel = payload.backendModel;
      event.backendSource = `${payload.source || "route"}${sourceField ? ` · ${sourceField}` : ""}`;
      event.backendConfidence = payload.backendExplicit ? "explicit-route" : "model-label";
      event.backendEvidenceVersion = 3;
      event.backendObservedAt = payload.observedAt || new Date().toISOString();
      event.status = status;
    } else if (status === "conflict") {
      event.backendModel = null;
      event.backendSource = `${payload.source || "route"}${sourceField ? ` · ${sourceField}` : ""}`;
      event.backendConfidence = "conflicting-route-evidence";
      event.backendEvidenceVersion = 3;
      event.backendObservedAt = payload.observedAt || new Date().toISOString();
      event.status = "conflict";
    } else if (payload.phase === "requested") {
      event.status = "unverified";
    }

    await saveEvents();
    render();
  }

  async function recordDetectedPlan(plan) {
    const normalized = S.normalizePlanType(plan);
    if (!normalized) return;
    state.detectedPlan = normalized;
    await chrome.storage.local.set({ modelLensDetectedPlan: normalized });
    if (state.settings.autoUseDetectedPlan && S.PLAN_PROFILES[normalized]) {
      await saveSettings({ quotaProfile: normalized });
    } else {
      render();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    const { kind, payload } = event.data;
    if (kind === "route-observation") recordRouteObservation(payload || {});
    if (kind === "frontend-model") recordFrontend(payload || {});
    if (kind === "plan-observed") recordDetectedPlan(payload?.plan);
    if (kind === "backend-model") recordBackend(payload);
  });
  window.postMessage({ channel: CHANNEL, kind: "request-snapshot" }, "*");

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.channel !== "MODEL_LENS_EXTENSION") return;
    if (message.kind === "frontend-model") recordFrontend(message.payload || {});
    if (message.kind === "plan-observed") recordDetectedPlan(message.payload?.plan);
    if (message.kind === "toggle-panel") {
      saveSettings({ panelMode: state.settings.panelMode === "dock" ? "peek" : "dock" });
    }
  });

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "checked") el.checked = !!value;
      else if (key === "value") el.value = value;
      else el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const root = h("aside", { id: "model-lens-root", "aria-label": "GPT Lens" });
  document.documentElement.append(root);

  const DRAG_MARGIN = 8;
  const DRAG_THRESHOLD = 4;
  let suppressedClickSource = null;
  let suppressClickTimer = null;

  function clampedPanelCenter(centerY) {
    const viewportHeight = Math.max(1, window.innerHeight);
    const panelHeight = Math.min(root.getBoundingClientRect().height || 0, viewportHeight);
    const half = panelHeight / 2;
    const min = Math.min(viewportHeight / 2, DRAG_MARGIN + half);
    const max = Math.max(viewportHeight / 2, viewportHeight - DRAG_MARGIN - half);
    return Math.min(max, Math.max(min, centerY));
  }

  function setPanelCenter(centerY) {
    const center = clampedPanelCenter(centerY);
    root.style.top = `${center}px`;
    return center;
  }

  function applyPanelPosition() {
    const ratio = Number.isFinite(Number(state.settings.panelYRatio))
      ? Number(state.settings.panelYRatio)
      : DEFAULT_SETTINGS.panelYRatio;
    setPanelCenter(window.innerHeight * ratio);
  }

  function persistPanelCenter(centerY) {
    const viewportHeight = Math.max(1, window.innerHeight);
    const ratio = Math.min(1, Math.max(0, centerY / viewportHeight));
    state.settings = {
      ...state.settings,
      panelYRatio: ratio,
      updatedAt: new Date().toISOString()
    };
    chrome.storage.local.set({ modelLensSettings: state.settings }).catch(() => {});
  }

  function suppressNextClickFrom(source) {
    suppressedClickSource = source;
    if (suppressClickTimer) window.clearTimeout(suppressClickTimer);
    suppressClickTimer = window.setTimeout(() => {
      suppressedClickSource = null;
      suppressClickTimer = null;
    }, 350);
  }

  root.addEventListener("click", (event) => {
    if (!suppressedClickSource || !suppressedClickSource.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressedClickSource = null;
    if (suppressClickTimer) window.clearTimeout(suppressClickTimer);
    suppressClickTimer = null;
  }, true);

  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const source = event.target.closest(".ml-edge-handle, .ml-header");
    if (!source || !root.contains(source)) return;
    if (source.classList.contains("ml-header") &&
        event.target.closest("button, input, select, textarea, a, [data-no-drag]")) return;

    const rect = root.getBoundingClientRect();
    const startCenter = rect.top + rect.height / 2;
    const startPointerY = event.clientY;
    let moved = false;
    let lastCenter = startCenter;

    try { source.setPointerCapture(event.pointerId); } catch {}
    root.classList.add("is-dragging");

    const move = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const deltaY = moveEvent.clientY - startPointerY;
      if (!moved && Math.abs(deltaY) >= DRAG_THRESHOLD) moved = true;
      if (!moved) return;
      moveEvent.preventDefault();
      lastCenter = setPanelCenter(startCenter + deltaY);
    };

    const finish = (endEvent) => {
      if (endEvent.pointerId !== event.pointerId) return;
      source.removeEventListener("pointermove", move);
      source.removeEventListener("pointerup", finish);
      source.removeEventListener("pointercancel", finish);
      try { source.releasePointerCapture(event.pointerId); } catch {}
      root.classList.remove("is-dragging");
      if (!moved) return;
      suppressNextClickFrom(source);
      persistPanelCenter(lastCenter);
    };

    source.addEventListener("pointermove", move);
    source.addEventListener("pointerup", finish);
    source.addEventListener("pointercancel", finish);
  });

  window.addEventListener("resize", () => requestAnimationFrame(applyPanelPosition));

  function statusInfo(status) {
    if (status === "normal") return { label: "Normal", cls: "normal", detail: "Request and backend model match" };
    if (status === "mismatch") return { label: "Mismatch", cls: "mismatch", detail: "Request and backend model differ" };
    if (status === "conflict") return { label: "Conflict", cls: "mismatch", detail: "Backend route evidence conflicts" };
    if (status === "auto_reasoning") return { label: "Auto", cls: "unverified", detail: "Backend used an automatic reasoning route" };
    return { label: "Unverified", cls: "unverified", detail: "No reliable backend model observed" };
  }

  function formatPeriod(_period, hours) {
    if (hours === 168) return "week";
    if (hours === 720) return "month";
    if (hours === 24) return "day";
    return hours ? `${hours}h` : "";
  }

  function formatCompactPeriod(hours) {
    if (hours === 168) return "wk";
    if (hours === 720) return "mo";
    if (hours === 24) return "day";
    return hours ? `${hours}h` : "";
  }

  function quotaProfile() {
    const key = state.settings.autoUseDetectedPlan && state.detectedPlan
      ? state.detectedPlan
      : state.settings.quotaProfile;
    return S.PLAN_PROFILES[key] || S.PLAN_PROFILES.free;
  }

  function renderQuotaRules() {
    const profile = quotaProfile();
    return profile.rules.map((rule) => {
      const kind = S.ruleKind(rule);
      const count = S.countRule(state.events, rule);
      const ratio = S.ruleRatio(count, rule);
      const period = kind === "numeric" ? formatPeriod(rule.period, rule.hours) : "";
      const valueText = kind === "numeric"
        ? `${count} / ${S.ruleLimitText(rule)}`
        : kind === "soft-unlimited"
          ? `${count} · ${S.ruleLimitText(rule)}`
          : S.ruleLimitText(rule);
      return h("div", { class: "ml-quota" },
        h("div", { class: "ml-quota-top" },
          h("span", { class: "ml-quota-name", text: rule.label }),
          h("span", { class: `ml-quota-count ${kind}`, text: valueText })
        ),
        kind === "numeric" ? h("div", { class: "ml-progress" }, h("i", { style: `--ml-progress:${ratio * 100}%` })) : null,
        period ? h("div", {
          class: "ml-quota-period",
          text: `${period}${rule.sharedCap ? " · shared cap" : ""}`
        }) : null
      );
    });
  }

  function compactQuota(latest) {
    const profile = quotaProfile();
    const canonical = S.canonicalModel(latest?.frontendModel);
    const rule = profile.rules.find((candidate) =>
      candidate.models.some((model) => S.canonicalModel(model) === canonical)
    );
    if (!rule) return null;
    const kind = S.ruleKind(rule);
    const count = S.countRule(state.events, rule);
    return {
      count,
      ratio: S.ruleRatio(count, rule),
      period: kind === "numeric" ? formatPeriod(rule.period, rule.hours) : "",
      hours: rule.hours,
      limitText: S.ruleLimitText(rule),
      kind,
      uncertain: !!rule.uncertain,
      sharedCap: !!rule.sharedCap,
      label: rule.label,
      profile: profile.label
    };
  }

  function manualModelRows() {
    const profile = quotaProfile();
    const windows = new Map();

    for (const rule of profile.rules) {
      if (!rule.hours) continue;
      for (const model of rule.models) {
        const canonical = S.canonicalModel(model);
        windows.set(canonical, Math.max(windows.get(canonical) || 0, rule.hours || 24));
      }
    }

    for (const event of state.events) {
      const canonical = S.canonicalModel(event.frontendModel);
      if (canonical && !windows.has(canonical)) windows.set(canonical, 720);
    }

    return [...windows.entries()]
      .map(([model, hours]) => ({ model, hours, count: S.countModel(state.events, model, hours) }))
      .sort((a, b) => S.modelLabel(a.model).localeCompare(S.modelLabel(b.model)));
  }

  function periodLabel(hours) {
    if (hours === 24) return "24h";
    if (hours === 168) return "7d";
    if (hours === 720) return "30d";
    return `${hours}h`;
  }

  async function adjustModelUsage(model, delta, hours) {
    const canonical = S.canonicalModel(model);
    const now = new Date();

    if (delta > 0) {
      state.events.push({
        id: uid(),
        timestamp: now.toISOString(),
        createdAt: now.toISOString(),
        conversationId: currentConversationId(),
        frontendModel: canonical,
        backendModel: null,
        backendSource: "manual adjustment",
        backendConfidence: null,
        thinkingEffort: null,
        status: "manual",
        manualAdjustment: true,
        manualDelta: 1
      });
    } else {
      const cutoff = now.getTime() - hours * 3600_000;
      const neutralized = new Set(
        state.events
          .filter((event) => event.manualAdjustment && event.manualDelta === -1 && event.targetEventId)
          .map((event) => event.targetEventId)
      );
      const target = [...state.events]
        .filter((event) => {
          const ts = new Date(event.timestamp || 0).getTime();
          return Number.isFinite(ts) &&
            ts >= cutoff &&
            S.canonicalModel(event.frontendModel) === canonical &&
            S.eventWeight(event) > 0 &&
            !neutralized.has(event.id);
        })
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

      if (!target) return false;
      state.events.push({
        id: uid(),
        timestamp: target.timestamp,
        createdAt: now.toISOString(),
        conversationId: target.conversationId || null,
        frontendModel: canonical,
        backendModel: null,
        backendSource: "manual adjustment",
        backendConfidence: null,
        thinkingEffort: null,
        status: "manual",
        manualAdjustment: true,
        manualDelta: -1,
        targetEventId: target.id
      });
    }

    if (state.events.length > 10000) state.events = state.events.slice(-10000);
    await saveEvents();
    return true;
  }

  function renderMonitor() {
    const latest = mostRecentEvent();
    const status = statusInfo(latest?.status || "unverified");
    const profile = quotaProfile();
    const detected = state.detectedPlan ? S.PLAN_PROFILES[state.detectedPlan]?.label || state.detectedPlan : "—";

    return h("div", { class: "ml-view ml-monitor" },
      h("div", { class: `ml-status-card ${status.cls}` },
        h("div", { class: "ml-status-row" },
          h("span", { class: "ml-status-dot" }),
          h("strong", { text: status.label }),
          h("span", { class: "ml-status-detail", text: status.detail })
        ),
        h("div", { class: "ml-model-grid" },
          h("span", { text: "Request model" }),
          h("b", { text: latest?.frontendModel || "—" }),
          h("span", { text: "Backend model" }),
          h("b", { text: latest?.backendModel || "—" }),
          h("span", { text: "Thinking" }),
          h("b", { text: latest?.thinkingEffort || "—" })
        ),
        latest?.backendSource ? h("div", { class: "ml-source", text: latest.backendSource }) : null
      ),
      h("div", { class: "ml-section-head" },
        h("div", {},
          h("div", { class: "ml-eyebrow", text: "USAGE" }),
          h("div", { class: "ml-section-title", text: profile.label })
        ),
        h("button", { class: "ml-link-button", text: "Settings", onClick: () => openSettings() })
      ),
      h("div", { class: "ml-quota-list" }, ...renderQuotaRules()),
      h("div", { class: "ml-meta-line", text: `Detected plan: ${detected} · ${state.events.length} local events` })
    );
  }

  function truncate(text, max = 105) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  }

  function domToMarkdown(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    const kids = () => [...node.childNodes].map(domToMarkdown).join("");
    const text = kids();
    if (["script", "style", "button", "svg"].includes(tag)) return "";
    if (tag === "br") return "\n";
    if (tag === "p") return `${text.trim()}\n\n`;
    if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${text.trim()}\n\n`;
    if (tag === "strong" || tag === "b") return `**${text}**`;
    if (tag === "em" || tag === "i") return `*${text}*`;
    if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") return `\`${node.textContent || ""}\``;
    if (tag === "pre") {
      const code = node.querySelector("code")?.textContent || node.textContent || "";
      const cls = node.querySelector("code")?.className || "";
      const lang = cls.match(/language-([\w+-]+)/)?.[1] || "";
      return `\n\n\`\`\`${lang}\n${code.replace(/\n$/, "")}\n\`\`\`\n\n`;
    }
    if (tag === "blockquote") return `${text.trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
    if (tag === "li") return `${text.trim()}\n`;
    if (tag === "ul") return [...node.children].map((li) => `- ${domToMarkdown(li).trim()}\n`).join("") + "\n";
    if (tag === "ol") return [...node.children].map((li, i) => `${i + 1}. ${domToMarkdown(li).trim()}\n`).join("") + "\n";
    if (tag === "a") return `[${text.trim() || node.href}](${node.href})`;
    if (tag === "hr") return "\n---\n";
    if (tag === "table") return tableToMarkdown(node);
    if (["div", "section", "article", "main"].includes(tag)) return text;
    return text;
  }

  function tableToMarkdown(table) {
    const rows = [...table.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("th,td")].map((cell) => (cell.innerText || "").trim().replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const first = rows[0].concat(Array(width - rows[0].length).fill(""));
    const lines = [`| ${first.join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`];
    for (const row of rows.slice(1)) lines.push(`| ${row.concat(Array(width - row.length).fill("")).join(" | ")} |`);
    return `\n${lines.join("\n")}\n\n`;
  }

  function collectConversationTurns() {
    let turnNodes = [...document.querySelectorAll('article[data-testid^="conversation-turn-"], [data-testid^="conversation-turn-"]')];
    if (!turnNodes.length) {
      turnNodes = [...document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')];
    }
    const unique = [...new Set(turnNodes.map((n) => n.closest("article") || n.closest('[data-testid^="conversation-turn-"]') || n))];
    const turns = [];

    unique.forEach((node, index) => {
      const roleNode = node.querySelector("[data-message-author-role]");
      const role = roleNode?.getAttribute("data-message-author-role") ||
        (node.querySelector('[data-testid*="user"]') ? "user" : node.querySelector(".markdown") ? "assistant" : null);
      if (!role || !["user", "assistant"].includes(role)) return;

      let contentNode;
      if (role === "assistant") contentNode = node.querySelector(".markdown, [data-message-author-role='assistant']");
      else contentNode = node.querySelector("[data-message-author-role='user'] .whitespace-pre-wrap, [data-message-author-role='user'], .whitespace-pre-wrap");
      contentNode ||= roleNode || node;

      const markdown = role === "assistant" ? domToMarkdown(contentNode).trim() : (contentNode.innerText || contentNode.textContent || "").trim();
      if (!markdown) return;
      turns.push({ id: `${role}-${index}`, role, markdown, preview: truncate(markdown), index: turns.length + 1 });
    });
    return turns;
  }

  function refreshExportTurns(preserve = true) {
    const old = preserve ? state.selectedTurnIds : new Set();
    state.exportTurns = collectConversationTurns();
    state.selectedTurnIds = new Set(state.exportTurns.filter((t) => old.size ? old.has(t.id) : true).map((t) => t.id));
  }

  function renderExport() {
    if (!state.exportTurns.length) refreshExportTurns(false);
    const list = h("div", { class: "ml-turn-list" });
    state.exportTurns.forEach((turn) => {
      const checkbox = h("input", { type: "checkbox", checked: state.selectedTurnIds.has(turn.id) });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedTurnIds.add(turn.id); else state.selectedTurnIds.delete(turn.id);
        updateExportCount();
      });
      list.append(h("label", { class: "ml-turn" },
        checkbox,
        h("span", { class: `ml-role ${turn.role}`, text: turn.role === "user" ? "U" : "A" }),
        h("span", { class: "ml-turn-text" },
          h("b", { text: `${turn.index}. ${turn.role === "user" ? "You" : "ChatGPT"}` }),
          h("small", { text: turn.preview })
        )
      ));
    });

    return h("div", { class: "ml-view ml-export" },
      h("div", { class: "ml-export-head" },
        h("div", {}, h("div", { class: "ml-eyebrow", text: "SELECT · EXPORT" }), h("div", { class: "ml-section-title", text: "Current conversation" })),
        h("button", { class: "ml-icon-button", title: "Refresh", text: "↻", onClick: () => { refreshExportTurns(true); render(); } })
      ),
      h("div", { class: "ml-export-tools" },
        h("button", { class: "ml-chip", text: "Select all", onClick: () => { state.selectedTurnIds = new Set(state.exportTurns.map((t) => t.id)); render(); } }),
        h("button", { class: "ml-chip", text: "Clear", onClick: () => { state.selectedTurnIds.clear(); render(); } }),
        h("span", { id: "ml-export-count", text: `${state.selectedTurnIds.size} selected` })
      ),
      list,
      h("button", { class: "ml-primary", text: "Export Markdown", onClick: exportMarkdown })
    );
  }

  function updateExportCount() {
    const el = root.querySelector("#ml-export-count");
    if (el) el.textContent = `${state.selectedTurnIds.size} selected`;
  }

  function exportMarkdown() {
    const selected = state.exportTurns.filter((t) => state.selectedTurnIds.has(t.id));
    if (!selected.length) return;
    const title = document.title.replace(/\s*\|\s*ChatGPT.*$/i, "").trim() || "ChatGPT Conversation";
    const header = `# ${title}\n\n> Exported from ChatGPT · ${new Date().toLocaleString()}\n> ${location.href}\n\n`;
    const body = selected.map((t) => `## ${t.role === "user" ? "You" : "ChatGPT"}\n\n${t.markdown}`).join("\n\n---\n\n");
    const blob = new Blob([header + body + "\n"], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "chatgpt-conversation"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openSettings() {
    if (settingsViewOpen) return;
    settingsViewOpen = true;
    render();
  }

  function closeSettings() {
    settingsViewOpen = false;
    render();
  }

  function renderSettings() {
    const select = h("select", { class: "ml-select" });
    Object.entries(S.PLAN_PROFILES).forEach(([key, profile]) => {
      if (profile.hidden) return;
      select.append(h("option", { value: key, text: profile.label }));
    });
    select.value = state.settings.quotaProfile;

    const autoPlan = h("input", { type: "checkbox", checked: state.settings.autoUseDetectedPlan });
    const syncStatus = h("div", { class: "ml-sync-status", text: "Checking Google sync…" });
    const manualList = h("div", { class: "ml-manual-list" });

    const renderManualList = () => {
      manualList.replaceChildren();
      const rows = manualModelRows();
      for (const row of rows) {
        const count = h("span", { class: "ml-adjust-count", text: String(row.count) });
        const minus = h("button", { class: "ml-stepper-button", title: `Decrease ${S.modelLabel(row.model)}`, text: "−" });
        const plus = h("button", { class: "ml-stepper-button", title: `Increase ${S.modelLabel(row.model)}`, text: "+" });
        minus.disabled = row.count <= 0;
        minus.addEventListener("click", async () => {
          minus.disabled = true;
          await adjustModelUsage(row.model, -1, row.hours);
          renderManualList();
        });
        plus.addEventListener("click", async () => {
          plus.disabled = true;
          await adjustModelUsage(row.model, 1, row.hours);
          renderManualList();
        });
        manualList.append(h("div", { class: "ml-manual-row" },
          h("div", { class: "ml-manual-model" },
            h("b", { text: S.modelLabel(row.model) }),
            h("small", { text: `${periodLabel(row.hours)} window` })
          ),
          h("div", { class: "ml-stepper" }, minus, count, plus)
        ));
      }
    };
    renderManualList();

    const view = h("div", { class: "ml-view ml-settings" },
      h("section", { class: "ml-settings-section" },
        h("div", { class: "ml-field-title", text: "Usage profile" }),
        h("label", { class: "ml-field" }, h("span", { text: "Quota profile" }), select),
        h("label", { class: "ml-toggle-row" },
          autoPlan,
          h("span", { text: "Use the detected ChatGPT plan automatically. Pro ×5 and Pro ×20 remain manual." })
        )
      ),
      h("section", { class: "ml-settings-section" },
        h("div", { class: "ml-field-title", text: "Manual usage correction" }),
        h("div", { class: "ml-field-help", text: "Adjust local counts without changing captured requests." }),
        manualList
      ),
      h("section", { class: "ml-settings-section" },
        h("div", { class: "ml-field-title", text: "Google Drive sync" }),
        syncStatus,
        h("div", { class: "ml-button-row" },
          h("button", { class: "ml-secondary", text: "Sign in", onClick: async () => {
            syncStatus.textContent = "Signing in…";
            syncStatus.textContent = await googleAction("GOOGLE_SIGN_IN");
          } }),
          h("button", { class: "ml-secondary", text: "Sync now", onClick: async () => {
            syncStatus.textContent = "Syncing…";
            syncStatus.textContent = await googleAction("GOOGLE_SYNC_NOW");
          } }),
          h("button", { class: "ml-secondary", text: "Sign out", onClick: async () => {
            syncStatus.textContent = await googleAction("GOOGLE_SIGN_OUT");
          } })
        )
      ),
      h("section", { class: "ml-settings-section ml-settings-danger" },
        h("button", { class: "ml-danger", text: "Clear local usage history", onClick: async () => {
          if (!confirm("Clear GPT Lens local usage history?")) return;
          state.events = [];
          await saveEvents();
          render();
        } })
      )
    );

    select.addEventListener("change", async () => {
      await saveSettings({ quotaProfile: select.value });
      render();
    });
    autoPlan.addEventListener("change", async (event) => {
      await saveSettings({ autoUseDetectedPlan: event.target.checked });
      render();
    });
    googleAction("GOOGLE_STATUS").then((text) => { syncStatus.textContent = text; });
    return view;
  }

  async function googleAction(type) {
    try {
      const result = await chrome.runtime.sendMessage({ type });
      if (!result?.ok) return result?.error || "Google sync unavailable";
      if (type === "GOOGLE_SYNC_NOW") {
        await loadState();
        if (!settingsViewOpen) render();
      }
      return result.message || (result.email ? `Connected: ${result.email}` : "Done");
    } catch (error) {
      return String(error?.message || error);
    }
  }

  function renderEdgeHandle(mode) {
    const latest = mostRecentEvent();
    const status = statusInfo(latest?.status || "unverified");
    const nextMode = mode === "dock" ? "peek" : "dock";
    const actionLabel = mode === "dock" ? "Open GPT Lens" : "Hide summary";
    const tooltip = `${status.label} · ${actionLabel}`;
    return h("button", {
      class: `ml-edge-handle ${status.cls}`,
      "data-tooltip": tooltip,
      "aria-label": tooltip,
      onClick: () => saveSettings({ panelMode: nextMode })
    },
      h("span", { class: "ml-handle-chevron", text: mode === "dock" ? "‹" : "›" })
    );
  }

  function renderPeek() {
    const latest = mostRecentEvent();
    const status = statusInfo(latest?.status || "unverified");
    const quota = compactQuota(latest);
    const model = latest?.frontendModel || "Waiting for request";
    const numericQuota = quota?.kind === "numeric";
    const usageText = !quota
      ? "No quota data"
      : numericQuota
        ? `${quota.count} / ${quota.limitText}`
        : quota.kind === "soft-unlimited"
          ? `${quota.count} · ${quota.limitText}`
          : quota.limitText;
    const periodText = numericQuota ? formatCompactPeriod(quota.hours) : "";
    const percentage = numericQuota ? Math.round(quota.ratio * 100) : null;

    const card = h("button", {
      class: "ml-peek-card",
      title: "Open GPT Lens",
      onClick: () => saveSettings({ panelMode: "full" })
    },
      h("div", { class: "ml-peek-top" },
        h("strong", { class: "ml-peek-model", text: model, title: model })
      ),
      h("div", { class: "ml-peek-meta" },
        h("span", { class: `ml-peek-count ${quota?.kind || "unknown"}` },
          h("b", { text: usageText }),
          periodText ? h("span", { class: "ml-peek-period", text: ` (${periodText})` }) : null,
          quota?.uncertain ? h("span", { class: "ml-peek-uncertain", text: " ?" }) : null
        ),
        h("span", { class: `ml-peek-status ${status.cls}` },
          h("i", { class: "ml-peek-status-dot" }),
          h("span", { text: status.label })
        )
      ),
      numericQuota ? h("div", { class: "ml-peek-progress-row" },
        h("span", { class: "ml-peek-progress" },
          h("i", { style: `--ml-progress:${quota.ratio * 100}%` })
        ),
        h("span", { class: "ml-peek-percent", text: `${percentage}%` })
      ) : null
    );

    return h("div", { class: "ml-peek-wrap" }, card, renderEdgeHandle("peek"));
  }

  function renderFull() {
    if (settingsViewOpen) {
      return h("div", { class: "ml-shell" },
        h("header", { class: "ml-header ml-settings-header" },
          h("div", { class: "ml-settings-heading" },
            h("button", { class: "ml-back-button", title: "Back", "aria-label": "Back", text: "‹", onClick: closeSettings }),
            h("div", { class: "ml-brand" },
              h("strong", { text: "Settings" }),
              h("span", { class: "ml-brand-subtitle", text: "GPT Lens" })
            )
          )
        ),
        renderSettings()
      );
    }

    return h("div", { class: "ml-shell" },
      h("header", { class: "ml-header" },
        h("div", { class: "ml-brand" },
          h("strong", { text: "GPT Lens" }),
          h("span", { class: "ml-brand-subtitle", text: "Model & usage" })
        ),
        h("div", { class: "ml-header-actions" },
          h("button", { class: "ml-icon-button", title: "Settings", text: "⋯", onClick: openSettings }),
          h("button", { class: "ml-icon-button", title: "Back to summary", text: "›", onClick: () => saveSettings({ panelMode: "peek" }) })
        )
      ),
      h("nav", { class: "ml-segmented" },
        h("button", { class: state.settings.view === "monitor" ? "active" : "", text: "Monitor", onClick: () => saveSettings({ view: "monitor" }) }),
        h("button", { class: state.settings.view === "export" ? "active" : "", text: "Select · Export", onClick: () => { refreshExportTurns(true); saveSettings({ view: "export" }); } })
      ),
      state.settings.view === "export" ? renderExport() : renderMonitor()
    );
  }

  function render() {
    const mode = PANEL_MODES.has(state.settings.panelMode) ? state.settings.panelMode : "peek";
    root.className = `is-${mode}`;
    root.replaceChildren();

    if (mode === "dock") {
      root.append(renderEdgeHandle("dock"));
      requestAnimationFrame(applyPanelPosition);
      return;
    }

    if (mode === "peek") {
      root.append(renderPeek());
      requestAnimationFrame(applyPanelPosition);
      return;
    }

    root.append(renderFull());
    requestAnimationFrame(applyPanelPosition);
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.modelLensEvents || changes.modelLensSettings || changes.modelLensSyncMeta) {
      await loadState();
      if (!settingsViewOpen) render();
    }
  });

  (async () => {
    await loadState();
    render();
  })();
})();
