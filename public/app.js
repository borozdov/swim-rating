"use strict";

/* ---------- Constants (reverse-engineered from rsf.lsport.net) ---------- */

const SPORT_ID = "01f02e8d-6da4-43be-9dbf-05d47ab8a58d"; // Плавание
// Same-origin routes — server.js proxies these to rsf.lsport.net server-side,
// so the browser never makes a direct third-party request (ad blockers were
// flagging that pattern and silently failing it with "Failed to fetch").
const TOP_URL = "/api/top";
const LOCATIONS_URL = "/api/locations";
const SERVER_TAKE = 50; // rows fetched per server round-trip
const PERSON_SEARCH_TAKE = 500; // подтверждённый живым тестом максимум upstream — нужен полный (без имени) список, чтобы посчитать реальное место
const CLIENT_PAGE_SIZE = 50; // rows shown per pager page
const LOCATION_LEVEL_ID = 33;
const DEFAULT_ALIAS = "FREE50"; // the API has no "any discipline" mode — a specific alias is required

const RANKS = {
  0: "Б/Р", 5: "3 юн", 6: "2 юн", 7: "1 юн",
  15: "3", 16: "2", 17: "1",
  25: "КМС", 26: "МС", 27: "МСМК", 28: "ЗМС", 29: "ГМ",
  50: "ЗРФК РФ", 51: "ЗТ РФ", 52: "ЗТ СССР", 53: "МПЛ", 54: "МНР",
  55: "ОФКС", 56: "ЗРФК", 57: "ОНП", 58: "ПРО", 59: "ПС",
  1000000: "Другое",
};
const ELITE_RANKS = new Set([27, 28, 29]); // МСМК, ЗМС, ГМ
const MS_RANK = 26; // МС

// Список отфильтрован живым прогоном против upstream (все 34 исходных кода, без ограничения по
// дате): 25-метровые дистанции во всех стилях, FREE10000, обобщённый пункт "Открытая вода" и
// UNKNOWN5000G/UNKNOWN16000 стабильно возвращали пустой результат — убраны.
const DISCIPLINE_GROUPS = [
  { label: "Вольный стиль", options: [
    { value: "FREE50", label: "50 м" },
    { value: "FREE100", label: "100 м" },
    { value: "FREE200", label: "200 м" },
    { value: "FREE400", label: "400 м" },
    { value: "FREE800", label: "800 м" },
    { value: "FREE1500", label: "1500 м" },
    { value: "FREE5000", label: "5000 м" },
  ] },
  { label: "На спине", options: [
    { value: "BACK50", label: "50 м" },
    { value: "BACK100", label: "100 м" },
    { value: "BACK200", label: "200 м" },
  ] },
  { label: "Брасс", options: [
    { value: "BREAST50", label: "50 м" },
    { value: "BREAST100", label: "100 м" },
    { value: "BREAST200", label: "200 м" },
  ] },
  { label: "Баттерфляй", options: [
    { value: "FLY50", label: "50 м" },
    { value: "FLY100", label: "100 м" },
    { value: "FLY200", label: "200 м" },
  ] },
  { label: "Комплексное плавание", options: [
    { value: "MEDLEY100", label: "100 м (25 м бассейн)" },
    { value: "MEDLEY200", label: "200 м" },
    { value: "MEDLEY400", label: "400 м" },
  ] },
  { label: "Открытая вода", options: [
    { value: "UNKNOWN1500", label: "1500 м" },
    { value: "UNKNOWN3000", label: "3 км" },
    { value: "UNKNOWN3000G", label: "3 км (группа)" },
    { value: "UNKNOWN5000", label: "5 км" },
    { value: "UNKNOWN7500G", label: "7,5 км" },
    { value: "UNKNOWN10000", label: "10 км" },
    { value: "UNKNOWN25000", label: "25 км и более" },
  ] },
];

function disciplineLabel(value) {
  for (const g of DISCIPLINE_GROUPS) {
    const opt = g.options.find((o) => o.value === value);
    if (opt) return `${g.label} · ${opt.label}`;
  }
  return value;
}

function rankLabel(id) {
  return RANKS[id] || "";
}
function rankTier(id) {
  if (ELITE_RANKS.has(id)) return "rank-elite";
  if (id === MS_RANK) return "rank-ms";
  return "rank-mono";
}

/* ---------- State ---------- */

function currentYear() {
  return new Date().getFullYear();
}

function defaultStartDate() {
  return `${currentYear()}-01-01`;
}

const state = {
  alias: DEFAULT_ALIAS,
  genderID: "",
  pool: "",
  minBirthYear: null,
  maxBirthYear: null,
  start: defaultStartDate(),
  end: "",
  name: "",
  locations: [], // [{id, label}]
  unique: true,
  skip: 0,
  results: [],
  loading: false,
  hasMore: true,
  error: null,
  page: 1,
  requestSeq: 0,
};

/* ---------- DOM refs ---------- */

const $ = (id) => document.getElementById(id);

const el = {
  topbar: document.querySelector(".topbar"),
  genderSeg: $("gender-segmented"),
  poolSeg: $("pool-segmented"),
  birthYearMin: $("birthyear-min"),
  birthYearMax: $("birthyear-max"),
  territoryControl: $("territory-control"),
  territoryChips: $("territory-chips"),
  territoryInput: $("territory-input"),
  territoryDropdown: $("territory-dropdown"),
  nameSearch: $("name-search"),
  uniqueToggle: $("unique-toggle"),
  resetFilters: $("reset-filters"),
  emptyResetFilters: $("empty-reset-filters"),
  resultCount: $("result-count"),
  loadingBar: $("loading-bar"),
  statusBanner: $("status-banner"),
  skeleton: $("skeleton"),
  emptyState: $("empty-state"),
  resultsDesktop: $("results-desktop"),
  resultsMobile: $("results-mobile"),
  resultsBody: $("results-body"),
  pager: $("pager"),
  pgPrev: $("pg-prev"),
  pgNext: $("pg-next"),
  pgItems: $("pg-items"),
  pagerCaption: $("pager-caption"),
  exportCsv: $("export-csv"),
  exportListPng: $("export-list-png"),
  exportListPdf: $("export-list-pdf"),
  themeToggle: $("theme-toggle"),
  filters: $("filters"),
  filtersBackdrop: $("filters-backdrop"),
  filtersTriggerMobile: $("filters-trigger-mobile"),
  filtersCloseMobile: $("filters-close-mobile"),
  filtersApplyMobile: $("filters-apply-mobile"),
  filterBadgeTrigger: $("filter-count-badge-trigger"),
  filterBadgeHeading: $("filter-count-badge-heading"),
  favoritesTrigger: $("favorites-trigger"),
  favoritesTriggerLabel: $("favorites-trigger-label"),
  emptyTitle: $("empty-title"),
  emptySub: $("empty-sub"),
  personSearchTrigger: $("person-search-trigger"),
  personSearchPanel: $("person-search-panel"),
  personSearchBackdrop: $("person-search-backdrop"),
  personSearchClose: $("person-search-close"),
  personSearchName: $("person-search-name"),
  personSearchDisciplines: $("person-search-disciplines"),
  personSearchEstimate: $("person-search-estimate"),
  personSearchClear: $("person-search-clear"),
  personSearchSubmit: $("person-search-submit"),
  exitPersonSearch: $("exit-person-search"),
};

/* ---------- Helpers ---------- */

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function scrollToTop() {
  const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  // Мобильный лик скроллит страницу, десктопный app-shell — саму таблицу; сбрасываем оба,
  // лишний вызов по не-скроллящемуся контейнеру безвреден.
  window.scrollTo({ top: 0, behavior });
  el.resultsDesktop.scrollTo({ top: 0, behavior });
}

// Пул с ограниченной конкурентностью — используется поиском себя по нескольким дисциплинам (F),
// чтобы не долбить медленный upstream всеми запросами разом.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function lane() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function parseDotNetDate(str) {
  if (!str) return null;
  const m = /\d+/.exec(str);
  return m ? new Date(Number(m[0])) : null;
}

function formatDate(str) {
  const d = parseDotNetDate(str);
  if (!d) return "";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const MONTH_LABELS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatIsoDate(str) {
  if (!str) return "";
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function buildCalendarDays(year, month) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first grid
  const gridStart = new Date(year, month, 1 - startOffset);
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    days.push({ iso: isoDate(d), day: d.getDate(), inMonth: d.getMonth() === month });
  }
  return days;
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const POOL_TAG_RE = /\s*\(бассейн\s*(\d+)\s*м\)\s*$/i;
function splitDiscipline(discipline) {
  const text = discipline || "";
  const m = POOL_TAG_RE.exec(text);
  if (!m) return { disc: text, poolTag: "" };
  return { disc: text.slice(0, m.index).trim(), poolTag: `бассейн ${m[1]} м` };
}

/* ---------- Territory label (mirrors original kendo template logic) ---------- */

function locationLabel(item) {
  if (item.Facility) {
    return {
      big: item.Facility,
      small: [item.Address, [item.City, item.Region].filter(Boolean).join(" / ")].filter(Boolean).join(" · "),
    };
  }
  if (item.CityID) {
    return { big: [item.CityType, item.City].filter(Boolean).join(" "), small: item.Region || "" };
  }
  if (item.MunicipalityID) {
    return { big: `${item.Municipality} · муниципальный р-н`, small: item.Region || "" };
  }
  if (item.RegionID) {
    return { big: item.Region, small: "" };
  }
  if (item.DistrictID) {
    return { big: `${item.District} · федеральный округ`, small: "" };
  }
  return { big: [item.Country, item.City].filter(Boolean).join(", "), small: "" };
}

/* ---------- Request builders ---------- */

// overrides позволяет переиспользовать всю логику дат/пула/локаций для запроса по ДРУГОЙ
// дисциплине/имени, не трогая текущий стейт фильтров — нужно для поиска себя по дистанциям (F).
function buildTopRequestBody(overrides = {}) {
  // Upstream фильтрует по возрасту относительно ТЕКУЩЕГО года (подтверждено живым тестом:
  // minAge=maxAge=10 → BirthYear=2016 на событиях за 7+ месяцев подряд), не по дате старта —
  // поэтому конвертация год рождения → возраст берёт год рождения раньше = возраст больше.
  const thisYear = currentYear();
  const take = overrides.take ?? SERVER_TAKE;
  const skip = overrides.skip ?? state.skip;
  const options = {
    minAge: state.maxBirthYear !== null ? thisYear - state.maxBirthYear : null,
    maxAge: state.minBirthYear !== null ? thisYear - state.minBirthYear : null,
    alias: overrides.alias !== undefined ? overrides.alias : (state.alias || null),
    pool: state.pool ? Number(state.pool) : null,
    locations: state.locations.map((l) => l.id),
    name: overrides.name !== undefined ? overrides.name : (state.name || ""),
  };
  if (state.pool) options.strict = true;

  const body = {
    take,
    skip,
    page: Math.floor(skip / take) + 1,
    pageSize: take,
    sort: [{ field: "Result", dir: "asc" }], // всегда быстрые сначала
    sportID: SPORT_ID,
    genderID: state.genderID || undefined,
    unique: state.unique,
    options: JSON.stringify(options),
  };

  if (state.start) {
    const d = new Date(`${state.start}T00:00:00`);
    body.start = d.toISOString();
    body.soffset = d.getTimezoneOffset();
  }
  if (state.end) {
    const d = new Date(`${state.end}T00:00:00`);
    body.end = d.toISOString();
    body.eoffset = d.getTimezoneOffset();
  }
  return body;
}

async function fetchJson(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return JSON.parse(text);
}

/* ---------- Fetch + render orchestration ---------- */

let abortController = null;

async function fetchResults({ reset }) {
  if (reset) {
    state.skip = 0;
    state.results = [];
    state.hasMore = true;
    state.page = 1;
    scrollToTop();
  }
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const mySeq = ++state.requestSeq;

  state.loading = true;
  state.error = null;
  render();

  try {
    const rows = await fetchJson(TOP_URL, buildTopRequestBody(), abortController.signal);
    if (mySeq !== state.requestSeq) return; // superseded by a newer request
    const list = Array.isArray(rows) ? rows : [];
    state.results = reset ? list : state.results.concat(list);
    state.hasMore = list.length === SERVER_TAKE;
    state.skip += list.length;
    state.loading = false;
    render();
  } catch (err) {
    if (err.name === "AbortError") return;
    state.loading = false;
    state.error = err;
    render();
  }
}

/* ---------- Client-side pagination over the accumulated result set ---------- */

function totalPagesKnown() {
  return Math.max(1, Math.ceil(state.results.length / CLIENT_PAGE_SIZE));
}

async function ensureLoadedForPage(page) {
  // !state.error — иначе при упавшем upstream условие остаётся истинным после каждого
  // неудачного fetch и цикл бесконечно долбит сервер; ошибка показывается баннером с retry.
  while (state.hasMore && !state.loading && !state.error && state.results.length < page * CLIENT_PAGE_SIZE) {
    await fetchResults({ reset: false });
  }
}

async function goToPage(n) {
  const target = Math.max(1, n);
  await ensureLoadedForPage(target);
  state.page = Math.min(target, totalPagesKnown());
  // Скролл — ДО render(): если новая страница короче предыдущей, браузер мгновенно (без анимации)
  // подрежет текущий scrollTop под новую высоту таблицы в момент подмены строк — это и был тот рывок.
  // Скроллим, пока ещё видны старые строки, и только потом меняем содержимое.
  scrollToTop();
  render();
}

function buildPageItems(cur, total) {
  if (total <= 7) {
    const a = [];
    for (let i = 1; i <= total; i++) a.push(i);
    return a;
  }
  const items = [1];
  const s = Math.max(2, cur - 1);
  const e = Math.min(total - 1, cur + 1);
  if (s > 2) items.push("…");
  for (let i = s; i <= e; i++) items.push(i);
  if (e < total - 1) items.push("…");
  items.push(total);
  return items;
}

/* ---------- Favorites (локально, без аккаунта — localStorage) ---------- */

const FAVORITES_KEY = "rsf-favorites";
const FAV_STAR_PATH = "M12 2.5l2.9 6.9 7.1.6-5.4 4.7 1.7 7-6.3-3.9-6.3 3.9 1.7-7-5.4-4.7 7.1-.6z";

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Ключ строится из уже посчитанных, null-safe полей renderRow() (не из сырого PersonID —
// у командных/эстафетных строк item.Persons пуст, PersonID для них не существует).
function favoriteKey(r) {
  return `${r.name}|${r.disc}|${r.date}|${r.result}`;
}

let favorites = loadFavorites();
let favoriteKeySet = new Set(favorites.map(favoriteKey));
let showingFavorites = false;

function isFavorite(key) {
  return favoriteKeySet.has(key);
}

function saveFavorites() {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch {}
}

// Снапшотится весь объект renderRow() целиком (не подмножество полей) — иначе renderDesktopRow/
// renderMobileCard отрисуют буквально "undefined" там, где нет фолбэка (например r.pos).
function toggleFavorite(r) {
  const key = favoriteKey(r);
  if (favoriteKeySet.has(key)) {
    favoriteKeySet.delete(key);
    favorites = favorites.filter((f) => favoriteKey(f) !== key);
  } else {
    favoriteKeySet.add(key);
    favorites = favorites.concat([{ ...r, savedAt: Date.now() }]);
  }
  saveFavorites();
}

function favStarButton(r) {
  const key = favoriteKey(r);
  const active = isFavorite(key);
  return `<button type="button" class="fav-star${active ? " is-fav" : ""}" data-fav-key="${escapeHtml(key)}" aria-pressed="${active}" aria-label="${active ? "Убрать из избранного" : "Добавить в избранное"}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${FAV_STAR_PATH}"/></svg>
  </button>`;
}

// Скачивает карточку результата в PNG (viral share-card) — реализация в разделе "Экспорт в PNG/PDF".
function rowExportButton(r) {
  return `<button type="button" class="row-export" data-export-key="${escapeHtml(favoriteKey(r))}" aria-label="Скачать карточку PNG" title="Скачать карточку PNG">PNG</button>`;
}

function renderFavoritesTrigger() {
  el.favoritesTrigger.classList.toggle("active", showingFavorites);
  el.favoritesTrigger.setAttribute("aria-pressed", String(showingFavorites));
  el.favoritesTriggerLabel.textContent = showingFavorites ? "К результатам" : `Избранное${favorites.length ? ` (${favorites.length})` : ""}`;
}

function toggleFavoritesView() {
  showingFavorites = !showingFavorites;
  if (showingFavorites) scrollToTop();
  render();
}

el.favoritesTrigger.addEventListener("click", toggleFavoritesView);

function handleFavStarClick(e) {
  const btn = e.target.closest(".fav-star");
  if (!btn) return;
  const key = btn.dataset.favKey;
  // Строку по ключу ищем среди того, что реально сейчас отрисовано — renderResultsBlock() кэширует
  // эти же r-объекты в lastRenderedRows, пересчитывать renderRow() заново не нужно.
  const row = lastRenderedRows.find((r) => favoriteKey(r) === key);
  if (!row) return;
  toggleFavorite(row);
  if (showingFavorites) {
    render(); // список избранного мог измениться прямо сейчас
  } else {
    btn.classList.toggle("is-fav", isFavorite(key));
    btn.setAttribute("aria-pressed", String(isFavorite(key)));
    btn.setAttribute("aria-label", isFavorite(key) ? "Убрать из избранного" : "Добавить в избранное");
    renderFavoritesTrigger();
  }
}
el.resultsBody.addEventListener("click", handleFavStarClick);
el.resultsMobile.addEventListener("click", handleFavStarClick);

function handleRowExportClick(e) {
  const btn = e.target.closest(".row-export");
  if (!btn) return;
  const row = lastRenderedRows.find((r) => favoriteKey(r) === btn.dataset.exportKey);
  if (!row) return;
  btn.disabled = true;
  downloadCardPng(row).catch((err) => console.error(err)).finally(() => { btn.disabled = false; });
}
el.resultsBody.addEventListener("click", handleRowExportClick);
el.resultsMobile.addEventListener("click", handleRowExportClick);

/* ---------- Rendering ---------- */

function currentViewState() {
  if (showingFavorites) return favorites.length === 0 ? "empty" : "data";
  if (state.loading && state.results.length === 0) return "loading";
  if (state.error) return "error";
  if (state.results.length === 0) return "empty";
  return "data";
}

function updateEmptyStateCopy() {
  if (showingFavorites) {
    el.emptyTitle.textContent = "Пока нет избранного";
    el.emptySub.textContent = "Нажмите на звёздочку у результата, чтобы сохранить его сюда";
    el.emptyResetFilters.hidden = true;
  } else {
    el.emptyTitle.textContent = "Ничего не найдено";
    el.emptySub.textContent = "Попробуйте изменить или сбросить фильтры";
    el.emptyResetFilters.hidden = false;
  }
}

function render() {
  if (personSearch.active) {
    renderPersonSearchView();
    return;
  }
  el.exitPersonSearch.hidden = true;
  el.favoritesTrigger.hidden = false;
  el.exportCsv.hidden = false;
  el.exportListPng.hidden = false;
  el.exportListPdf.hidden = false;
  el.filters.classList.remove("is-disabled");
  el.filters.inert = false;
  el.filtersTriggerMobile.disabled = false;

  const vs = currentViewState();

  el.loadingBar.hidden = !state.loading || showingFavorites;
  el.skeleton.hidden = vs !== "loading";
  el.emptyState.hidden = vs !== "empty";
  if (vs === "empty") updateEmptyStateCopy();
  el.resultsDesktop.style.display = vs === "data" ? "" : "none";
  el.resultsMobile.style.display = vs === "data" ? "" : "none";

  el.statusBanner.innerHTML = "";
  if (vs === "error") {
    el.statusBanner.innerHTML = `
      <div class="error-banner" role="alert">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>
        <span>Не удалось загрузить данные (${escapeHtml(state.error.message)}).</span>
        <button type="button" id="retry-btn" class="btn">Повторить</button>
      </div>`;
    $("retry-btn").addEventListener("click", () => fetchResults({ reset: true }));
  }

  if (vs === "data") {
    renderResultsBlock();
  } else {
    el.pager.hidden = true;
    lastRenderedRows = [];
  }

  renderStatus();
  renderFilterBadge();
  renderFiltersApplyLabel();
  renderFavoritesTrigger();
  el.exportCsv.disabled = showingFavorites || state.results.length === 0;
  el.exportListPng.disabled = lastRenderedRows.length === 0;
  el.exportListPdf.disabled = lastRenderedRows.length === 0;
  if (vs === "data" && !showingFavorites) renderPager();
  else el.pager.hidden = true;
}

function personName(item) {
  const p = (item.Persons && item.Persons[0]) || null;
  return p ? `${p.LastName || ""} ${p.FirstName || ""}`.trim() : (item.Text || "");
}

function normalizeNameTokens(s) {
  return s.toLowerCase().replace(/ё/g, "е").trim().split(/\s+/).filter(Boolean);
}

// Клиентский матч имени против ПОЛНОГО (без name-фильтра upstream) списка —
// нужен, чтобы посчитать реальное место (см. runPersonSearch). Разрешает порядок
// токенов ("Иван Иванов" == "Иванов Иван") и подстроки, как обычный поиск по имени.
function nameMatches(item, query) {
  const candidateTokens = normalizeNameTokens(personName(item));
  const queryTokens = normalizeNameTokens(query);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return false;
  return queryTokens.every((qt) => candidateTokens.some((ct) => ct.includes(qt)));
}

function renderRow(item, pos) {
  const p = (item.Persons && item.Persons[0]) || null;
  const name = personName(item) || "—";
  const rankId = p ? p.RankID : null;
  const rank = p ? rankLabel(p.RankID) : "";
  const showBadge = rank && rank !== "Б/Р";
  const tierCls = showBadge ? rankTier(rankId) : "";
  const region = (p && p.City && (p.City.RegionTiny || p.City.Region)) || "";
  const { disc, poolTag } = splitDiscipline(item.Discipline);
  const date = formatDate(item.Date);
  const aqua = item.Rating !== null && item.Rating !== undefined ? Math.round(item.Rating) : null;

  // truePos переживает переименование pos для отображения (см. избранное, где pos
  // становится порядковым номером в списке избранного) — карточка экспорта должна
  // показывать реальное место в рейтинге, а не позицию в чьём-то личном списке.
  // filterSummary снимается ЗДЕСЬ и ЖЕ, а не читается заново из state в момент экспорта —
  // иначе избранное, экспортированное позже под другими фильтрами, показало бы место
  // из одного контекста рядом с описанием фильтров из совсем другого.
  return { pos, truePos: pos, name, showBadge, rank, tierCls, region, birthText: p && p.BirthYear ? `${p.BirthYear} г.р.` : "", disc, poolTag, result: item.FormattedResult || "—", isTeam: !!item.IsTeam, aqua, tournament: item.Tournament || "", location: item.Location || "", date, filterSummary: activeFilterSummary() };
}

function renderDesktopRow(r) {
  return `
    <div class="row" role="row">
      <div class="cell-index">${r.pos}</div>
      <div class="cell-athlete">
        <span class="athlete-name">${escapeHtml(r.name) || "—"}</span>
        <div class="athlete-meta">
          ${r.birthText ? `<span>${escapeHtml(r.birthText)}</span>` : ""}
          ${r.region ? `<span>${escapeHtml(r.region)}</span>` : ""}
          ${r.showBadge ? `<span class="rank-badge ${r.tierCls}">${escapeHtml(r.rank)}</span>` : ""}
        </div>
      </div>
      <div class="cell-discipline">${escapeHtml(r.disc)}${r.poolTag ? `<span class="pool-tag">${escapeHtml(r.poolTag)}</span>` : ""}</div>
      <div><span class="result-value">${escapeHtml(r.result)}</span>${r.isTeam ? `<span class="pool-tag" style="margin-left:6px;">эстафета</span>` : ""}</div>
      <div>${r.aqua !== null ? `<span class="aqua-num">${r.aqua}</span>` : ""}</div>
      <div class="cell-event">
        <span class="event-tournament">${escapeHtml(r.tournament)}</span>
        <div class="event-meta">
          ${r.location ? `<span>${escapeHtml(r.location)}</span>` : ""}
          ${r.date ? `<span>${r.date}</span>` : ""}
        </div>
      </div>
      <div class="row-actions">${favStarButton(r)}${rowExportButton(r)}</div>
    </div>`;
}

function renderMobileCard(r) {
  return `
    <div class="result-card">
      <div class="result-card-head">
        <span class="result-card-pos">${r.pos} место</span>
        <div class="result-card-head-right">
          <span class="result-card-aqua">
            <span class="result-card-aqua-label">AQUA</span>
            ${r.aqua !== null ? `<span class="aqua-num">${r.aqua}</span>` : ""}
          </span>
          ${favStarButton(r)}
          ${rowExportButton(r)}
        </div>
      </div>
      <div class="result-card-name">${escapeHtml(r.name) || "—"}</div>
      <div class="result-card-meta">
        ${r.birthText ? `<span>${escapeHtml(r.birthText)}</span>` : ""}
        ${r.region ? `<span>${escapeHtml(r.region)}</span>` : ""}
        ${r.showBadge ? `<span class="rank-badge ${r.tierCls}">${escapeHtml(r.rank)}</span>` : ""}
      </div>
      <div class="result-card-main">
        <span class="result-card-result">${escapeHtml(r.result)}</span>
        <span class="result-card-disc">${escapeHtml(r.disc)}${r.poolTag ? ` · ${escapeHtml(r.poolTag)}` : ""}</span>
      </div>
      <div class="result-card-footer">
        <span class="result-card-tournament">${escapeHtml(r.tournament)}</span>
        <div class="result-card-footer-meta">
          ${r.location ? `<span>${escapeHtml(r.location)}</span>` : ""}
          ${r.date ? `<span>${r.date}</span>` : ""}
        </div>
      </div>
    </div>`;
}

let lastRenderedRows = [];

function renderResultsBlock() {
  if (showingFavorites) {
    lastRenderedRows = favorites.map((r, i) => ({ ...r, pos: i + 1 }));
  } else {
    const start = (state.page - 1) * CLIENT_PAGE_SIZE;
    lastRenderedRows = state.results.slice(start, start + CLIENT_PAGE_SIZE).map((item, i) => renderRow(item, start + i + 1));
  }
  el.resultsBody.innerHTML = lastRenderedRows.map(renderDesktopRow).join("");
  el.resultsMobile.innerHTML = lastRenderedRows.map(renderMobileCard).join("");
}

function renderStatus() {
  if (showingFavorites) {
    el.resultCount.textContent = favorites.length ? `Сохранено: ${favorites.length}` : "";
    return;
  }
  if (state.loading && state.results.length === 0) {
    el.resultCount.textContent = "Загрузка…";
    return;
  }
  if (state.results.length === 0) {
    el.resultCount.textContent = state.error ? "" : "Ничего не найдено";
    return;
  }
  const start = (state.page - 1) * CLIENT_PAGE_SIZE;
  const from = start + 1;
  const to = Math.min(start + CLIENT_PAGE_SIZE, state.results.length);
  el.resultCount.textContent = state.hasMore
    ? `Показаны ${from}–${to}`
    : `Найдено ${state.results.length} · показаны ${from}–${to}`;
}

function renderPager() {
  const total = totalPagesKnown();
  const show = state.results.length > 0 && (total > 1 || state.hasMore);
  el.pager.hidden = !show;
  if (!show) return;

  const cur = state.page;
  // state.loading здесь означает подгрузку СЛЕДУЮЩЕЙ пачки (vs="data" уже требует results.length>0) —
  // без явной индикации клик по «дальше» выглядел как зависание: старая страница просто оставалась на месте.
  const loadingMore = state.loading;
  el.pager.classList.toggle("is-loading", loadingMore);
  el.pgItems.innerHTML = buildPageItems(cur, total).map((it) => it === "…"
    ? `<button type="button" class="pg-btn ellipsis" disabled>…</button>`
    : `<button type="button" class="pg-btn${it === cur ? " active" : ""}" data-page="${it}" ${loadingMore ? "disabled" : ""}>${it}</button>`
  ).join("");
  el.pgPrev.disabled = loadingMore || cur <= 1;
  el.pgNext.disabled = loadingMore || (cur >= total && !state.hasMore);
  el.pagerCaption.textContent = loadingMore
    ? "Загрузка…"
    : (state.hasMore && cur >= total) ? `Страница ${cur}` : `Страница ${cur} из ${total}`;
}

el.pgItems.addEventListener("click", (e) => {
  const btn = e.target.closest(".pg-btn:not(.ellipsis)");
  if (!btn) return;
  goToPage(Number(btn.dataset.page));
});
el.pgPrev.addEventListener("click", () => goToPage(state.page - 1));
el.pgNext.addEventListener("click", () => goToPage(state.page + 1));

/* ---------- Sheet controller (общая механика bottom sheet / модалки) ---------- */
/* Переиспользуется мобильной шторкой фильтров и панелью поиска себя (F) — гарантирует
   одинаковое поведение (фокус-ловушка, backdrop, Escape, возврат фокуса), а не visual copy-paste. */

const mobileMQ = matchMedia("(max-width: 999px)");

function getFocusable(container) {
  return Array.from(container.querySelectorAll(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )).filter((node) => node.offsetParent !== null);
}

function createSheetController({ panel, backdrop, trigger, closeBtn, initialFocus, isModal = () => true }) {
  let returnFocus = null;

  function syncA11y() {
    const isOpen = panel.classList.contains("open");
    const modal = isModal();
    panel.setAttribute("aria-hidden", String(modal && !isOpen));
    if (modal && isOpen) {
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
    } else {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
    }
  }

  function open() {
    returnFocus = document.activeElement;
    panel.classList.add("open");
    if (backdrop) {
      backdrop.hidden = false;
      requestAnimationFrame(() => backdrop.classList.add("open"));
    }
    document.body.classList.add("sheet-open");
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    syncA11y();
    (initialFocus || closeBtn || panel).focus();
  }

  function close() {
    const wasOpen = panel.classList.contains("open");
    panel.classList.remove("open");
    if (backdrop) backdrop.classList.remove("open");
    document.body.classList.remove("sheet-open");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    syncA11y();
    if (backdrop) {
      setTimeout(() => {
        if (!panel.classList.contains("open")) backdrop.hidden = true;
      }, 320);
    }
    if (wasOpen && returnFocus) {
      returnFocus.focus();
      returnFocus = null;
    }
  }

  if (trigger) trigger.addEventListener("click", open);
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (backdrop) backdrop.addEventListener("click", close);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) {
      close();
      return;
    }
    if (e.key === "Tab" && isModal() && panel.classList.contains("open")) {
      const focusable = getFocusable(panel);
      if (focusable.length === 0) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  syncA11y();
  return { open, close, syncA11y };
}

/* ---------- Mobile filters sheet ---------- */

const filtersSheet = createSheetController({
  panel: el.filters,
  backdrop: el.filtersBackdrop,
  trigger: el.filtersTriggerMobile,
  closeBtn: el.filtersCloseMobile,
  isModal: () => mobileMQ.matches,
});
el.filtersApplyMobile.addEventListener("click", filtersSheet.close);
mobileMQ.addEventListener("change", filtersSheet.syncA11y);

/* ---------- Найти себя по дистанциям ---------- */
/* Ручной выбор дисциплин пользователем (не автоматический перебор всех ~26) — upstream слишком
   медленный (3–40+ сек на запрос, подтверждено живыми тестами в этой сессии), автоматический
   перебор занял бы много минут без возможности пользователя ограничить объём. */

el.personSearchDisciplines.innerHTML = DISCIPLINE_GROUPS.map((g) => `
  <div class="psd-group">
    <div class="psd-group-label">${escapeHtml(g.label)}</div>
    <div class="psd-options">
      ${g.options.map((o) => `
        <label class="psd-option" data-value="${escapeHtml(o.value)}">
          <input type="checkbox" value="${escapeHtml(o.value)}" />
          ${escapeHtml(o.label)}
        </label>`).join("")}
    </div>
  </div>`).join("");

function selectedPersonSearchDisciplines() {
  return Array.from(el.personSearchDisciplines.querySelectorAll("input:checked")).map((i) => i.value);
}

function personSearchNameNonEmpty() {
  return el.personSearchName.value.trim().length > 0;
}

function renderPersonSearchEstimate() {
  const n = selectedPersonSearchDisciplines().length;
  const nameOk = personSearchNameNonEmpty();
  el.personSearchSubmit.disabled = n === 0 || !nameOk;
  if (n === 0) {
    el.personSearchEstimate.textContent = "";
    return;
  }
  // Конкурентность 3, среднее по прошлым живым замерам этой сессии — от секунд до десятков секунд на дисциплину.
  const roundsMin = Math.ceil(n / 3);
  el.personSearchEstimate.textContent = `Отмечено: ${n} · ориентировочно ${roundsMin}–${roundsMin * 3} мин`;
}

el.personSearchDisciplines.addEventListener("change", (e) => {
  const input = e.target.closest('input[type="checkbox"]');
  if (!input) return;
  input.closest(".psd-option").classList.toggle("checked", input.checked);
  renderPersonSearchEstimate();
});
el.personSearchName.addEventListener("input", renderPersonSearchEstimate);

el.personSearchClear.addEventListener("click", () => {
  el.personSearchDisciplines.querySelectorAll("input:checked").forEach((i) => {
    i.checked = false;
    i.closest(".psd-option").classList.remove("checked");
  });
  renderPersonSearchEstimate();
});

const personSearchSheet = createSheetController({
  panel: el.personSearchPanel,
  backdrop: el.personSearchBackdrop,
  closeBtn: el.personSearchClose,
  initialFocus: el.personSearchName,
});

el.personSearchTrigger.addEventListener("click", () => {
  el.personSearchName.value = el.nameSearch.value.trim();
  renderPersonSearchEstimate();
  personSearchSheet.open();
});

let personSearch = { active: false, name: "", disciplines: [], resultsByDiscipline: {}, errors: {}, truncated: {}, doneCount: 0 };
let personSearchController = null;
let personSearchSeq = 0;

async function runPersonSearch(name, disciplines) {
  if (personSearchController) personSearchController.abort();
  personSearchController = new AbortController();
  const mySeq = ++personSearchSeq;

  personSearch = {
    active: true,
    name,
    disciplines,
    resultsByDiscipline: Object.fromEntries(disciplines.map((d) => [d, null])), // null = ещё грузится
    errors: {},
    truncated: {}, // true = дисциплина отдала PERSON_SEARCH_TAKE строк без совпадения — реальное место может быть глубже
    doneCount: 0,
  };
  showingFavorites = false;
  render();

  await mapWithConcurrency(disciplines, 3, async (alias) => {
    if (mySeq !== personSearchSeq) return;
    try {
      // Без name-фильтра upstream — иначе pos становится индексом среди
      // однофамильцев, а не реальным местом в общем рейтинге по этим фильтрам.
      const body = buildTopRequestBody({ alias, name: "", take: PERSON_SEARCH_TAKE, skip: 0 });
      const rows = await fetchJson(TOP_URL, body, personSearchController.signal);
      if (mySeq !== personSearchSeq) return;
      const list = Array.isArray(rows) ? rows : [];
      const matched = list
        .map((item, i) => ({ item, pos: i + 1 }))
        .filter(({ item }) => nameMatches(item, name));
      personSearch.resultsByDiscipline[alias] = matched.map(({ item, pos }) => renderRow(item, pos));
      personSearch.truncated[alias] = list.length >= PERSON_SEARCH_TAKE && matched.length === 0;
    } catch (err) {
      if (mySeq !== personSearchSeq) return;
      if (err.name !== "AbortError") personSearch.errors[alias] = true;
      personSearch.resultsByDiscipline[alias] = [];
    }
    if (mySeq !== personSearchSeq) return;
    personSearch.doneCount++;
    render();
  });
}

el.personSearchSubmit.addEventListener("click", () => {
  const name = el.personSearchName.value.trim();
  const disciplines = selectedPersonSearchDisciplines();
  if (!name || disciplines.length === 0) return;
  personSearchSheet.close();
  runPersonSearch(name, disciplines);
});

function exitPersonSearch() {
  personSearchSeq++; // делает все ещё летящие ответы неактуальными
  if (personSearchController) personSearchController.abort();
  personSearch = { active: false, name: "", disciplines: [], resultsByDiscipline: {}, errors: {}, truncated: {}, doneCount: 0 };
  render();
}
el.exitPersonSearch.addEventListener("click", exitPersonSearch);

function renderPersonSearchView() {
  el.exitPersonSearch.hidden = false;
  el.favoritesTrigger.hidden = true;
  el.exportCsv.hidden = true;
  el.exportListPng.hidden = false;
  el.exportListPdf.hidden = false;
  el.filters.classList.add("is-disabled");
  // pointer-events:none в CSS блокирует только мышь — inert закрывает и Tab-фокус,
  // иначе с клавиатуры можно менять фильтры «за спиной» у режима поиска по дистанциям.
  el.filters.inert = true;
  el.filtersTriggerMobile.disabled = true;

  el.loadingBar.hidden = true;
  el.skeleton.hidden = true;
  el.pager.hidden = true;
  el.statusBanner.innerHTML = "";

  const total = personSearch.disciplines.length;
  const done = personSearch.doneCount;
  const errCount = Object.keys(personSearch.errors).length;
  const truncatedCount = Object.values(personSearch.truncated).filter(Boolean).length;
  const groups = personSearch.disciplines
    .map((alias) => ({ alias, rows: personSearch.resultsByDiscipline[alias] }))
    .filter((g) => g.rows && g.rows.length > 0);
  const hasAny = groups.length > 0;

  el.emptyState.hidden = !(done >= total && !hasAny);
  if (done >= total && !hasAny) {
    el.emptyTitle.textContent = "Ничего не нашлось";
    el.emptySub.textContent = truncatedCount > 0
      ? `«${personSearch.name}» не встретился ни в одной из ${total} дисциплин (в ${truncatedCount} из них проверены только первые ${PERSON_SEARCH_TAKE} мест)`
      : `«${personSearch.name}» не встретился ни в одной из ${total} проверенных дисциплин`;
    el.emptyResetFilters.hidden = true;
  }

  el.resultsDesktop.style.display = hasAny ? "" : "none";
  el.resultsMobile.style.display = hasAny ? "" : "none";

  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);
  if (done < total) {
    el.resultCount.textContent = `Проверено ${done} из ${total} дисциплин · найдено ${totalRows}`;
  } else {
    const caveats = [
      errCount ? `${errCount} дисциплин не удалось проверить` : null,
      truncatedCount ? `в ${truncatedCount} проверены только первые ${PERSON_SEARCH_TAKE} мест` : null,
    ].filter(Boolean).join(" · ");
    el.resultCount.textContent = `Готово: найдено ${totalRows}${caveats ? ` · ${caveats}` : ""}`;
  }

  // Всегда в актуальном состоянии — звёзды «в избранное» и кнопки экспорта списка зависят от этого
  // независимо от того, нашлось что-то уже или нет.
  lastRenderedRows = hasAny ? groups.flatMap((g) => g.rows) : [];
  if (hasAny) {
    el.resultsBody.innerHTML = groups.map((g) => `
      <div class="row-group-label">${escapeHtml(disciplineLabel(g.alias))}</div>
      ${g.rows.map(renderDesktopRow).join("")}
    `).join("");
    el.resultsMobile.innerHTML = groups.map((g) => `
      <div class="result-group-label">${escapeHtml(disciplineLabel(g.alias))}</div>
      ${g.rows.map(renderMobileCard).join("")}
    `).join("");
  }
  el.exportListPng.disabled = lastRenderedRows.length === 0;
  el.exportListPdf.disabled = lastRenderedRows.length === 0;
}

/* ---------- Header height (for sticky offsets) ---------- */

function syncHeaderHeight() {
  document.documentElement.style.setProperty("--header-h", `${el.topbar.offsetHeight}px`);
}
syncHeaderHeight();
window.addEventListener("resize", debounce(syncHeaderHeight, 150));

/* ---------- Active filter count ---------- */

function pluralRu(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function activeFilterCount() {
  let n = 0;
  if (state.alias !== DEFAULT_ALIAS) n++;
  if (state.genderID) n++;
  if (state.pool) n++;
  if (state.minBirthYear !== null || state.maxBirthYear !== null) n++;
  if (state.start !== defaultStartDate() || state.end) n++;
  if (state.locations.length) n++;
  if (state.name) n++;
  if (!state.unique) n++;
  return n;
}

// Человекочитаемое описание области действия рейтинга — для карточки экспорта одного
// результата: число вроде "12 место" бессмысленно без ответа "среди кого". В отличие от
// activeFilterCount, всегда включает пол/бассейн/период (у них есть значение по умолчанию,
// а не просто "не задано"), чтобы шкала места была понятна и вне контекста приложения.
function activeFilterSummary() {
  const parts = [];
  parts.push(state.genderID === "1" ? "мужчины" : state.genderID === "2" ? "женщины" : "любой пол");
  parts.push(state.pool ? `бассейн ${state.pool} м` : "любой бассейн");
  if (state.minBirthYear !== null || state.maxBirthYear !== null) {
    parts.push(`${state.minBirthYear ?? "…"}–${state.maxBirthYear ?? "…"} г.р.`);
  }
  parts.push(`${formatIsoDate(state.start)} – ${state.end ? formatIsoDate(state.end) : "н.в."}`);
  if (state.locations.length) parts.push(state.locations.map((l) => l.label).join(", "));
  if (!state.unique) parts.push("все попытки");
  return parts.join(" · ");
}

function renderFilterBadge() {
  const n = activeFilterCount();
  [el.filterBadgeTrigger, el.filterBadgeHeading].forEach((badge) => {
    badge.hidden = n === 0;
    badge.textContent = n;
  });
}

function renderFiltersApplyLabel() {
  if (state.loading && state.results.length === 0) {
    el.filtersApplyMobile.textContent = "Загрузка…";
    return;
  }
  const n = state.results.length;
  if (n === 0) {
    el.filtersApplyMobile.textContent = "Показать результаты";
    return;
  }
  const label = state.hasMore ? `${n}+` : `${n}`;
  el.filtersApplyMobile.textContent = `Показать ${label} ${pluralRu(n, "результат", "результата", "результатов")}`;
}

el.emptyResetFilters.addEventListener("click", () => el.resetFilters.click());

/* ---------- Filter bindings ---------- */

/* Custom discipline dropdown */

const disciplineTrigger = $("discipline-trigger");
const disciplineTriggerLabel = $("discipline-trigger-label");
const disciplinePanel = $("discipline-panel");

disciplinePanel.innerHTML = DISCIPLINE_GROUPS.map((g) => `
  <div class="custom-select-group">
    <div class="custom-select-group-label">${escapeHtml(g.label)}</div>
    ${g.options.map((o) => `<button type="button" class="custom-select-option" role="option" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`).join("")}
  </div>`).join("");

function renderDisciplineTrigger() {
  disciplineTriggerLabel.textContent = disciplineLabel(state.alias);
  disciplinePanel.querySelectorAll(".custom-select-option").forEach((btn) => {
    const isActive = btn.dataset.value === state.alias;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });
}

function closeDisciplinePanel() {
  const hadFocusInside = disciplinePanel.contains(document.activeElement);
  disciplinePanel.hidden = true;
  disciplineTrigger.setAttribute("aria-expanded", "false");
  if (hadFocusInside) disciplineTrigger.focus();
}
function openDisciplinePanel() {
  disciplinePanel.hidden = false;
  disciplineTrigger.setAttribute("aria-expanded", "true");
  const active = disciplinePanel.querySelector(".custom-select-option.active") || disciplinePanel.querySelector(".custom-select-option");
  if (active) { active.scrollIntoView({ block: "nearest" }); active.focus(); }
}

disciplineTrigger.addEventListener("click", () => {
  if (disciplinePanel.hidden) openDisciplinePanel(); else closeDisciplinePanel();
});
disciplinePanel.addEventListener("click", (e) => {
  const btn = e.target.closest(".custom-select-option");
  if (!btn) return;
  state.alias = btn.dataset.value;
  renderDisciplineTrigger();
  closeDisciplinePanel();
  syncUrl();
  fetchResults({ reset: true });
});
disciplinePanel.addEventListener("keydown", (e) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const options = Array.from(disciplinePanel.querySelectorAll(".custom-select-option"));
  if (options.length === 0) return;
  e.preventDefault();
  const cur = options.indexOf(document.activeElement);
  let next;
  if (e.key === "Home") next = 0;
  else if (e.key === "End") next = options.length - 1;
  else if (e.key === "ArrowDown") next = cur < 0 ? 0 : Math.min(cur + 1, options.length - 1);
  else next = cur < 0 ? options.length - 1 : Math.max(cur - 1, 0);
  options[next].focus();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#discipline-field")) closeDisciplinePanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !disciplinePanel.hidden) closeDisciplinePanel();
});

function initSegmented(container, onChange) {
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    container.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    onChange(btn.dataset.value);
  });
}

initSegmented(el.genderSeg, (value) => {
  state.genderID = value;
  syncUrl();
  fetchResults({ reset: true });
});

initSegmented(el.poolSeg, (value) => {
  state.pool = value;
  syncUrl();
  fetchResults({ reset: true });
});

const onBirthYearChange = debounce(() => {
  let min = el.birthYearMin.value === "" ? null : Number(el.birthYearMin.value);
  let max = el.birthYearMax.value === "" ? null : Number(el.birthYearMax.value);
  if (min !== null && max !== null && min > max) [min, max] = [max, min]; // «от» не может быть больше «до» — молча меняем местами
  state.minBirthYear = min;
  state.maxBirthYear = max;
  el.birthYearMin.value = min ?? "";
  el.birthYearMax.value = max ?? "";
  syncUrl();
  fetchResults({ reset: true });
}, 450);
el.birthYearMin.addEventListener("input", onBirthYearChange);
el.birthYearMax.addEventListener("input", onBirthYearChange);

/* Custom date pickers */

function createDatePicker({ fieldId, triggerId, labelId, panelId, monthId, gridId, prevId, nextId, todayId, clearId, getValue, setValue }) {
  const trigger = $(triggerId);
  const triggerLabel = $(labelId);
  const panel = $(panelId);
  const monthLabel = $(monthId);
  const grid = $(gridId);

  let viewDate = new Date();

  function renderTrigger() {
    const v = getValue();
    triggerLabel.textContent = v ? formatIsoDate(v) : "Любая";
    triggerLabel.classList.toggle("is-placeholder", !v);
  }

  function renderPanel() {
    monthLabel.textContent = `${MONTH_LABELS_RU[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
    const todayIso = isoDate(new Date());
    const selected = getValue();
    grid.innerHTML = buildCalendarDays(viewDate.getFullYear(), viewDate.getMonth()).map((d) => {
      const cls = ["date-picker-day"];
      if (!d.inMonth) cls.push("is-outside");
      if (d.iso === todayIso) cls.push("is-today");
      if (d.iso === selected) cls.push("is-selected");
      return `<button type="button" class="${cls.join(" ")}" data-iso="${d.iso}">${d.day}</button>`;
    }).join("");
  }

  function focusCell(selector) {
    const cell = grid.querySelector(selector);
    if (cell) cell.focus();
    return !!cell;
  }

  function open() {
    const v = getValue();
    viewDate = v ? new Date(`${v}T00:00:00`) : new Date();
    renderPanel();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    focusCell(".date-picker-day.is-selected") ||
      focusCell(".date-picker-day.is-today") ||
      focusCell(".date-picker-day:not(.is-outside)");
  }
  function close() {
    const hadFocusInside = panel.contains(document.activeElement);
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (hadFocusInside) trigger.focus();
  }

  trigger.addEventListener("click", () => { if (panel.hidden) open(); else close(); });
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".date-picker-day");
    if (!btn) return;
    setValue(btn.dataset.iso);
    renderTrigger();
    close();
  });
  grid.addEventListener("keydown", (e) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const cells = Array.from(grid.querySelectorAll(".date-picker-day"));
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      cells[e.key === "Home" ? 0 : cells.length - 1].focus();
      return;
    }
    if (!(e.key in steps)) return;
    e.preventDefault();
    const cur = cells.indexOf(document.activeElement);
    const next = Math.min(cells.length - 1, Math.max(0, (cur < 0 ? 0 : cur) + steps[e.key]));
    cells[next].focus();
  });
  $(prevId).addEventListener("click", () => {
    viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
    renderPanel();
    focusCell(".date-picker-day:not(.is-outside)");
  });
  $(nextId).addEventListener("click", () => {
    viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
    renderPanel();
    focusCell(".date-picker-day:not(.is-outside)");
  });
  $(todayId).addEventListener("click", () => { setValue(isoDate(new Date())); renderTrigger(); close(); });
  $(clearId).addEventListener("click", () => { setValue(""); renderTrigger(); close(); });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(`#${fieldId}`)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  renderTrigger();
  return { renderTrigger };
}

function normalizeDateRange() {
  // «от» не может быть позже «до» — молча меняем местами (ISO-строки сравнимы лексикографически)
  if (state.start && state.end && state.start > state.end) {
    [state.start, state.end] = [state.end, state.start];
    dateStartPicker.renderTrigger();
    dateEndPicker.renderTrigger();
  }
}

const dateStartPicker = createDatePicker({
  fieldId: "date-start-field", triggerId: "date-start-trigger", labelId: "date-start-trigger-label",
  panelId: "date-start-panel", monthId: "date-start-month", gridId: "date-start-grid",
  prevId: "date-start-prev", nextId: "date-start-next", todayId: "date-start-today", clearId: "date-start-clear",
  getValue: () => state.start,
  setValue: (v) => { state.start = v; normalizeDateRange(); syncUrl(); fetchResults({ reset: true }); },
});

const dateEndPicker = createDatePicker({
  fieldId: "date-end-field", triggerId: "date-end-trigger", labelId: "date-end-trigger-label",
  panelId: "date-end-panel", monthId: "date-end-month", gridId: "date-end-grid",
  prevId: "date-end-prev", nextId: "date-end-next", todayId: "date-end-today", clearId: "date-end-clear",
  getValue: () => state.end,
  setValue: (v) => { state.end = v; normalizeDateRange(); syncUrl(); fetchResults({ reset: true }); },
});

const onNameChange = debounce(() => {
  state.name = el.nameSearch.value.trim();
  syncUrl();
  fetchResults({ reset: true });
}, 450);
el.nameSearch.addEventListener("input", onNameChange);

el.uniqueToggle.addEventListener("change", () => {
  state.unique = el.uniqueToggle.checked;
  syncUrl();
  fetchResults({ reset: true });
});

el.resetFilters.addEventListener("click", () => {
  state.alias = DEFAULT_ALIAS;
  state.genderID = "";
  state.pool = "";
  state.minBirthYear = null;
  state.maxBirthYear = null;
  state.start = defaultStartDate();
  state.end = "";
  state.name = "";
  state.locations = [];
  state.unique = true;
  applyStateToControls();
  syncUrl();
  fetchResults({ reset: true });
});

/* ---------- Territory autocomplete ---------- */

async function searchLocations(query) {
  const body = {
    take: 12, skip: 0, page: 1, pageSize: 12,
    sort: [{ field: "Name", dir: "asc" }],
    levelID: LOCATION_LEVEL_ID,
    selection: state.locations.map((l) => l.id),
    name: query,
  };
  const data = await fetchJson(LOCATIONS_URL, body);
  return (data && data.items) || [];
}

function renderTerritoryDropdown(items) {
  const selectedIds = new Set(state.locations.map((l) => l.id));
  const filtered = items.filter((i) => !selectedIds.has(i.ItemID));
  if (filtered.length === 0) {
    el.territoryDropdown.innerHTML = `<div class="territory-empty">Ничего не найдено</div>`;
    el.territoryDropdown.hidden = false;
    return;
  }
  el.territoryDropdown.innerHTML = filtered.map((item) => {
    const label = locationLabel(item);
    return `
      <button type="button" class="territory-option" data-id="${escapeHtml(item.ItemID)}" data-label="${escapeHtml(label.big)}">
        <span class="opt-big">${escapeHtml(label.big)}</span>
        ${label.small ? `<span class="opt-small">${escapeHtml(label.small)}</span>` : ""}
      </button>`;
  }).join("");
  el.territoryDropdown.hidden = false;
}

const doLocationSearch = debounce(async (query) => {
  if (!query || query.length < 2) {
    el.territoryDropdown.hidden = true;
    return;
  }
  try {
    const items = await searchLocations(query);
    renderTerritoryDropdown(items);
  } catch {
    el.territoryDropdown.hidden = true;
  }
}, 300);

el.territoryInput.addEventListener("input", (e) => doLocationSearch(e.target.value.trim()));
el.territoryInput.addEventListener("focus", (e) => {
  if (e.target.value.trim().length >= 2) doLocationSearch(e.target.value.trim());
});

el.territoryDropdown.addEventListener("click", (e) => {
  const btn = e.target.closest(".territory-option");
  if (!btn) return;
  state.locations.push({ id: btn.dataset.id, label: btn.dataset.label });
  el.territoryInput.value = "";
  el.territoryDropdown.hidden = true;
  renderTerritoryChips();
  syncUrl();
  fetchResults({ reset: true });
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#territory-control")) el.territoryDropdown.hidden = true;
});

function renderTerritoryChips() {
  el.territoryChips.innerHTML = state.locations.map((l) => `
    <span class="chip">
      ${escapeHtml(l.label)}
      <button type="button" class="chip-remove" data-id="${escapeHtml(l.id)}" aria-label="Удалить">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </span>`).join("");
}

el.territoryChips.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip-remove");
  if (!btn) return;
  state.locations = state.locations.filter((l) => l.id !== btn.dataset.id);
  renderTerritoryChips();
  syncUrl();
  fetchResults({ reset: true });
});

/* ---------- CSV export ---------- */

el.exportCsv.addEventListener("click", () => {
  if (state.results.length === 0) return;
  const header = ["№", "Фамилия", "Имя", "Год рождения", "Разряд", "Регион", "Дисциплина", "Результат", "AQUA", "Соревнование", "Место", "Дата"];
  const lines = [header.map(csvEscape).join(";")];
  state.results.forEach((item, i) => {
    const p = (item.Persons && item.Persons[0]) || {};
    lines.push([
      i + 1,
      p.LastName || "",
      p.FirstName || "",
      p.BirthYear || "",
      rankLabel(p.RankID),
      (p.City && p.City.Region) || "",
      item.Discipline || "",
      item.FormattedResult || "",
      item.Rating != null ? Math.round(item.Rating) : "",
      item.Tournament || "",
      item.Location || "",
      formatDate(item.Date),
    ].map(csvEscape).join(";"));
  });
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, "rating.csv");
});

/* ---------- Экспорт в PNG/PDF ---------- */
/* Палитра следует текущему лику (обсидиан/титан), не хардкожена — пользовательские share-экспорты
   не входят в закрытый список "вне зеркала" borozdov-style (там только фавикон/иконки/OG/QR/печать,
   references/web-implementation.md §4). Читаем живые CSS-переменные. */

function exportPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    canvas: v("--canvas"), inset: v("--inset"), zebra: v("--zebra") || v("--inset"),
    hairline: v("--hairline"), slate: v("--slate"), soft: v("--soft"), ink: v("--ink"),
  };
}

function safeFileName(s) {
  return String(s).replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "") || "export";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function hexToRgb(hex) {
  const h = String(hex).replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function truncateToWidth(measure, text, maxWidth) {
  if (measure(text) <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && measure(s + "…") > maxWidth) s = s.slice(0, -1);
  return s.length > 1 ? s + "…" : s;
}

/* ---- Карточка результата: одна спека, два рендерера (Canvas2D → PNG, jsPDF → PDF) ---- */

const CARD_FONT = {
  eyebrow: { size: 20, weight: 600, mono: false, upper: true },
  hero: { size: 84, weight: 700, mono: true },
  name: { size: 42, weight: 700, mono: false },
  meta: { size: 22, weight: 500, mono: false },
  label: { size: 16, weight: 600, mono: false, upper: true },
  statValue: { size: 30, weight: 700, mono: true },
  footer: { size: 16, weight: 500, mono: false },
};

function buildCardSpec(r) {
  const pal = exportPalette();
  const W = 1000, H = 1000, PAD = 64;
  const discText = r.disc + (r.poolTag ? ` · ${r.poolTag}` : "");
  const aquaText = r.aqua !== null && r.aqua !== undefined ? String(r.aqua) : "—";
  const posText = r.truePos !== null && r.truePos !== undefined ? String(r.truePos) : "—";
  const metaBits = [r.birthText, r.region, r.rank].filter(Boolean).join("   ·   ");
  return {
    width: W, height: H,
    blocks: [
      { type: "rect", x: 0, y: 0, w: W, h: H, fill: pal.canvas },
      { type: "text", x: PAD, y: 54, text: "РЕЙТИНГ ПЛОВЦОВ", role: "eyebrow", color: pal.slate },
      { type: "text", x: PAD, y: 84, text: discText, role: "eyebrow", color: pal.slate, maxWidth: W - PAD * 2 },
      { type: "rect", x: PAD, y: 148, w: W - PAD * 2, h: 210, radius: 16, fill: pal.ink },
      // Раньше висело в левом верхнем углу чёрного блока — центрируем по обеим осям:
      // по X через align:"center" (ширина результата непостоянна — центр считает рендерер
      // по факту измеренного текста), по Y — подобранной вручную константой (высота шрифта
      // и блока фиксированы, поэтому один и тот же отступ подходит для любого результата).
      { type: "text", x: PAD, y: 212, text: r.result || "—", role: "hero", color: pal.canvas, maxWidth: W - PAD * 2, align: "center" },
      { type: "text", x: PAD, y: 404, text: r.name || "—", role: "name", color: pal.ink, maxWidth: W - PAD * 2 },
      { type: "text", x: PAD, y: 456, text: metaBits, role: "meta", color: pal.slate, maxWidth: W - PAD * 2 },
      { type: "line", x1: PAD, y1: 522, x2: W - PAD, y2: 522, color: pal.hairline },
      { type: "text", x: PAD, y: 548, text: "AQUA", role: "label", color: pal.slate },
      { type: "text", x: PAD, y: 572, text: aquaText, role: "statValue", color: pal.soft },
      { type: "text", x: PAD + 220, y: 548, text: "ДАТА СТАРТА", role: "label", color: pal.slate },
      { type: "text", x: PAD + 220, y: 572, text: r.date || "—", role: "statValue", color: pal.soft },
      { type: "text", x: PAD + 440, y: 548, text: "МЕСТО", role: "label", color: pal.slate },
      { type: "text", x: PAD + 440, y: 572, text: posText, role: "statValue", color: pal.soft },
      { type: "text", x: PAD, y: 646, text: r.tournament || "", role: "meta", color: pal.ink, maxWidth: W - PAD * 2 },
      { type: "text", x: PAD, y: 678, text: r.location || "", role: "meta", color: pal.slate, maxWidth: W - PAD * 2 },
      { type: "text", x: PAD, y: 738, text: `Фильтры: ${r.filterSummary || activeFilterSummary()}`, role: "footer", color: pal.slate, maxWidth: W - PAD * 2 },
      { type: "line", x1: PAD, y1: H - 96, x2: W - PAD, y2: H - 96, color: pal.hairline },
      { type: "text", x: PAD, y: H - 66, text: "рейтинг-пловцов · swim-rating.borozdov.ru", role: "footer", color: pal.slate },
    ],
  };
}

/* ---- Canvas2D ---- */

function canvasFontString(role) {
  const f = CARD_FONT[role];
  return `${f.weight} ${f.size}px ${f.mono ? '"JetBrains Mono", monospace' : '"Inter", sans-serif'}`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSpecOnCanvas(ctx, spec) {
  ctx.textBaseline = "top"; // единый top-left якорь текста — тот же в jsPDF-рендерере
  for (const b of spec.blocks) {
    if (b.type === "rect") {
      ctx.fillStyle = b.fill;
      if (b.radius) { roundRectPath(ctx, b.x, b.y, b.w, b.h, b.radius); ctx.fill(); }
      else ctx.fillRect(b.x, b.y, b.w, b.h);
    } else if (b.type === "line") {
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
    } else if (b.type === "text") {
      const f = CARD_FONT[b.role];
      ctx.font = canvasFontString(b.role);
      try { ctx.letterSpacing = f.upper ? "1.5px" : "0px"; } catch { /* не везде поддержано — не критично */ }
      ctx.fillStyle = b.color;
      let text = f.upper ? String(b.text).toUpperCase() : String(b.text);
      if (b.maxWidth) text = truncateToWidth((s) => ctx.measureText(s).width, text, b.maxWidth);
      // Центрирование требует maxWidth (без него офсет — NaN и текст молча пропадает);
      // Math.max не даёт тексту вылезти левее b.x, если он даже после обрезки шире зоны.
      const x = b.align === "center" && b.maxWidth
        ? b.x + Math.max(0, (b.maxWidth - ctx.measureText(text).width) / 2)
        : b.x;
      ctx.fillText(text, x, b.y);
    }
  }
}

async function loadExportFontsForCanvas() {
  await Promise.all([
    document.fonts.load('700 84px "JetBrains Mono"'),
    document.fonts.load('500 22px "Inter"'),
    document.fonts.load('700 42px "Inter"'),
    document.fonts.load('600 20px "Inter"'),
  ]).catch(() => {}); // не удалось — рисуем системным шрифтом, экспорт всё равно не должен падать
}

async function renderCardCanvas(r) {
  await loadExportFontsForCanvas();
  const spec = buildCardSpec(r);
  const canvas = document.createElement("canvas");
  canvas.width = spec.width;
  canvas.height = spec.height;
  drawSpecOnCanvas(canvas.getContext("2d"), spec);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function downloadCardPng(r) {
  const canvas = await renderCardCanvas(r);
  const blob = await canvasToBlob(canvas);
  if (blob) downloadBlob(blob, `${safeFileName(r.name)}_${safeFileName(r.result)}.png`);
}

/* ---- jsPDF: ленивая загрузка (по первому клику, не в <head>) + кириллический шрифт ---- */

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    // Упавший тег удаляется (см. onerror ниже), так что existing здесь — либо загруженный,
    // либо ещё грузящийся; на "мёртвый" тег с уже отстрелявшим error наткнуться нельзя.
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) { resolve(); return; }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`Не удалось загрузить ${src}`)));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => { script.dataset.loaded = "1"; resolve(); };
    script.onerror = () => { script.remove(); reject(new Error(`Не удалось загрузить ${src}`)); };
    document.head.appendChild(script);
  });
}

let jsPdfLoadPromise = null;
async function loadJsPdf() {
  if (window.jspdf) return window.jspdf;
  if (!jsPdfLoadPromise) {
    jsPdfLoadPromise = loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js")
      .then(() => loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js"))
      .then(() => window.jspdf)
      .catch((err) => {
        jsPdfLoadPromise = null; // не кэшировать неудачу — иначе PDF-экспорт мёртв до перезагрузки страницы
        throw err;
      });
  }
  return jsPdfLoadPromise;
}

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

let exportFontPromise = null;
async function loadExportFontBase64() {
  if (!exportFontPromise) {
    // Встроенные шрифты jsPDF не содержат кириллицы вообще (WinAnsi) — молча превратили бы русские
    // имена в пустоту/тофу. fonts/Inter-*.ttf — кириллический сабсет Inter, скачан отдельно и лежит
    // в проекте; server.js отдаёт его уже существующей serveStatic() без каких-либо правок.
    exportFontPromise = Promise.all([
      fetch("/fonts/Inter-Regular.ttf").then((r) => { if (!r.ok) throw new Error(`шрифт: HTTP ${r.status}`); return r.arrayBuffer(); }),
      fetch("/fonts/Inter-Bold.ttf").then((r) => { if (!r.ok) throw new Error(`шрифт: HTTP ${r.status}`); return r.arrayBuffer(); }),
    ]).then(([reg, bold]) => ({ regular: arrayBufferToBase64(reg), bold: arrayBufferToBase64(bold) }))
      .catch((err) => {
        exportFontPromise = null; // не кэшировать неудачу — следующий клик попробует снова
        throw err;
      });
  }
  return exportFontPromise;
}

async function createPdfDoc(widthMM, heightMM) {
  const { jsPDF } = await loadJsPdf();
  const fonts = await loadExportFontBase64();
  const doc = new jsPDF({ unit: "mm", format: [widthMM, heightMM] });
  doc.addFileToVFS("Inter-Regular.ttf", fonts.regular);
  doc.addFont("Inter-Regular.ttf", "Inter", "normal");
  doc.addFileToVFS("Inter-Bold.ttf", fonts.bold);
  doc.addFont("Inter-Bold.ttf", "Inter", "bold");
  doc.setFont("Inter", "normal");
  return doc;
}

/* ---- Список (то, что сейчас реально на экране — lastRenderedRows) ---- */

const LIST_COLS = [
  { key: "pos", label: "№", width: 50, mono: true },
  { key: "name", label: "Спортсмен", width: 260, mono: false },
  { key: "disc", label: "Дисциплина", width: 210, mono: false },
  { key: "result", label: "Результат", width: 140, mono: true, bold: true },
  { key: "aqua", label: "AQUA", width: 90, mono: true },
  { key: "date", label: "Старт", width: 130, mono: true },
];

function listExportTitle() {
  if (personSearch.active) return `«${personSearch.name}» — поиск по дистанциям`;
  if (showingFavorites) return "Избранное";
  return disciplineLabel(state.alias);
}

function listCellText(r, col) {
  const val = col.key === "aqua" ? (r.aqua ?? "—") : (r[col.key] ?? "—");
  return String(val);
}

function renderListCanvas(rows, title) {
  const pal = exportPalette();
  const PAD = 40;
  const colsW = LIST_COLS.reduce((s, c) => s + c.width, 0);
  const W = colsW + PAD * 2;
  const rowH = 46, headH = 96, footH = 56;
  const H = headH + Math.max(rows.length, 1) * rowH + footH;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  ctx.fillStyle = pal.canvas; ctx.fillRect(0, 0, W, H);

  ctx.font = '600 22px "Inter"'; ctx.fillStyle = pal.ink;
  ctx.fillText(title, PAD, 30);

  let x = PAD;
  const colHeadY = headH - 30;
  ctx.font = '600 12px "Inter"';
  LIST_COLS.forEach((c) => {
    ctx.fillStyle = pal.slate;
    ctx.fillText(c.label.toUpperCase(), x, colHeadY);
    x += c.width;
  });
  ctx.strokeStyle = pal.hairline; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD, headH); ctx.lineTo(W - PAD, headH); ctx.stroke();

  rows.forEach((r, i) => {
    const ry = headH + i * rowH;
    if (i % 2 === 1) { ctx.fillStyle = pal.zebra; ctx.fillRect(PAD - 12, ry, colsW + 24, rowH); }
    let cx = PAD;
    LIST_COLS.forEach((c) => {
      ctx.font = `${c.bold ? 700 : 500} 14px ${c.mono ? '"JetBrains Mono", monospace' : '"Inter", sans-serif'}`;
      ctx.fillStyle = c.bold ? pal.ink : pal.soft;
      const text = truncateToWidth((s) => ctx.measureText(s).width, listCellText(r, c), c.width - 14);
      ctx.fillText(text, cx, ry + rowH / 2 - 8);
      cx += c.width;
    });
  });

  ctx.font = '500 13px "Inter"'; ctx.fillStyle = pal.slate;
  ctx.fillText("рейтинг-пловцов · swim-rating.borozdov.ru", PAD, H - footH / 2 - 7);
  return canvas;
}

async function downloadListPng() {
  const rows = lastRenderedRows;
  if (rows.length === 0) return;
  await loadExportFontsForCanvas();
  const canvas = renderListCanvas(rows, listExportTitle());
  const blob = await canvasToBlob(canvas);
  if (blob) downloadBlob(blob, `${safeFileName(listExportTitle())}.png`);
}

async function downloadListPdf() {
  const rows = lastRenderedRows;
  if (rows.length === 0) return;
  const pal = exportPalette();
  const doc = await createPdfDoc(210, 297); // A4
  doc.setFontSize(14);
  doc.setTextColor(...hexToRgb(pal.ink));
  doc.text(listExportTitle(), 12, 14);
  doc.autoTable({
    startY: 20,
    styles: { font: "Inter", fontStyle: "normal", fontSize: 9, textColor: hexToRgb(pal.ink), lineColor: hexToRgb(pal.hairline), lineWidth: 0.1 },
    headStyles: { font: "Inter", fontStyle: "bold", fillColor: hexToRgb(pal.inset), textColor: hexToRgb(pal.slate) },
    alternateRowStyles: { fillColor: hexToRgb(pal.zebra) },
    head: [LIST_COLS.map((c) => c.label)],
    body: rows.map((r) => LIST_COLS.map((c) => listCellText(r, c))),
    margin: { left: 12, right: 12 },
  });
  doc.save(`${safeFileName(listExportTitle())}.pdf`);
}

function withBusyButton(btn, task) {
  btn.addEventListener("click", () => {
    btn.disabled = true;
    task().catch((err) => console.error(err)).finally(() => { btn.disabled = lastRenderedRows.length === 0; });
  });
}
withBusyButton(el.exportListPng, downloadListPng);
withBusyButton(el.exportListPdf, downloadListPdf);

/* ---------- Theme (lik: obsidian ↔ titan — ручной выбор, закон №5) ---------- */
/* Системная тема участвует один раз, как стартовое значение — см. инлайн-скрипт
   в <head> index.html. Дальше лик меняется только кликом; живые изменения
   OS-темы интерфейс не трогают. */

const THEME_KEY = "lik";
const themeColorMeta = $("theme-color-meta");

function currentLik() {
  return document.documentElement.dataset.theme === "titan" ? "titan" : "obsidian";
}

function applyLik(lik, instant) {
  const root = document.documentElement;
  if (instant) root.classList.add("theme-switching");
  root.dataset.theme = lik;
  if (instant) {
    void root.offsetHeight; // reflow: фиксирует новые цвета при выключенных transition
    root.classList.remove("theme-switching");
  }
  themeColorMeta.content = lik === "obsidian" ? "#0d0d0d" : "#fafafa";
  const next = lik === "obsidian" ? "светлый лик" : "тёмный лик";
  el.themeToggle.title = "Переключить: " + next;
  el.themeToggle.setAttribute("aria-label", "Переключить тему: " + next);
}

function initTheme() {
  applyLik(currentLik(), false);
}
el.themeToggle.addEventListener("click", () => {
  const next = currentLik() === "obsidian" ? "titan" : "obsidian";
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  applyLik(next, true);
});

/* ---------- URL state sync ---------- */

function stateToParams() {
  const p = new URLSearchParams();
  if (state.alias && state.alias !== DEFAULT_ALIAS) p.set("alias", state.alias);
  if (state.genderID) p.set("gender", state.genderID);
  if (state.pool) p.set("pool", state.pool);
  if (state.minBirthYear !== null) p.set("byMin", state.minBirthYear);
  if (state.maxBirthYear !== null) p.set("byMax", state.maxBirthYear);
  if (state.start !== defaultStartDate()) p.set("start", state.start);
  if (state.end) p.set("end", state.end);
  if (state.name) p.set("name", state.name);
  if (state.locations.length) p.set("loc", state.locations.map((l) => `${l.id}|${l.label}`).join(","));
  if (!state.unique) p.set("all", "1");
  return p;
}

function syncUrl() {
  const qs = stateToParams().toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has("alias")) state.alias = p.get("alias");
  if (p.has("gender")) state.genderID = p.get("gender");
  if (p.has("pool")) state.pool = p.get("pool");
  if (p.has("byMin")) state.minBirthYear = Number(p.get("byMin"));
  if (p.has("byMax")) state.maxBirthYear = Number(p.get("byMax"));
  if (p.has("start")) state.start = p.get("start");
  if (p.has("end")) state.end = p.get("end");
  if (p.has("name")) state.name = p.get("name");
  if (p.has("loc")) {
    state.locations = p.get("loc").split(",").filter(Boolean).map((pair) => {
      const [id, ...rest] = pair.split("|");
      return { id, label: rest.join("|") };
    });
  }
  if (p.has("all")) state.unique = false;
}

function applyStateToControls() {
  renderDisciplineTrigger();
  el.genderSeg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.value === state.genderID));
  el.poolSeg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.value === state.pool));
  el.birthYearMin.value = state.minBirthYear ?? "";
  el.birthYearMax.value = state.maxBirthYear ?? "";
  dateStartPicker.renderTrigger();
  dateEndPicker.renderTrigger();
  el.nameSearch.value = state.name;
  el.uniqueToggle.checked = state.unique;
  renderTerritoryChips();
}

/* ---------- Init ---------- */

function init() {
  el.birthYearMin.max = el.birthYearMax.max = String(currentYear());
  initTheme();
  readStateFromUrl();
  applyStateToControls();
  fetchResults({ reset: true });
}

init();
