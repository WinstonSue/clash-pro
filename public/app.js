const supplierIds = () => Object.keys(state?.suppliers || {});
const supplierName = id => state?.supplierNames?.[id] || "已删除的供应商";
const laneNames = { agent: "Agent", daily: "日常" };
const byId = (id) => document.getElementById(id);
const regionFields = byId("region-fields");
const heartbeatFields = byId("heartbeat-fields");
const regionSelect = byId("region");
const extraChoices = byId("extra-regions");
const activeInterval = byId("interval-active");
const extraInterval = byId("interval-extra");

const controllerLabels = {
  offline: "Clash Verge 未连接",
  unmanaged: "等待启用合并配置",
  ready: "Clash 已连接",
  switching: "正在切换地区",
  error: "Clash 状态异常",
};

const healthLabels = {
  waiting: "待检查",
  healthy: "可用",
  warning: "只剩一个",
  down: "全断",
  unknown: "待确认",
  checking: "检查中",
};

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const regionFormat = new Intl.Collator("zh-CN");
let state;
let requestGeneration = 0;
let pendingAction;
let dirtyRegion = false;
let dirtyHeartbeat = false;
let regionsSignature;
let monitorSignature;
let alertsSignature;
let routesSignature;
let sharingSignature;
let requestedFocus = preferredFocus();
let currentPage;
let detailSupplier;
let detailRequest;
let importSupplier;
let removalSupplier;
const addDialog = byId("add-dialog");
const detailDialog = byId("detail-dialog");
const importDialog = byId("import-dialog");
const heartbeatDialog = byId("heartbeat-dialog");
const removeDialog = byId("remove-dialog");
const helpDialog = byId("help-dialog");
const openHelp = byId("open-help");
const helpDownloadAddress = byId("help-download-address");
const dialogs = [addDialog, detailDialog, importDialog, heartbeatDialog, removeDialog, helpDialog];
const pageLabels = { local: "供应商直连", client: "Tailscale 跳板" };
const protocolLabels = { ss: "Shadowsocks", anytls: "AnyTLS", trojan: "Trojan", vmess: "VMess", vless: "VLESS" };

function element(tag, label, className) {
  const node = document.createElement(tag);
  if (label !== undefined) node.textContent = label;
  if (className) node.className = className;
  return node;
}

function message(id, content = "", level = "") {
  const node = byId(id);
  node.textContent = content;
  node.dataset.level = level;
  if (node.classList.contains("notice")) node.hidden = !content;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : dateFormat.format(date);
}

function safeMessage(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/https?:\/\/[^\s，。；）)]+/gi, "链接").slice(0, 220);
}

async function request(path, body) {
  const options = { cache: "no-store" };
  if (body !== undefined) {
    options.method = "POST";
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  } else {
    options.signal = AbortSignal.timeout(5500);
  }
  const response = await fetch(`api/${path}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(safeMessage(result?.error, "操作失败，请重试。"));
  return result;
}

function regionName(code) {
  return state?.regions?.[code] || code;
}

function getRegionEntries() {
  return Object.entries(state.regions || {}).sort((left, right) => regionFormat.compare(left[1], right[1]));
}

function preferredFocus() {
  const match = location.hash.match(/^#import-([AB]|p[0-9a-f]{12})$/);
  return match?.[1];
}

function showPage(page) {
  if (page === currentPage) return;
  const local = page === "local";
  currentPage = page;
  byId("supplier-page").hidden = !local;
  byId("gateway-page").hidden = local;
  for (const [id, active] of [["nav-supplier", local], ["nav-gateway", !local]]) {
    if (active) byId(id).setAttribute("aria-current", "page");
    else byId(id).removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
}

function focusImport(supplier) {
  if (pendingAction || !state) {
    requestedFocus = supplier;
    return;
  }
  requestedFocus = undefined;
  showPage("local");
  if (!Object.hasOwn(state.suppliers, supplier)) {
    message("supplier-message", "该供应商已删除。", "error");
    byId("supplier-section").scrollIntoView({ block: "start" });
    return;
  }
  if (importDialog.open && importSupplier === supplier) {
    byId("import-nodes").elements.subscription.focus();
    return;
  }
  for (const dialog of dialogs) if (dialog.open) dialog.close();
  importSupplier = supplier;
  byId("import-nodes").reset();
  byId("import-title").textContent = `导入节点 · ${supplierName(supplier)}`;
  message("import-message");
  importDialog.showModal();
}

function heartbeatFromFields() {
  return {
    extraRegions: Array.from(extraChoices.querySelectorAll("input:checked"), ({ value }) => value)
      .filter(code => code !== state.region).sort(),
    intervals: { active: activeInterval.valueAsNumber, extra: extraInterval.valueAsNumber },
  };
}

function heartbeatFromState() {
  return {
    extraRegions: [...(state.extraRegions || [])].filter((code) => code !== state.region).sort(),
    intervals: { active: state.intervals?.active ?? 10, extra: state.intervals?.extra ?? 30 },
  };
}

function renderSettings() {
  const entries = getRegionEntries();
  const signature = JSON.stringify(entries);
  const region = dirtyRegion ? regionSelect.value : state.region;
  if (signature !== regionsSignature) {
    const draft = dirtyHeartbeat ? heartbeatFromFields() : heartbeatFromState();
    regionSelect.replaceChildren();
    extraChoices.replaceChildren();
    for (const [code, label] of entries) {
      const option = element("option", label);
      option.value = code;
      regionSelect.append(option);

      const choice = element("label", undefined, "choice");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.value = code;
      checkbox.checked = draft.extraRegions.includes(code);
      const current = element("small", "当前");
      current.hidden = true;
      choice.append(checkbox, element("span", label), current);
      extraChoices.append(choice);
    }
    regionsSignature = signature;
  }
  regionSelect.value = region;
  dirtyRegion = regionSelect.value !== state.region;
  byId("route-summary").textContent = `${regionName(state.region)} · Agent 与日常共用`;
  if (heartbeatDialog.open) renderHeartbeatDraft();
}

function renderHeartbeatDraft() {
  const saved = heartbeatFromState();
  const selected = new Set(saved.extraRegions);
  if (!dirtyHeartbeat) {
    activeInterval.value = saved.intervals.active;
    extraInterval.value = saved.intervals.extra;
  }
  byId("heartbeat-current").textContent = `当前地区 · ${regionName(state.region)}`;
  for (const checkbox of extraChoices.querySelectorAll("input")) {
    const current = checkbox.value === state.region;
    if (current) checkbox.checked = false;
    else if (!dirtyHeartbeat) checkbox.checked = selected.has(checkbox.value);
    checkbox.disabled = current;
    checkbox.parentElement.querySelector("small").hidden = !current;
  }
  if (!pendingAction) dirtyHeartbeat = JSON.stringify(heartbeatFromFields()) !== JSON.stringify(saved);
}

function actionButton(label, handler) {
  const button = element("button", label, "mutation");
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function createSupplierRow(id) {
  const row = element("li", undefined, "supplier-row");
  row.id = `supplier-${id}`;
  const identity = element("div", undefined, "supplier-identity");
  const name = element("h3");
  name.id = `supplier-name-${id}`;
  const summary = element("div", undefined, "supplier-summary");
  summary.id = `summary-${id}`;
  identity.append(name, summary);

  const actions = element("div", undefined, "supplier-actions");
  const remove = actionButton("删除", () => openSupplierRemoval(id));
  remove.classList.add("danger-action");
  remove.setAttribute("aria-haspopup", "dialog");
  remove.setAttribute("aria-describedby", name.id);
  actions.append(actionButton("节点详情", () => void openSupplierDetails(id)),
    actionButton("导入节点", () => focusImport(id)), remove);
  row.append(identity, actions);
  return row;
}

function renderSuppliers() {
  const list = byId("supplier-list");
  const ids = supplierIds();
  byId("empty-suppliers").hidden = ids.length !== 0;
  for (const row of [...list.children]) {
    if (!Object.hasOwn(state.suppliers, row.id.slice("supplier-".length))) row.remove();
  }
  for (const id of ids) {
    const snapshot = state.suppliers[id];
    if (!byId(`supplier-${id}`)) list.append(createSupplierRow(id));
    byId(`supplier-name-${id}`).textContent = snapshot.name;
    const overview = byId(`summary-${id}`);
    overview.replaceChildren(element("strong", `${snapshot.total} 个节点`));
    if (snapshot.unknown) overview.append(element("span", `未识别地区 ${snapshot.unknown}`));
    const imported = formatDate(snapshot.importedAt);
    overview.append(element("span", imported ? `导入于 ${imported}` : "尚未导入"));
  }
}

function supplierChangesNeedRefresh() {
  return state.networkMode === "local" || state.controller?.activeMode === "local";
}

function renderSupplierRemoval() {
  const supplier = state.suppliers[removalSupplier];
  if (!supplier) {
    byId("remove-impact").textContent = "该供应商已删除。";
    byId("remove-warning").hidden = true;
    return;
  }
  const lanes = Object.keys(laneNames).filter(lane => state.routes[lane].includes(removalSupplier));
  const emptied = lanes.filter(lane => state.routes[lane].length === 1);
  const label = lanes.map(lane => laneNames[lane]).join("、");
  const impact = label ? `将从${label}线路移除该供应商。` : "该供应商未加入 Agent 或日常线路。";
  const refresh = supplierChangesNeedRefresh() ? "请在删除后刷新 Clash Verge 中的本机配置。" : "";
  byId("remove-impact").textContent = `删除「${supplier.name}」及其节点？${impact}${refresh}`;
  const warning = byId("remove-warning");
  warning.hidden = !emptied.length;
  warning.textContent = emptied.length ? `${emptied.map(lane => laneNames[lane]).join("、")}线路将没有供应商。` : "";
}

function openSupplierRemoval(id) {
  if (!Object.hasOwn(state.suppliers, id)) return;
  removalSupplier = id;
  renderSupplierRemoval();
  message("remove-message");
  removeDialog.showModal();
  renderControls();
}

function renderNodeGroups(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    if (!groups.has(node.region)) groups.set(node.region, []);
    groups.get(node.region).push(node);
  }
  const entries = [...groups.entries()].sort(([a], [b]) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return regionFormat.compare(regionName(a), regionName(b));
  });
  byId("node-groups").replaceChildren(...entries.map(([code, members]) => {
    const group = element("details", undefined, "node-group");
    const summary = element("summary");
    summary.append(element("span", code ? regionName(code) : "未识别地区"),
      element("span", `${members.length} 个节点`, "muted"));
    const list = element("ul", undefined, "node-list");
    for (const { name, protocol } of members) {
      const row = element("li");
      row.append(element("span", name), element("span", protocolLabels[protocol] || protocol, "muted"));
      list.append(row);
    }
    group.append(summary, list);
    return group;
  }));
  message("detail-message", nodes.length ? "" : "尚未导入节点");
}

async function openSupplierDetails(id) {
  if (!Object.hasOwn(state.suppliers, id)) return;
  detailSupplier = id;
  byId("detail-title").textContent = `节点详情 · ${supplierName(id)}`;
  byId("rename-supplier").elements.name.value = supplierName(id);
  byId("node-groups").replaceChildren();
  message("edit-message");
  message("detail-message", "正在读取节点…");
  detailDialog.showModal();
  const current = Symbol();
  detailRequest = current;
  try {
    const { nodes } = await request(`suppliers/${id}/nodes`);
    if (detailDialog.open && detailRequest === current) renderNodeGroups(nodes);
  } catch (error) {
    if (detailDialog.open && detailRequest === current) {
      message("detail-message", safeMessage(error.message, "无法读取节点，请重试。"), "error");
    }
  }
}

function renderRoutes() {
  const active = state.controller?.activeRoutes;
  const signature = JSON.stringify([state.routes, state.supplierNames, active, state.controller?.needsRefresh]);
  if (signature === routesSignature) return;
  routesSignature = signature;
  byId("lane-grid").replaceChildren(...Object.entries(laneNames).map(([lane, title]) => {
    const panel = element("div", undefined, "lane-panel");
    panel.append(element("h3", title));
    const ordered = state.routes[lane];
    const save = order => change("routes", { ...state.routes, [lane]: order }, "route-message");
    const list = element("ol", undefined, "lane-list");
    for (const [index, id] of ordered.entries()) {
      const row = element("li", undefined, "lane-row");
      row.append(element("span", `${index + 1}. ${supplierName(id)}`));
      const move = (step) => {
        const order = [...ordered];
        [order[index], order[index + step]] = [order[index + step], order[index]];
        void save(order);
      };
      if (index > 0) row.append(actionButton("上移", () => move(-1)));
      if (index + 1 < ordered.length) row.append(actionButton("下移", () => move(1)));
      row.append(actionButton("移除", () => save(ordered.filter(value => value !== id))));
      list.append(row);
    }
    panel.append(list);
    if (!ordered.length) panel.append(element("p", "尚未分配供应商", "muted"));
    const available = supplierIds().filter(id => !ordered.includes(id));
    if (available.length) {
      const selection = element("select");
      selection.setAttribute("aria-label", `${title}可添加供应商`);
      for (const id of available) {
        const option = element("option", supplierName(id));
        option.value = id;
        selection.append(option);
      }
      const add = element("div", undefined, "inline-actions");
      add.append(selection, actionButton("添加到线路", () => save([...ordered, selection.value])));
      panel.append(add);
    }
    if (state.controller?.needsRefresh && active) {
      panel.append(element("p", `Clash Verge 当前节点顺序 ${active[lane].map(supplierName).join(" → ") || "暂无节点"}`, "muted"));
    }
    return panel;
  }));
}

function renderSharing() {
  const share = state.sharing;
  const label = state.networkMode === "client"
    ? `通过 ${state.pairing.host}:${state.pairing.port} 上网`
    : share.state === "ready" ? `共享中 · ${share.address}:${share.port}` : share.message || "未开启共享";
  byId("gateway-status").textContent = label;
  byId("toggle-share").textContent = share.enabled ? "关闭共享" : "开启共享";
  const signature = JSON.stringify([share.devices, share.peers]);
  if (signature === sharingSignature) return;
  sharingSignature = signature;
  byId("authorize-panel").hidden = !share.devices.length;
  const select = byId("tailnet-devices");
  const selected = select.value;
  select.replaceChildren(...share.devices.map(device => {
    const option = element("option", `${device.name} · ${device.address}`);
    option.value = device.id;
    return option;
  }));
  if (share.devices.some(device => device.id === selected)) select.value = selected;
  byId("authorized-peers").replaceChildren(...share.peers.map(peer => {
    const row = element("li", undefined, "lane-row");
    const doAction = action => change("gateway", { action, device: peer.device }, "gateway-message",
      action === "rotate" ? "密钥已更换，请复制新配对码。" : "");
    row.append(element("span", `${peer.name} · ${peer.address}`),
      actionButton("复制配对码", () => doAction("code")),
      actionButton("更换密钥", () => doAction("rotate")),
      actionButton("撤销", () => doAction("revoke")));
    return row;
  }));
}

function healthCell(supplier, code, readings) {
  const td = element("td");
  const reading = readings.get(`${supplier}:${code}`);
  const inventoryCount = state.suppliers?.[supplier]?.regions?.[code] || 0;
  if (!reading && !inventoryCount) {
    td.append(element("span", "暂无节点", "muted"));
    return td;
  }
  const line = element("div", undefined, "health-line");
  let status = reading?.status || "waiting";
  if (reading && state.controller?.activeMode !== "local" && state.sharing?.state !== "ready") {
    status = "unknown";
  }
  if (Number.isInteger(reading?.available) && Number.isInteger(reading?.total)) {
    line.append(element("span", `${reading.available} / ${reading.total}`, "health-number"));
  }
  const tag = element("span", healthLabels[status] || "待确认", "health-tag");
  tag.dataset.status = status;
  line.append(tag);
  td.append(line);
  const checked = formatDate(reading?.checkedAt);
  if (checked) td.append(element("span", `上次检查 ${checked}`, "cell-secondary"));
  return td;
}

function renderMonitoring() {
  const current = state.region;
  const codes = new Set([current, ...(state.extraRegions || [])].filter(Boolean));
  const signature = JSON.stringify([current, [...codes], state.health, state.controller?.state,
    state.regions, state.supplierNames, state.sharing?.state, ...supplierIds().map((supplier) => state.suppliers?.[supplier]?.regions)]);
  if (signature === monitorSignature) return;
  monitorSignature = signature;
  byId("health-columns").replaceChildren(...["地区", ...supplierIds().map(supplierName)].map(label => {
    const th = element("th", label);
    th.scope = "col";
    return th;
  }));
  const readings = new Map((state.health || []).map((row) => [`${row.supplier}:${row.region}`, row]));
  const rows = document.createDocumentFragment();
  for (const code of codes) {
    const row = element("tr");
    const name = element("td");
    name.append(element("span", regionName(code), "region-label"),
      element("span", code === current ? "当前地区" : "额外心跳", "cell-secondary"));
    row.append(name, ...supplierIds().map((supplier) => healthCell(supplier, code, readings)));
    rows.append(row);
  }
  byId("health").replaceChildren(rows);
  const extraCount = codes.size - Number(Boolean(current));
  byId("monitor-summary").textContent = extraCount ? `${extraCount} 个额外地区` : "当前地区";
}

function renderAlerts() {
  const items = [...(state.alerts || [])].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 8);
  const signature = JSON.stringify([items, state.supplierNames]);
  if (signature === alertsSignature) return;
  alertsSignature = signature;
  byId("no-alerts").hidden = items.length > 0;
  const list = document.createDocumentFragment();
  for (const { supplier, supplierName: originalName, region, level, time } of items) {
    const item = element("li");
    const content = element("div");
    const outage = level === "down" || level === "critical";
    const tag = element("span", outage ? "全断" : "提醒", "health-tag");
    tag.dataset.status = outage ? "down" : "warning";
    content.append(tag, element("span",
      `${state.supplierNames?.[supplier] || originalName || "已删除的供应商"} · ${regionName(region)} ${outage ? "地区全断" : "只剩 1 个可用端点"}`));
    const checked = formatDate(time);
    if (checked) content.append(element("time", checked));
    item.append(content);
    if (Object.hasOwn(state.suppliers, supplier)) {
      const button = element("button", `导入 ${supplierName(supplier)}`);
      button.type = "button";
      button.addEventListener("click", () => focusImport(supplier));
      item.append(button);
    }
    list.append(item);
  }
  byId("alerts").replaceChildren(list);
}

function renderControls() {
  const locked = Boolean(pendingAction) || !state;
  regionFields.disabled = locked;
  heartbeatFields.disabled = locked;
  byId("save-region").disabled = locked || !dirtyRegion;
  byId("save-heartbeat").disabled = locked || !dirtyHeartbeat;
  for (const button of document.querySelectorAll(".mutation")) button.disabled = locked;
  byId("confirm-remove").disabled = locked || !Object.hasOwn(state.suppliers, removalSupplier);
  for (const dialog of dialogs) dialog.querySelector("[data-close-dialog]").disabled = locked && dialog !== helpDialog;
  byId("submit-import").textContent = pendingAction === "import" ? "导入中…" : "导入节点";
  if (requestedFocus && !locked && dialogs.every(dialog => !dialog.open)) focusImport(requestedFocus);
}

function receive(next) {
  state = next;
  if (!currentPage) showPage(state.networkMode === "client" ? "client" : "local");
  const controller = byId("controller");
  const status = state.controller?.state || "offline";
  controller.dataset.status = status;
  controller.textContent = controllerLabels[status] || controllerLabels.offline;
  const hint = safeMessage(state.controller?.message, "");
  controller.title = hint;
  const active = pageLabels[state.controller?.activeMode];
  byId("active-mode").textContent = active ? `当前生效 · ${active}` : "代理方式尚未确认";
  message("connection-message", status === "ready" && !state.controller?.needsRefresh ? "" : hint,
    status === "error" ? "error" : "");
  byId("copy-profile").disabled = !state.profileURL;
  helpDownloadAddress.hidden = !state.downloadPort;
  helpDownloadAddress.textContent = state.downloadPort ? `http://127.0.0.1:${state.downloadPort}` : "";
  renderSettings();
  const client = state.networkMode === "client";
  byId("share-panel").hidden = client;
  byId("return-local").hidden = !client;
  renderSharing();
  renderSuppliers();
  renderRoutes();
  renderMonitoring();
  renderAlerts();
  if (removeDialog.open) renderSupplierRemoval();
  renderControls();
}

async function poll() {
  if (pendingAction) return;
  const generation = ++requestGeneration;
  try {
    const result = await request("state");
    if (generation === requestGeneration) receive(result);
  } catch {
    if (generation !== requestGeneration) return;
    const controller = byId("controller");
    controller.dataset.status = "offline";
    controller.textContent = "本机扩展未连接";
    message("connection-message", state ? "无法更新状态，页面显示上次读取的结果。" : "无法连接本机扩展。", "error");
  }
}

function begin(action) {
  requestGeneration++;
  pendingAction = action;
  renderControls();
}

function finish() {
  pendingAction = undefined;
  renderControls();
}

async function change(path, payload, place, success = "", action = path) {
  if (pendingAction || !state) return;
  begin(action);
  message(place, "处理中…");
  try {
    const result = await request(path, payload);
    const { pairingCode, ...snapshot } = result;
    receive(snapshot);
    if (pairingCode) await copy(pairingCode, "配对码");
    message(place, success, success ? "success" : "");
    return true;
  } catch (error) {
    message(place, safeMessage(error.message, "操作失败，请重试。"), "error");
    return false;
  } finally {
    finish();
  }
}

byId("nav-supplier").addEventListener("click", () => showPage("local"));
byId("nav-gateway").addEventListener("click", () => showPage("client"));
openHelp.addEventListener("click", () => helpDialog.showModal());

for (const dialog of dialogs) {
  dialog.querySelector("[data-close-dialog]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => {
    if (pendingAction && dialog !== helpDialog) event.preventDefault();
  });
  dialog.addEventListener("close", () => queueMicrotask(renderControls));
}
helpDialog.addEventListener("close", () => {
  if (dialogs.every(dialog => !dialog.open)) openHelp.focus();
});
detailDialog.addEventListener("close", () => {
  if (detailDialog.open) return;
  detailRequest = undefined;
  detailSupplier = undefined;
});
importDialog.addEventListener("close", () => {
  if (importDialog.open) return;
  importSupplier = undefined;
  byId("import-nodes").reset();
  message("import-message");
});
heartbeatDialog.addEventListener("close", () => {
  if (!heartbeatDialog.open) dirtyHeartbeat = false;
});
removeDialog.addEventListener("close", () => {
  if (!removeDialog.open) removalSupplier = undefined;
});

byId("open-add-supplier").addEventListener("click", () => {
  byId("add-supplier").reset();
  message("add-message");
  addDialog.showModal();
});
byId("add-supplier").addEventListener("submit", async event => {
  event.preventDefault();
  const name = event.currentTarget.elements.name.value;
  if (await change("suppliers", { action: "create", name }, "add-message")) {
    addDialog.close();
    message("supplier-message", "供应商已添加。", "success");
  }
});

byId("rename-supplier").addEventListener("submit", async event => {
  event.preventDefault();
  const id = detailSupplier;
  const input = event.currentTarget.elements.name;
  if (await change("suppliers", { action: "rename", id, name: input.value }, "edit-message", "名称已保存。")) {
    input.value = supplierName(id);
    byId("detail-title").textContent = `节点详情 · ${supplierName(id)}`;
  }
});
byId("remove-supplier").addEventListener("submit", async event => {
  event.preventDefault();
  if (!Object.hasOwn(state.suppliers, removalSupplier)) return;
  if (await change("suppliers", { action: "remove", id: removalSupplier }, "remove-message")) {
    removeDialog.close();
    if (!importDialog.open) byId("open-add-supplier").focus();
    message("supplier-message", supplierChangesNeedRefresh()
      ? "供应商已删除。请刷新 Clash Verge 中的本机配置。" : "供应商已删除。", "success");
  }
});

byId("import-nodes").addEventListener("submit", async event => {
  event.preventDefault();
  const input = event.currentTarget.elements.subscription;
  const url = input.value.trim();
  if (!/^https:\/\//i.test(url)) {
    message("import-message", "请输入 HTTPS 订阅链接。", "error");
    input.focus();
    return;
  }
  if (await change("import", { supplier: importSupplier, url }, "import-message")) {
    input.value = "";
    importDialog.close();
    message("supplier-message", "节点已导入。", "success");
  } else input.focus();
});

byId("scan-tailnet").addEventListener("click", () => change("gateway", { action: "scan" }, "gateway-message"));
byId("toggle-share").addEventListener("click", () => change("gateway",
  { action: state.sharing.enabled ? "disable" : "enable" }, "gateway-message"));
byId("authorize-device").addEventListener("click", () => change("gateway",
  { action: "authorize", device: byId("tailnet-devices").value }, "gateway-message"));
byId("return-local").addEventListener("click", async () => {
  if (await change("pairing", { action: "local" }, "gateway-message", "已保存，请刷新 Clash Verge 配置。")) {
    showPage("local");
  }
});
byId("pair-form").addEventListener("submit", async event => {
  event.preventDefault();
  const input = event.currentTarget.elements.code;
  const code = input.value;
  input.value = "";
  await change("pairing", { action: "connect", code }, "gateway-message", "验证通过，请刷新 Clash Verge 配置。");
});

byId("region-form").addEventListener("input", () => {
  dirtyRegion = regionSelect.value !== state.region;
  message("region-message");
  renderControls();
});

byId("region-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!dirtyRegion) return;
  if (await change("settings", { region: regionSelect.value }, "region-message", "地区已保存。")) {
    dirtyRegion = false;
    renderSettings();
    renderControls();
  }
});

byId("open-heartbeat").addEventListener("click", () => {
  dirtyHeartbeat = false;
  renderHeartbeatDraft();
  message("heartbeat-error");
  heartbeatDialog.showModal();
  renderControls();
});
byId("heartbeat-form").addEventListener("input", () => {
  dirtyHeartbeat = JSON.stringify(heartbeatFromFields()) !== JSON.stringify(heartbeatFromState());
  message("heartbeat-error");
  renderControls();
});
byId("heartbeat-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!dirtyHeartbeat) return;
  if (await change("settings", heartbeatFromFields(), "heartbeat-error")) {
    heartbeatDialog.close();
    message("heartbeat-message", "心跳设置已保存。", "success");
  }
});

async function copy(value, description) {
  if (!value) return;
  const field = byId("profile-address");
  const fallback = byId("profile-fallback");
  fallback.querySelector("span").textContent = description;
  try {
    await navigator.clipboard.writeText(value);
    fallback.hidden = true;
    field.value = "";
    message("profile-message", `${description}已复制。`);
  } catch {
    fallback.hidden = false;
    field.value = value;
    field.focus();
    field.select();
    let copied = false;
    try { copied = document.execCommand?.("copy"); } catch { /* Keep the selection accessible. */ }
    if (copied) {
      fallback.hidden = true;
      field.value = "";
      message("profile-message", `${description}已复制。`);
      return;
    }
    message("profile-message", "请复制选中的地址。");
  }
}

byId("copy-profile").addEventListener("click", () => copy(state?.profileURL, "Clash 配置链接"));
window.addEventListener("hashchange", () => {
  const supplier = preferredFocus();
  if (supplier) focusImport(supplier);
});

let pollInProgress = false;
async function refresh() {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    await poll();
  } finally {
    pollInProgress = false;
  }
}

renderControls();
refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 6000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
