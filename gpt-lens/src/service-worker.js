const DRIVE_FILE_NAME = "model-lens-sync.json";
const LOCAL_KEYS = ["modelLensEvents", "modelLensSettings", "modelLensDetectedPlan", "modelLensSyncMeta"];

const CHATGPT_REQUEST_FILTER = {
  urls: [
    "https://chatgpt.com/backend-api/conversation*",
    "https://chatgpt.com/backend-api/f/conversation*",
    "https://chatgpt.com/ces/v1/i*"
  ]
};

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.method !== "POST" || details.tabId < 0 || !details.requestBody) return;
  const payload = decodeRequestBody(details.requestBody);
  if (!payload) return;

  if (/\/backend-api\/(?:f\/)?conversation(?:$|[/?#])/.test(details.url) && payload.model) {
    chrome.tabs.sendMessage(details.tabId, {
      channel: "MODEL_LENS_EXTENSION",
      kind: "frontend-model",
      payload: {
        frontendModel: payload.model,
        thinkingEffort: payload.thinking_effort || null,
        conversationId: payload.conversation_id || null,
        parentMessageId: payload.parent_message_id || null,
        action: payload.action || null,
        timestamp: new Date(details.timeStamp || Date.now()).toISOString()
      }
    }).catch(() => {});
  }

  if (/\/ces\/v1\/i(?:$|[/?#])/.test(details.url)) {
    const plan = payload?.traits?.plan_type;
    if (plan) {
      chrome.tabs.sendMessage(details.tabId, {
        channel: "MODEL_LENS_EXTENSION",
        kind: "plan-observed",
        payload: { plan: String(plan).toLowerCase() }
      }).catch(() => {});
    }
  }
}, CHATGPT_REQUEST_FILTER, ["requestBody"]);

function decodeRequestBody(requestBody) {
  try {
    if (requestBody.formData) {
      const object = {};
      for (const [key, values] of Object.entries(requestBody.formData)) {
        object[key] = Array.isArray(values) && values.length === 1 ? values[0] : values;
      }
      return object;
    }
    const raw = requestBody.raw || [];
    if (!raw.length) return null;
    const chunks = raw.map((part) => part.bytes ? new Uint8Array(part.bytes) : new Uint8Array());
    const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(joined);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("model-lens-auto-sync", { periodInMinutes: 15 });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url?.startsWith("https://chatgpt.com/")) return;
  chrome.tabs.sendMessage(tab.id, { channel: "MODEL_LENS_EXTENSION", kind: "toggle-panel" }).catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "model-lens-auto-sync") return;
  const { modelLensSyncMeta } = await chrome.storage.local.get("modelLensSyncMeta");
  if (!modelLensSyncMeta?.enabled) return;
  try { await syncNow(false); } catch {}
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type?.startsWith("GOOGLE_")) return;
  (async () => {
    try {
      if (message.type === "GOOGLE_SIGN_IN") {
        const token = await getToken(true);
        const profile = await fetchProfile(token);
        await chrome.storage.local.set({ modelLensSyncMeta: { enabled: true, email: profile.email || "", lastSyncAt: null } });
        sendResponse({ ok: true, email: profile.email, message: profile.email ? `Connected: ${profile.email}` : "Google connected" });
      } else if (message.type === "GOOGLE_SYNC_NOW") {
        const result = await syncNow(true);
        sendResponse({ ok: true, message: `Synced · ${result.events} events` });
      } else if (message.type === "GOOGLE_SIGN_OUT") {
        await chrome.identity.clearAllCachedAuthTokens();
        const { modelLensSyncMeta = {} } = await chrome.storage.local.get("modelLensSyncMeta");
        await chrome.storage.local.set({ modelLensSyncMeta: { ...modelLensSyncMeta, enabled: false } });
        sendResponse({ ok: true, message: "Google disconnected" });
      } else if (message.type === "GOOGLE_STATUS") {
        const { modelLensSyncMeta = {} } = await chrome.storage.local.get("modelLensSyncMeta");
        sendResponse({ ok: true, message: modelLensSyncMeta.enabled ? `Connected${modelLensSyncMeta.email ? `: ${modelLensSyncMeta.email}` : ""}${modelLensSyncMeta.lastSyncAt ? ` · last ${new Date(modelLensSyncMeta.lastSyncAt).toLocaleString()}` : ""}` : "Not connected" });
      }
    } catch (error) {
      sendResponse({ ok: false, error: normalizeAuthError(error) });
    }
  })();
  return true;
});

function normalizeAuthError(error) {
  const msg = String(error?.message || error || "Unknown error");
  if (/oauth|client|bad client id|invalid_client/i.test(msg)) {
    return "Google OAuth client ID is not configured for this extension ID. See README → Google sync setup.";
  }
  return msg;
}

async function getToken(interactive) {
  const result = await chrome.identity.getAuthToken({ interactive });
  const token = typeof result === "string" ? result : result?.token;
  if (!token) throw new Error("No Google OAuth token returned");
  return token;
}

async function authedFetch(url, options = {}, interactive = false) {
  let token = await getToken(interactive);
  let response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  if (response.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token });
    token = await getToken(interactive);
    response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  }
  return response;
}

async function fetchProfile(token) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return {};
  return response.json();
}

async function findDriveFile(interactive) {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name='${DRIVE_FILE_NAME}' and trashed=false`,
    fields: "files(id,name,modifiedTime)",
    pageSize: "10"
  });
  const response = await authedFetch(`https://www.googleapis.com/drive/v3/files?${params}`, {}, interactive);
  if (!response.ok) throw new Error(`Drive list failed (${response.status})`);
  const data = await response.json();
  return data.files?.[0] || null;
}

async function readRemoteFile(fileId, interactive) {
  if (!fileId) return null;
  const response = await authedFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {}, interactive);
  if (!response.ok) throw new Error(`Drive download failed (${response.status})`);
  try { return await response.json(); } catch { return null; }
}

async function writeRemoteFile(fileId, data, interactive) {
  const bodyText = JSON.stringify(data);
  if (fileId) {
    const response = await authedFetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: bodyText
    }, interactive);
    if (!response.ok) throw new Error(`Drive update failed (${response.status})`);
    return response.json();
  }

  const boundary = `model_lens_${Date.now()}`;
  const metadata = JSON.stringify({ name: DRIVE_FILE_NAME, parents: ["appDataFolder"] });
  const multipart = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${bodyText}\r\n`,
    `--${boundary}--`
  ].join("");
  const response = await authedFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart
  }, interactive);
  if (!response.ok) throw new Error(`Drive create failed (${response.status})`);
  return response.json();
}

function mergeData(local, remote) {
  const events = new Map();
  for (const event of [...(remote?.events || []), ...(local.events || [])]) {
    if (!event?.id) continue;
    const previous = events.get(event.id);
    if (!previous) events.set(event.id, event);
    else {
      const a = new Date(previous.backendObservedAt || previous.timestamp || 0).getTime();
      const b = new Date(event.backendObservedAt || event.timestamp || 0).getTime();
      events.set(event.id, b >= a ? { ...previous, ...event } : { ...event, ...previous });
    }
  }

  const localSettingsTime = new Date(local.settings?.updatedAt || 0).getTime();
  const remoteSettingsTime = new Date(remote?.settings?.updatedAt || 0).getTime();
  const settings = remoteSettingsTime > localSettingsTime ? remote.settings : local.settings;

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    events: [...events.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)).slice(-10000),
    settings: settings || {},
    detectedPlan: local.detectedPlan || remote?.detectedPlan || null
  };
}

async function syncNow(interactive) {
  const localRaw = await chrome.storage.local.get(LOCAL_KEYS);
  const local = {
    events: localRaw.modelLensEvents || [],
    settings: localRaw.modelLensSettings || {},
    detectedPlan: localRaw.modelLensDetectedPlan || null
  };
  const file = await findDriveFile(interactive);
  const remote = file ? await readRemoteFile(file.id, interactive) : null;
  const merged = mergeData(local, remote);
  await writeRemoteFile(file?.id, merged, interactive);

  const meta = {
    ...(localRaw.modelLensSyncMeta || {}),
    enabled: true,
    lastSyncAt: new Date().toISOString()
  };
  await chrome.storage.local.set({
    modelLensEvents: merged.events,
    modelLensSettings: merged.settings,
    modelLensDetectedPlan: merged.detectedPlan,
    modelLensSyncMeta: meta
  });
  return { events: merged.events.length };
}
