const STORAGE_KEY = "headerFoundryTargetsV2";
const LEGACY_STORAGE_KEY = "headerFoundryRules";

const RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
];

const APPENDABLE_REQUEST_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "access-control-request-headers",
  "cache-control", "connection", "content-language", "cookie", "forwarded",
  "if-match", "if-none-match", "keep-alive", "range", "te", "trailer",
  "transfer-encoding", "upgrade", "user-agent", "via", "want-digest", "x-forwarded-for"
]);

const elements = {
  form: document.querySelector("#targetForm"),
  urlFilter: document.querySelector("#urlFilter"),
  batchRows: document.querySelector("#batchRows"),
  addHeaderRow: document.querySelector("#addHeaderRow"),
  draftCount: document.querySelector("#draftCount"),
  targetList: document.querySelector("#targetList"),
  emptyState: document.querySelector("#emptyState"),
  targetCount: document.querySelector("#targetCount"),
  activeCount: document.querySelector("#activeCount"),
  clearAll: document.querySelector("#clearAll"),
  toast: document.querySelector("#toast")
};

let targets = [];
let draftRowSequence = 0;
let toastTimer;
let editingHeaderId = null;
const collapsedTargets = new Set();

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

function nextRuleId() {
  const usedIds = new Set(allHeaders().map((header) => header.id));
  let candidate = Math.max(0, ...usedIds) + 1;
  if (candidate > 2_000_000_000) {
    candidate = 1;
    while (usedIds.has(candidate)) candidate += 1;
  }
  return candidate;
}

function createTargetId() {
  return `target-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function toDnrRule(target, header) {
  const change = { header: header.headerName, operation: header.operation };
  if (header.operation !== "remove") change.value = header.headerValue;

  const condition = { urlFilter: target.urlFilter, resourceTypes: RESOURCE_TYPES };
  if (header.requestMethod !== "all") condition.requestMethods = [header.requestMethod];

  return {
    id: header.id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      [header.headerTarget === "request" ? "requestHeaders" : "responseHeaders"]: [change]
    },
    condition
  };
}

function enabledDnrRules(source = targets) {
  return source.flatMap((target) => {
    if (!target.enabled) return [];
    return target.headers
      .filter((header) => header.enabled)
      .map((header) => toDnrRule(target, header));
  });
}

async function syncDnr(source = targets) {
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  const desired = enabledDnrRules(source);
  if (current.length === 0 && desired.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: current.map((rule) => rule.id),
    addRules: desired
  });
}

async function commit(nextTargets) {
  await syncDnr(nextTargets);
  await chrome.storage.local.set({ [STORAGE_KEY]: nextTargets });
  targets = nextTargets;
  renderTargets();
}

function headerValueMarkup(header) {
  if (header.operation === "remove") return "";
  return ` <b>${escapeHtml(header.headerValue)}</b>`;
}

function renderTargets() {
  const liveRules = enabledDnrRules().length;
  elements.targetCount.textContent = String(targets.length).padStart(2, "0");
  elements.activeCount.textContent = String(liveRules).padStart(2, "0");
  elements.emptyState.hidden = targets.length > 0;
  elements.clearAll.hidden = targets.length === 0;

  elements.targetList.innerHTML = targets.map((target) => {
    const activeHeaders = target.headers.filter((header) => header.enabled).length;
    const collapsed = collapsedTargets.has(target.id);
    const rows = target.headers.map((header) => {
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
            <div class="rule-line">${header.operation.toUpperCase()} ${escapeHtml(header.headerName)}${headerValueMarkup(header)}</div>
            <div class="rule-method">${header.requestMethod === "all" ? "ALL METHODS" : header.requestMethod.toUpperCase()}</div>
          </div>
          <div class="rule-actions">
            ${header.operation === "remove" ? "" : '<button data-action="edit-header-value" type="button">改值</button>'}
            <button data-action="toggle-header" type="button">${header.enabled ? "停用" : "启用"}</button>
            <button class="delete-rule" data-action="delete-header" type="button" aria-label="删除这条 Header">×</button>
          </div>
        </div>
      `;
    }).join("");

    return `
      <article class="target-card ${target.enabled ? "" : "disabled"} ${collapsed ? "collapsed" : ""}" data-target-id="${target.id}">
        <div class="target-head">
          <button class="toggle" data-action="toggle-target" type="button" aria-label="${target.enabled ? "停用" : "启用"}该目标" aria-pressed="${target.enabled}"></button>
          <div class="target-identity">
            <div class="target-url">${escapeHtml(target.urlFilter)}</div>
            <div class="target-stat">${activeHeaders}/${target.headers.length} HEADERS READY</div>
          </div>
          <div class="target-actions">
            <button class="icon-button" data-action="append-target" type="button" title="向此 URL 追加规则">＋</button>
            <button class="icon-button collapse-button" data-action="collapse-target" type="button" title="展开或收起">⌄</button>
            <button class="icon-button danger" data-action="delete-target" type="button" title="删除目标">×</button>
          </div>
        </div>
        <div class="target-rules">${rows}</div>
      </article>
    `;
  }).join("");
}

function rowTemplate(rowId) {
  return `
    <div class="batch-row" data-row-id="${rowId}">
      <span class="row-number">01</span>
      <select data-field="headerTarget" aria-label="作用位置"><option value="request">请求头</option><option value="response">响应头</option></select>
      <select data-field="requestMethod" aria-label="请求方法"><option value="all">ALL</option><option value="get">GET</option><option value="post">POST</option><option value="put">PUT</option><option value="patch">PATCH</option><option value="delete">DELETE</option></select>
      <select data-field="operation" aria-label="操作"><option value="set">SET</option><option value="remove">REMOVE</option><option value="append">APPEND</option></select>
      <input data-field="headerName" required placeholder="X-Debug" aria-label="Header 名称" spellcheck="false" />
      <input class="value-input" data-field="headerValue" value="true" placeholder="true" aria-label="Header 值" spellcheck="false" />
      <button class="remove-row" data-action="remove-draft" type="button" aria-label="移除这一行">×</button>
    </div>
  `;
}

function updateDraftRows() {
  const rows = [...elements.batchRows.querySelectorAll(".batch-row")];
  rows.forEach((row, index) => {
    row.querySelector(".row-number").textContent = String(index + 1).padStart(2, "0");
    row.querySelector(".remove-row").disabled = rows.length === 1;
  });
  elements.draftCount.textContent = String(rows.length).padStart(2, "0");
}

function addDraftRow(initial = {}) {
  draftRowSequence += 1;
  elements.batchRows.insertAdjacentHTML("beforeend", rowTemplate(draftRowSequence));
  const row = elements.batchRows.lastElementChild;
  for (const [field, value] of Object.entries(initial)) {
    const input = row.querySelector(`[data-field="${field}"]`);
    if (input) input.value = value;
  }
  updateRowValueVisibility(row);
  updateDraftRows();
}

function updateRowValueVisibility(row) {
  const operation = row.querySelector('[data-field="operation"]').value;
  const valueInput = row.querySelector('[data-field="headerValue"]');
  valueInput.disabled = operation === "remove";
  valueInput.required = operation !== "remove";
}

function collectDraftHeaders() {
  const usedIds = new Set(allHeaders().map((header) => header.id));
  let candidate = nextRuleId();

  return [...elements.batchRows.querySelectorAll(".batch-row")].map((row) => {
    while (usedIds.has(candidate)) candidate += 1;
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

function validateHeader(header, index) {
  const prefix = `第 ${index + 1} 行：`;
  if (!header.headerName) return `${prefix}Header 名称不能为空`;
  if (/\s/.test(header.headerName)) return `${prefix}Header 名称不能包含空格`;
  if (header.operation !== "remove" && header.headerValue === "") return `${prefix}请填写 Header 值`;
  if (header.headerTarget === "request" && header.operation === "append" && !APPENDABLE_REQUEST_HEADERS.has(header.headerName)) {
    return `${prefix}Chrome 不允许 APPEND ${header.headerName}，请使用 SET`;
  }
  return null;
}

async function submitBatch(event) {
  event.preventDefault();
  const urlFilter = elements.urlFilter.value.trim();
  if (!urlFilter) return showToast("目标 URL 不能为空", true);

  const draftHeaders = collectDraftHeaders();
  for (let index = 0; index < draftHeaders.length; index += 1) {
    const error = validateHeader(draftHeaders[index], index);
    if (error) return showToast(error, true);
  }

  // The last duplicate in a batch wins, preventing equal-priority DNR conflicts.
  const headerKey = (header) => [
    header.headerTarget,
    header.requestMethod,
    header.headerName.toLowerCase()
  ].join(":");
  const headers = [...new Map(draftHeaders.map((header) => [headerKey(header), header])).values()];

  const existing = targets.find((target) => target.urlFilter === urlFilter);
  const nextTargets = structuredClone(targets);
  if (existing) {
    const target = nextTargets.find((item) => item.id === existing.id);
    target.enabled = true;
    for (const header of headers) {
      const existingIndex = target.headers.findIndex((item) => headerKey(item) === headerKey(header));
      if (existingIndex >= 0) {
        header.id = target.headers[existingIndex].id;
        target.headers[existingIndex] = header;
      } else {
        target.headers.push(header);
      }
    }
    collapsedTargets.delete(target.id);
  } else {
    nextTargets.unshift({ id: createTargetId(), urlFilter, enabled: true, headers });
  }

  try {
    await commit(nextTargets);
    elements.batchRows.innerHTML = "";
    addDraftRow();
    showToast(existing ? `已向 ${urlFilter} 追加 ${headers.length} 条规则` : `已创建目标并应用 ${headers.length} 条规则`);
  } catch (error) {
    showToast(`应用失败：${error.message}`, true);
  }
}

async function mutateTargets(mutator, successMessage) {
  const nextTargets = structuredClone(targets);
  mutator(nextTargets);
  try {
    await commit(nextTargets);
    showToast(successMessage);
  } catch (error) {
    showToast(`更新失败：${error.message}`, true);
  }
}

function migrateLegacyRules(legacyRules) {
  const grouped = new Map();
  for (const rule of legacyRules) {
    if (!rule || !rule.urlFilter || !Number.isInteger(rule.id)) continue;
    if (!grouped.has(rule.urlFilter)) {
      grouped.set(rule.urlFilter, { id: createTargetId(), urlFilter: rule.urlFilter, enabled: true, headers: [] });
    }
    grouped.get(rule.urlFilter).headers.push({
      id: rule.id,
      enabled: rule.enabled !== false,
      headerTarget: rule.headerTarget || "request",
      requestMethod: rule.requestMethod || "all",
      operation: rule.operation || "set",
      headerName: rule.headerName,
      headerValue: rule.headerValue || ""
    });
  }
  return [...grouped.values()];
}

async function initialize() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
    if (Array.isArray(stored[STORAGE_KEY])) {
      targets = stored[STORAGE_KEY];
    } else if (Array.isArray(stored[LEGACY_STORAGE_KEY])) {
      targets = migrateLegacyRules(stored[LEGACY_STORAGE_KEY]);
      await chrome.storage.local.set({ [STORAGE_KEY]: targets });
    }
    await syncDnr();
    renderTargets();
  } catch (error) {
    showToast(`初始化失败：${error.message}`, true);
  }
}

elements.form.addEventListener("submit", submitBatch);
elements.addHeaderRow.addEventListener("click", () => addDraftRow());
elements.batchRows.addEventListener("change", (event) => {
  if (event.target.dataset.field === "operation") updateRowValueVisibility(event.target.closest(".batch-row"));
});
elements.batchRows.addEventListener("click", (event) => {
  if (!event.target.closest('[data-action="remove-draft"]')) return;
  const rows = elements.batchRows.querySelectorAll(".batch-row");
  if (rows.length === 1) return;
  event.target.closest(".batch-row").remove();
  updateDraftRows();
});

elements.targetList.addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-action]");
  const card = event.target.closest(".target-card");
  if (!actionButton || !card) return;
  const targetId = card.dataset.targetId;
  const target = targets.find((item) => item.id === targetId);
  if (!target) return;

  const action = actionButton.dataset.action;
  if (action === "collapse-target") {
    collapsedTargets.has(targetId) ? collapsedTargets.delete(targetId) : collapsedTargets.add(targetId);
    renderTargets();
  } else if (action === "append-target") {
    elements.urlFilter.value = target.urlFilter;
    window.scrollTo({ top: 0, behavior: "smooth" });
    elements.batchRows.querySelector('[data-field="headerName"]').focus();
    showToast("已锁定目标 URL，可继续批量追加");
  } else if (action === "toggle-target") {
    mutateTargets((next) => { next.find((item) => item.id === targetId).enabled = !target.enabled; }, target.enabled ? "目标已整体停用" : "目标已整体启用");
  } else if (action === "delete-target") {
    mutateTargets((next) => next.splice(next.findIndex((item) => item.id === targetId), 1), "目标及其规则已删除");
  } else {
    const headerId = Number(event.target.closest(".saved-rule")?.dataset.headerId);
    if (!Number.isInteger(headerId)) return;
    if (action === "edit-header-value") {
      editingHeaderId = headerId;
      renderTargets();
      const input = elements.targetList.querySelector(`.saved-rule[data-header-id="${headerId}"] .edit-value-input`);
      input?.focus();
      input?.select();
    } else if (action === "cancel-header-value") {
      editingHeaderId = null;
      renderTargets();
    } else if (action === "save-header-value") {
      const input = event.target.closest(".saved-rule").querySelector(".edit-value-input");
      if (input.value === "") return showToast("Header 值不能为空", true);
      mutateTargets((next) => {
        const nextHeader = next.find((item) => item.id === targetId).headers.find((item) => item.id === headerId);
        nextHeader.headerValue = input.value;
      }, "Header 值已更新");
      editingHeaderId = null;
    } else if (action === "toggle-header") {
      const header = target.headers.find((item) => item.id === headerId);
      mutateTargets((next) => {
        const nextHeader = next.find((item) => item.id === targetId).headers.find((item) => item.id === headerId);
        nextHeader.enabled = !header.enabled;
      }, header.enabled ? "Header 已停用" : "Header 已启用");
    } else if (action === "delete-header") {
      mutateTargets((next) => {
        const targetIndex = next.findIndex((item) => item.id === targetId);
        next[targetIndex].headers = next[targetIndex].headers.filter((item) => item.id !== headerId);
        if (next[targetIndex].headers.length === 0) next.splice(targetIndex, 1);
      }, "Header 已删除");
    }
  }
});

elements.targetList.addEventListener("keydown", (event) => {
  if (!event.target.classList.contains("edit-value-input")) return;
  const savedRule = event.target.closest(".saved-rule");
  if (event.key === "Enter") {
    event.preventDefault();
    savedRule.querySelector('[data-action="save-header-value"]').click();
  } else if (event.key === "Escape") {
    savedRule.querySelector('[data-action="cancel-header-value"]').click();
  }
});

elements.clearAll.addEventListener("click", () => mutateTargets((next) => next.splice(0), "全部目标已清空"));

addDraftRow({ headerName: "X-Debug", headerValue: "true" });
initialize();
