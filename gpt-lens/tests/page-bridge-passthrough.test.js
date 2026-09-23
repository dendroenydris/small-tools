const fs = require("fs");
const vm = require("vm");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../src/page-bridge.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const response = { ok: false, headers: { get: () => "application/json" } };
  const nativePromise = Promise.resolve(response);
  const calls = [];
  const events = [];
  let classifyCalls = 0;

  class FakeRequest {
    constructor(url, options = {}) {
      this.url = url;
      this.method = options.method || "GET";
      this.cloneCalls = 0;
    }

    clone() {
      this.cloneCalls += 1;
      throw new Error("Request.clone must not be called");
    }
  }

  const context = {
    console,
    URL,
    URLSearchParams,
    Promise,
    Reflect,
    WeakSet,
    Map,
    Set,
    Object,
    Array,
    JSON,
    Date,
    Math,
    String,
    Number,
    Boolean,
    RegExp,
    TypeError,
    Uint8Array,
    Request: FakeRequest,
    location: { href: "https://chatgpt.com/", pathname: "/" },
    document: { addEventListener() {} },
    crypto: { randomUUID: () => "capture-1" },
    queueMicrotask,
    setTimeout,
    clearTimeout
  };

  context.globalThis = context;
  context.window = context;
  context.addEventListener = () => {};
  context.postMessage = (message) => events.push(`post:${message.kind}`);
  context.setInterval = (_fn, delay) => {
    events.push(`interval:${delay}`);
    return 1;
  };
  context.WebSocket = null;
  context.fetch = function nativeFetch(...args) {
    calls.push(args);
    events.push("fetch");
    return nativePromise;
  };

  context.ModelLensRouteParser = {
    classifyEndpoint(url) {
      classifyCalls += 1;
      return String(url).endsWith("/backend-api/conversation")
        ? { kind: "conversation_stream", conversationId: null }
        : { kind: "other", conversationId: null };
    },

    emptyFields() {
      return {
        requestedModel: null,
        responseModelSlug: null,
        resolvedModelSlug: null,
        serverModelSlug: null,
        requestId: null,
        conversationId: null,
        thinkingEffort: null,
        planType: null
      };
    },

    assessRoute() {
      return {
        routeSources: [],
        modelLabelSources: [],
        routeModel: null,
        modelLabel: null,
        verdict: "unknown"
      };
    },

    parseConversationCapture(raw) {
      const value = JSON.parse(raw);
      return {
        fields: {
          ...this.emptyFields(),
          requestedModel: value.model || null,
          conversationId: value.conversation_id || null
        },
        correlation: {
          conversationId: value.conversation_id || "conv-1",
          inputMessageId: "msg-1",
          parentMessageId: "parent-1"
        }
      };
    },

    mergeFields(...items) {
      return Object.assign(this.emptyFields(), ...items.filter(Boolean));
    },

    ResponseStreamParser: class {
      push() { return {}; }
      finish() { return {}; }
    },

    WebSocketRouteParser: class {
      clear() {}
      parse() { return []; }
    }
  };

  vm.createContext(context);
  vm.runInContext(src, context);

  events.length = 0;
  const historyPromise = context.fetch("https://chatgpt.com/backend-api/conversation/abc");
  assert(historyPromise === nativePromise, "history GET must return the original fetch Promise");
  assert(classifyCalls === 0, "history GET must bypass GPT Lens endpoint inspection");

  const ordinaryPostPromise = context.fetch(
    "https://chatgpt.com/backend-api/some-other-endpoint",
    { method: "POST", body: '{"x":1}' }
  );
  assert(ordinaryPostPromise === nativePromise, "non-target POST must return the original fetch Promise");

  const request = new FakeRequest(
    "https://chatgpt.com/backend-api/conversation",
    { method: "POST" }
  );
  const requestObjectPromise = context.fetch(request);
  assert(requestObjectPromise === nativePromise, "Request-object generation POST must bypass body inspection");
  assert(request.cloneCalls === 0, "GPT Lens must never clone/read Request bodies");

  events.length = 0;
  const generationPromise = context.fetch(
    "https://chatgpt.com/backend-api/conversation",
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5-6-thinking",
        conversation_id: "conv-1"
      })
    }
  );
  const generationResponse = await generationPromise;

  assert(generationResponse === response, "generation fetch must resolve to the original Response");
  assert(events[0] === "fetch", "native fetch must start before GPT Lens observation");
  assert(events.includes("post:route-observation"), "generation POST should still emit a route observation");

  console.log("page-bridge passthrough tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
