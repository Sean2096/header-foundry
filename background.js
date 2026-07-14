const STORAGE_KEY = "headerFoundryTargetsV2";
const SESSION_KEY = "headerFoundryMatchedTabs";

const RESOURCE_TYPES = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
]);

function createIcon(size, active) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  const scale = size / 16;

  context.clearRect(0, 0, size, size);
  context.fillStyle = active ? "#d9ff45" : "#9b978d";
  context.strokeStyle = "#151512";
  context.lineWidth = Math.max(1, scale);
  context.beginPath();
  context.roundRect(1 * scale, 1 * scale, 14 * scale, 14 * scale, 3 * scale);
  context.fill();
  context.stroke();

  context.fillStyle = active ? "#1e5dff" : "#f4f0e5";
  context.fillRect(4 * scale, 4 * scale, 2 * scale, 8 * scale);
  context.fillRect(10 * scale, 4 * scale, 2 * scale, 8 * scale);
  context.fillRect(6 * scale, 7 * scale, 4 * scale, 2 * scale);

  if (active) {
    context.fillStyle = "#ff5635";
    context.beginPath();
    context.arc(13 * scale, 3 * scale, 1.5 * scale, 0, Math.PI * 2);
    context.fill();
  }

  return context.getImageData(0, 0, size, size);
}

const ICONS = {
  active: { 16: createIcon(16, true), 32: createIcon(32, true) },
  inactive: { 16: createIcon(16, false), 32: createIcon(32, false) }
};

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function urlFilterMatches(urlValue, filterValue) {
  if (!urlValue || !filterValue) return false;

  try {
    const url = new URL(urlValue);
    if (filterValue.startsWith("||")) {
      const raw = filterValue.slice(2).replace(/\|$/, "");
      const slashIndex = raw.indexOf("/");
      const domain = (slashIndex >= 0 ? raw.slice(0, slashIndex) : raw).replace(/\^$/, "");
      const path = slashIndex >= 0 ? raw.slice(slashIndex) : "";
      const domainMatches = url.hostname === domain || url.hostname.endsWith(`.${domain}`);
      if (!domainMatches || !path) return domainMatches;
      const pathPattern = escapeRegex(path)
        .replace(/\*/g, ".*")
        .replace(/\\\^/g, "(?:[^a-zA-Z0-9_.%-]|$)");
      return new RegExp(`^${pathPattern}`).test(`${url.pathname}${url.search}`);
    }
  } catch {
    return false;
  }

  let filter = filterValue;
  const startAnchored = filter.startsWith("|");
  const endAnchored = filter.endsWith("|");
  if (startAnchored) filter = filter.slice(1);
  if (endAnchored) filter = filter.slice(0, -1);

  const pattern = escapeRegex(filter)
    .replace(/\*/g, ".*")
    .replace(/\\\^/g, "(?:[^a-zA-Z0-9_.%-]|$)");

  try {
    return new RegExp(`${startAnchored ? "^" : ""}${pattern}${endAnchored ? "$" : ""}`).test(urlValue);
  } catch {
    return urlValue.includes(filterValue);
  }
}

let targets = [];
let matchedTabs = new Map();
let persistQueue = Promise.resolve();

const targetsReady = chrome.storage.local.get(STORAGE_KEY).then((stored) => {
  targets = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
});

const sessionReady = chrome.storage.session.get(SESSION_KEY).then((stored) => {
  const saved = stored[SESSION_KEY] || {};
  matchedTabs = new Map(
    Object.entries(saved).map(([tabId, ruleIds]) => [Number(tabId), new Set(ruleIds)])
  );
});

function persistMatchedTabs() {
  const snapshot = Object.fromEntries(
    [...matchedTabs.entries()].map(([tabId, ruleIds]) => [String(tabId), [...ruleIds]])
  );
  persistQueue = persistQueue.then(() => chrome.storage.session.set({ [SESSION_KEY]: snapshot }));
  return persistQueue;
}

async function setTabState(tabId, ruleIds) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const count = ruleIds.size;
  const active = count > 0;

  try {
    await Promise.all([
      chrome.action.setIcon({ tabId, imageData: active ? ICONS.active : ICONS.inactive }),
      chrome.action.setBadgeText({ tabId, text: active ? String(Math.min(count, 99)) : "" }),
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#1e5dff" }),
      chrome.action.setTitle({
        tabId,
        title: active
          ? `Header Foundry：当前页面有 ${count} 条请求规则已命中`
          : "Header Foundry：当前页面尚无请求命中规则"
      })
    ]);
  } catch {
    // The tab may close while an async icon update is in flight.
  }
}

async function resetTab(tabId) {
  await sessionReady;
  matchedTabs.delete(tabId);
  await Promise.all([setTabState(tabId, new Set()), persistMatchedTabs()]);
}

function matchingRuleIds(details) {
  if (!RESOURCE_TYPES.has(details.type)) return [];
  const method = details.method.toLowerCase();
  const ids = [];

  for (const target of targets) {
    if (!target.enabled || !urlFilterMatches(details.url, target.urlFilter)) continue;
    for (const header of target.headers) {
      if (!header.enabled) continue;
      if (header.requestMethod !== "all" && header.requestMethod !== method) continue;
      ids.push(header.id);
    }
  }

  return ids;
}

async function observeRequest(details) {
  if (details.tabId < 0) return;
  await Promise.all([targetsReady, sessionReady]);

  if (details.type === "main_frame") {
    matchedTabs.delete(details.tabId);
  }

  const matchedIds = matchingRuleIds(details);
  const tabMatches = matchedTabs.get(details.tabId) || new Set();
  let changed = details.type === "main_frame";

  for (const ruleId of matchedIds) {
    if (!tabMatches.has(ruleId)) {
      tabMatches.add(ruleId);
      changed = true;
    }
  }

  if (!changed) return;
  if (tabMatches.size > 0) matchedTabs.set(details.tabId, tabMatches);
  await Promise.all([setTabState(details.tabId, tabMatches), persistMatchedTabs()]);
}

async function refreshStoredTabs() {
  await sessionReady;
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => setTabState(tab.id, matchedTabs.get(tab.id) || new Set())));
}

async function clearAllTabMatches() {
  await sessionReady;
  matchedTabs.clear();
  await persistMatchedTabs();
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => setTabState(tab.id, new Set())));
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => { observeRequest(details); },
  { urls: ["http://*/*", "https://*/*"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  sessionReady.then(() => {
    if (matchedTabs.delete(tabId)) persistMatchedTabs();
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  sessionReady.then(() => {
    matchedTabs.delete(removedTabId);
    matchedTabs.delete(addedTabId);
    Promise.all([setTabState(addedTabId, new Set()), persistMatchedTabs()]);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) return;
  targets = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
  clearAllTabMatches();
});

chrome.runtime.onInstalled.addListener(clearAllTabMatches);
chrome.runtime.onStartup.addListener(refreshStoredTabs);

chrome.action.setIcon({ imageData: ICONS.inactive });
chrome.action.setTitle({ title: "Header Foundry：当前页面尚无请求命中规则" });
refreshStoredTabs();
