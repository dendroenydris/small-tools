(() => {
  if (window.__MODEL_LENS_UI_INSTALLED__) return;
  window.__MODEL_LENS_UI_INSTALLED__ = true;

  const CHANNEL = "__MODEL_LENS__";
  const S = globalThis.ModelLensShared;
  const STORAGE_KEYS = ["modelLensEvents", "modelLensSettings", "modelLensDetectedPlan", "modelLensSyncMeta"];
  const DEFAULT_SETTINGS = {
    collapsed: false,
    view: "monitor",
    quotaProfile: "plus",
    autoUseDetectedPlan: true,
    updatedAt: new Date().toISOString()
  };

  let settingsModalOpen = false;

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

  async function loadState() {
    const data = await chrome.storage.local.get(STORAGE_KEYS);
    state.events = Array.isArray(data.modelLensEvents) ? data.modelLensEvents : [];
    state.settings = { ...DEFAULT_SETTINGS, ...(data.modelLensSettings || {}) };
    state.detectedPlan = data.modelLensDetectedPlan || null;
    state.syncMeta = data.modelLensSyncMeta || {};
  }

  async function saveEvents() {
    await chrome.storage.local.set({ modelLensEvents: state.events });
  }

  async function saveSettings(patch) {
    state.settings = { ...state.settings, ...patch, updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ modelLensSettings: state.settings });
    if (!settingsModalOpen) render();
  }

  function mostRecentEvent() {
    const cid = currentConversationId();
    return [...state.events]
      .filter((e) => !e.manualAdjustment)
      .filter((e) => !cid || !e.conversationId || e.conversationId === cid)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null;
  }

  function findEventForBackend(payload) {
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
    const event = {
      id: uid(),
      timestamp: payload.timestamp || new Date().toISOString(),
      conversationId: payload.conversationId || currentConversationId(),
      parentMessageId: payload.parentMessageId || null,
      frontendModel: payload.frontendModel,
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
    if (!payload.backendModel) return;
    const event = findEventForBackend(payload);
    if (!event) return;
    event.backendModel = payload.backendModel;
    event.backendSource = `${payload.source || "server"}${payload.sourceField ? ` · ${payload.sourceField}` : ""}`;
    event.backendConfidence = payload.confidence || "strong";
    if (!event.conversationId && payload.conversationId) event.conversationId = payload.conversationId;
    event.status = event.backendConfidence === "strong"
      ? S.compareModels(event.frontendModel, event.backendModel)
      : "unverified";
    event.backendObservedAt = payload.timestamp || new Date().toISOString();
    await saveEvents();
    render();
  }

  async function recordDetectedPlan(plan) {
    if (!plan) return;
    state.detectedPlan = plan;
    await chrome.storage.local.set({ modelLensDetectedPlan: plan });
    if (state.settings.autoUseDetectedPlan && S.PLAN_PROFILES[plan]) {
      await saveSettings({ quotaProfile: plan });
    } else {
      render();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    const { kind, payload } = event.data;
    if (kind === "backend-model") recordBackend(payload);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.channel !== "MODEL_LENS_EXTENSION") return;
    if (message.kind === "frontend-model") recordFrontend(message.payload || {});
    if (message.kind === "plan-observed") recordDetectedPlan(message.payload?.plan);
    if (message.kind === "toggle-panel") saveSettings({ collapsed: !state.settings.collapsed });
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

  function statusInfo(status) {
    if (status === "normal") return { label: "正常", cls: "normal", detail: "请求与服务器标识一致" };
    if (status === "mismatch") return { label: "异常", cls: "mismatch", detail: "请求与服务器标识不一致" };
    return { label: "未验证", cls: "unverified", detail: "没有强后端模型标识可比较" };
  }

  function quotaProfile() {
    return S.PLAN_PROFILES[state.settings.quotaProfile] || S.PLAN_PROFILES.plus;
  }

  function renderQuotaRules() {
    const profile = quotaProfile();
    return profile.rules.map((rule) => {
      const count = S.countRule(state.events, rule);
      const ratio = Math.min(1, count / rule.limit);
      const period = rule.note || (rule.hours === 24 ? "day" : rule.hours === 168 ? "week" : rule.hours === 3 ? "3h" : `${rule.hours}h`);
      return h("div", { class: "ml-quota" },
        h("div", { class: "ml-quota-top" },
          h("span", { class: "ml-quota-name", text: rule.label }),
          h("span", { class: "ml-quota-count", text: `${count} / ${rule.limit}` })
        ),
        h("div", { class: "ml-progress" }, h("i", { style: `--ml-progress:${ratio * 100}%` })),
        h("div", { class: "ml-quota-period", text: period })
      );
    });
  }

  function manualModelRows() {
    const profile = quotaProfile();
    const windows = new Map();

    for (const rule of profile.rules) {
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
          h("span", { text: "前端请求" }),
          h("b", { text: latest ? S.modelLabel(latest.frontendModel) : "—" }),
          h("span", { text: "后端可观测" }),
          h("b", { text: latest?.backendModel ? S.modelLabel(latest.backendModel) : "—" }),
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
        h("button", { class: "ml-link-button", text: "设置", onClick: () => openSettings() })
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
        h("div", {}, h("div", { class: "ml-eyebrow", text: "SELECT · EXPORT" }), h("div", { class: "ml-section-title", text: "当前对话" })),
        h("button", { class: "ml-icon-button", title: "Refresh", text: "↻", onClick: () => { refreshExportTurns(true); render(); } })
      ),
      h("div", { class: "ml-export-tools" },
        h("button", { class: "ml-chip", text: "全选", onClick: () => { state.selectedTurnIds = new Set(state.exportTurns.map((t) => t.id)); render(); } }),
        h("button", { class: "ml-chip", text: "清空", onClick: () => { state.selectedTurnIds.clear(); render(); } }),
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
    if (settingsModalOpen) return;
    settingsModalOpen = true;
    const backdrop = h("div", { class: "ml-modal-backdrop" });
    const closeSettings = () => {
      settingsModalOpen = false;
      backdrop.remove();
      render();
    };
    const select = h("select", { class: "ml-select" });
    Object.entries(S.PLAN_PROFILES).forEach(([key, profile]) => select.append(h("option", { value: key, text: profile.label })));
    select.value = state.settings.quotaProfile;

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
            h("small", { text: `current ${periodLabel(row.hours)} window` })
          ),
          h("div", { class: "ml-stepper" }, minus, count, plus)
        ));
      }
    };
    renderManualList();

    const modal = h("div", { class: "ml-modal" },
      h("div", { class: "ml-modal-title" }, h("strong", { text: "GPT Lens Settings" }), h("button", { class: "ml-icon-button", text: "×", onClick: closeSettings })),
      h("label", { class: "ml-field" }, h("span", { text: "Quota profile" }), select),
      h("label", { class: "ml-toggle-row" },
        h("input", { type: "checkbox", checked: state.settings.autoUseDetectedPlan }),
        h("span", { text: "自动使用 ChatGPT 检测到的套餐（x5/x20 仍需手动选择）" })
      ),
      h("div", { class: "ml-divider" }),
      h("div", { class: "ml-field-title", text: "Manual usage correction" }),
      h("div", { class: "ml-field-help", text: "Use + to add a local call. − offsets one recorded call in the same quota window. Corrections are stored locally and included in Google sync." }),
      manualList,
      h("div", { class: "ml-divider" }),
      h("div", { class: "ml-field-title", text: "Google Drive sync" }),
      syncStatus,
      h("div", { class: "ml-button-row" },
        h("button", { class: "ml-secondary", text: "Sign in", onClick: async () => { syncStatus.textContent = "Signing in…"; syncStatus.textContent = await googleAction("GOOGLE_SIGN_IN"); } }),
        h("button", { class: "ml-secondary", text: "Sync now", onClick: async () => { syncStatus.textContent = "Syncing…"; syncStatus.textContent = await googleAction("GOOGLE_SYNC_NOW"); } }),
        h("button", { class: "ml-secondary", text: "Sign out", onClick: async () => { syncStatus.textContent = await googleAction("GOOGLE_SIGN_OUT"); } })
      ),
      h("div", { class: "ml-divider" }),
      h("button", { class: "ml-danger", text: "Clear local usage history", onClick: async () => {
        if (!confirm("Clear GPT Lens local usage history?")) return;
        state.events = [];
        await saveEvents();
        closeSettings();
      } })
    );
    backdrop.append(modal);
    root.append(backdrop);

    select.addEventListener("change", () => saveSettings({ quotaProfile: select.value, autoUseDetectedPlan] ? true : false }));
    modal.querySelector(".ml-toggle-row input").addEventListener("change", (e) => saveSettings({ autoUseDetectedPlan] ? e.target.checked : false }));
    googleAction("GOOGLE_STATUS").then((text) => { syncStatus.textContent = text; });
  }

  async function googleAction(type) {
    try {
      const result = await chrome.runtime.sendMessage({ type });
      if (!result?.ok) return result?.error || "Google sync unavailable";
      if (type === "GOOGLE_SYNC_NOW") {
        await loadState();
        if (!settingsModalOpen) render();
      }
      return result.message || (result.email ? `Connected: ${result.email}` : "Done");
    } catch (error) {
      return String(error?.message || error);
    }
  }

  function render() {
    root.className = state.settings.collapsed ? "is-collapsed" : "";
    root.replaceChildren();

    if (state.settings.collapsed) {
      const latest = mostRecentEvent();
      const status = statusInfo(latest?.status || "unverified");
      root.append(h("button", {
        class: `ml-rail ${status.cls}`,
        title: "Open GPT Lens",
        onClick: () => saveSettings({ collapsed: false }
      }, h("span", { class: "ml-rail-dot" }), h("span", { class: "ml-rail-mark", text: "M" })));
      return;
    }

    const shell = h("div", { class: "ml-shell" },
      h("header", { class: "ml-header" },
        h("div", { class: "ml-brand" }, h("span", { class: "ml-brand-mark", text: "M" }), h("strong", { text: "GPT Lens" })),
        h("div", { class: "ml-header-actions" },
          h("button", { class: "ml-icon-button", title: "Settings", text: "⋯", onClick: openSettings }),
          h("button", { class: "ml-icon-button", title: "Collapse", text: "›", onClick: () => saveSettings({ collapsed: true }) })
        )
      ),
      h("nav", { class: "ml-segmented" },
        h("button", { class: state.settings.view === "monitor" ? "active" : "", text: "Monitor", onClick: () => saveSettings({ view: "monitor" }) }),
        h("button", { class: state.settings.view === "export" ? "active" : "", text: "Select · Export", onClick: () => { refreshExportTurns(true); saveSettings({ view: "export" }); } })
      ),
      state.settings.view === "export" ? renderExport() : renderMonitor()
    );
    root.append(shell);
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.modelLensEvents || changes.modelLensSettings || changes.modelLensSyncMeta) {
      await loadState();
      if (!settingsModalOpen) render();
    }
  });

  (async () => {
    await loadState();
    render();
  })();
})();
