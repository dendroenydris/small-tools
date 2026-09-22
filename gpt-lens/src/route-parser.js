(() => {
  if (globalThis.ModelLensRouteParser) return;

  const EMPTY_FIELDS = Object.freeze({
    requestedModel: null,
    responseModelSlug: null,
    resolvedModelSlug: null,
    serverModelSlug: null,
    requestId: null,
    conversationId: null,
    thinkingEffort: null,
    planType: null
  });

  const METADATA_KEYS = new Set([
    "message", "messages", "metadata", "server_ste_metadata", "author", "role", "type",
    "id", "parent", "parent_id", "conversation_id", "model_slug", "default_model_slug",
    "resolved_model_slug", "plan_type", "request_id", "thinking_effort", "topic_id", "topic"
  ]);
  const PATCH_OPS = new Set(["add", "replace", "append", "remove", "truncate", "patch"]);

  function emptyFields() {
    return { ...EMPTY_FIELDS };
  }

  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function stringValue(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  function boundedId(value) {
    const s = stringValue(value);
    return s && s.length <= 512 ? s : null;
  }

  function mergeFields(...items) {
    const out = emptyFields();
    for (const item of items) {
      if (!item) continue;
      for (const key of Object.keys(out)) {
        const value = item[key];
        if (value !== null && value !== undefined) out[key] = value;
      }
    }
    return out;
  }

  function classifyEndpoint(input, base = location.href) {
    let url;
    try { url = new URL(String(input), base); }
    catch { return { kind: "other", conversationId: null }; }

    if (url.pathname === "/backend-api/conversation" || /^\/backend-api\/f\/conversations?$/.test(url.pathname)) {
      return { kind: "conversation_stream", conversationId: null };
    }

    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
    if (pathname === "/backend-api/conversation/init") {
      return { kind: "conversation_init", conversationId: null };
    }

    if (new Set([
      "/backend-api/sentinel/chat-requirements/prepare",
      "/backend-anon/sentinel/chat-requirements/prepare",
      "/api/sentinel/chat-requirements/prepare",
      "/backend-api/sentinel/chat-requirements",
      "/backend-anon/sentinel/chat-requirements",
      "/api/sentinel/chat-requirements"
    ]).has(pathname)) {
      return { kind: "pow_requirements", conversationId: null };
    }

    const match = /^\/backend-api\/conversations?\/([^/]+)$/.exec(url.pathname);
    if (match?.[1] && !["cursor", "offset", "before", "after"].some((key) => url.searchParams.has(key))) {
      try { return { kind: "conversation_record", conversationId: decodeURIComponent(match[1]) }; }
      catch { return { kind: "other", conversationId: null }; }
    }

    return { kind: "other", conversationId: null };
  }

  function parseConversationCapture(raw) {
    let root;
    try { root = asRecord(JSON.parse(raw)); }
    catch { root = null; }
    if (!root) {
      return {
        fields: emptyFields(),
        correlation: { conversationId: null, inputMessageId: null, parentMessageId: null }
      };
    }

    const messages = Array.isArray(root.messages) ? root.messages : [];
    const first = asRecord(messages[0]);
    return {
      fields: {
        ...emptyFields(),
        requestedModel: stringValue(root.model),
        thinkingEffort: stringValue(root.thinking_effort),
        conversationId: boundedId(root.conversation_id)
      },
      correlation: {
        conversationId: boundedId(root.conversation_id),
        inputMessageId: boundedId(first?.id),
        parentMessageId: boundedId(root.parent_message_id)
      }
    };
  }

  function extractMetadata(metadata, kind = "none") {
    const model = stringValue(metadata?.model_slug);
    return {
      ...emptyFields(),
      responseModelSlug: kind === "assistant" ? model : null,
      serverModelSlug: kind === "server" ? model : null,
      resolvedModelSlug: stringValue(metadata?.resolved_model_slug),
      requestId: boundedId(metadata?.request_id),
      conversationId: boundedId(metadata?.conversation_id),
      planType: stringValue(metadata?.plan_type)
    };
  }

  function walkForFields(value, fields = emptyFields(), depth = 0, budget = { count: 0 }) {
    if (depth > 10 || budget.count > 3000) return fields;
    budget.count += 1;

    if (Array.isArray(value)) {
      let result = fields;
      for (const item of value.slice(0, 128)) {
        if (budget.count > 3000) break;
        result = walkForFields(item, result, depth + 1, budget);
      }
      return result;
    }

    const record = asRecord(value);
    if (!record) return fields;
    let result = fields;
    const metadata = asRecord(record.metadata);

    if (record.type === "server_ste_metadata" && metadata) {
      result = mergeFields(result, extractMetadata(metadata, "server"));
    } else {
      result = mergeFields(result, extractMetadata(record));
      if (metadata) {
        const author = asRecord(record.author);
        result = mergeFields(result, extractMetadata(metadata, author?.role === "assistant" ? "assistant" : "none"));
      }
    }

    if (typeof record.conversation_id === "string") {
      result = mergeFields(result, { conversationId: record.conversation_id });
    }

    for (const [key, nested] of Object.entries(record)) {
      if (budget.count > 3000) break;
      if (["content", "parts", "text", "args", "arguments", "input", "output"].includes(key)) continue;
      if (record.type === "server_ste_metadata" && key === "metadata") continue;
      if (nested && typeof nested === "object") {
        result = walkForFields(nested, result, depth + 1, budget);
      }
    }
    return result;
  }

  function projectMetadata(value, depth = 0, budget = { nodes: 0 }) {
    if (++budget.nodes > 4096 || depth > 16) throw new Error("stream_metadata_limit");
    if (typeof value === "string") return value.length <= 1024 ? value : undefined;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) {
      if (value.length > 128) throw new Error("stream_metadata_limit");
      return value.map((item) => projectMetadata(item, depth + 1, budget));
    }
    const source = asRecord(value);
    if (!source) return undefined;
    const out = {};
    for (const [key, item] of Object.entries(source)) {
      if (!METADATA_KEYS.has(key)) continue;
      const projected = projectMetadata(item, depth + 1, budget);
      if (projected !== undefined) out[key] = projected;
    }
    return out;
  }

  class SseDecoder {
    constructor() {
      this.buffer = "";
      this.eventName = "";
      this.data = [];
      this.dataLength = 0;
      this.previous = { channel: 0, path: "", op: "add" };
      this.channels = new Map();
    }

    push(text, onEvent) {
      this.buffer += text;
      let start = 0;
      for (let i = 0; i < this.buffer.length; i += 1) {
        const ch = this.buffer[i];
        if (ch !== "\r" && ch !== "\n") continue;
        if (ch === "\r" && i + 1 === this.buffer.length) break;
        const line = this.buffer.slice(start, i);
        if (ch === "\r" && this.buffer[i + 1] === "\n") i += 1;
        start = i + 1;
        this.line(line, onEvent);
      }
      this.buffer = this.buffer.slice(start);
      if (this.buffer.length > 1024 * 1024) throw new Error("stream_event_too_large");
    }

    finish(onEvent) {
      if (this.buffer) this.line(this.buffer.replace(/\r$/, ""), onEvent);
      this.buffer = "";
      this.dispatch(onEvent);
    }

    line(line, onEvent) {
      if (line.length > 1024 * 1024) throw new Error("stream_event_too_large");
      if (line === "") {
        this.dispatch(onEvent);
        return;
      }
      if (line.startsWith(":")) return;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") this.eventName = value;
      if (field === "data") {
        this.dataLength += value.length + 1;
        if (this.dataLength > 1024 * 1024) throw new Error("stream_event_too_large");
        this.data.push(value);
      }
    }

    dispatch(onEvent) {
      const payload = this.data.join("\n");
      const name = this.eventName;
      this.data = [];
      this.dataLength = 0;
      this.eventName = "";
      if (!payload) return;

      if (payload === "[DONE]") {
        onEvent({ value: null, done: true });
        this.channels.clear();
        this.previous = { channel: 0, path: "", op: "add" };
        return;
      }

      let value;
      try { value = JSON.parse(payload); }
      catch {
        if (name === "delta" || name === "delta_encoding") throw new Error("invalid_stream_delta");
        for (const line of payload.split("\n")) {
          try { onEvent({ value: JSON.parse(line), done: false }); } catch {}
        }
        return;
      }

      if (name === "delta_encoding") {
        if (value !== "v1") throw new Error("unsupported_delta_encoding");
        this.channels.clear();
        this.previous = { channel: 0, path: "", op: "add" };
        onEvent({ value: null, done: false, reset: true });
        return;
      }

      const item = asRecord(value);
      if (name === "delta" && item && ("v" in item || "o" in item || "p" in item || "c" in item)) {
        value = this.delta(item);
      }
      onEvent({ value, done: false });
    }

    delta(item) {
      const channel = "c" in item ? item.c : this.previous.channel;
      const path = "p" in item ? item.p : this.previous.path;
      const op = "o" in item ? item.o : this.previous.op;
      if (!Number.isSafeInteger(channel) || channel < 0 || typeof path !== "string" || path.length > 1024 ||
          typeof op !== "string" || !PATCH_OPS.has(op)) {
        throw new Error("invalid_stream_delta");
      }
      const header = { channel, path, op };
      const result = this.apply(this.channels.get(channel), header, item.v, { operations: 0 });
      this.previous = header;
      this.channels.set(channel, result);
      return result;
    }

    apply(root, delta, value, budget, depth = 0) {
      if (++budget.operations > 512 || depth > 16) throw new Error("stream_patch_limit");
      const tokens = delta.path === ""
        ? []
        : delta.path.replace(/^\//, "").split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      if (tokens.length > 16) throw new Error("stream_patch_limit");
      if (tokens.some((part) => !METADATA_KEYS.has(part) && !/^(?:0|[1-9]\d{0,2})$/.test(part))) return root;

      const box = { root };
      let parent = box;
      let key = "root";
      for (const token of tokens) {
        let child = parent[key];
        if (!child || typeof child !== "object") {
          child = /^\d+$/.test(token) ? [] : {};
          parent[key] = child;
        }
        parent = child;
        key = Array.isArray(parent) ? Number(token) : token;
        if (Array.isArray(parent) && (!Number.isSafeInteger(key) || key >= 128)) throw new Error("stream_metadata_limit");
      }

      const old = parent[key];
      if (delta.op === "patch") {
        if (!Array.isArray(value) || value.length > 512) throw new Error("invalid_stream_delta");
        let patched = old;
        for (const entry of value) {
          const child = asRecord(entry);
          if (!child || typeof child.o !== "string") throw new Error("invalid_stream_delta");
          patched = this.apply(
            patched,
            { channel: delta.channel, path: typeof child.p === "string" ? child.p : "", op: child.o },
            child.v,
            budget,
            depth + 1
          );
        }
        parent[key] = patched;
      } else if (delta.op === "remove") {
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else delete parent[key];
      } else if (delta.op === "truncate") {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_stream_delta");
        if (typeof old === "string") parent[key] = old.slice(0, value);
        else if (Array.isArray(old)) old.length = Math.min(old.length, value);
      } else {
        const next = projectMetadata(value);
        if (delta.op === "append" && typeof old === "string" && typeof next === "string") {
          parent[key] = old + next;
        } else if (delta.op === "append" && Array.isArray(old)) {
          old.push(...(Array.isArray(next) ? next : [next]));
        } else if (delta.op === "append" && asRecord(old) && asRecord(next)) {
          Object.assign(old, next);
        } else if (delta.op === "add" && Array.isArray(parent)) {
          parent.splice(Number(key), 0, next);
        } else {
          parent[key] = next;
        }
      }
      return box.root;
    }
  }

  class ResponseStreamParser {
    constructor(onEvent) {
      this.decoder = new SseDecoder();
      this.fields = emptyFields();
      this.onEvent = onEvent;
    }

    accept(event) {
      if (event.reset) this.fields = emptyFields();
      if (!event.done) this.fields = walkForFields(event.value, this.fields);
      if (this.onEvent) this.onEvent(event);
    }

    push(text) {
      this.decoder.push(text, (event) => this.accept(event));
      return { ...this.fields };
    }

    finish() {
      this.decoder.finish((event) => this.accept(event));
      return { ...this.fields };
    }
  }

  function pushUnique(list, value) {
    if (value && !list.includes(value) && list.length < 8) list.push(value);
  }

  function collectCorrelation(value, result, depth = 0) {
    if (depth > 8 || result.visited >= 500) return;
    result.visited += 1;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) collectCorrelation(item, result, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;

    pushUnique(result.conversationIds, boundedId(record.conversation_id));
    pushUnique(result.parentIds, boundedId(record.parent_id));
    pushUnique(result.parentIds, boundedId(record.parent));

    const author = asRecord(record.author);
    if (author) pushUnique(result.messageIds, boundedId(record.id));
    const message = asRecord(record.message);
    if (message) pushUnique(result.messageIds, boundedId(message.id));

    if (record.type === "server_ste_metadata") result.terminal = true;

    for (const [key, nested] of Object.entries(record)) {
      if (["content", "parts", "text", "args", "arguments", "input", "output"].includes(key)) continue;
      if (nested && typeof nested === "object") collectCorrelation(nested, result, depth + 1);
    }
  }

  function newCorrelation() {
    return { conversationIds: [], messageIds: [], parentIds: [], terminal: false, visited: 0 };
  }

  class WebSocketRouteParser {
    constructor() {
      this.topics = new Map();
    }

    clear() {
      this.topics.clear();
    }

    state() {
      const state = {
        correlation: newCorrelation(),
        streamEnded: false,
        expiresAt: 0,
        reset: false,
        parser: null
      };
      state.parser = new ResponseStreamParser((event) => {
        if (event.reset) {
          state.reset = true;
          state.correlation = newCorrelation();
        }
        state.streamEnded ||= event.done;
        state.correlation.terminal ||= event.done;
        if (!event.done) collectCorrelation(event.value, state.correlation);
      });
      return state;
    }

    parse(raw) {
      if (typeof raw !== "string" || raw.length === 0 || raw.length > 2 * 1024 * 1024) return [];
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return []; }
      if (!Array.isArray(parsed)) return [];

      const now = Date.now();
      for (const [topic, state] of this.topics) if (state.expiresAt <= now) this.topics.delete(topic);

      const results = [];
      for (const candidate of parsed.slice(0, 16)) {
        const envelope = asRecord(candidate);
        const outer = asRecord(envelope?.payload);
        const inner = asRecord(outer?.payload);
        const encoded = inner?.encoded_item;
        if (typeof encoded !== "string" || !encoded || encoded.length > 1024 * 1024) continue;

        const topicId = boundedId(envelope?.topic_id);
        const state = topicId ? (this.topics.get(topicId) || this.state()) : this.state();
        const previous = state.correlation;
        state.correlation = newCorrelation();
        state.streamEnded = false;
        state.reset = false;

        let fields = emptyFields();
        let errorCode = null;
        try {
          state.parser.push(encoded);
          fields = state.parser.finish();
        } catch {
          errorCode = "stream_decode_failed";
          state.streamEnded = true;
        }

        const correlation = state.correlation;
        if (!state.reset) {
          for (const key of ["conversationIds", "messageIds", "parentIds"]) {
            if (correlation[key].length === 0) correlation[key] = previous[key];
          }
        }
        pushUnique(correlation.conversationIds, fields.conversationId);

        results.push({
          topicId,
          fields,
          conversationIds: [...correlation.conversationIds],
          messageIds: [...correlation.messageIds],
          parentIds: [...correlation.parentIds],
          terminal: correlation.terminal,
          streamEnded: state.streamEnded,
          errorCode
        });

        if (topicId) {
          this.topics.delete(topicId);
          if (!state.streamEnded) {
            state.expiresAt = now + 10 * 60 * 1000;
            this.topics.set(topicId, state);
          }
        }
      }
      return results;
    }
  }

  function assessRoute(fields) {
    const norm = (value) => value?.trim().toLowerCase() || null;
    const requested = norm(fields.requestedModel);
    const routeCandidates = [
      { source: "resolved_model_slug", model: norm(fields.resolvedModelSlug) },
      { source: "server_ste_metadata.model_slug", model: norm(fields.serverModelSlug) }
    ].filter((candidate) => candidate.model);
    const labelCandidates = [
      { source: "assistant.metadata.model_slug", model: norm(fields.responseModelSlug) }
    ].filter((candidate) => candidate.model);

    const routeModels = [...new Set(routeCandidates.map((candidate) => candidate.model))];
    const labelModels = [...new Set(labelCandidates.map((candidate) => candidate.model))];
    const routeConflict = routeModels.length > 1;
    const labelConflict = labelModels.length > 1;
    const explicitRoute = routeConflict ? null : routeModels[0] || null;
    const label = labelConflict ? null : labelModels[0] || null;

    if (explicitRoute === "gpt-5-6-auto-thinking" || explicitRoute === "gpt-5-5-auto-thinking") {
      return {
        verdict: "auto_reasoning",
        routeModel: explicitRoute,
        routeSources: routeCandidates.map((candidate) => candidate.source),
        modelLabel: label,
        modelLabelSources: labelCandidates.map((candidate) => candidate.source)
      };
    }

    const routeLabelConflict = Boolean(explicitRoute && labelCandidates.some((candidate) => candidate.model !== explicitRoute));
    if (routeConflict || routeLabelConflict) {
      return {
        verdict: "conflict",
        routeModel: null,
        routeSources: [
          ...routeCandidates.map((candidate) => candidate.source),
          ...(routeLabelConflict ? labelCandidates.map((candidate) => candidate.source) : [])
        ],
        modelLabel: label,
        modelLabelSources: labelCandidates.map((candidate) => candidate.source)
      };
    }

    const routeModel = explicitRoute || label;
    const routeSources = explicitRoute
      ? routeCandidates.map((candidate) => candidate.source)
      : label
        ? labelCandidates.map((candidate) => candidate.source)
        : [];

    if (!routeModel || !requested) {
      return { verdict: "unknown", routeModel, routeSources, modelLabel: label, modelLabelSources: labelCandidates.map((candidate) => candidate.source) };
    }

    return {
      verdict: requested === routeModel ? "normal" : "mismatch",
      routeModel,
      routeSources,
      modelLabel: label,
      modelLabelSources: labelCandidates.map((candidate) => candidate.source)
    };
  }

  globalThis.ModelLensRouteParser = {
    EMPTY_FIELDS,
    emptyFields,
    mergeFields,
    classifyEndpoint,
    parseConversationCapture,
    walkForFields,
    ResponseStreamParser,
    WebSocketRouteParser,
    assessRoute
  };
})();
