const STORAGE_KEY = "headerFoundryTargetsV2";

const PAGE_REQUEST_RESOURCE_TYPES = [
  "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
];

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

function enabledHeadersForPage(pageUrl) {
  const headers = [];
  const seen = new Set();

  for (const target of targets) {
    if (!target.enabled || !urlFilterMatches(pageUrl, target.urlFilter)) continue;
    for (const header of target.headers) {
      if (!header.enabled) continue;
      const key = [header.headerTarget, header.requestMethod, header.headerName.toLowerCase()].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(header);
    }
  }

  return headers;
}

function headerAction(header) {
  const change = { header: header.headerName, operation: header.operation };
  if (header.operation !== "remove") change.value = header.headerValue;
  return {
    type: "modifyHeaders",
    [header.headerTarget === "request" ? "requestHeaders" : "responseHeaders"]: [change]
  };
}

function conditionForHeader(header, baseCondition) {
  const condition = { ...baseCondition };
  if (header.requestMethod !== "all") condition.requestMethods = [header.requestMethod];
  return condition;
}

function buildSessionRules(tabs) {
  const rules = [];
  let ruleId = 1;

  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    for (const header of enabledHeadersForPage(tab.url)) {
      rules.push({
        id: ruleId,
        priority: 1,
        action: headerAction(header),
        condition: conditionForHeader(header, {
          tabIds: [tab.id],
          resourceTypes: PAGE_REQUEST_RESOURCE_TYPES
        })
      });
      ruleId += 1;
    }
  }

  return rules;
}

function buildNavigationRules() {
  const rules = [];
  let ruleId = 1;

  targets.forEach((target, targetIndex) => {
    if (!target.enabled) return;
    target.headers.filter((header) => header.enabled).forEach((header) => {
      rules.push({
        id: ruleId,
        priority: targets.length - targetIndex,
        action: headerAction(header),
        condition: conditionForHeader(header, {
          urlFilter: target.urlFilter,
          resourceTypes: ["main_frame"]
        })
      });
      ruleId += 1;
    });
  });

  return rules;
}

async function setTabState(tab, headers) {
  if (!Number.isInteger(tab.id)) return;
  const count = headers.length;
  const active = count > 0;

  try {
    await Promise.all([
      chrome.action.setIcon({ tabId: tab.id, imageData: active ? ICONS.active : ICONS.inactive }),
      chrome.action.setBadgeText({ tabId: tab.id, text: active ? String(Math.min(count, 99)) : "" }),
      chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#1e5dff" }),
      chrome.action.setTitle({
        tabId: tab.id,
        title: active
          ? `Header Foundry：当前页面已启用 ${count} 条 Header 规则`
          : "Header Foundry：当前页面没有启用的 Header 规则"
      })
    ]);
  } catch {
    // The tab may close while its rules and icon are being refreshed.
  }
}

let targets = [];
let syncQueue = Promise.resolve();

const targetsReady = chrome.storage.local.get(STORAGE_KEY).then((stored) => {
  targets = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
});

async function syncAllPageRules() {
  await targetsReady;
  const tabs = await chrome.tabs.query({});
  const [currentSessionRules, currentDynamicRules] = await Promise.all([
    chrome.declarativeNetRequest.getSessionRules(),
    chrome.declarativeNetRequest.getDynamicRules()
  ]);
  const sessionRules = buildSessionRules(tabs);
  const navigationRules = buildNavigationRules();

  await Promise.all([
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: currentSessionRules.map((rule) => rule.id),
      addRules: sessionRules
    }),
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: currentDynamicRules.map((rule) => rule.id),
      addRules: navigationRules
    })
  ]);

  await Promise.all(tabs.map((tab) => setTabState(tab, enabledHeadersForPage(tab.url))));
}

function scheduleSync() {
  const run = syncQueue.then(syncAllPageRules);
  syncQueue = run.catch(() => {});
  return run;
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url) scheduleSync();
});

chrome.tabs.onRemoved.addListener(() => { scheduleSync(); });
chrome.tabs.onReplaced.addListener(() => { scheduleSync(); });

function syncTopFrame(details) {
  if (details.frameId === 0) scheduleSync();
}

chrome.webNavigation.onCommitted.addListener(syncTopFrame);
chrome.webNavigation.onHistoryStateUpdated.addListener(syncTopFrame);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) return;
  targets = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
  scheduleSync();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "sync-page-rules") return scheduleSync().then(() => ({ ok: true }));
  return undefined;
});

chrome.runtime.onInstalled.addListener(() => { scheduleSync(); });
chrome.runtime.onStartup.addListener(() => { scheduleSync(); });

chrome.action.setIcon({ imageData: ICONS.inactive });
chrome.action.setTitle({ title: "Header Foundry：当前页面没有启用的 Header 规则" });
scheduleSync();
