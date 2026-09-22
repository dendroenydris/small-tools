(() => {
  if (window.__MODEL_LENS_BRIDGE_INSTALLED__) return;
  window.__MODEL_LENS_BRIDGE_INSTALLED__ = true;

  const CHANNEL = "__MODEL_LENS__";
  const nativeFetch = window.fetch;
  const nativeWebSocket = window.WebSocket;
  const nativeEventSource = window.EventSource;
  const REQUEST_URL_RE = /\/backend-api\/(?:f\/)?conversation(?:$|[/?#])/;
  const CONVERSATION_JSON_RE = /\/backend-api\/conversation\/[^/?#]+(?:$|[/?#])/;

  const post = (kind, payload = {}) => {
    window.postMessage({ channel: CHANNEL, kind, payload }, "*");
  };

  function getUrl(input) {
    try {
      if (input instanceof Request) return input.url;
      return new URL(String(input), location.href).href;
    } catch {
      return String(input || "");
    }
  }

  function conversationIdFromLocation() {
    const match = location.pathname.match(/\/c\/([0-9a-z-]+)/i);
    return match?.[1] || null;
  }

  function looksLikeModelSlug(value) {
    return typeof value === "string" && /^(?:gpt-|o[1345](?:-|$)|chatgpt-)/i.test(value) && value.length < 120;
  }

  function walkForModelCandidates(value, ctx = {}, out = [], depth = 0) {
    if (depth > 14 || value == null) return out;
    if (Array.isArray(value)) {
      for (const item of value) walkForModelCandidates(item, ctx, out, depth + 1);
      return out;
    }
    if (typeof value !== "object") return out;

    const authorRole = value.author?.role || ctx.authorRole;
    const conversationId = value.conversation_id || value.conversationId || ctx.conversationId;
    const messageId = value.id || value.message_id || ctx.messageId;
    const createTime = value.create_time || value.created_at || ctx.createTime;
    const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata : null;

    const push = (model, sourceField, confidence = "strong") => {
      if (!looksLikeModelSlug(model)) return;
      out.push({
        model,
        sourceField,
        confidence,
        conversationId: conversationId || null,
        messageId: messageId || null,
        createTime: createTime || null,
        authorRole: authorRole || null
      });
    };

    push(value.backend_model, "backend_model", "strong");
    push(value.model_slug, "model_slug", "strong");
    push(value.served_model, "served_model", "strong");
    if (metadata) {
      push(metadata.backend_model, "metadata.backend_model", "strong");
      push(metadata.model_slug, "metadata.model_slug", "strong");
      push(metadata.served_model, "metadata.served_model", "strong");
      push(metadata.model, "metadata.model", "medium");
    }

    if (looksLikeModelSlug(value.model) && (authorRole === "assistant" || metadata || value.message)) {
      push(value.model, "model", "medium");
    }

    const nextCtx = { authorRole, conversationId, messageId, createTime };
    for (const [key, child] of Object.entries(value)) {
      if (key === "content" && typeof child === "string") continue;
      walkForModelCandidates(child, nextCtx, out, depth + 1);
    }
    return out;
  }

  function chooseBestCandidate(candidates) {
    const assistant = candidates.filter((c) => c.authorRole === "assistant");
    const pool = assistant.length ? assistant : candidates;
    if (!pool.length) return null;
    const score = (c) => {
      let s = c.confidence === "strong" ? 100 : 60;
      if (c.authorRole === "assistant") s += 25;
      if (c.createTime) s += Math.min(20, Number(c.createTime) / 1e12 || 0);
      return s;
    };
    return pool.slice().sort((a, b) => score(b) - score(a))[0];
  }

  function inspectStructuredBackend(value, source, explicitConversationId = null) {
    try {
      const candidates = walkForModelCandidates(value, { conversationId: explicitConversationId });
      const best = chooseBestCandidate(candidates);
      if (!best) return;
      post("backend-model", {
        backendModel: best.model,
        source,
        sourceField: best.sourceField,
        confidence: best.confidence,
        conversationId: best.conversationId || explicitConversationId || conversationIdFromLocation(),
        messageId: best.messageId,
        timestamp: new Date().toISOString()
      });
    } catch {}
  }

  function conversationIdFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      const match = u.pathname.match(/\/backend-api\/conversation\/([^/]+)/);
      return match?.[1] || null;
    } catch {
      return null;
    }
  }

  async function inspectResponseClone(response, url) {
    let clone;
    try { clone = response.clone(); } catch { return; }
    const contentType = clone.headers.get("content-type") || "";
    const shouldInspect = REQUEST_URL_RE.test(url) || CONVERSATION_JSON_RE.test(url);
    if (!shouldInspect) return;

    try {
      if (contentType.includes("application/json")) {
        const data = await clone.json();
        inspectStructuredBackend(data, "fetch-json", conversationIdFromUrl(url));
        return;
      }

      const text = await clone.text();
      if (!text || text === "ok") return;
      try {
        inspectStructuredBackend(JSON.parse(text), "fetch-text-json", conversationIdFromUrl(url));
      } catch {
        const matches = [...text.matchAll(/"(?:backend_model|model_slug|served_model)"\s*:\s*"([^"]+)"/g)];
        if (matches.length) {
          post("backend-model", {
            backendModel: matches[matches.length - 1][1],
            source: "fetch-text",
            sourceField: "regex-model-field",
            confidence: "strong",
            conversationId: conversationIdFromUrl(url) || conversationIdFromLocation(),
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch {}
  }

  window.fetch = function patchedFetch(input, init) {
    const url = getUrl(input);
    const promise = nativeFetch.apply(this, arguments);
    promise.then((response) => inspectResponseClone(response, url)).catch(() => {});
    return promise;
  };

  if (nativeWebSocket) {
    function ModelLensWebSocket(url, protocols) {
      const socket = protocols === undefined ? new nativeWebSocket(url) : new nativeWebSocket(url, protocols);
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || !/model|metadata|conversation/i.test(event.data)) return;
        try { inspectStructuredBackend(JSON.parse(event.data), "websocket"); } catch {}
      });
      return socket;
    }
    ModelLensWebSocket.prototype = nativeWebSocket.prototype;
    Object.setPrototypeOf(ModelLensWebSocket, nativeWebSocket);
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      try { Object.defineProperty(ModelLensWebSocket, key, { value: nativeWebSocket[key] }); } catch {}
    }
    window.WebSocket = ModelLensWebSocket;
  }

  if (nativeEventSource) {
    function ModelLensEventSource(url, config) {
      const es = new nativeEventSource(url, config);
      es.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || !/model|metadata|conversation/i.test(event.data)) return;
        try { inspectStructuredBackend(JSON.parse(event.data), "eventsource"); } catch {}
      });
      return es;
    }
    ModelLensEventSource.prototype = nativeEventSource.prototype;
    Object.setPrototypeOf(ModelLensEventSource, nativeEventSource);
    window.EventSource = ModelLensEventSource;
  }

  post("bridge-ready", { timestamp: new Date().toISOString() });
})();
