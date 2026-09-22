(() => {
  if (window.__MODEL_LENS_BRIDGE_INSTALLED__) return;
  window.__MODEL_LENS_BRIDGE_INSTALLED__ = true;

  const CHANNEL = "__MODEL_LENS__";
  const R = globalThis.ModelLensRouteParser;
  if (!R) return;

  const nativeFetch = window.fetch;
  const nativeWebSocket = window.WebSocket;
  const PLAN_RE = /\/ces\/v1\/i(?:$|[/?#])/;
  const PENDING_TTL_MS = 10 * 60 * 1000;
  const MAX_PENDING = 32;
  const MAX_TOPICS = 8;

  let lastObservedPlan = null;
  const pending = new Map();

  const post = (kind, payload = {}) => {
    window.postMessage({ channel: CHANNEL, kind, payload }, "*");
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function requestUrl(input) {
    try {
      if (input instanceof Request) return input.url;
      return new URL(String(input), location.href).href;
    } catch {
      return String(input || "");
    }
  }

  function requestMethod(input, init) {
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    return String(method || "GET").toUpperCase();
  }

  async function requestBody(input, init) {
    if (typeof init?.body === "string") return init.body;
    if (input instanceof Request) {
      try { return await input.clone().text(); }
      catch { return null; }
    }
    if (init?.body instanceof URLSearchParams) return init.body.toString();
    if (typeof Blob !== "undefined" && init?.body instanceof Blob) {
      try { return await init.body.text(); }
      catch { return null; }
    }
    if (init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body)) {
      try {
        const body = init.body;
        const bytes = body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        return new TextDecoder().decode(bytes);
      } catch {
        return null;
      }
    }
    return null;
  }

  function parsePlanBody(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const plan = parsed?.traits?.plan_type;
      return typeof plan === "string" && plan ? plan.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function boundedId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
  }

  function fieldsSignature(fields) {
    return JSON.stringify([
      fields.requestedModel,
      fields.responseModelSlug,
      fields.resolvedModelSlug,
      fields.serverModelSlug,
      fields.requestId,
      fields.conversationId,
      fields.thinkingEffort,
      fields.planType
    ]);
  }

  function hasResponseEvidence(fields) {
    return Boolean(fields.resolvedModelSlug || fields.serverModelSlug || fields.responseModelSlug);
  }

  function prunePending(timestamp = Date.now()) {
    for (const [id, capture] of pending) {
      if (!capture.httpActive && capture.expiresAt <= timestamp) pending.delete(id);
    }
  }

  function registerPending(captureId, startedAt, parsed, pageUrl) {
    const c = parsed.correlation;
    if (!c.conversationId && !c.inputMessageId && !c.parentMessageId) return;
    prunePending();
    while (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (!oldest) break;
      pending.delete(oldest);
    }
    pending.set(captureId, {
      captureId,
      startedAt,
      pageUrl,
      conversationId: c.conversationId,
      inputMessageId: c.inputMessageId,
      parentMessageId: c.parentMessageId,
      requestFields: parsed.fields,
      expiresAt: Date.now() + PENDING_TTL_MS,
      httpActive: true,
      topicIds: new Set(),
      webSocketFields: R.emptyFields(),
      lastWebSocketSignature: fieldsSignature(R.emptyFields())
    });
  }

  function rememberTopic(capture, topicId) {
    if (topicId && capture.topicIds.size < MAX_TOPICS) capture.topicIds.add(topicId);
  }

  function emitObservation(captureId, fields, phase, source, startedAt, pageUrl) {
    const assessment = R.assessRoute(fields);
    const routeSources = assessment.routeSources || [];
    const labelSources = assessment.modelLabelSources || [];
    const backendSource = routeSources.length
      ? routeSources.join(" + ")
      : labelSources.join(" + ");

    post("route-observation", {
      captureId,
      phase,
      source,
      startedAt,
      observedAt: nowIso(),
      pageUrl,
      requestedModel: fields.requestedModel || null,
      backendModel: assessment.routeModel || null,
      backendSource: backendSource || null,
      backendExplicit: routeSources.some((name) => name !== "assistant.metadata.model_slug"),
      modelLabel: assessment.modelLabel || null,
      verdict: assessment.verdict,
      routeSources,
      requestId: fields.requestId || null,
      conversationId: fields.conversationId || null,
      thinkingEffort: fields.thinkingEffort || null,
      resolvedModelSlug: fields.resolvedModelSlug || null,
      serverModelSlug: fields.serverModelSlug || null,
      responseModelSlug: fields.responseModelSlug || null
    });

    if (fields.planType) {
      lastObservedPlan = String(fields.planType).toLowerCase();
      post("plan-observed", { plan: lastObservedPlan });
    }
  }

  async function parseSseStream(response, captureId, startedAt, baseFields, pageUrl) {
    if (!response.body?.getReader) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let handedOff = false;
    const parser = new R.ResponseStreamParser((event) => {
      const value = event?.value && typeof event.value === "object" && !Array.isArray(event.value)
        ? event.value
        : null;
      if (value?.type === "stream_handoff" || value?.type === "subscribe_ws_topic") {
        handedOff = true;
        const capture = pending.get(captureId);
        if (capture) rememberTopic(capture, boundedId(value.topic_id) || boundedId(value.topic));
      }
    });

    let fields = baseFields;
    let lastSignature = fieldsSignature(fields);

    try {
      while (true) {
        const { value, done } = await reader.read();
        fields = R.mergeFields(baseFields, parser.push(decoder.decode(value || new Uint8Array(), { stream: !done })));
        const capture = pending.get(captureId);
        if (capture) {
          capture.expiresAt = Date.now() + PENDING_TTL_MS;
          if (!capture.conversationId && fields.conversationId) capture.conversationId = fields.conversationId;
        }

        const signature = fieldsSignature(fields);
        if (signature !== lastSignature) {
          lastSignature = signature;
          emitObservation(captureId, fields, "responding", "page_fetch", startedAt, pageUrl);
        }
        if (done) break;
      }
      fields = R.mergeFields(baseFields, parser.finish());
    } finally {
      try { await reader.cancel(); } catch {}
      const capture = pending.get(captureId);
      if (capture) {
        capture.httpActive = false;
        capture.expiresAt = Date.now() + PENDING_TTL_MS;
      }
    }

    emitObservation(
      captureId,
      fields,
      handedOff ? "responding" : "completed",
      "page_fetch",
      startedAt,
      pageUrl
    );
    if (!handedOff) pending.delete(captureId);
  }

  function uniqueCandidate(candidates) {
    return candidates.length === 1 ? candidates[0] : null;
  }

  function pendingCaptureFor(evidence) {
    prunePending();
    const captures = [...pending.values()];

    const inputMatches = captures.filter((candidate) =>
      candidate.inputMessageId &&
      (evidence.messageIds.includes(candidate.inputMessageId) ||
       evidence.parentIds.includes(candidate.inputMessageId))
    );

    const compatible = (candidate) =>
      (!candidate.conversationId || evidence.conversationIds.length === 0 ||
       evidence.conversationIds.includes(candidate.conversationId)) &&
      (!evidence.topicId || candidate.topicIds.size === 0 || candidate.topicIds.has(evidence.topicId));

    const parentMatches = captures.filter((candidate) =>
      candidate.parentMessageId &&
      evidence.parentIds.includes(candidate.parentMessageId) &&
      (evidence.conversationIds.length === 0 ||
       !candidate.conversationId || evidence.conversationIds.includes(candidate.conversationId))
    );

    const topicMatches = captures.filter((candidate) =>
      evidence.topicId && candidate.topicIds.has(evidence.topicId)
    );

    if (topicMatches.length) {
      const match = uniqueCandidate(topicMatches);
      const identityMatches = inputMatches.length ? inputMatches : parentMatches;
      return match && compatible(match) && (!identityMatches.length || identityMatches.includes(match))
        ? match
        : null;
    }

    if (inputMatches.length) return uniqueCandidate(inputMatches.filter(compatible));
    if (parentMatches.length) return uniqueCandidate(parentMatches.filter(compatible));

    const conversationMatches = captures.filter((candidate) =>
      candidate.conversationId && evidence.conversationIds.includes(candidate.conversationId)
    );
    return uniqueCandidate(conversationMatches.filter(compatible));
  }

  function handleWebSocketText(raw, parser) {
    if (pending.size === 0) {
      parser.clear();
      return;
    }

    const evidenceItems = parser.parse(raw);
    for (const evidence of evidenceItems) {
      const capture = pendingCaptureFor(evidence);
      if (!capture) continue;

      capture.expiresAt = Date.now() + PENDING_TTL_MS;
      rememberTopic(capture, evidence.topicId);
      if (!capture.conversationId && evidence.conversationIds.length === 1) {
        capture.conversationId = evidence.conversationIds[0];
      }

      if (evidence.errorCode) {
        pending.delete(capture.captureId);
        continue;
      }

      capture.webSocketFields = R.mergeFields(
        capture.requestFields,
        capture.webSocketFields,
        evidence.fields,
        { conversationId: capture.conversationId }
      );

      const signature = fieldsSignature(capture.webSocketFields);
      const meaningful = hasResponseEvidence(capture.webSocketFields) ||
        Boolean(capture.webSocketFields.requestId || capture.webSocketFields.planType);

      if (meaningful && (signature !== capture.lastWebSocketSignature || evidence.terminal)) {
        capture.lastWebSocketSignature = signature;
        emitObservation(
          capture.captureId,
          capture.webSocketFields,
          evidence.terminal ? "completed" : "responding",
          "page_websocket",
          capture.startedAt,
          capture.pageUrl
        );
      }

      if (evidence.streamEnded) pending.delete(capture.captureId);
    }
  }

  async function inspectFetch(downstream, receiver, input, init) {
    const url = requestUrl(input);
    const endpoint = R.classifyEndpoint(url);
    const method = requestMethod(input, init);

    if (PLAN_RE.test(url) && method === "POST") {
      void requestBody(input, init).then((raw) => {
        const plan = parsePlanBody(raw);
        if (plan) {
          lastObservedPlan = plan;
          post("plan-observed", { plan });
        }
      });
    }

    if (endpoint.kind !== "conversation_stream" || method !== "POST") {
      return downstream.call(receiver, input, init);
    }

    const captureId = crypto.randomUUID ? crypto.randomUUID() : `ml-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startedAt = nowIso();
    const pageUrl = location.href;
    const bodyPromise = requestBody(input, init);

    const requestFieldsPromise = bodyPromise.then((raw) => {
      if (!raw) return null;
      const parsed = R.parseConversationCapture(raw);
      if (!parsed.fields.requestedModel) return null;
      registerPending(captureId, startedAt, parsed, pageUrl);
      emitObservation(captureId, parsed.fields, "requested", "page_fetch", startedAt, pageUrl);
      return parsed.fields;
    }).catch(() => null);

    let response;
    try {
      response = await downstream.call(receiver, input, init);
    } catch (error) {
      pending.delete(captureId);
      throw error;
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
    if (!response.ok || contentType !== "text/event-stream") return response;

    try {
      const clone = response.clone();
      void requestFieldsPromise.then((fields) => {
        if (!fields) {
          try { clone.body?.cancel(); } catch {}
          return;
        }
        return parseSseStream(clone, captureId, startedAt, fields, pageUrl);
      }).catch(() => pending.delete(captureId));
    } catch {
      pending.delete(captureId);
    }

    return response;
  }

  let downstreamFetch = nativeFetch;
  let fetchWrapper;

  function makeFetchWrapper() {
    const wrapper = function modelLensFetch(input, init) {
      return inspectFetch(downstreamFetch, this, input, init);
    };
    try {
      Object.defineProperty(wrapper, "name", { value: "fetch", configurable: true });
      Object.defineProperty(wrapper, "length", { value: downstreamFetch.length, configurable: true });
    } catch {}
    return wrapper;
  }

  function installFetchHook() {
    try {
      const current = window.fetch;
      if (typeof current === "function" && current !== fetchWrapper) downstreamFetch = current;
    } catch {}
    fetchWrapper = makeFetchWrapper();
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, "fetch");
      Object.defineProperty(window, "fetch", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() { return fetchWrapper; },
        set(candidate) {
          if (typeof candidate === "function" && candidate !== fetchWrapper) {
            downstreamFetch = candidate;
            fetchWrapper = makeFetchWrapper();
          }
        }
      });
    } catch {
      window.fetch = fetchWrapper;
    }
  }

  const observedSockets = new WeakSet();

  function isAllowedWebSocket(url) {
    try {
      const parsed = new URL(String(url), location.href);
      if (!["ws:", "wss:"].includes(parsed.protocol)) return false;
      const host = parsed.hostname.toLowerCase();
      return host === "chatgpt.com" || host.endsWith(".chatgpt.com") ||
        host === "openai.com" || host.endsWith(".openai.com");
    } catch {
      return false;
    }
  }

  function observeWebSocket(socket) {
    if (observedSockets.has(socket) || !isAllowedWebSocket(socket.url)) return;
    observedSockets.add(socket);
    const parser = new R.WebSocketRouteParser();
    socket.addEventListener("close", () => parser.clear(), { once: true });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const raw = event.data;
      queueMicrotask(() => handleWebSocketText(raw, parser));
    });
  }

  let downstreamWebSocket = nativeWebSocket;
  let webSocketWrapper;

  function copyWebSocketShape(wrapper, downstream) {
    try { Object.setPrototypeOf(wrapper, Object.getPrototypeOf(downstream)); } catch {}
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      const descriptor = Object.getOwnPropertyDescriptor(downstream, key) ||
        Object.getOwnPropertyDescriptor(nativeWebSocket, key);
      if (!descriptor) continue;
      try { Object.defineProperty(wrapper, key, descriptor); } catch {}
    }
    try {
      Object.defineProperty(wrapper, "prototype", {
        value: downstream.prototype,
        writable: false,
        enumerable: false,
        configurable: false
      });
    } catch {}
  }

  function makeWebSocketWrapper() {
    const wrapper = function WebSocket(url, protocols) {
      if (!new.target) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
      const args = arguments.length > 1 ? [url, protocols] : [url];
      const target = new.target === wrapper ? downstreamWebSocket : new.target;
      const socket = Reflect.construct(downstreamWebSocket, args, target);
      observeWebSocket(socket);
      return socket;
    };
    copyWebSocketShape(wrapper, downstreamWebSocket);
    return wrapper;
  }

  function installWebSocketHook() {
    try {
      const current = window.WebSocket;
      if (typeof current === "function" && current !== webSocketWrapper) downstreamWebSocket = current;
    } catch {}
    webSocketWrapper = makeWebSocketWrapper();
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, "WebSocket");
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() { return webSocketWrapper; },
        set(candidate) {
          if (typeof candidate === "function" && candidate !== webSocketWrapper) {
            downstreamWebSocket = candidate;
            webSocketWrapper = makeWebSocketWrapper();
          }
        }
      });
    } catch {
      window.WebSocket = webSocketWrapper;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL || event.data?.kind !== "request-snapshot") return;
    if (lastObservedPlan) post("plan-observed", { plan: lastObservedPlan });
  });

  installFetchHook();
  installWebSocketHook();
  queueMicrotask(() => {
    installFetchHook();
    installWebSocketHook();
  });
  document.addEventListener("DOMContentLoaded", () => {
    installFetchHook();
    installWebSocketHook();
  }, { once: true });
  window.addEventListener("load", () => {
    installFetchHook();
    installWebSocketHook();
  }, { once: true });
  window.setInterval(() => {
    installFetchHook();
    installWebSocketHook();
    prunePending();
  }, 1000);

  post("bridge-ready", { timestamp: nowIso(), detector: "route-inspector-style-v1" });
})();
