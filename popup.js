const STORAGE_KEY = "headerFoundryTargetsV2";
const LEGACY_STORAGE_KEY = "headerFoundryRules";
const DRAFT_STORAGE_KEY = "headerFoundryComposerDraft";

const elements = {
  form: document.querySelector("#targetForm"),
  urlFilter: document.querySelector("#urlFilter"),
  urlFieldNew: document.querySelector("#urlFieldNew"),
  urlFieldLocked: document.querySelector("#urlFieldLocked"),
  urlLockedValue: document.querySelector("#urlLockedValue"),
  useCurrentPage: document.querySelector("#useCurrentPage"),
  batchRows: document.querySelector("#batchRows"),
  draftCount: document.querySelector("#draftCount"),
  addHeaderRow: document.querySelector("#addHeaderRow"),
  targetList: document.querySelector("#targetList"),
  emptyState: document.querySelector("#emptyState"),
  targetDetail: document.querySelector("#targetDetail"),
  detailUrl: document.querySelector("#detailUrl"),
  detailStat: document.querySelector("#detailStat"),
  detailRules: document.querySelector("#detailRules"),
  newTargetBtn: document.querySelector("#newTargetBtn"),
  emptyCreate: document.querySelector("#emptyCreate"),
  closeComposer: document.querySelector("#closeComposer"),
  composerPanel: document.querySelector("#composerPanel"),
  composerTitle: document.querySelector("#composerTitle"),
  submitBtn: document.querySelector("#submitBtn"),
  toggleBulkMode: document.querySelector("#toggleBulkMode"),
  bulkBar: document.querySelector("#bulkBar"),
  selectAllTargets: document.querySelector("#selectAllTargets"),
  selectedTargetCount: document.querySelector("#selectedTargetCount"),
  enableSelected: document.querySelector("#enableSelected"),
  disableSelected: document.querySelector("#disableSelected"),
  invertSelected: document.querySelector("#invertSelected"),
  targetCount: document.querySelector("#targetCount"),
  activeCount: document.querySelector("#activeCount"),
  clearAll: document.querySelector("#clearAll"),
  toast: document.querySelector("#toast")
};

let targets = [];
let draftRowSequence = 0;
let toastTimer;
let editingHeaderId = null;
let bulkMode = false;
const selectedTargetIds = new Set();
let selectedTargetId = null;
// composer: closed | { mode: "new" } | { mode: "append", targetId }
let composer = { open: false, mode: "new", targetId: null };

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2500);
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = String(value);
  return node.innerHTML;
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function allHeaders(source = targets) {
  return source.flatMap((target) => target.headers);
}

function headerValueMarkup(header) {
  if (header.operation === "remove") return "";
  return ` <b>${escapeHtml(header.headerValue)}</b>`;
}

function nextRuleId() {
  const usedIds = new Set(allHeaders().map((header) => header.id));
  let candidate = Math.max(0, ...usedIds) + 1;
  while (usedIds.has(candidate)) candidate += 1;
  return candidate;
}

function createTargetId() {
  return `target-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function enabledHeaderCount(source = targets) {
  return source.reduce((count, target) => {
    if (!target.enabled) return count;
    return count + target.headers.filter((header) => header.enabled).length;
  }, 0);
}

// Only returns headers whose per-target/method combination actually applies to
// the page, matching the background dedup semantics.
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


function currentTarget() {
  return targets.find((item) => item.id === selectedTargetId) || null;
}

/* ---------------- draft rows ---------------- */

function rowTemplate(rowId) {
  return `
    <div class="batch-row" data-row-id="${rowId}">
      <span class="row-number">01</span>
      <select data-field="headerTarget" aria-label="作用位置"><option value="request">请求头</option><option value="response">响应头</option></select>
      <select data-field="requestMethod" aria-label="请求方法"><option value="all">ALL</option><option value="get">GET</option><option value="post">POST</option><option value="put">PUT</option><option value="patch">PATCH</option><option value="delete">DELETE</option></select>
      <select data-field="operation" aria-label="操作"><option value="set">SET</option><option value="remove">REMOVE</option><option value="append">APPEND</option></select>
      <input data-field="headerName" required placeholder="X-Debug" aria-label="Header 名称" spellcheck="false" />
      <input data-field="headerValue" class="value-input" value="true" aria-label="Header 值" spellcheck="false" />
      <button class="remove-row" data-action="remove-draft" type="button" aria-label="移除这一行">×</button>
    </div>
  `;
}

function addDraftRow(initial = {}) {
  draftRowSequence += 1;
  const rowId = `draftRow-${draftRowSequence}`;
  elements.batchRows.insertAdjacentHTML("beforeend", rowTemplate(rowId));
  const row = elements.batchRows.lastElementChild;
  for (const [field, value] of Object.entries(initial)) {
    const input = row.querySelector(`[data-field="${field}"]`);
    if (input) input.value = value;
  }
  updateRowValueVisibility(row);
  updateDraftRows();
}

function resetDraftRows() {
  elements.batchRows.innerHTML = "";
  addDraftRow({ headerName: "x-use-ppe", headerValue: "1" });
  addDraftRow({ headerName: "x-tt-env", headerValue: "ppe_xx" });
}

function updateDraftRows() {
  const rows = [...elements.batchRows.querySelectorAll(".batch-row")];
  rows.forEach((row, index) => {
    row.querySelector(".row-number").textContent = String(index + 1).padStart(2, "0");
    const remove = row.querySelector(".remove-row");
    remove.disabled = rows.length === 1;
  });
  elements.draftCount.textContent = String(rows.length).padStart(2, "0");
}

function updateRowValueVisibility(row) {
  const operation = row.querySelector('[data-field="operation"]').value;
  const valueInput = row.querySelector('[data-field="headerValue"]');
  valueInput.disabled = operation === "remove";
  valueInput.required = operation !== "remove";
}

// Accepts pasted text such as "x-tt-env: ppe_test" (also ":", "：", "="
// separators, quoted values, and multiple lines). Returns parsed rows or null
// when the text is not recognizable header lines so normal paste still works.
function parseHeaderPaste(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const items = [];
  for (const line of lines) {
    const match = line.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*[:：=]\s*(.*)$/);
    if (!match) return null;
    const name = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    items.push({ name, value });
  }
  return items;
}

function applyParsedHeaderToRow(row, { name, value }) {
  const nameInput = row.querySelector('[data-field="headerName"]');
  const valueInput = row.querySelector('[data-field="headerValue"]');
  const operationSelect = row.querySelector('[data-field="operation"]');
  nameInput.value = name;
  if (value) {
    operationSelect.value = "set";
    valueInput.value = value;
  }
  updateRowValueVisibility(row);
}

function draftState() {
  return {
    urlFilter: elements.urlFilter.value,
    headers: [...elements.batchRows.querySelectorAll(".batch-row")].map((row) => ({
      headerTarget: row.querySelector('[data-field="headerTarget"]').value,
      requestMethod: row.querySelector('[data-field="requestMethod"]').value,
      operation: row.querySelector('[data-field="operation"]').value,
      headerName: row.querySelector('[data-field="headerName"]').value.trim(),
      headerValue: row.querySelector('[data-field="headerValue"]').value
    }))
  };
}

function saveDraft() {
  return chrome.storage.session.set({ [DRAFT_STORAGE_KEY]: draftState() });
}

function persistDraft() {
  saveDraft().catch(() => {
    // Rules still work if the short-lived composer draft cannot be persisted.
  });
}

function restoreDraft(savedDraft) {
  if (!savedDraft || !Array.isArray(savedDraft.headers) || savedDraft.headers.length === 0) return false;
  elements.urlFilter.value = typeof savedDraft.urlFilter === "string" ? savedDraft.urlFilter : elements.urlFilter.value;
  elements.batchRows.innerHTML = "";
  savedDraft.headers.forEach((header) => addDraftRow(header));
  return true;
}

function collectDraftHeaders() {
  const usedIds = new Set(allHeaders().map((header) => header.id));
  let candidate = nextRuleId();

  return [...elements.batchRows.querySelectorAll(".batch-row")].map((row) => {
    const header = {
      id: candidate,
      enabled: true,
      headerTarget: row.querySelector('[data-field="headerTarget"]').value,
      requestMethod: row.querySelector('[data-field="requestMethod"]').value,
      operation: row.querySelector('[data-field="operation"]').value,
      headerName: row.querySelector('[data-field="headerName"]').value.trim(),
      headerValue: row.querySelector('[data-field="headerValue"]').value
    };
    usedIds.add(candidate);
    candidate += 1;
    if (header.headerTarget === "request" && header.operation === "append") {
      header.headerName = header.headerName.toLowerCase();
    }
    return header;
  });
}

/* ---------------- url filter matching (mirrors background.js) ---------------- */

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
      const pathPattern = escapeRegex(path)
        .replace(/\*/g, ".*")
        .replace(/\\\^/g, "(?:[^a-zA-Z0-9_.%-]|$)");
      const domainMatches = url.hostname === domain || url.hostname.endsWith(`.${domain}`);
      if (!domainMatches) return false;
      const pathTest = path ? new RegExp(`^${pathPattern}`).test(`${url.pathname}${url.search}`) : true;
      return pathTest;
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
  } catch {
    return false;
  }
}

/* ---------------- legacy migration ---------------- */

function migrateLegacyRules(legacyRules) {
  const grouped = new Map();
  for (const rule of legacyRules) {
    if (!rule || !Number.isInteger(rule.id)) continue;
    if (!rule.urlFilter || !rule.headerName) continue;
    if (!grouped.has(rule.urlFilter)) grouped.set(rule.urlFilter, []);
    grouped.get(rule.urlFilter).push({
      id: rule.id,
      enabled: rule.enabled !== false,
      headerTarget: rule.headerTarget || "request",
      requestMethod: rule.requestMethod || "all",
      operation: rule.operation || "set",
      headerName: rule.headerName,
      headerValue: rule.headerValue || ""
    });
  }
  return [...grouped.entries()].map(([urlFilter, headers]) => ({
    id: createTargetId(), urlFilter, enabled: true, headers
  }));
}

async function initialize() {
  try {
    const [stored, storedLegacy] = await Promise.all([
      chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]),
      chrome.storage.session.get(DRAFT_STORAGE_KEY)
    ]);
    if (Array.isArray(stored[STORAGE_KEY])) {
      targets = stored[STORAGE_KEY];
    } else if (Array.isArray(stored[LEGACY_STORAGE_KEY])) {
      targets = migrateLegacyRules(stored[LEGACY_STORAGE_KEY]);
      await chrome.storage.local.set({ [STORAGE_KEY]: targets });
    }

    if (targets.length > 0) {
      selectedTargetId = targets[0].id;
      composer = { open: false, mode: "new", targetId: null };
    } else {
      selectedTargetId = null;
      composer = { open: true, mode: "new", targetId: null };
      restoreDraft(storedLegacy[DRAFT_STORAGE_KEY]);
    }

    // Restore an in-progress append draft only when it matches selection.
    if (!composer.open && storedLegacy[DRAFT_STORAGE_KEY]) {
      const draft = storedLegacy[DRAFT_STORAGE_KEY];
      const owner = targets.find((t) => t.urlFilter === draft.urlFilter);
      if (owner) {
        selectedTargetId = owner.id;
        composer = { open: true, mode: "append", targetId: owner.id };
        elements.urlFilter.value = owner.urlFilter;
        elements.batchRows.innerHTML = "";
        draft.headers.forEach((h) => addDraftRow(h));
      }
    }

    if (!elements.batchRows.children.length) resetDraftRows();
    renderTargets();
    await chrome.runtime.sendMessage({ type: "sync-page-rules" });
  } catch (error) {
    showToast(`初始化失败：${error.message}`, true);
  }
}

/* ---------------- render ---------------- */

function truncationTitle(el) {
  // Tooltip only when text is actually clipped.
  el.title = el.scrollWidth > el.clientWidth ? el.textContent : "";
}

function renderRail() {
  elements.targetList.classList.toggle("bulk-mode", bulkMode);
  if (targets.length === 0) {
    elements.targetList.innerHTML = `<div class="rail-empty">暂无页面规则</div>`;
    return;
  }

  elements.targetList.innerHTML = targets.map((target) => {
    const activeHeaders = target.headers.filter((h) => h.enabled).length;
    const isOn = target.enabled;
    const selected = target.id === selectedTargetId && !(composer.open && composer.mode === "new");
    const checked = selectedTargetIds.has(target.id);
    return `
      <button class="rail-item ${selected ? "selected" : ""} ${isOn ? "is-on" : "rail-disabled"} ${checked ? "rail-checked" : ""}" data-target-id="${target.id}" type="button" role="listitem">
        <input class="rail-checkbox" data-action="select-target" type="checkbox" ${checked ? "checked" : ""} aria-label="选择 ${escapeAttribute(target.urlFilter)}" />
        <span class="rail-item-body">
          <span class="rail-url-row">
            <span class="rail-dot" aria-hidden="true"></span>
            <span class="rail-url">${escapeHtml(target.urlFilter)}</span>
          </span>
          <span class="rail-sub">${isOn
            ? `<span class="n">${activeHeaders}/${target.headers.length}</span><span>条已启用</span>`
            : '<span class="off-tag">已停用</span>'}</span>
        </span>
      </button>
    `;
  }).join("");

  requestAnimationFrame(() => {
    elements.targetList.querySelectorAll(".rail-url").forEach(truncationTitle);
  });
}

function ruleRowMarkup(header) {
  if (editingHeaderId === header.id) {
    return `
          <div class="saved-rule editing" data-header-id="${header.id}">
            <span class="rule-kind ${header.headerTarget === "response" ? "response" : ""}">${header.headerTarget === "request" ? "REQ" : "RES"}</span>
            <div class="rule-editor">
              <span>${escapeHtml(header.headerName)}</span>
              <input class="edit-value-input" value="${escapeAttribute(header.headerValue)}" aria-label="新的 Header 值" spellcheck="false" />
            </div>
            <div class="edit-actions">
              <button data-action="save-header-value" type="button">保存</button>
              <button data-action="cancel-header-value" type="button">取消</button>
            </div>
          </div>
        `;
  }

  return `
          <div class="saved-rule ${header.enabled ? "" : "disabled"}" data-header-id="${header.id}">
            <span class="rule-kind ${header.headerTarget === "response" ? "response" : ""}">${header.headerTarget === "request" ? "REQ" : "RES"}</span>
            <div class="rule-copy">
              <div class="rule-line"><span class="rule-op ${header.operation}">${header.operation.toUpperCase()}</span> ${escapeHtml(header.headerName)}${headerValueMarkup(header)}</div>
              <div class="rule-method">${header.requestMethod === "all" ? "ALL" : header.requestMethod.toUpperCase()}</div>
            </div>
            <div class="rule-actions">
              ${header.operation === "remove" ? "" : '<button data-action="edit-header-value" type="button">改值</button>'}
              <button data-action="toggle-header" type="button">${header.enabled ? "停用" : "启用"}</button>
              <button class="delete-rule" data-action="delete-header" type="button" aria-label="删除这条 Header">×</button>
            </div>
          </div>
        `;
}

function renderDetail() {
  const target = currentTarget();
  const inNewMode = composer.open && composer.mode === "new";

  elements.emptyState.hidden = targets.length > 0 || inNewMode;
  elements.targetDetail.hidden = !target || inNewMode;
  elements.newTargetBtn.classList.toggle("active", inNewMode);

  if (target) {
    const activeHeaders = target.headers.filter((h) => h.enabled).length;
    elements.targetDetail.classList.toggle("is-disabled", !target.enabled);
    elements.targetDetail.querySelector('[data-action="toggle-target"]').setAttribute("aria-pressed", String(target.enabled));
    elements.detailUrl.textContent = target.urlFilter;
    elements.detailStat.innerHTML = target.enabled
      ? `<span class="n">${activeHeaders}/${target.headers.length}</span> 条 Header 已启用`
      : '<span class="is-off">已停用</span>';
    elements.detailRules.innerHTML = target.headers.map(ruleRowMarkup).join("");
    requestAnimationFrame(() => truncationTitle(elements.detailUrl));
    if (editingHeaderId !== null) {
      const input = elements.detailRules.querySelector(".edit-value-input");
      input?.focus();
      input?.select();
    }
  }
}

function renderComposer() {
  const open = composer.open;
  elements.composerPanel.hidden = !open;
  elements.composerPanel.classList.toggle("open", open);
  if (!open) return;

  const isNew = composer.mode === "new";
  elements.urlFieldNew.hidden = !isNew;
  elements.urlFieldLocked.hidden = isNew;
  elements.useCurrentPage.style.display = isNew ? "" : "none";

  if (isNew) {
    elements.composerTitle.textContent = targets.length === 0 ? "新建页面规则" : "新增页面";
    elements.submitBtn.textContent = "创建并应用";
  } else {
    const target = currentTarget();
    elements.composerTitle.textContent = "追加 Header";
    elements.submitBtn.textContent = "应用到该页面";
    elements.urlLockedValue.textContent = target ? target.urlFilter : "";
  }
}

function renderBulk() {
  const hasTargets = targets.length > 0;
  elements.toggleBulkMode.hidden = targets.length === 0;
  elements.clearAll.hidden = targets.length === 0;
  elements.bulkBar.hidden = !bulkMode;
  elements.toggleBulkMode.textContent = bulkMode ? "完成" : "批量管理";
  elements.toggleBulkMode.classList.toggle("active", bulkMode);
  elements.selectAllTargets.checked = targets.length > 0 && selectedTargetIds.size === targets.length;
  elements.selectAllTargets.indeterminate = selectedTargetIds.size > 0 && selectedTargetIds.size < targets.length;
  elements.selectedTargetCount.textContent = String(selectedTargetIds.size).padStart(2, "0");
  const hasSelection = selectedTargetIds.size > 0;
  elements.enableSelected.disabled = !hasSelection;
  elements.disableSelected.disabled = !hasSelection;
  elements.invertSelected.disabled = !hasSelection;
}

function renderTargets() {
  // Prune stale ids.
  if (!targets.some((t) => t.id === selectedTargetId)) selectedTargetId = targets[0]?.id || null;
  for (const id of [...selectedTargetIds]) {
    if (!targets.some((t) => t.id === id)) selectedTargetIds.delete(id);
  }

  const liveRules = enabledHeaderCount();
  elements.targetCount.textContent = String(targets.length).padStart(2, "0");
  elements.activeCount.textContent = String(liveRules).padStart(2, "0");

  renderBulk();
  renderRail();
  renderDetail();
  renderComposer();
}

/* ---------------- mutations ---------------- */

async function commit(nextTargets, successMessage) {
  nextTargets = structuredClone(nextTargets);
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: nextTargets });
  } catch (error) {
    showToast(`更新失败：${error.message}`, true);
    throw error;
  }
  targets = nextTargets;
  renderTargets();
  showToast(successMessage);
  try {
    await chrome.runtime.sendMessage({ type: "sync-page-rules" });
  } catch (error) {
    showToast(`应用失败：${error.message}`, true);
  }
}

function mutateTargets(mutator, successMessage) {
  const nextTargets = structuredClone(targets);
  mutator(nextTargets);
  return commit(nextTargets, successMessage);
}

/* ---------------- composer open/close ---------------- */

function openNewComposer() {
  editingHeaderId = null;
  composer = { open: true, mode: "new", targetId: null };
  renderTargets();
  elements.composerPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  elements.urlFilter.focus();
}

function openAppendComposer(target) {
  editingHeaderId = null;
  selectedTargetId = target.id;
  composer = { open: true, mode: "append", targetId: target.id };
  // Preserve an in-progress draft for the same page; otherwise blank rows.
  const keepDraft = draftState().urlFilter === target.urlFilter
    && elements.batchRows.querySelector('[data-field="headerName"]')?.value.trim();
  elements.urlFilter.value = target.urlFilter;
  if (!keepDraft) {
    elements.batchRows.innerHTML = "";
    addDraftRow({});
    persistDraft();
  }
  renderTargets();
  elements.composerPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  elements.batchRows.querySelector('[data-field="headerName"]')?.focus();
}

function closeComposerPanel() {
  composer = { open: false, mode: "new", targetId: null };
  editingHeaderId = null;
  renderTargets();
}

/* ---------------- submit ---------------- */

async function submitBatch(event) {
  event.preventDefault();

  const urlFilter = composer.mode === "append"
    ? currentTarget()?.urlFilter
    : elements.urlFilter.value.trim();
  if (!urlFilter) {
    showToast("页面 URL 不能为空", true);
    return;
  }

  const draftHeaders = collectDraftHeaders();
  for (let index = 0; index < draftHeaders.length; index += 1) {
    const header = draftHeaders[index];
    const prefix = `第 ${index + 1} 行：`;
    if (/\s/.test(header.headerName)) {
      showToast(`${prefix}Header 名称不能包含空格`, true);
      return;
    }
    if (!header.headerName) {
      showToast(`${prefix}请填写 Header 名称`, true);
      return;
    }
    if (header.operation !== "remove" && header.headerValue === "") {
      showToast(`${prefix}请填写 Header 值`, true);
      return;
    }
    if (header.headerTarget === "request" && header.operation === "append" && !APPENDABLE_REQUEST_HEADERS.has(header.headerName)) {
      showToast(`${prefix}Chrome 不允许 APPEND ${header.headerName}，请使用 SET`, true);
      return;
    }
  }

  // Same (target, request method, header name) wins with the newest batch row;
  // equal-priority DNR conflicts across targets are avoided this way.
  const headerKey = (header) => [
    header.headerTarget, header.requestMethod, header.headerName.toLowerCase()
  ].join(":");
  const headers = [...new Map(draftHeaders.map((header) => [headerKey(header), header])).values()];

  const existing = targets.find((t) => t.urlFilter === urlFilter);
  const nextTargets = structuredClone(targets);
  let createdId = null;
  if (existing) {
    const target = nextTargets.find((item) => item.id === existing.id);
    const existingIndex = new Map();
    target.headers.forEach((item, index) => existingIndex.set(headerKey(item), index));
    for (const header of headers) {
      const idx = existingIndex.get(headerKey(header));
      if (idx >= 0) {
        header.id = target.headers[idx].id;
        target.headers[idx] = header;
      } else {
        target.headers.push(header);
      }
    }
    target.enabled = true;
    createdId = target.id;
  } else {
    const target = { id: createTargetId(), urlFilter, enabled: true, headers };
    nextTargets.unshift(target);
    createdId = target.id;
  }

  try {
    await commit(nextTargets, existing ? `已向 ${urlFilter} 追加 ${headers.length} 条规则` : `已创建目标并应用 ${headers.length} 条规则`);
    selectedTargetId = createdId;
    composer = { open: false, mode: "new", targetId: null };
    resetDraftRows();
    renderTargets();
    persistDraft();
  } catch {
    // toast already surfaced
  }

}

const APPENDABLE_REQUEST_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "access-control-request-headers",
  "access-control-request-method", "cache-control", "connection", "content-encoding",
  "content-language", "content-type", "cookie", "forwarded", "if-match", "if-none-match",
  "keep-alive", "range", "te", "trailer", "transfer-encoding", "upgrade",
  "via", "want-digest", "x-forwarded-for"
]);

/* ---------------- events ---------------- */

elements.form.addEventListener("submit", submitBatch);
elements.form.addEventListener("input", persistDraft);
elements.form.addEventListener("change", persistDraft);
elements.useCurrentPage.addEventListener("click", fillCurrentPage);

async function fillCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("当前页面不是 HTTP(S) 页面");
    elements.urlFilter.value = `||${url.hostname}/`;
    persistDraft();
    showToast(`已使用当前页面：${url.hostname}`);
  } catch (error) {
    showToast(error.message || "无法读取当前页面", true);
  }
}

elements.batchRows.addEventListener("change", (event) => {
  if (event.target.dataset.field === "operation") updateRowValueVisibility(event.target.closest(".batch-row"));
});
elements.batchRows.addEventListener("paste", (event) => {
  if (event.target.dataset.field !== "headerName") return;
  const parsed = parseHeaderPaste(event.clipboardData?.getData("text") || "");
  if (!parsed) return;
  event.preventDefault();
  applyParsedHeaderToRow(event.target.closest(".batch-row"), parsed[0]);
  for (const item of parsed.slice(1)) {
    addDraftRow({ headerName: item.name, headerValue: item.value, operation: "set" });
  }
  persistDraft();
});
elements.batchRows.addEventListener("click", (event) => {
  if (!event.target.closest('[data-action="remove-draft"]')) return;
  const rows = elements.batchRows.querySelectorAll(".batch-row");
  if (rows.length === 1) return;
  event.target.closest(".batch-row").remove();
  updateDraftRows();
  persistDraft();
});

/* rail: select + bulk checkbox */
elements.targetList.addEventListener("click", (event) => {
  const item = event.target.closest(".rail-item");
  if (!item) return;
  const targetId = item.dataset.targetId;
  const target = targets.find((t) => t.id === targetId);
  if (!target) return;

  if (event.target.closest('[data-action="select-target"]')) {
    const checked = event.target.checked;
    checked ? selectedTargetIds.add(targetId) : selectedTargetIds.delete(targetId);
    renderBulk();
    renderRail();
    return;
  }

  selectedTargetId = targetId;
  // Switching target discards a "new page" draft view.
  if (composer.open && composer.mode === "new") {
    composer = { open: false, mode: "new", targetId: null };
  }
  renderTargets();
});

/* detail head + rules */
document.querySelector("#targetDetail").addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-action]");
  const target = currentTarget();
  if (!target) return;

  if (!actionButton) return;
  const action = actionButton.dataset.action;

  if (action === "toggle-target") {
    mutateTargets((next) => { next.find((item) => item.id === target.id).enabled = !target.enabled; },
      target.enabled ? "目标已整体停用" : "目标已整体启用");
  } else if (action === "append-target") {
    openAppendComposer(target);
  } else if (action === "delete-target") {
    mutateTargets((next) => next.splice(next.findIndex((item) => item.id === target.id), 1), "目标及其规则已删除");
  } else if (["toggle-header", "delete-header", "edit-header-value", "save-header-value", "cancel-header-value"].includes(action)) {
    handleHeaderAction(action, target, actionButton, event);
  }
});

function handleHeaderAction(action, target, actionButton, event) {
  const headerId = Number(event.target.closest(".saved-rule")?.dataset.headerId);
  if (!Number.isInteger(headerId)) return;

  if (action === "select-target") {
    actionButton.checked ? selectedTargetIds.add(target.id) : selectedTargetIds.delete(target.id);
    renderTargets();
  } else if (action === "edit-header-value") {
    editingHeaderId = headerId;
    renderDetail();
  } else if (action === "cancel-header-value") {
    editingHeaderId = null;
    renderDetail();
  } else if (action === "save-header-value") {
    const input = elements.detailRules.querySelector(".edit-value-input");
    if (input.value === "") { showToast("Header 值不能为空", true); return; }
    mutateTargets((next) => {
      const nextHeader = next.find((item) => item.id === target.id)?.headers.find((item) => item.id === headerId);
      if (nextHeader) nextHeader.headerValue = input.value;
    }, "Header 值已更新").then(() => { editingHeaderId = null; renderDetail(); });
  } else if (action === "toggle-header") {
    mutateTargets((next) => {
      const nextHeader = next.find((item) => item.id === target.id)?.headers.find((item) => item.id === headerId);
      if (nextHeader) nextHeader.enabled = !nextHeader.enabled;
    }, headerById(target, headerId)?.enabled ? "Header 已停用" : "Header 已启用");
  } else if (action === "delete-header") {
    mutateTargets((next) => {
      const nextTarget = next.find((item) => item.id === target.id);
      const idx = nextTarget.headers.findIndex((item) => item.id === headerId);
      if (idx >= 0) nextTarget.headers.splice(idx, 1);
      // Remove the target shell when its last rule is gone.
      if (nextTarget.headers.length === 0) {
        const ti = next.findIndex((item) => item.id === target.id);
        next.splice(ti, 1);
      }
    }, "Header 已删除");
  }
}

function headerById(target, id) {
  return target.headers.find((h) => h.id === id);
}

/* Enter/Escape inside value editor */
elements.detailRules.addEventListener("keydown", (event) => {
  if (!event.target.classList.contains("edit-value-input")) return;
  const savedRule = event.target.closest(".saved-rule");
  if (event.key === "Enter") {
    event.preventDefault();
    savedRule.querySelector('[data-action="save-header-value"]').click();
  } else if (event.key === "Escape") {
    savedRule.querySelector('[data-action="cancel-header-value"]').click();
  }
});

/* composer buttons */
elements.newTargetBtn.addEventListener("click", openNewComposer);
elements.emptyCreate.addEventListener("click", openNewComposer);
elements.closeComposer.addEventListener("click", closeComposerPanel);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !composer.open || editingHeaderId !== null) return;
  if (event.target.closest("input, select, textarea")) return;
  closeComposerPanel();
});

/* bulk */
elements.selectAllTargets.addEventListener("change", () => {
  selectedTargetIds.clear();
  if (elements.selectAllTargets.checked) targets.forEach((t) => selectedTargetIds.add(t.id));
  renderBulk();
  renderRail();
});

async function updateSelectedTargets(mode) {
  if (selectedTargetIds.size === 0) return;
  const selectedIds = new Set(selectedTargetIds);
  const messages = { enable: `已启用 ${selectedIds.size} 个页面规则`, disable: `已停用 ${selectedIds.size} 个页面规则`, invert: `已反转 ${selectedIds.size} 个页面规则状态` };
  await mutateTargets((next) => {
    next.forEach((target) => {
      if (!selectedIds.has(target.id)) return;
      if (mode === "enable") target.enabled = true;
      else if (mode === "disable") target.enabled = false;
      else target.enabled = !target.enabled;
    });
  }, messages[mode]);
}

elements.enableSelected.addEventListener("click", () => updateSelectedTargets("enable"));
elements.disableSelected.addEventListener("click", () => updateSelectedTargets("disable"));
elements.invertSelected.addEventListener("click", () => updateSelectedTargets("invert"));

elements.toggleBulkMode.addEventListener("click", () => {
  bulkMode = !bulkMode;
  if (!bulkMode) selectedTargetIds.clear();
  renderTargets();
});

elements.clearAll.addEventListener("click", mutateTargets.bind(null, (next) => next.splice(0), "全部目标已清空"));

resetDraftRows();
initialize();
