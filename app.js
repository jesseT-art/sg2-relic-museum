"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ARTIFACTS = Array.isArray(window.MUSEUM_ARTIFACTS) ? window.MUSEUM_ARTIFACTS : [];
const ASSET_STATS = window.MUSEUM_ASSET_STATS || {
  uniqueCatalogItems: ARTIFACTS.length,
  duplicateSourcesMerged: 0,
};

const STORAGE_KEY = "relic-museum-state-v2";
const DB_NAME = "relic-museum-images";
const DB_STORE = "images";
const PAGE_SIZE = 30;
const CABINET_COUNT = 5;
const CATEGORY_ORDER = ["全部", "武器", "护甲", "头饰", "护盾", "戒指", "素材", "其他"];

const objectUrlCache = new Map();
let databasePromise = null;
let state = loadState();
let activeSlot = state.lastSlot;
let isOverview = false;
let inspecting = false;
let editingRelic = null;
let activeRelicId = null;
let pendingUploadBlob = null;
let pendingUploadPreview = "";
let libraryFilter = { category: "全部", query: "", page: 0 };
let lastExportBlob = null;
let lastExportRelic = null;
let lastExportUrl = "";
let splashTimer = null;
let toastTimer = null;
let panelHideTimer = null;
let museum3D = null;
let museum3DReady = false;

function emptyState() {
  return {
    version: 2,
    museumName: "无名者装备博物馆",
    relics: [],
    slots: Array(CABINET_COUNT).fill(null),
    lastSlot: 0,
    demoLoaded: false,
    createdAt: new Date().toISOString(),
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function uid(prefix = "relic") {
  if (crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function todayValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) return "日期未记录";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function descriptionFor(relic) {
  if (!relic) return "";
  if (String(relic.description || "").trim()) return String(relic.description).trim();
  return [
    relic.quote,
    relic.motivation,
    relic.challenge,
    relic.method,
    relic.moment,
    relic.materials ? `材料与路线：${relic.materials}` : "",
  ]
    .filter((part) => String(part || "").trim())
    .join("\n\n")
    .trim();
}

function normalizeRelic(relic) {
  if (!relic || typeof relic !== "object") return null;
  return {
    ...relic,
    id: relic.id || uid("relic"),
    name: String(relic.name || "未命名藏品"),
    category: String(relic.category || "其他"),
    madeAt: String(relic.madeAt || ""),
    description: descriptionFor(relic),
    image: String(relic.image || ""),
    imageId: String(relic.imageId || ""),
    assetId: String(relic.assetId || ""),
  };
}

function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const relics = Array.isArray(raw.relics)
    ? raw.relics.map(normalizeRelic).filter(Boolean)
    : [];
  const relicIds = new Set(relics.map((relic) => relic.id));
  const slots = Array.isArray(raw.slots)
    ? raw.slots.slice(0, CABINET_COUNT).map((id) => (relicIds.has(id) ? id : null))
    : Array(CABINET_COUNT).fill(null);
  while (slots.length < CABINET_COUNT) slots.push(null);
  return {
    ...base,
    ...raw,
    relics,
    slots,
    lastSlot: clamp(Number(raw.lastSlot) || 0, 0, CABINET_COUNT - 1),
    museumName: String(raw.museumName || base.museumName),
  };
}

function loadState() {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (current) return normalizeState(current);
    const legacy = JSON.parse(localStorage.getItem("relic-museum-state-v1") || "null");
    return normalizeState(legacy);
  } catch (error) {
    console.warn("Unable to load museum state.", error);
    return emptyState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) {
        request.result.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function putImageBlob(key, blob) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(blob, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getImageBlob(key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function deleteImageBlob(key) {
  if (!key) return;
  objectUrlCache.delete(key);
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function uploadedImageUrl(imageId) {
  if (!imageId) return "";
  if (objectUrlCache.has(imageId)) return objectUrlCache.get(imageId);
  const blob = await getImageBlob(imageId);
  if (!blob) return "";
  const dataUrl = await blobToDataUrl(blob);
  objectUrlCache.set(imageId, dataUrl);
  return dataUrl;
}

async function resolveRelicImage(relic) {
  if (!relic) return "";
  if (relic.imageId) return uploadedImageUrl(relic.imageId);
  if (relic.image) return relic.image;
  return findArtifact(relic.assetId)?.image || "";
}

async function hydrateUploadedImages(root = document) {
  for (const image of $$("img[data-upload-id]", root)) {
    if (image.dataset.hydrating === "1") continue;
    image.dataset.hydrating = "1";
    const dataUrl = await uploadedImageUrl(image.dataset.uploadId);
    if (dataUrl) image.src = dataUrl;
  }
}

function findArtifact(assetId) {
  return ARTIFACTS.find((artifact) => artifact.id === assetId) || null;
}

function findRelic(relicId) {
  return state.relics.find((relic) => relic.id === relicId) || null;
}

function relicBySlot(slot) {
  return findRelic(state.slots[slot]);
}

function displayedCount() {
  return state.slots.filter(Boolean).length;
}

function primaryImageSource(relic) {
  return relic?.image || findArtifact(relic?.assetId)?.image || "";
}

function artifactByNeedle(needle, category = "") {
  return (
    ARTIFACTS.find((artifact) => artifact.name.toLowerCase().includes(needle.toLowerCase())) ||
    ARTIFACTS.find((artifact) => artifact.category === category) ||
    ARTIFACTS[0]
  );
}

function demoRelic(asset, name, category, madeAt, description) {
  return {
    id: uid("demo"),
    assetId: asset?.id || "",
    image: asset?.image || "",
    imageId: "",
    name,
    category,
    madeAt,
    description,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    demo: true,
  };
}

function createDemoState() {
  const next = emptyState();
  next.demoLoaded = true;
  next.museumName = "灰烬幸存者博物馆";
  next.relics = [
    demoRelic(
      artifactByNeedle("MoonEclipse", "武器"),
      "月蚀终章",
      "武器",
      "2026-10-23",
      "这是我第一次决定不靠运气等一件武器，而是把整条材料路线完整走一遍。第六次锻造在最后一步失败，稀有核心只够再试一次。凌晨 2:17，锻造台终于亮起白光。我没有立刻截图，只是盯着它看了很久。\n\n真正让我记住它的，不是属性，而是我差点放弃的那一晚。",
    ),
    demoRelic(
      artifactByNeedle("DarkMoon", "护盾"),
      "无声守望",
      "护盾",
      "2026-09-17",
      "它是我和固定队友第一次认真规划的长期目标。地图刷新和在线时间总是错开，材料拖了整整三周。我们轮流记录刷新点，把每次掉落截图拼成一张时间表。\n\n最后一块暗月石是在临睡前掉落的，队友在语音里先喊了出来。",
    ),
    demoRelic(
      artifactByNeedle("ForbiddenGem", "素材"),
      "禁忌星辉",
      "素材",
      "2026-08-04",
      "我想把它留给真正重要的装备，所以一直没有使用。前三张配方都显示成功，实际结果却是我看错了材料等级。后来把配方拆成材料、顺序、时间三个部分，逐项比对才终于合成。\n\n它还没有被用掉，但它已经收藏了一段准备很久的期待。",
    ),
    demoRelic(
      artifactByNeedle("DragonSpine", "护甲"),
      "龙骨远行甲",
      "护甲",
      "2025-12-30",
      "我想在冬日礼结束前，和已经准备退游的朋友一起完成一件装备。活动只剩一天，最关键的材料却始终没有出现。朋友把地图上所有可能刷新的位置手画给我，我们分了三条路线寻找。\n\n材料在活动倒计时 00:11 时出现，队伍里所有人都停了两秒。",
    ),
    demoRelic(
      artifactByNeedle("DevilCannon", "武器"),
      "赤焰回响",
      "武器",
      "2026-10-02",
      "这是我用得最久的一套装备，也是我所有早期记忆的终点。它经历过几次版本变化，每一次都可能再也无法完成。我把每个版本留下的材料都保留下来，最后统一完成强化。\n\n强化完成的提示出现时，我反而先去看旧截图里第一次拿到它的样子。",
    ),
  ];
  next.slots = next.relics.map((relic) => relic.id);
  return next;
}

function maybeLoadDemoFromQuery() {
  const params = new URLSearchParams(location.search);
  if (params.get("demo") === "1" && !state.demoLoaded) {
    state = createDemoState();
    activeSlot = 0;
    saveState();
  }
}

function cabinetTemplate(index) {
  const relic = relicBySlot(index);
  const activeClass = index === activeSlot ? " is-active" : "";
  const source = primaryImageSource(relic);
  const uploadAttribute = relic?.imageId
    ? `data-upload-id="${escapeHtml(relic.imageId)}"`
    : "";
  return `
    <article class="cabinet-stage${activeClass}" data-slot="${index}">
      <button class="cabinet-button" type="button" data-action="open-slot" data-slot="${index}"
        aria-label="${relic ? `查看${escapeHtml(relic.name)}` : `空展柜 ${index + 1}`}">
        <span class="display-unit">
          <span class="glass-case">
            <span class="glass-side-left" aria-hidden="true"></span>
            <span class="glass-side-right" aria-hidden="true"></span>
            <span class="glass-top" aria-hidden="true"></span>
            <span class="case-light-cone" aria-hidden="true"></span>
            <span class="case-lamp" aria-hidden="true"></span>
            <span class="case-object-wrap">
              ${
                relic
                  ? `<img class="case-object" src="${escapeHtml(source)}" ${uploadAttribute}
                      alt="${escapeHtml(relic.name)}" draggable="false" />`
                  : `<span class="case-empty">＋<small>空展柜</small></span>`
              }
            </span>
            <span class="case-shadow" aria-hidden="true"></span>
            <span class="case-shelf" aria-hidden="true"></span>
          </span>
          <span class="museum-pillar" aria-hidden="true">
            <span class="pillar-capital"></span>
            <span class="pillar-shaft"></span>
            <span class="pillar-base"></span>
          </span>
          <span class="cabinet-plaque">${relic ? escapeHtml(relic.name) : "空展柜"}</span>
        </span>
      </button>
    </article>`;
}

function renderHall() {
  $("#museumName").textContent = state.museumName;
  $("#collectionCount").textContent = `${displayedCount()} / ${CABINET_COUNT}`;
  $("#cabinetTrack").innerHTML = Array.from({ length: CABINET_COUNT }, (_, index) =>
    cabinetTemplate(index),
  ).join("");
  hydrateUploadedImages();
  refreshMuseum3D();
  renderSceneHotspots();
  requestAnimationFrame(() => positionScene());
}

function renderSceneHotspots() {
  const container = $("#sceneHotspots");
  if (!container || !museum3DReady) {
    if (container) container.innerHTML = "";
    return;
  }
  container.innerHTML = Array.from({ length: CABINET_COUNT }, (_, index) => {
    const relic = relicBySlot(index);
    return `<button class="scene-hotspot${index === activeSlot ? " is-active" : ""}"
      type="button" data-action="open-slot" data-slot="${index}"
      aria-label="${relic ? `查看${escapeHtml(relic.name)}` : `空展柜 ${index + 1}`}"></button>`;
  }).join("");
}

function viewSwitchMarkup(overview) {
  return overview
    ? `<span class="overview-icon" aria-hidden="true"><i></i><i></i><i></i></span>单柜视图`
    : `<span class="overview-icon" aria-hidden="true"><i></i><i></i><i></i></span>大场景`;
}

function positionScene() {
  if (museum3DReady) return;
  const viewport = $("#hallViewport");
  const scene = $("#hallScene");
  if (!viewport || !scene || isOverview) return;
  const stage = $(`.cabinet-stage[data-slot="${activeSlot}"]`, $("#cabinetTrack"));
  if (!stage) return;
  const ratio = inspecting ? (viewport.clientWidth <= 710 ? 0.25 : 0.29) : 0.5;
  const target = stage.offsetLeft + stage.offsetWidth / 2 - viewport.clientWidth * ratio;
  const maximum = Math.max(0, scene.scrollWidth - viewport.clientWidth);
  const shift = clamp(target, 0, maximum);
  scene.style.transform = `translate3d(${-shift}px, 0, 0)`;
}

function setActiveSlot(nextSlot, { persist = true } = {}) {
  activeSlot = clamp(Number(nextSlot) || 0, 0, CABINET_COUNT - 1);
  state.lastSlot = activeSlot;
  if (persist) saveState();
  $$(".cabinet-stage", $("#cabinetTrack")).forEach((stage) => {
    stage.classList.toggle("is-active", Number(stage.dataset.slot) === activeSlot);
  });
  if (inspecting) {
    const relic = relicBySlot(activeSlot);
    if (relic) renderRelicPanel(relic);
    else closeRelicPanel();
  }
  museum3D?.updateView({ activeSlot, overview: isOverview, inspecting });
  renderSceneHotspots();
  requestAnimationFrame(positionScene);
}

function setOverview(overview) {
  isOverview = Boolean(overview);
  $("#hallViewport").classList.toggle("is-overview", isOverview);
  $("#overviewBtn").innerHTML = viewSwitchMarkup(isOverview);
  if (isOverview) {
    closeRelicPanel();
  } else {
    requestAnimationFrame(() => setActiveSlot(activeSlot, { persist: false }));
  }
  museum3D?.updateView({ activeSlot, overview: isOverview, inspecting });
  renderSceneHotspots();
}

function renderRelicPanel(relic) {
  activeRelicId = relic.id;
  inspecting = true;
  const panel = $("#relicPanel");
  clearTimeout(panelHideTimer);
  panel.hidden = false;
  $("#hallViewport").classList.add("is-inspecting");
  $("#relicTitle").textContent = relic.name;
  $("#relicDate").textContent = formatDate(relic.madeAt);
  $("#relicCategory").textContent = relic.category;
  const description = descriptionFor(relic);
  const descriptionElement = $("#relicDescription");
  descriptionElement.textContent = description || "这件藏品还没有留下描述。";
  descriptionElement.classList.toggle("is-empty", !description);
  requestAnimationFrame(() => {
    panel.classList.add("is-visible");
    museum3D?.updateView({ activeSlot, overview: isOverview, inspecting: true });
    positionScene();
  });
}

function closeRelicPanel({ reposition = true } = {}) {
  const panel = $("#relicPanel");
  if (!panel || panel.hidden) return;
  inspecting = false;
  activeRelicId = null;
  panel.classList.remove("is-visible");
  $("#hallViewport").classList.remove("is-inspecting");
  clearTimeout(panelHideTimer);
  panelHideTimer = setTimeout(() => {
    if (!inspecting) panel.hidden = true;
  }, 320);
  museum3D?.updateView({ activeSlot, overview: isOverview, inspecting: false });
  if (reposition) requestAnimationFrame(positionScene);
}

function openSlot(slot) {
  if (isOverview) {
    setOverview(false);
    setActiveSlot(slot);
    const relic = relicBySlot(slot);
    if (relic) setTimeout(() => renderRelicPanel(relic), 520);
    return;
  }
  if (slot !== activeSlot) {
    setActiveSlot(slot);
    return;
  }
  const relic = relicBySlot(slot);
  if (relic) renderRelicPanel(relic);
  else openLibrary();
}

function filteredArtifacts() {
  const query = libraryFilter.query.trim().toLowerCase();
  return ARTIFACTS.filter((artifact) => {
    const categoryMatches =
      libraryFilter.category === "全部" || artifact.category === libraryFilter.category;
    const queryMatches =
      !query ||
      artifact.name.toLowerCase().includes(query) ||
      artifact.sources.join(" ").toLowerCase().includes(query);
    return categoryMatches && queryMatches;
  });
}

function renderLibraryGrid() {
  const list = filteredArtifacts();
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  libraryFilter.page = clamp(libraryFilter.page, 0, pageCount - 1);
  const slice = list.slice(
    libraryFilter.page * PAGE_SIZE,
    libraryFilter.page * PAGE_SIZE + PAGE_SIZE,
  );
  $("#artifactGrid").innerHTML = slice.length
    ? slice
        .map(
          (artifact) => `
          <button class="artifact-card" type="button" data-action="choose-artifact"
            data-asset-id="${escapeHtml(artifact.id)}" title="${escapeHtml(artifact.name)}">
            <img src="${escapeHtml(artifact.image)}" alt="${escapeHtml(artifact.name)}"
              loading="lazy" decoding="async" draggable="false" />
            <span>${escapeHtml(artifact.name)}</span>
          </button>`,
        )
        .join("")
    : `<div class="empty-state">没有找到匹配的素材。可以换个分类，或直接导入截图。</div>`;
  $("#libraryPageLabel").textContent = `${libraryFilter.page + 1} / ${pageCount}`;
  $("#libraryCountLabel").textContent = `${list.length} 件素材`;
  $("#libraryPrevBtn").disabled = libraryFilter.page === 0;
  $("#libraryNextBtn").disabled = libraryFilter.page >= pageCount - 1;
}

function openLibrary() {
  const counts = Object.fromEntries(
    CATEGORY_ORDER.map((category) => [
      category,
      category === "全部"
        ? ARTIFACTS.length
        : ARTIFACTS.filter((artifact) => artifact.category === category).length,
    ]),
  );
  const tabs = CATEGORY_ORDER.filter(
    (category) => category === "全部" || counts[category] > 0,
  );
  openModal({
    title: "选择藏品素材",
    kicker: "LOCAL RELIC LIBRARY",
    wide: true,
    tall: true,
    html: `
      <div class="library-layout">
        <div class="library-toolbar">
          <div class="category-tabs">
            ${tabs
              .map(
                (category) => `
                <button class="category-tab${libraryFilter.category === category ? " is-active" : ""}"
                  type="button" data-action="library-category" data-category="${escapeHtml(category)}">
                  ${escapeHtml(category)} ${counts[category]}
                </button>`,
              )
              .join("")}
          </div>
          <input id="librarySearch" class="library-search" type="search"
            value="${escapeHtml(libraryFilter.query)}" placeholder="搜索素材" autocomplete="off" />
          <button class="upload-shortcut" type="button" data-action="upload-screenshot">导入截图</button>
        </div>
        <div class="artifact-grid" id="artifactGrid"></div>
        <footer class="library-footer">
          <span><span id="libraryCountLabel"></span> · 已合并重复来源 ${ASSET_STATS.duplicateSourcesMerged} 组</span>
          <div class="pager">
            <button id="libraryPrevBtn" type="button" data-action="library-page" data-direction="-1">‹</button>
            <span id="libraryPageLabel">1 / 1</span>
            <button id="libraryNextBtn" type="button" data-action="library-page" data-direction="1">›</button>
          </div>
        </footer>
      </div>`,
    onMount() {
      renderLibraryGrid();
      const search = $("#librarySearch");
      search?.addEventListener("input", () => {
        libraryFilter.query = search.value;
        libraryFilter.page = 0;
        renderLibraryGrid();
      });
    },
  });
}

function openEditor(initialRelic, { isNew = true, previewSource = "", uploadBlob = null } = {}) {
  editingRelic = initialRelic;
  pendingUploadBlob = uploadBlob;
  pendingUploadPreview = previewSource || "";
  const source = previewSource || primaryImageSource(initialRelic);
  const uploadAttribute = initialRelic.imageId
    ? `data-upload-id="${escapeHtml(initialRelic.imageId)}"`
    : "";
  openModal({
    title: isNew ? "记录新藏品" : "编辑藏品",
    kicker: isNew ? "NEW RELIC" : "EDIT RELIC",
    wide: true,
    tall: true,
    html: `
      <form id="relicEditorForm" class="editor-layout" data-is-new="${isNew ? "1" : "0"}">
        <aside class="editor-preview">
          <img src="${escapeHtml(source)}" ${uploadAttribute} alt="${escapeHtml(
            initialRelic.name || "藏品",
          )}" draggable="false" />
          <div class="editor-preview-foot">
            <span>${escapeHtml(initialRelic.category || "未分类")}</span>
            <button class="quiet-button" type="button" data-action="change-editor-image">更换图片</button>
          </div>
        </aside>
        <div class="editor-form">
          <div class="field-grid">
            <div class="field full">
              <label for="relicName">名称</label>
              <input id="relicName" name="name" maxlength="36"
                value="${escapeHtml(initialRelic.name || "")}" placeholder="未命名藏品" />
            </div>
            <div class="field">
              <label for="relicCategory">分类</label>
              <select id="relicCategory" name="category">
                ${CATEGORY_ORDER.filter((category) => category !== "全部")
                  .map(
                    (category) =>
                      `<option value="${category}" ${
                        initialRelic.category === category ? "selected" : ""
                      }>${category}</option>`,
                  )
                  .join("")}
              </select>
            </div>
            <div class="field">
              <label for="relicDate">日期</label>
              <input id="relicDate" name="madeAt" type="date" value="${escapeHtml(
                initialRelic.madeAt || todayValue(),
              )}" />
            </div>
            <div class="field full">
              <label for="relicDescription">描述</label>
              <textarea id="relicDescription" name="description" maxlength="1600"
                placeholder="记录制作过程、经历或想留下的话">${escapeHtml(
                  descriptionFor(initialRelic),
                )}</textarea>
            </div>
          </div>
          <div class="form-actions">
            <button class="quiet-button" type="button" data-close-modal>取消</button>
            <button class="warm-button" type="submit">${isNew ? "收入博物馆" : "保存"}</button>
          </div>
        </div>
      </form>`,
    onMount() {
      hydrateUploadedImages($("#modalBody"));
    },
  });
}

async function saveRelicForm(form) {
  const data = new FormData(form);
  const isNew = form.dataset.isNew === "1";
  const next = {
    ...editingRelic,
    name: String(data.get("name") || "").trim() || editingRelic.name || "未命名藏品",
    category: String(data.get("category") || "其他"),
    madeAt: String(data.get("madeAt") || ""),
    description: String(data.get("description") || "").trim(),
    updatedAt: new Date().toISOString(),
  };

  if (pendingUploadBlob) {
    next.imageId = next.imageId || uid("image");
    next.image = "";
    next.assetId = "";
    await putImageBlob(next.imageId, pendingUploadBlob);
  }

  if (isNew) {
    next.id = uid("relic");
    next.createdAt = new Date().toISOString();
    state.relics.unshift(next);
    const emptySlot = state.slots.findIndex((id) => !id);
    const targetSlot = emptySlot >= 0 ? emptySlot : activeSlot;
    if (emptySlot < 0) {
      showToast("五个展柜都已使用，新藏品已保存到馆藏档案");
    } else {
      state.slots[targetSlot] = next.id;
      activeSlot = targetSlot;
    }
  } else {
    state.relics = state.relics.map((relic) => (relic.id === next.id ? next : relic));
  }

  pendingUploadBlob = null;
  pendingUploadPreview = "";
  editingRelic = null;
  saveState();
  closeModal();
  setOverview(false);
  renderHall();
  if (isNew) {
    showCeremony(`“${next.name}”已经收入博物馆。`);
  } else {
    if (activeRelicId === next.id) renderRelicPanel(next);
    showToast("藏品已保存");
  }
}

function openArchive() {
  const archived = state.relics.filter((relic) => !state.slots.includes(relic.id));
  const displayed = state.relics.filter((relic) => state.slots.includes(relic.id));
  openModal({
    title: "馆藏档案",
    kicker: "LOCAL ARCHIVE",
    wide: true,
    tall: true,
    html: `
      ${
        archived.length
          ? `<div class="archive-grid">${archived
              .map((relic) => archiveCard(relic, "档案库"))
              .join("")}</div>`
          : `<div class="empty-state">档案库还是空的。五个展柜之外，其余藏品会保存在这里。</div>`
      }
      ${
        displayed.length
          ? `<div style="padding:0 13px 6px;color:var(--brass);font-family:var(--pixel-font);font-size:8px;letter-spacing:.08em">当前陈列</div>
            <div class="archive-grid">${displayed
              .map((relic) => archiveCard(relic, `展柜 ${state.slots.indexOf(relic.id) + 1}`))
              .join("")}</div>`
          : ""
      }`,
    onMount() {
      hydrateUploadedImages($("#modalBody"));
    },
  });
}

function archiveCard(relic, location) {
  const uploadAttribute = relic.imageId
    ? `data-upload-id="${escapeHtml(relic.imageId)}"`
    : "";
  return `
    <article class="archive-card">
      <div class="archive-art">
        <img src="${escapeHtml(primaryImageSource(relic))}" ${uploadAttribute}
          alt="${escapeHtml(relic.name)}" loading="lazy" draggable="false" />
      </div>
      <div class="archive-copy">
        <strong>${escapeHtml(relic.name)}</strong>
        <small>${escapeHtml(relic.category)} · ${escapeHtml(location)}</small>
        <div class="archive-actions">
          <button type="button" data-action="open-archived" data-relic-id="${escapeHtml(
            relic.id,
          )}">查看</button>
          ${
            location === "档案库"
              ? `<button type="button" data-action="auto-display" data-relic-id="${escapeHtml(
                  relic.id,
                )}">陈列</button>`
              : ""
          }
          <button type="button" data-action="delete-relic" data-relic-id="${escapeHtml(
            relic.id,
          )}">删除</button>
        </div>
      </div>
    </article>`;
}

function openCabinetChooser(relicId) {
  const relic = findRelic(relicId);
  if (!relic) return;
  openModal({
    title: "选择展柜",
    kicker: "DISPLAY POSITION",
    wide: true,
    html: `
      <div class="cabinet-picker">
        ${state.slots
          .map((id, index) => {
            const occupant = findRelic(id);
            const current = id === relic.id;
            return `
              <button class="cabinet-pick${current ? " is-current" : ""}" type="button"
                data-action="assign-slot" data-relic-id="${escapeHtml(relic.id)}" data-slot="${index}">
                <span class="cabinet-pick-mark">${index + 1}</span>
                <span>
                  <strong>${current ? "当前展柜" : `展柜 ${index + 1}`}</strong>
                  <small>${current ? relic.name : occupant ? `替换 ${occupant.name}` : "空展柜"}</small>
                </span>
              </button>`;
          })
          .join("")}
      </div>`,
  });
}

function assignRelicToSlot(relicId, slot) {
  const relic = findRelic(relicId);
  if (!relic) return;
  const previous = state.slots.indexOf(relic.id);
  if (previous >= 0) state.slots[previous] = null;
  state.slots[slot] = relic.id;
  activeSlot = slot;
  saveState();
  closeModal();
  setOverview(false);
  renderHall();
  closeRelicPanel({ reposition: false });
  setTimeout(() => renderRelicPanel(relic), 120);
  showToast(`已放入展柜 ${slot + 1}`);
}

function autoDisplayRelic(relicId) {
  const emptySlot = state.slots.findIndex((id) => !id);
  if (emptySlot < 0) {
    showToast("五个展柜都已使用，请先替换一件藏品");
    return;
  }
  assignRelicToSlot(relicId, emptySlot);
}

async function deleteRelic(relicId) {
  const relic = findRelic(relicId);
  if (!relic) return;
  if (!window.confirm(`确定永久删除“${relic.name}”吗？`)) return;
  state.slots = state.slots.map((id) => (id === relicId ? null : id));
  state.relics = state.relics.filter((item) => item.id !== relicId);
  if (relic.imageId) await deleteImageBlob(relic.imageId);
  saveState();
  closeModal();
  closeRelicPanel({ reposition: false });
  renderHall();
}

function openSettings() {
  openModal({
    title: "设置",
    kicker: "LOCAL MUSEUM",
    wide: true,
    tall: true,
    html: `
      <form id="settingsForm" class="settings-layout">
        <section class="settings-card">
          <h3>博物馆名称</h3>
          <div class="field">
            <input name="museumName" value="${escapeHtml(state.museumName)}" maxlength="26" />
          </div>
          <div class="settings-actions">
            <button class="warm-button" type="submit">保存</button>
          </div>
        </section>
        <section class="settings-card">
          <h3>本地数据</h3>
          <p>藏品、描述与导入图片只保存在当前设备。清理网站数据或移除桌面图标前，请先保存需要分享的 4K 图片。</p>
          <div class="stats-row">
            <div class="stat-tile"><strong>${state.relics.length}</strong><span>藏品</span></div>
            <div class="stat-tile"><strong>${displayedCount()}</strong><span>陈列</span></div>
            <div class="stat-tile"><strong>${ASSET_STATS.uniqueCatalogItems}</strong><span>素材</span></div>
          </div>
          <div class="settings-actions">
            <button class="quiet-button" type="button" data-action="load-demo">载入示例</button>
            <button class="danger-button" type="button" data-action="reset-museum">清空数据</button>
          </div>
        </section>
        <section class="settings-card" style="grid-column:1/-1">
          <h3>说明</h3>
          <p>本应用是非官方玩家二创工具，与 Cowbeans 及《像素生存者2》官方无隶属关系。游戏素材版权归原权利人所有。</p>
        </section>
      </form>`,
  });
}

function resetMuseum() {
  if (!window.confirm("确定清空全部藏品和描述吗？此操作不可撤销。")) return;
  const imageIds = state.relics.map((relic) => relic.imageId).filter(Boolean);
  Promise.all(imageIds.map((id) => deleteImageBlob(id))).catch(console.warn);
  state = emptyState();
  activeSlot = 0;
  saveState();
  closeModal();
  closeRelicPanel({ reposition: false });
  setOverview(false);
  renderHall();
}

function loadDemoMuseum() {
  if (state.relics.length && !window.confirm("载入示例会替换当前馆藏，是否继续？")) return;
  state = createDemoState();
  activeSlot = 0;
  saveState();
  closeModal();
  closeRelicPanel({ reposition: false });
  setOverview(false);
  renderHall();
}

function openScreenshotPicker() {
  const input = $("#screenshotInput");
  input.value = "";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("请选择图片文件");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      showToast("图片超过 20MB，请先裁切或压缩");
      return;
    }
    const preview = await blobToDataUrl(file);
    openEditor(
      {
        id: "",
        name: "",
        category: "其他",
        madeAt: todayValue(),
        description: "",
        image: "",
        imageId: "",
        assetId: "",
      },
      { isNew: true, previewSource: preview, uploadBlob: file },
    );
  };
  input.click();
}

function chooseArtifact(assetId) {
  const artifact = findArtifact(assetId);
  if (!artifact) return;
  openEditor(
    {
      id: "",
      name: artifact.name,
      category: artifact.category,
      madeAt: todayValue(),
      description: "",
      image: artifact.image,
      imageId: "",
      assetId: artifact.id,
    },
    { isNew: true, previewSource: artifact.image },
  );
}

function openExportForCurrent() {
  let slot = activeSlot;
  let relic = relicBySlot(slot);
  if (!relic) {
    slot = state.slots.findIndex(Boolean);
    relic = relicBySlot(slot);
  }
  if (!relic) {
    showToast("先放入一件藏品，再导出典藏档案");
    return;
  }
  openExport(relic);
}

async function openExport(relic) {
  lastExportRelic = relic;
  openModal({
    title: "导出 4K 典藏档案",
    kicker: "3840 × 2160",
    wide: true,
    tall: true,
    html: `
      <div class="export-layout">
        <div class="export-preview">
          <div class="export-loading">正在生成 ${escapeHtml(relic.name)} 的典藏档案…<span class="loading-line"></span></div>
        </div>
        <aside class="export-side">
          <div class="export-note"><strong>本地生成</strong>图片会重新排版为 3840 × 2160，不会上传任何数据。</div>
          <div class="export-note"><strong>手机保存</strong>生成后可直接下载，也可以长按预览图保存到相册。</div>
        </aside>
      </div>`,
  });
  try {
    const blob = await generateExportBlob(relic);
    if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
    lastExportBlob = blob;
    lastExportUrl = URL.createObjectURL(blob);
    $("#modalBody").innerHTML = `
      <div class="export-layout">
        <div class="export-preview">
          <img src="${lastExportUrl}" alt="${escapeHtml(relic.name)} 4K 典藏档案" />
        </div>
        <aside class="export-side">
          <div class="export-note"><strong>3840 × 2160</strong>图片已生成。iOS 用户可长按预览图保存；也支持系统分享。</div>
          <div class="export-actions">
            <button class="quiet-button" type="button" data-action="download-export">下载原图</button>
            <button class="warm-button" type="button" data-action="share-export">分享图片</button>
          </div>
        </aside>
      </div>`;
  } catch (error) {
    console.error(error);
    $("#modalBody").innerHTML = `<div class="empty-state">生成图片失败：${escapeHtml(
      error.message || String(error),
    )}</div>`;
  }
}

function exportFileName() {
  return `${(lastExportRelic?.name || "像素典藏馆").replace(/[\\/:*?"<>|]/g, "_")}-4K典藏档案.png`;
}

function downloadExport() {
  if (!lastExportUrl) return;
  const anchor = document.createElement("a");
  anchor.href = lastExportUrl;
  anchor.download = exportFileName();
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  showToast("已开始保存 4K 图片");
}

async function shareExport() {
  if (!lastExportBlob) return;
  const file = new File([lastExportBlob], exportFileName(), { type: "image/png" });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: `${lastExportRelic?.name || "像素典藏馆"} · 4K 典藏档案`,
      });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  downloadExport();
}

function showToast(text) {
  const toast = $("#toast");
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function showCeremony(text) {
  $("#ceremonyText").textContent = text;
  $("#ceremony").hidden = false;
}

function openModal({ title, kicker = "", html = "", wide = false, tall = false, onMount }) {
  const modal = $("#modal");
  const panel = $(".modal-panel", modal);
  $("#modalTitle").textContent = title;
  $("#modalKicker").textContent = kicker;
  $("#modalBody").innerHTML = html;
  panel.classList.toggle("modal-panel-wide", wide);
  panel.classList.toggle("modal-panel-tall", tall);
  modal.hidden = false;
  $("#modalBody").scrollTop = 0;
  requestAnimationFrame(() => onMount?.());
}

function closeModal() {
  $("#modal").hidden = true;
  $("#modalBody").innerHTML = "";
  editingRelic = null;
}

function canvasRoundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function loadCanvasImage(source) {
  return new Promise((resolve, reject) => {
    if (!source) {
      reject(new Error("缺少藏品图片"));
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("藏品图片加载失败"));
    image.src = source;
  });
}

function fitContain(image, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
  return {
    width: image.naturalWidth * scale,
    height: image.naturalHeight * scale,
  };
}

function wrapCanvasText(context, text, maxWidth, maxLines = Infinity) {
  const lines = [];
  for (const paragraph of String(text || "").split("\n")) {
    if (!paragraph) {
      if (lines.length < maxLines) lines.push("");
      continue;
    }
    let line = "";
    for (const character of paragraph) {
      const next = line + character;
      if (context.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = character;
      } else {
        line = next;
      }
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
    if (line) lines.push(line);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
  }
  return lines;
}

function drawTextBlock(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const lines = wrapCanvasText(context, text, maxWidth, maxLines);
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
}

function drawGlassCase(context, x, y, width, height) {
  context.save();
  context.shadowColor = "rgba(0,0,0,.62)";
  context.shadowBlur = 48;
  context.shadowOffsetY = 25;
  context.fillStyle = "rgba(15,28,25,.38)";
  context.fillRect(x, y, width, height);
  context.restore();

  context.strokeStyle = "rgba(244,214,143,.78)";
  context.lineWidth = 8;
  context.strokeRect(x, y, width, height);
  context.strokeStyle = "rgba(198,249,234,.16)";
  context.lineWidth = 2;
  context.strokeRect(x + 18, y + 18, width - 36, height - 36);

  const shine = context.createLinearGradient(x, y, x + width, y + height);
  shine.addColorStop(0, "rgba(255,255,255,.13)");
  shine.addColorStop(0.22, "rgba(255,255,255,0)");
  shine.addColorStop(0.75, "rgba(255,255,255,.025)");
  context.fillStyle = shine;
  context.fillRect(x + 18, y + 18, width - 36, height - 36);

  const light = context.createLinearGradient(x, y, x, y + height);
  light.addColorStop(0, "rgba(255,233,176,.2)");
  light.addColorStop(1, "rgba(255,233,176,0)");
  context.beginPath();
  context.moveTo(x + width * 0.38, y + 8);
  context.lineTo(x + width * 0.62, y + 8);
  context.lineTo(x + width * 0.92, y + height);
  context.lineTo(x + width * 0.08, y + height);
  context.closePath();
  context.fillStyle = light;
  context.fill();
}

async function generateExportBlob(relic) {
  await document.fonts?.ready;
  const width = 3840;
  const height = 2160;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#0b0705");
  background.addColorStop(0.48, "#26150f");
  background.addColorStop(1, "#422016");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  for (let x = 80; x < width; x += 210) {
    context.fillStyle = x % 420 === 80 ? "rgba(83,44,28,.28)" : "rgba(45,25,17,.2)";
    context.fillRect(x, 0, 202, height);
    context.fillStyle = "rgba(0,0,0,.18)";
    context.fillRect(x + 202, 0, 4, height);
  }

  const glow = context.createRadialGradient(1170, 1030, 100, 1170, 1030, 960);
  glow.addColorStop(0, "rgba(255,224,154,.23)");
  glow.addColorStop(0.5, "rgba(209,153,78,.08)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = glow;
  context.fillRect(80, 120, 2200, 1860);

  context.strokeStyle = "rgba(244,214,143,.3)";
  context.lineWidth = 4;
  context.strokeRect(55, 55, width - 110, height - 110);

  const logoImage = await loadCanvasImage("./assets/logo/platform-logo-white.png");
  const logoCanvas = document.createElement("canvas");
  logoCanvas.width = 620;
  logoCanvas.height = 124;
  const logoContext = logoCanvas.getContext("2d");
  logoContext.drawImage(logoImage, 0, 0, 620, 124);
  logoContext.globalCompositeOperation = "source-in";
  const logoGradient = logoContext.createLinearGradient(0, 0, 0, 124);
  logoGradient.addColorStop(0, "#ffe8ab");
  logoGradient.addColorStop(0.65, "#c7964c");
  logoContext.fillStyle = logoGradient;
  logoContext.fillRect(0, 0, 620, 124);
  context.drawImage(logoCanvas, 158, 90, 540, 108);

  context.fillStyle = "rgba(98,188,169,.9)";
  context.font = "700 29px 'Courier New', monospace";
  context.fillText("PRIVATE RELIC HALL", 770, 145);
  context.fillStyle = "rgba(240,226,196,.58)";
  context.font = "24px 'Microsoft YaHei', sans-serif";
  context.fillText(state.museumName, 770, 184);

  context.textAlign = "right";
  context.fillStyle = "rgba(244,214,143,.58)";
  context.font = "700 23px 'Courier New', monospace";
  context.fillText("4K COLLECTION DOSSIER", width - 160, 145);
  context.fillStyle = "rgba(184,165,138,.42)";
  context.font = "20px 'Microsoft YaHei', sans-serif";
  context.fillText(`馆藏 ${String(state.slots.indexOf(relic.id) + 1).padStart(2, "0")} / 05`, width - 160, 182);
  context.textAlign = "left";

  const caseX = 180;
  const caseY = 380;
  const caseWidth = 1540;
  const caseHeight = 1080;
  drawGlassCase(context, caseX, caseY, caseWidth, caseHeight);

  context.fillStyle = "#1d110c";
  context.fillRect(caseX + caseWidth / 2 - 13, caseY + caseHeight, 26, 28);
  context.fillStyle = "#583723";
  context.fillRect(caseX + caseWidth * 0.25, caseY + caseHeight + 18, caseWidth * 0.5, 410);
  context.fillStyle = "rgba(198,150,77,.25)";
  for (let x = caseX + caseWidth * 0.3; x < caseX + caseWidth * 0.7; x += 22) {
    context.fillRect(x, caseY + caseHeight + 54, 6, 330);
  }
  context.fillStyle = "#392116";
  context.fillRect(caseX + caseWidth * 0.17, caseY + caseHeight + 388, caseWidth * 0.66, 90);
  context.fillStyle = "#6d442a";
  context.fillRect(caseX + caseWidth * 0.16, caseY + caseHeight - 15, caseWidth * 0.68, 32);

  const artifactImage = await loadCanvasImage(await resolveRelicImage(relic));
  const fitted = fitContain(artifactImage, 720, 600);
  const artifactX = caseX + caseWidth / 2 - fitted.width / 2;
  const artifactY = caseY + caseHeight / 2 - fitted.height / 2;
  context.save();
  context.imageSmoothingEnabled = false;
  context.shadowColor = "rgba(0,0,0,.6)";
  context.shadowBlur = 32;
  context.shadowOffsetY = 18;
  context.drawImage(artifactImage, artifactX, artifactY, fitted.width, fitted.height);
  context.restore();

  const contentX = 1990;
  const contentWidth = 1620;
  context.fillStyle = "#f4e7c7";
  context.font = "700 92px 'Courier New', 'Microsoft YaHei', monospace";
  drawTextBlock(context, relic.name, contentX, 415, contentWidth, 104, 2);

  context.fillStyle = "rgba(184,165,138,.68)";
  context.font = "30px 'Microsoft YaHei', sans-serif";
  context.fillText(
    `${relic.category}   ·   ${formatDate(relic.madeAt)}`,
    contentX,
    555,
  );
  context.fillStyle = "rgba(244,214,143,.75)";
  context.fillRect(contentX, 610, 145, 4);

  context.fillStyle = "rgba(240,226,196,.82)";
  context.font = "32px 'Microsoft YaHei', sans-serif";
  drawTextBlock(
    context,
    descriptionFor(relic) || "这件藏品还没有留下描述。",
    contentX,
    710,
    contentWidth,
    55,
    17,
  );

  context.fillStyle = "rgba(98,188,169,.12)";
  canvasRoundRect(context, contentX, 1740, contentWidth, 120, 14);
  context.fill();
  context.strokeStyle = "rgba(98,188,169,.22)";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "rgba(203,239,229,.68)";
  context.font = "25px 'Microsoft YaHei', sans-serif";
  context.fillText(`${state.museumName}    ·    玩家私人馆藏`, contentX + 30, 1812);

  context.strokeStyle = "rgba(244,214,143,.34)";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(width - 305, height - 255, 108, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = "rgba(244,214,143,.72)";
  context.textAlign = "center";
  context.font = "700 52px 'Courier New', 'Microsoft YaHei', monospace";
  context.fillText("藏", width - 305, height - 237);
  context.textAlign = "left";

  context.fillStyle = "rgba(184,165,138,.32)";
  context.font = "19px 'Microsoft YaHei', sans-serif";
  context.fillText(
    "非官方玩家二创工具 · 与 Cowbeans 及《像素生存者2》官方无隶属关系 · 游戏素材版权归原权利人所有",
    158,
    height - 88,
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("无法生成图片"))),
      "image/png",
      1,
    );
  });
}

function handleClick(event) {
  if (event.target.closest("[data-close-modal]")) {
    closeModal();
    return;
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  switch (action) {
    case "open-slot":
      openSlot(Number(target.dataset.slot));
      break;
    case "library-category":
      libraryFilter.category = target.dataset.category;
      libraryFilter.page = 0;
      $$(".category-tab", $("#modalBody")).forEach((tab) =>
        tab.classList.toggle("is-active", tab.dataset.category === libraryFilter.category),
      );
      renderLibraryGrid();
      break;
    case "library-page":
      libraryFilter.page += Number(target.dataset.direction);
      renderLibraryGrid();
      break;
    case "upload-screenshot":
      openScreenshotPicker();
      break;
    case "choose-artifact":
      chooseArtifact(target.dataset.assetId);
      break;
    case "change-editor-image":
      openLibrary();
      break;
    case "edit-current":
      if (activeRelicId) {
        const relic = findRelic(activeRelicId);
        if (relic) openEditor(relic, { isNew: false, previewSource: primaryImageSource(relic) });
      }
      break;
    case "move-current":
      if (activeRelicId) openCabinetChooser(activeRelicId);
      break;
    case "export-current":
      {
        const relic = activeRelicId ? findRelic(activeRelicId) : null;
        if (relic) openExport(relic);
      }
      break;
    case "open-archived": {
      const relic = findRelic(target.dataset.relicId);
      if (relic) {
        const slot = state.slots.indexOf(relic.id);
        if (slot >= 0) {
          closeModal();
          setOverview(false);
          setActiveSlot(slot);
          setTimeout(() => renderRelicPanel(relic), 50);
        } else {
          openCabinetChooser(relic.id);
        }
      }
      break;
    }
    case "auto-display":
      autoDisplayRelic(target.dataset.relicId);
      break;
    case "assign-slot":
      assignRelicToSlot(target.dataset.relicId, Number(target.dataset.slot));
      break;
    case "delete-relic":
      deleteRelic(target.dataset.relicId);
      break;
    case "load-demo":
      loadDemoMuseum();
      break;
    case "reset-museum":
      resetMuseum();
      break;
    case "download-export":
      downloadExport();
      break;
    case "share-export":
      shareExport();
      break;
    default:
      break;
  }
}

function handleSubmit(event) {
  if (event.target.id === "relicEditorForm") {
    event.preventDefault();
    saveRelicForm(event.target).catch((error) => {
      console.error(error);
      showToast(`保存失败：${error.message}`);
    });
  } else if (event.target.id === "settingsForm") {
    event.preventDefault();
    const name = String(new FormData(event.target).get("museumName") || "").trim();
    state.museumName = name || "无名者装备博物馆";
    saveState();
    renderHall();
    closeModal();
  }
}

function createDust() {
  $("#dustField").innerHTML = Array.from({ length: 24 }, (_, index) => {
    const left = (index * 39.2 + 6) % 100;
    const top = 9 + ((index * 18.7) % 78);
    const size = 1 + (index % 3) * 0.65;
    const duration = 5 + (index % 6) * 0.8;
    const delay = -(index % 10) * 0.5;
    const alpha = 0.16 + (index % 5) * 0.07;
    return `<span class="dust" style="--left:${left}%;--top:${top}%;--size:${size}px;
      --duration:${duration}s;--delay:${delay}s;--alpha:${alpha}"></span>`;
  }).join("");
}

async function warmArtifactCache() {
  if (!("caches" in window) || !ARTIFACTS.length) return;
  try {
    const cache = await caches.open("relic-museum-artifacts-v1");
    const urls = [...new Set(ARTIFACTS.map((artifact) => new URL(artifact.image, location.href).href))];
    const batchSize = 8;
    for (let offset = 0; offset < urls.length; offset += batchSize) {
      if (!navigator.onLine) break;
      const batch = urls.slice(offset, offset + batchSize);
      await Promise.all(
        batch.map(async (url) => {
          if (await cache.match(url)) return;
          const response = await fetch(url);
          if (response.ok) await cache.put(url, response);
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
  } catch (error) {
    console.warn("Artifact cache warm-up skipped.", error);
  }
}

async function refreshMuseum3D() {
  if (!museum3D) return;
  const relics = await Promise.all(
    state.slots.map(async (relicId, index) => {
      const relic = findRelic(relicId);
      if (!relic) return { name: "", image: "", slot: index };
      return {
        name: relic.name,
        image: await resolveRelicImage(relic),
        slot: index,
      };
    }),
  );
  museum3D.setData(relics, activeSlot, {
    overview: isOverview,
    inspecting,
  });
}

async function initializeMuseum3D() {
  try {
    const { createMuseum3D } = await import("./museum3d.js?v=19");
    museum3D = await createMuseum3D({
      canvas: $("#museum3d"),
      onSelect(slot) {
        openSlot(Number(slot));
      },
    });
    await refreshMuseum3D();
    museum3DReady = true;
    $("#hallViewport").classList.add("webgl-ready");
    renderSceneHotspots();
  } catch (error) {
    museum3D = null;
    museum3DReady = false;
    console.warn("WebGL museum unavailable; using layered fallback.", error);
  }
}

function finishSplash() {
  const splash = $("#splash");
  if (!splash || splash.classList.contains("is-leaving")) return;
  splash.classList.add("is-leaving");
  $("#app").setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    $("#app").classList.add("is-ready");
    renderHall();
  });
  clearTimeout(splashTimer);
  setTimeout(() => {
    splash.hidden = true;
  }, 1250);
}

function bindGestures() {
  const viewport = $("#hallViewport");
  let startX = 0;
  let startY = 0;
  let pointerId = null;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button") || isOverview) return;
    startX = event.clientX;
    startY = event.clientY;
    pointerId = event.pointerId;
  });
  viewport.addEventListener("pointerup", (event) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      setActiveSlot(activeSlot + (dx < 0 ? 1 : -1));
    }
  });
  viewport.addEventListener(
    "wheel",
    (event) => {
      if (isOverview || Math.abs(event.deltaX) < Math.abs(event.deltaY)) return;
      event.preventDefault();
      setActiveSlot(activeSlot + (event.deltaX > 0 ? 1 : -1));
    },
    { passive: false },
  );
}

function bindEvents() {
  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  $("#skipSplashBtn").addEventListener("click", finishSplash);
  $("#prevCabinetBtn").addEventListener("click", () => {
    if (!isOverview) setActiveSlot(activeSlot - 1);
  });
  $("#nextCabinetBtn").addEventListener("click", () => {
    if (!isOverview) setActiveSlot(activeSlot + 1);
  });
  $("#overviewBtn").addEventListener("click", () => setOverview(!isOverview));
  $("#archiveBtn").addEventListener("click", openArchive);
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#museumNameBtn").addEventListener("click", openSettings);
  $("#addRelicBtn").addEventListener("click", openLibrary);
  $("#exportHallBtn").addEventListener("click", openExportForCurrent);
  $("#closeRelicPanelBtn").addEventListener("click", () => closeRelicPanel());
  $("#ceremonyCloseBtn").addEventListener("click", () => {
    $("#ceremony").hidden = true;
  });
  window.addEventListener("resize", () => positionScene());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("#modal").hidden) closeModal();
      else if (!$("#ceremony").hidden) $("#ceremony").hidden = true;
      else if (inspecting) closeRelicPanel();
      else if (isOverview) setOverview(false);
    }
    if ($("#modal").hidden && $("#ceremony").hidden && !isOverview) {
      if (event.key === "ArrowLeft") setActiveSlot(activeSlot - 1);
      if (event.key === "ArrowRight") setActiveSlot(activeSlot + 1);
    }
  });
  bindGestures();
}

function boot() {
  if (window.SG2Native?.setStatusBarColor) {
    try {
      window.SG2Native.setStatusBarColor("#160e0b", false);
    } catch {}
  }
  maybeLoadDemoFromQuery();
  createDust();
  bindEvents();
  renderHall();
  setOverview(false);
  initializeMuseum3D();

  if (new URLSearchParams(location.search).get("skipSplash") === "1") {
    $("#splash").hidden = true;
    $("#app").setAttribute("aria-hidden", "false");
    $("#app").classList.add("is-ready");
    setActiveSlot(activeSlot, { persist: false });
  } else {
    splashTimer = setTimeout(finishSplash, 5000);
  }

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
    navigator.storage?.persist?.().catch(() => {});
    const warm = () => window.setTimeout(warmArtifactCache, 1800);
    if ("requestIdleCallback" in window) window.requestIdleCallback(warm);
    else window.setTimeout(warm, 3500);
  }
}

boot();
