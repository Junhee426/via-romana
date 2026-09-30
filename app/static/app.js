/* via-romana 지도
 *
 * 책임 단위로 나눈 구역:
 *   공통 도구 → 상태 → 지도·배경 → 데이터 로딩 → 필터 → 마커 → 목록·건수
 *   → 선택·상세 → 사진·설명 → 하루 행군 → 내보내기 → 패널 → 시작
 * 지도·목록·건수·내보내기는 모두 passes()라는 하나의 필터 기준을 쓴다.
 */
(() => {
  "use strict";

  // ── 공통 도구 ────────────────────────────────
  const REMAINS_LABEL = {
    substantive: "상당 부분 남아 있음",
    restored: "복원되어 있음",
    traces: "흔적이 남아 있음",
    notvisible: "지표에서 보이지 않음",
    none: "남아 있지 않음",
    unknown: "남은 정도 정보 없음",
  };
  const VISIBLE = new Set(["substantive", "traces", "restored"]);
  const PAGE = 50;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const fmt = new Intl.NumberFormat("ko-KR");
  const year = (y) => (y < 0 ? `기원전 ${-y}년` : `${y}년`);
  const narrowMq = window.matchMedia("(max-width: 899px)");
  const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const isNarrow = () => narrowMq.matches;
  const animate = () => !reduceMq.matches;

  // 검색 정규화: 악센트 제거, 소문자, 공백 하나로. 서버 app/main.py normalize()와 같은 규칙
  const normalize = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "")
    .toLowerCase().split(/\s+/).filter(Boolean).join(" ");

  function haversineKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2
      + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
  }

  let announceTimer = 0;
  function announce(text) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { $("live").textContent = text; }, 400);
  }

  // ── 상태 ────────────────────────────────────
  const state = {
    phase: "loading",          // loading | ready | error
    meta: null,
    catByKey: {},
    sites: [],                 // { id, name, cat, ..., coordinates, text, marker, shown }
    byId: new Map(),
    sortedByName: null,
    filter: { q: "", terms: [], active: new Set(), visibleOnly: false },
    scope: "view",             // view | all | march
    shownCount: PAGE,
    selectedId: null,
    picking: false,
    march: null,               // { center, layers, status, result }
  };

  // ── 지도·배경 ────────────────────────────────
  const map = L.map("map", {
    center: [45.5, 10.5],
    zoom: 5,
    minZoom: 3,
    zoomControl: false,
    preferCanvas: true,
    worldCopyJump: true,
    zoomAnimation: animate(),
    fadeAnimation: animate(),
    markerZoomAnimation: animate(),
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const renderer = L.canvas({ padding: 0.5, tolerance: 8 });
  map.attributionControl.addAttribution('유적: <a href="https://pleiades.stoa.org">Pleiades</a>');

  // CARTO는 키 없이 요청하면 타일에 "API key required" 워터마크가 찍힌다.
  // 서버에 CARTO_API_KEY가 있으면 /api/meta를 받은 뒤 키를 붙여서 띄운다
  const CARTO_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const bases = {
    map: L.tileLayer(CARTO_URL, {
      maxZoom: 19,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }),
    sat: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
    }),
  };
  let baseKey = "map";

  // 타일이 하나도 안 뜨고 실패만 쌓이면 배경 지도 오류로 따로 알린다 (유적 데이터 오류와 구분)
  function watchTiles(layer) {
    layer._okTiles = 0;
    layer._badTiles = 0;
    layer.on("tileload", () => { layer._okTiles++; if (layer === bases[baseKey]) $("base-error").hidden = true; });
    layer.on("tileerror", () => {
      layer._badTiles++;
      if (layer === bases[baseKey] && layer._okTiles === 0 && layer._badTiles >= 4) $("base-error").hidden = false;
    });
  }
  Object.values(bases).forEach(watchTiles);

  function showBase(key) {
    baseKey = key;
    Object.entries(bases).forEach(([k, layer]) => {
      if (k === key) layer.addTo(map); else map.removeLayer(layer);
    });
    document.querySelectorAll(".basemap button").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.base === key)));
    $("base-error").hidden = true;
    if (google) updateGoogleCredit();
  }
  document.querySelectorAll(".basemap button").forEach((btn) => {
    btn.addEventListener("click", () => showBase(btn.dataset.base));
  });
  $("base-retry").addEventListener("click", () => {
    const layer = bases[baseKey];
    layer._okTiles = 0;
    layer._badTiles = 0;
    $("base-error").hidden = true;
    layer.redraw();
  });
  $("base-switch").addEventListener("click", () => showBase(baseKey === "map" ? "sat" : "map"));

  // ── Google 배경 지도 (서버에 GOOGLE_MAPS_API_KEY가 있을 때만) ──
  // Map Tiles API: 지도 유형마다 세션을 만들고, 화면 범위의 저작권 표시를 받아 띄운다
  const GTILE = "https://tile.googleapis.com";
  let google = null;   // { key, sessions: { map, sat } }
  let googleCredit = "";

  async function useGoogle(key) {
    const make = async (mapType) => {
      const res = await fetch(`${GTILE}/v1/createSession?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapType, language: "ko-KR", region: "KR" }),
      });
      if (!res.ok) throw new Error(res.status);
      return (await res.json()).session;
    };
    try {
      const [roadmap, satellite] = await Promise.all([make("roadmap"), make("satellite")]);
      google = { key, sessions: { map: roadmap, sat: satellite } };
    } catch (err) {
      console.warn("Google 지도를 쓸 수 없어 기본 지도를 씁니다.", err);
      return;
    }
    for (const k of ["map", "sat"]) {
      map.removeLayer(bases[k]);
      bases[k] = L.tileLayer(
        `${GTILE}/v1/2dtiles/{z}/{x}/{y}?session=${google.sessions[k]}&key=${encodeURIComponent(key)}`,
        { maxZoom: 21, maxNativeZoom: k === "sat" ? 20 : 21, attribution: "" },
      );
      watchTiles(bases[k]);
    }
    showBase(baseKey);
    map.on("moveend", updateGoogleCredit);
  }

  async function updateGoogleCredit() {
    const b = map.getBounds();
    const params = new URLSearchParams({
      session: google.sessions[baseKey],
      key: google.key,
      zoom: map.getZoom(),
      north: b.getNorth(), south: b.getSouth(),
      east: b.getEast(), west: b.getWest(),
    });
    let text = "Google";
    try {
      const res = await fetch(`${GTILE}/tile/v1/viewport?${params}`);
      if (res.ok) {
        const { copyright } = await res.json();
        if (copyright) text = `Google · ${copyright}`;
      }
    } catch { /* 저작권 표시는 기본값으로 */ }
    if (googleCredit) map.attributionControl.removeAttribution(googleCredit);
    googleCredit = esc(text);
    map.attributionControl.addAttribution(googleCredit);
  }

  // 지도에서 상단 바·배너·패널에 가리지 않는 영역 (컨테이너 기준 px)
  function clearArea() {
    const box = map.getContainer().getBoundingClientRect();
    let top = document.querySelector(".topbar").getBoundingClientRect().bottom + 8;
    for (const id of ["pick-banner", "base-error"]) {
      const el = $(id);
      if (!el.hidden) top = Math.max(top, el.getBoundingClientRect().bottom + 8);
    }
    const panel = $("panel").getBoundingClientRect();
    const left = isNarrow() ? 12 : panel.right + 12;
    const bottom = isNarrow() ? Math.min(box.height, panel.top) - 12 : box.height - 12;
    return { top, left, right: box.width - 12, bottom: Math.max(bottom, top + 40) };
  }

  // 선택한 곳이 가려져 있거나 너무 멀리서 보고 있으면 보이는 영역 가운데로 옮긴다
  function bringIntoView(latlng, minZoom = 12) {
    const area = clearArea();
    const zoom = Math.max(map.getZoom(), minZoom);
    const pt = map.latLngToContainerPoint(latlng);
    const inside = pt.x >= area.left && pt.x <= area.right && pt.y >= area.top && pt.y <= area.bottom;
    if (inside && zoom === map.getZoom()) return;
    centerInClearArea(latlng, zoom);
  }

  function centerInClearArea(latlng, zoom) {
    const area = clearArea();
    const size = map.getSize();
    const offset = L.point((area.left + area.right) / 2 - size.x / 2, (area.top + area.bottom) / 2 - size.y / 2);
    const center = map.unproject(map.project(latlng, zoom).subtract(offset), zoom);
    map.setView(center, zoom, { animate: animate() });
  }

  function fitPadding() {
    const a = clearArea();
    const size = map.getSize();
    return { paddingTopLeft: [a.left, a.top], paddingBottomRight: [size.x - a.right, size.y - a.bottom] };
  }

  // ── 데이터 로딩 ──────────────────────────────
  let loadCtl = null;

  function setPhase(phase, message) {
    state.phase = phase;
    document.body.dataset.phase = phase;
    const ready = phase === "ready";
    document.querySelectorAll("[data-needs-data]").forEach((el) => { el.disabled = !ready; });
    $("load-error").hidden = phase !== "error";
    if (phase === "loading") $("count-line").textContent = "유적을 불러오는 중…";
    if (phase === "error") {
      $("count-line").textContent = "유적 데이터를 불러오지 못했어요";
      $("count-sub").textContent = "";
      $("load-error-msg").textContent = message;
    }
  }

  const getJson = async (url, signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  async function load() {
    loadCtl?.abort();
    const ctl = new AbortController();
    loadCtl = ctl;
    setPhase("loading");
    const sitesReq = getJson("/api/sites", ctl.signal);
    sitesReq.catch(() => {});   // 실패는 아래 await에서 처리
    try {
      const meta = state.meta || await getJson("/api/meta", ctl.signal);
      if (!state.meta) applyMeta(meta);
      const sites = await sitesReq;
      if (ctl !== loadCtl) return;
      applySites(sites.features);
      setPhase("ready");
      refresh({ announceCount: false });
    } catch (err) {
      if (ctl !== loadCtl || err.name === "AbortError") return;
      // 배경 지도는 유적 데이터와 따로 띄운다
      if (!map.hasLayer(bases[baseKey])) showBase(baseKey);
      setPhase("error", navigator.onLine === false
        ? "인터넷 연결이 끊긴 것 같아요. 연결을 확인한 뒤 다시 시도해 주세요."
        : "서버에서 유적 데이터를 받지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    }
  }
  $("retry").addEventListener("click", load);

  // meta는 한 번만 적용한다 (재시도 때 칩·버튼이 겹치지 않게)
  function applyMeta(meta) {
    state.meta = meta;
    state.catByKey = Object.fromEntries(meta.categories.map((c) => [c.key, c]));
    state.filter.active = new Set(meta.categories.map((c) => c.key));
    // 배경 지도는 키 여부를 안 뒤에 띄워서 워터마크 타일을 먼저 받지 않게 한다
    if (meta.carto_key) bases.map.setUrl(`${CARTO_URL}?key=${encodeURIComponent(meta.carto_key)}`, true);
    showBase(baseKey);
    if (meta.google_maps_key) useGoogle(meta.google_maps_key);
    $("march-lede").textContent =
      `로마 군단은 하루 20 로마마일(약 ${meta.day_march_km}km)을 걸었어요. 출발점을 정하면 그 반경 안의 유적을 가까운 순으로 보여 드려요.`;
    buildChips();
    buildRegions();
  }

  // 유적은 한 번만 만든다. 이미 있으면(재시도 경쟁 등) 건너뛴다
  function applySites(features) {
    if (state.sites.length) return;
    for (const f of features) {
      const p = f.properties;
      const site = {
        ...p,
        ko: p.ko || [],
        coordinates: f.geometry.coordinates,
        text: normalize([p.name, p.desc || "", ...(p.ko || [])].join(" ")),
        nameText: normalize([p.name, ...(p.ko || [])].join(" ")),
        marker: null,
        shown: false,
      };
      state.sites.push(site);
      state.byId.set(site.id, site);
    }
    buildMarkers();
  }

  // ── 필터 (지도·목록·건수·내보내기 공통) ─────────
  function passes(s) {
    const f = state.filter;
    if (!f.active.has(s.cat)) return false;
    if (f.visibleOnly && !VISIBLE.has(s.remains)) return false;
    for (const t of f.terms) if (!s.text.includes(t)) return false;
    return true;
  }
  const allCatsOn = () => state.filter.active.size === state.meta.categories.length;
  const noCats = () => state.filter.active.size === 0;

  // 서버 API용 파라미터. 분류가 하나도 없을 때는 호출하지 않는다(cat 생략 = 전체이므로)
  function filterParams() {
    const params = new URLSearchParams();
    if (!allCatsOn()) params.set("cat", [...state.filter.active].join(","));
    if (state.filter.visibleOnly) params.set("visible", "true");
    if (state.filter.q.trim()) params.set("q", state.filter.q.trim());
    return params;
  }

  function filterSummary() {
    const total = state.meta.categories.length;
    const on = state.filter.active.size;
    const cats = on === total ? "모든 분류" : on === 0 ? "분류 모두 꺼짐" : `분류 ${on}/${total}`;
    return state.filter.visibleOnly ? `${cats} · 남아 있는 곳만` : cats;
  }

  function buildChips() {
    const box = $("chips");
    box.innerHTML = "";
    for (const c of state.meta.categories) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.cat = c.key;
      btn.style.setProperty("--c", c.color);
      btn.setAttribute("aria-pressed", "true");
      btn.innerHTML = `<span class="swatch"></span>${esc(c.label)} <span class="n">${fmt.format(c.count)}</span>`;
      btn.addEventListener("click", () => {
        const a = state.filter.active;
        if (a.has(c.key)) a.delete(c.key); else a.add(c.key);
        filtersChanged();
      });
      box.appendChild(btn);
    }
  }

  function setAll(on) {
    state.filter.active = new Set(on ? state.meta.categories.map((c) => c.key) : []);
    filtersChanged();
  }
  $("all-on").addEventListener("click", () => setAll(true));
  $("all-off").addEventListener("click", () => setAll(false));
  $("visible-only").addEventListener("change", (e) => {
    state.filter.visibleOnly = e.target.checked;
    filtersChanged();
  });

  // 필터나 검색어가 바뀌면: 지도는 움직이지 않고 마커·목록·건수만 갱신, 행군 반경은 다시 조회
  function filtersChanged() {
    document.querySelectorAll(".chip").forEach((b) =>
      b.setAttribute("aria-pressed", String(state.filter.active.has(b.dataset.cat))));
    $("visible-only").checked = state.filter.visibleOnly;
    state.shownCount = PAGE;
    if (state.march) runMarch(state.march.center, { fit: false });
    refresh();
  }

  // 검색: 입력 150ms 뒤에 적용. 처음 검색하면 목록 범위를 '전체'로 바꾼다
  let searchTimer = 0;
  $("search").addEventListener("input", () => {
    $("search-clear").hidden = !$("search").value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 150);
  });
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(searchTimer);
    applySearch();
    if (isNarrow()) {
      $("search").blur();
      setPanel("list", { focus: false });
    }
    showResultsTop();
  });

  // 목록 머리가 패널 맨 위에 오게 (검색 제출·지역 선택 뒤 결과가 바로 보이도록)
  function showResultsTop() {
    const main = $("panel-main");
    const head = document.querySelector(".results");
    main.scrollTo({ top: head.offsetTop - main.offsetTop, behavior: animate() ? "smooth" : "auto" });
  }
  $("search-clear").addEventListener("click", () => {
    $("search").value = "";
    $("search-clear").hidden = true;
    applySearch();
    $("search").focus();
  });

  function applySearch() {
    const q = $("search").value;
    const had = state.filter.terms.length > 0;
    state.filter.q = q;
    state.filter.terms = normalize(q).split(" ").filter(Boolean);
    const has = state.filter.terms.length > 0;
    if (has && !had && state.scope === "view") state.scope = "all";
    if (!has && had && state.scope === "all") state.scope = "view";
    if (has && isNarrow() && $("panel").dataset.state === "peek") setPanel("list");
    filtersChanged();
  }

  // ── 마커 ────────────────────────────────────
  const markerLayer = L.layerGroup().addTo(map);
  let markerRadius = 0;
  const radiusForZoom = (z) => (z < 6 ? 3 : z < 9 ? 4.5 : 6.5);

  function buildMarkers() {
    markerRadius = radiusForZoom(map.getZoom());
    for (const s of state.sites) {
      const [lon, lat] = s.coordinates;
      s.marker = L.circleMarker([lat, lon], {
        renderer,
        radius: markerRadius,
        color: "#ffffff",
        weight: 1,
        fillColor: state.catByKey[s.cat].color,
        fillOpacity: VISIBLE.has(s.remains) ? 0.95 : 0.45,
      });
      // 출발점 고르기 중에는 점을 눌러도 그 자리를 출발점으로 쓴다
      s.marker.on("click", (e) => {
        if (state.picking) pickAt(e.latlng);
        else selectSite(s.id, { from: "map" });
      });
    }
  }

  // 바뀐 마커만 더하고 뺀다 (전부 지웠다 다시 넣지 않음)
  function syncMarkers() {
    for (const s of state.sites) {
      const want = passes(s);
      if (want === s.shown) continue;
      if (want) markerLayer.addLayer(s.marker); else markerLayer.removeLayer(s.marker);
      s.shown = want;
    }
  }

  // 반지름 구간이 바뀔 때만 모든 마커를 고친다
  map.on("zoomend", () => {
    const r = radiusForZoom(map.getZoom());
    if (r === markerRadius) return;
    markerRadius = r;
    for (const s of state.sites) s.marker?.setRadius(r);
    if (selRing) selRing.setRadius(r + 5);
  });

  let selRing = null;
  function highlight(site) {
    if (selRing) map.removeLayer(selRing);
    selRing = null;
    if (!site) return;
    const [lon, lat] = site.coordinates;
    selRing = L.circleMarker([lat, lon], {
      renderer, radius: markerRadius + 5, color: "#26282C", weight: 3, fill: false, interactive: false,
    }).addTo(map);
  }

  // ── 목록·건수 ────────────────────────────────
  function sortedByName() {
    if (!state.sortedByName) {
      const coll = new Intl.Collator("en", { sensitivity: "base" });
      state.sortedByName = [...state.sites].sort((a, b) => coll.compare(a.name, b.name));
    }
    return state.sortedByName;
  }

  // 검색 결과 순서: 이름·별칭이 검색어로 시작 → 이름·별칭의 단어가 검색어로 시작
  //   → 이름·별칭 어딘가에 포함 → 설명에만 포함
  function rank(s) {
    const terms = state.filter.terms;
    const q = terms.join(" ");
    if (s.nameText.startsWith(q) || s.ko.some((k) => normalize(k).startsWith(q))) return 0;
    const words = s.nameText.split(" ");
    if (terms.every((t) => words.some((w) => w.startsWith(t)))) return 1;
    if (terms.every((t) => s.nameText.includes(t))) return 2;
    return 3;
  }

  function viewBoundsIntersectData() {
    const [w, so, e, n] = state.meta.extent;
    return map.getBounds().intersects(L.latLngBounds([so, w], [n, e]));
  }

  // 현재 필터와 지도 범위로 건수와 목록 후보를 한 번에 계산
  function compute() {
    const bounds = map.getBounds();
    const matched = [];
    const inView = [];
    for (const s of state.sites) {
      if (!passes(s)) continue;
      matched.push(s);
      const [lon, lat] = s.coordinates;
      if (bounds.contains([lat, lon])) inView.push(s);
    }
    return { matched, inView };
  }

  let last = { matched: [], inView: [] };

  function refresh({ announceCount = true } = {}) {
    if (state.phase !== "ready") return;
    syncMarkers();
    last = compute();
    renderCounts();
    renderList();
    renderExportScope();
    $("filter-summary").textContent = filterSummary();
    if (announceCount) announce(`조건에 맞는 유적 ${fmt.format(last.matched.length)}곳, 지금 지도 범위 ${fmt.format(last.inView.length)}곳`);
  }
  map.on("moveend", () => {
    if (state.phase !== "ready") return;
    last = compute();
    renderCounts();
    if (state.scope === "view") { state.shownCount = PAGE; renderList(); }
    renderExportScope();
  });

  function renderCounts() {
    if (state.phase !== "ready") return;
    const m = state.march;
    $("count-line").textContent =
      `조건 일치 ${fmt.format(last.matched.length)}곳 · 지금 지도 범위 ${fmt.format(last.inView.length)}곳`;
    let sub = "";
    if (state.picking) sub = "출발점을 고르는 중";
    else if (m?.status === "ready") sub = `행군 반경 안 ${fmt.format(m.result.count)}곳`;
    else if (m?.status === "loading") sub = "행군 반경 조회 중…";
    else if (isNarrow() && $("panel").dataset.state === "peek") sub = "눌러서 목록 보기";
    $("count-sub").textContent = sub;
  }

  function setScope(scope) {
    state.scope = scope;
    state.shownCount = PAGE;
    renderList();
  }
  document.querySelectorAll(".scope button").forEach((b) =>
    b.addEventListener("click", () => setScope(b.dataset.scope)));

  // 현재 범위의 목록 항목: [{ site, distance? }]
  function listItems() {
    if (state.scope === "march") {
      const m = state.march;
      if (!m || m.status !== "ready") return [];
      return m.result.sites
        .map((r) => ({ site: state.byId.get(r.id), distance: r.distance_km }))
        .filter((x) => x.site);
    }
    if (state.scope === "all") {
      if (!state.filter.terms.length) {
        const set = new Set(last.matched);
        return sortedByName().filter((s) => set.has(s)).map((site) => ({ site }));
      }
      return last.matched
        .map((site) => ({ site, r: rank(site) }))
        .sort((a, b) => a.r - b.r || a.site.name.localeCompare(b.site.name, "en"))
        .map(({ site }) => ({ site }));
    }
    // 지금 지도 범위: 지도 가운데에 가까운 순 (거리는 표시하지 않음)
    const c = map.getCenter();
    return last.inView
      .map((site) => ({ site, d: (site.coordinates[1] - c.lat) ** 2 + (site.coordinates[0] - c.lng) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .map(({ site }) => ({ site }));
  }

  function renderList() {
    if (state.phase !== "ready") return;
    const hasMarch = !!state.march;
    if (!hasMarch && state.scope === "march") state.scope = "view";
    document.querySelectorAll(".scope button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.scope === state.scope));
      if (b.dataset.scope === "march") b.hidden = !hasMarch;
    });

    const items = listItems();
    const list = $("results");
    const q = state.filter.q.trim();
    const scopeLabel = { view: "지금 지도 범위", all: "전체 데이터", march: "행군 반경" }[state.scope];
    const summary = $("results-summary");
    if (state.scope === "march" && state.march?.status !== "ready") {
      summary.textContent = state.march?.status === "error"
        ? "행군 반경을 불러오지 못했어요. 위 ‘하루 행군’에서 다시 시도해 주세요."
        : "행군 반경 안의 유적을 찾는 중…";
    } else {
      const extra = state.scope === "march" && state.march.result.count > items.length
        ? ` (가까운 ${fmt.format(items.length)}곳까지 표시)` : "";
      summary.textContent = `${scopeLabel}${q ? `에서 ‘${q}’ 검색` : ""} · ${fmt.format(state.scope === "march" ? state.march.result.count : items.length)}곳${extra}`;
    }

    const visible = items.slice(0, state.shownCount);
    const mile = state.meta.roman_mile_km;
    list.innerHTML = visible.map(({ site: s, distance }) => {
      const cat = state.catByKey[s.cat];
      const ko = s.ko.length ? `<span class="ko">${esc(s.ko[0])}</span>` : "";
      const dist = distance == null ? ""
        : `<span class="dist">출발점에서 ${distance.toFixed(1)}km<br>(${(distance / mile).toFixed(1)} 로마마일)</span>`;
      return `<li><button type="button" class="site-row" data-id="${esc(s.id)}"${s.id === state.selectedId ? ' aria-current="true"' : ""} style="--c:${cat.color}">
        <span class="swatch" aria-hidden="true"></span>
        <span class="row-main"><span class="name">${esc(s.name)}</span>${ko}
          <span class="row-meta">${esc(cat.label)} · ${esc(REMAINS_LABEL[s.remains] || REMAINS_LABEL.unknown)}</span></span>
        ${dist}
      </button></li>`;
    }).join("");

    const more = $("results-more");
    const rest = items.length - visible.length;
    more.hidden = rest <= 0;
    more.textContent = `더 보기 (${fmt.format(rest)}곳 남음)`;
    renderEmpty(items.length);
  }

  $("results").addEventListener("click", (e) => {
    const btn = e.target.closest(".site-row");
    if (btn) selectSite(btn.dataset.id, { from: "list" });
  });
  $("results-more").addEventListener("click", () => {
    const before = state.shownCount;
    state.shownCount += PAGE;
    renderList();
    // 새로 나타난 첫 항목으로 포커스를 옮겨 키보드 사용자가 이어서 볼 수 있게
    $("results").querySelectorAll(".site-row")[before]?.focus();
  });

  // 비어 있는 이유를 구분하고 되돌릴 수 있는 동작을 준다
  function renderEmpty(count) {
    const box = $("results-empty");
    if (count > 0 || (state.scope === "march" && state.march?.status !== "ready")) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    const q = state.filter.q.trim();
    let html;
    if (noCats()) {
      html = `<p>모든 분류가 꺼져 있어요.</p><button type="button" class="btn" data-fix="cats-on">모든 분류 켜기</button>`;
    } else if (last.matched.length === 0) {
      html = `<p>${q ? `‘${esc(q)}’에 맞는 유적이 없어요.` : "조건에 맞는 유적이 없어요."} 이름은 원래 표기(라틴어·현지어)나 일부 한국어 이름으로 찾을 수 있어요.</p>`
        + (q ? `<button type="button" class="btn" data-fix="clear-q">검색어 지우기</button>` : "")
        + (state.filter.visibleOnly ? `<button type="button" class="btn" data-fix="visible-off">남아 있는 곳만 보기 끄기</button>` : "")
        + (!allCatsOn() ? `<button type="button" class="btn" data-fix="cats-on">모든 분류 켜기</button>` : "");
    } else if (state.scope === "march") {
      html = `<p>행군 반경 안에는 조건에 맞는 유적이 없어요. 조건에 맞는 유적은 전체 ${fmt.format(last.matched.length)}곳이에요.</p>`
        + `<button type="button" class="btn" data-fix="pick">다른 출발점 고르기</button><button type="button" class="btn" data-fix="scope-all">전체 목록 보기</button>`;
    } else if (!viewBoundsIntersectData()) {
      html = `<p>지금 지도는 이 서비스의 데이터 범위(유럽의 로마 유적) 밖이에요.</p>`
        + `<button type="button" class="btn" data-fix="fit-data">유럽 전체 보기</button><button type="button" class="btn" data-fix="scope-all">전체 목록 보기</button>`;
    } else {
      html = `<p>지금 지도 범위에는 조건에 맞는 유적이 없어요. 전체에는 ${fmt.format(last.matched.length)}곳이 있어요.</p>`
        + `<button type="button" class="btn" data-fix="scope-all">전체 목록 보기</button><button type="button" class="btn" data-fix="zoom-out">지도 축소</button>`;
    }
    box.innerHTML = html;
    box.hidden = false;
  }

  $("results-empty").addEventListener("click", (e) => {
    const fix = e.target.closest("[data-fix]")?.dataset.fix;
    if (!fix) return;
    if (fix === "cats-on") setAll(true);
    if (fix === "clear-q") $("search-clear").click();
    if (fix === "visible-off") { state.filter.visibleOnly = false; filtersChanged(); }
    if (fix === "scope-all") setScope("all");
    if (fix === "zoom-out") map.setZoom(Math.max(map.getZoom() - 2, map.getMinZoom()), { animate: animate() });
    if (fix === "fit-data") fitData();
    if (fix === "pick") startPicking();
  });

  function fitData() {
    const [w, s, e, n] = state.meta.extent;
    map.fitBounds([[s, w], [n, e]], { ...fitPadding(), animate: animate() });
  }

  // 시작 지역: 실제 데이터와 대응을 확인한 곳만 (data/curated.json)
  function buildRegions() {
    const regions = state.meta.regions || [];
    $("regions-row").hidden = regions.length === 0;
    $("regions").innerHTML = regions.map((r) =>
      `<button type="button" class="region" data-region="${esc(r.key)}">${esc(r.label)}</button>`).join("");
  }
  $("regions").addEventListener("click", (e) => {
    const key = e.target.closest("[data-region]")?.dataset.region;
    const r = state.meta?.regions.find((x) => x.key === key);
    if (!r) return;
    state.scope = "view";
    state.shownCount = PAGE;
    // 패널을 먼저 연 뒤, 가려지지 않는 영역 가운데에 그 지역이 오도록 옮긴다
    if (isNarrow()) setPanel("list", { focus: false });
    centerInClearArea(L.latLng(r.center), r.zoom);
    renderList();
    showResultsTop();
  });

  // ── 선택·상세 ────────────────────────────────
  let listScroll = 0;

  function selectSite(id, { from } = {}) {
    const site = state.byId.get(id);
    if (!site) return;
    if (state.picking) stopPicking();
    if ($("panel").dataset.state !== "detail") listScroll = $("panel-main").scrollTop;
    state.selectedId = id;
    highlight(site);
    $("results").querySelectorAll(".site-row").forEach((b) => {
      if (b.dataset.id === id) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    });
    renderDetail(site);
    setPanel("detail", { focus: from !== "map" });
    const [lon, lat] = site.coordinates;
    // 지도에서 누른 경우는 이미 보이는 자리이므로 필요할 때만, 목록에서 고른 경우는 확대해서 보여 준다
    bringIntoView(L.latLng(lat, lon), from === "map" ? map.getZoom() : 12);
  }

  function backToList() {
    setPanel("list", { focus: false });
    $("panel-main").scrollTop = listScroll;
    const btn = $("results").querySelector(`.site-row[data-id="${CSS.escape(state.selectedId || "")}"]`);
    (btn || $("results-title")).focus({ preventScroll: true });
  }
  $("detail-back").addEventListener("click", backToList);

  function renderDetail(s) {
    const cat = state.catByKey[s.cat];
    const period = s.from == null ? "연대 미상" : `${year(s.from)} ~ ${year(s.to)}`;
    const [lon, lat] = s.coordinates;
    $("detail").innerHTML = `
      <div class="d-photo" id="d-photo"></div>
      <h2 class="d-name" id="detail-name" tabindex="-1">${esc(s.name)}</h2>
      <p class="d-label" id="d-label">${esc(s.ko.join(" · "))}</p>
      <span class="pop-cat" style="--c:${cat.color}"><span class="swatch"></span>${esc(cat.label)}</span>
      <dl class="pop-facts">
        <dt>시기</dt><dd>${period}</dd>
        <dt>유적</dt><dd>${esc(REMAINS_LABEL[s.remains] || REMAINS_LABEL.unknown)}</dd>
        ${s.certain ? "" : "<dt>위치</dt><dd>추정 위치</dd>"}
      </dl>
      <p class="d-note">‘남아 있음’은 유적의 보존 상태예요. 개방 시간·입장 가능 여부는 방문 전에 따로 확인해 주세요.</p>
      <div class="d-actions">
        <button type="button" class="btn primary" id="d-explore">이곳 주변 탐색</button>
        <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}" target="_blank" rel="noopener">구글맵</a>
        <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" rel="noopener">길찾기</a>
      </div>
      <section class="d-about" id="d-about" aria-label="설명"></section>
      ${s.desc ? `<p class="d-desc"><span class="d-desc-label">Pleiades 설명</span> <span lang="en">${esc(s.desc)}</span></p>` : ""}
      <p class="d-links"><a href="https://pleiades.stoa.org/places/${encodeURIComponent(s.id)}" target="_blank" rel="noopener">Pleiades에서 보기</a></p>`;
    $("d-explore").addEventListener("click", () => exploreAround(s));
    renderPhoto(s);
    renderAbout(s);
    if (s.wd) {
      settle(loadPart("photo", s.wd), () => { if (state.selectedId === s.id) renderPhoto(s); });
      settle(loadPart("about", s.wd), () => { if (state.selectedId === s.id) renderAbout(s); });
    }
  }

  function exploreAround(s) {
    const [lon, lat] = s.coordinates;
    state.scope = "march";
    setPanel("list", { focus: false });
    runMarch([lat, lon], { fit: true });
    showResultsTop();
    $("results-title").focus({ preventScroll: true });
  }

  // ── 사진·설명 (Wikidata → 위키백과·위키미디어 공용) ──
  // 유적에 Wikidata ID(wd)가 있으면 상세를 연 뒤에 불러온다. 모두 키 없이 쓰는 공개 API.
  // 사진과 설명은 따로 성공·실패하고, 일시적인 실패는 캐시에 '자료 없음'으로 남기지 않는다.
  // 사진은 그 Wikidata 항목의 대표 사진(P18)만 쓴다 (문서 썸네일 등 다른 대상의 사진을 쓰지 않음)
  const WD_API = "https://www.wikidata.org/w/api.php?format=json&origin=*";
  const parts = { entity: new Map(), photo: new Map(), about: new Map() };   // wd → { status, data, promise }
  const imgBroken = new Set();   // 파일 자체를 못 받은 사진 주소

  const stripTags = (html) => {
    const div = document.createElement("div");
    div.innerHTML = html || "";
    return div.textContent.trim();
  };
  class Missing extends Error {}
  const settle = (promise, fn) => promise.then(fn, fn);   // 자료가 원래 없음 (다시 시도해도 같음)

  const fetchers = {
    async entity(wd) {
      const d = await getJson(`${WD_API}&action=wbgetentities&ids=${wd}&props=sitelinks|labels&languages=ko&sitefilter=kowiki|enwiki`);
      return d.entities?.[wd] || {};
    },
    async photo(wd) {
      const claims = await getJson(`${WD_API}&action=wbgetclaims&entity=${wd}&property=P18`);
      const file = claims.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (!file) throw new Missing();
      const d = await getJson("https://commons.wikimedia.org/w/api.php?format=json&origin=*&action=query&prop=imageinfo"
        + `&iiprop=url|extmetadata&iiurlwidth=640&iiextmetadatafilter=Artist|LicenseShortName&titles=${encodeURIComponent("File:" + file)}`);
      const info = Object.values(d.query?.pages || {})[0]?.imageinfo?.[0];
      if (!info?.thumburl) throw new Missing();
      const meta = info.extmetadata || {};
      const credit = [stripTags(meta.Artist?.value), meta.LicenseShortName?.value].filter(Boolean).join(", ");
      return { src: info.thumburl, href: info.descriptionurl, credit: credit || "Wikimedia Commons" };
    },
    async about(wd) {
      const item = await loadPart("entity", wd);
      const link = item.sitelinks?.kowiki || item.sitelinks?.enwiki;
      if (!link) throw new Missing();
      const lang = item.sitelinks?.kowiki ? "ko" : "en";
      const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(link.title)}`);
      if (res.status === 404) throw new Missing();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const summary = await res.json();
      if (!summary.extract) throw new Missing();
      return { text: summary.extract, lang, href: summary.content_urls?.desktop?.page, label: item.labels?.ko?.value };
    },
  };

  // 같은 항목은 한 번만 요청한다. 실패(error)는 retry 때 새로 요청한다
  function loadPart(kind, wd, { retry = false } = {}) {
    const cache = parts[kind];
    let entry = cache.get(wd);
    if (entry && !(retry && entry.status === "error")) return entry.promise;
    entry = { status: "loading", data: null, promise: null };
    cache.set(wd, entry);
    entry.promise = fetchers[kind](wd).then(
      (data) => { entry.status = "ok"; entry.data = data; return data; },
      (err) => {
        entry.status = err instanceof Missing ? "none" : "error";
        if (entry.status === "error" && kind === "entity") cache.delete(wd);   // 설명 재시도 때 다시 받게
        throw err;
      },
    );
    entry.promise.catch(() => {});
    return entry.promise;
  }

  function renderPhoto(s) {
    const box = $("d-photo");
    if (!box) return;
    if (!s.wd) {
      box.className = "d-photo empty";
      box.innerHTML = `<p>이 유적에는 연결된 사진 자료가 없어요.</p>`;
      return;
    }
    const e = parts.photo.get(s.wd);
    if (!e || e.status === "loading") {
      box.className = "d-photo loading";
      box.innerHTML = `<p>사진을 불러오는 중…</p>`;
    } else if (e.status === "ok" && !imgBroken.has(e.data.src)) {
      box.className = "d-photo";
      box.innerHTML = `<img src="${esc(e.data.src)}" alt="${esc(s.name)} 사진">
        <p class="credit"><a href="${esc(e.data.href)}" target="_blank" rel="noopener">사진: ${esc(e.data.credit)}</a></p>`;
      box.querySelector("img").addEventListener("error", () => {
        imgBroken.add(e.data.src);
        if (state.selectedId === s.id) renderPhoto(s);
      }, { once: true });
    } else if (e.status === "none") {
      box.className = "d-photo empty";
      box.innerHTML = `<p>이 유적의 위키데이터 항목에는 대표 사진이 없어요.</p>`;
    } else {
      box.className = "d-photo error";
      box.innerHTML = `<p>사진을 불러오지 못했어요.</p><button type="button" class="btn" id="photo-retry">사진 다시 시도</button>`;
      $("photo-retry").addEventListener("click", () => {
        if (e.status === "ok") imgBroken.delete(e.data.src);
        else settle(loadPart("photo", s.wd, { retry: true }), () => { if (state.selectedId === s.id) renderPhoto(s); });
        renderPhoto(s);
      });
    }
  }

  function renderAbout(s) {
    const box = $("d-about");
    if (!box) return;
    if (!s.wd) {
      box.innerHTML = `<p class="muted">위키백과와 연결된 정보가 없어요.</p>`;
      return;
    }
    const e = parts.about.get(s.wd);
    if (!e || e.status === "loading") {
      box.innerHTML = `<p class="muted">설명을 불러오는 중…</p>`;
    } else if (e.status === "ok") {
      const d = e.data;
      if (d.label && !s.ko.includes(d.label) && d.label !== s.name) {
        $("d-label").textContent = [...s.ko, d.label].join(" · ");
      }
      box.innerHTML = `<p class="d-about-text" lang="${d.lang}">${esc(d.text)}</p>
        <p class="d-source"><a href="${esc(d.href)}" target="_blank" rel="noopener">${d.lang === "ko" ? "위키백과" : "영어 위키백과"}에서 더 읽기</a></p>`;
    } else if (e.status === "none") {
      box.innerHTML = `<p class="muted">위키백과 요약이 없어요.</p>`;
    } else {
      box.innerHTML = `<p class="muted">설명을 불러오지 못했어요.</p><button type="button" class="btn" id="about-retry">설명 다시 시도</button>`;
      $("about-retry").addEventListener("click", () => {
        settle(loadPart("about", s.wd, { retry: true }), () => { if (state.selectedId === s.id) renderAbout(s); });
        renderAbout(s);
      });
    }
  }

  // ── 하루 행군 ────────────────────────────────
  // 요청마다 세대 번호를 올리고, 성공·실패·마무리 모두 최신 세대일 때만 화면을 바꾼다
  let marchGen = 0;
  let marchCtl = null;
  let locateGen = 0;

  function cancelMarchRequest() {
    marchGen++;
    marchCtl?.abort();
    marchCtl = null;
  }

  function drawMarch(center, km) {
    if (state.march) state.march.layers.forEach((l) => map.removeLayer(l));
    const ring = L.circle(center, {
      radius: km * 1000, color: "#26282C", weight: 2, dashArray: "6 6",
      fill: true, fillColor: "#26282C", fillOpacity: 0.04, interactive: false,
    }).addTo(map);
    const stone = L.circleMarker(center, {
      radius: 6, color: "#F1F2EF", weight: 2, fillColor: "#26282C", fillOpacity: 1, interactive: false,
    }).addTo(map);
    stone.bindTooltip(`XX MP (${km}km)`, {
      permanent: true, direction: "top", offset: [0, -8], className: "milestone-label",
    });
    return [ring, stone];
  }

  async function runMarch(center, { fit = true } = {}) {
    cancelMarchRequest();
    locateGen++;
    const gen = marchGen;
    const km = state.meta.day_march_km;
    const layers = drawMarch(center, km);
    state.march = { center, layers, status: "loading", result: null };
    if (fit) map.fitBounds(layers[0].getBounds(), { ...fitPadding(), animate: animate() });
    renderMarch();

    if (noCats()) {
      state.march.status = "ready";
      state.march.result = { count: 0, sites: [] };
      renderMarch();
      return;
    }
    const params = filterParams();
    params.set("lat", center[0]);
    params.set("lon", center[1]);
    params.set("km", km);
    params.set("limit", 500);
    const ctl = new AbortController();
    marchCtl = ctl;
    try {
      const res = await fetch(`/api/near?${params}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (gen !== marchGen) return;
      state.march.status = "ready";
      state.march.result = data;
      announce(`하루 행군 반경 안 유적 ${fmt.format(data.count)}곳`);
    } catch (err) {
      if (gen !== marchGen || err.name === "AbortError") return;
      state.march.status = "error";
    } finally {
      if (gen === marchGen) {
        marchCtl = null;
        renderMarch();
      }
    }
  }

  function clearMarch() {
    cancelMarchRequest();
    locateGen++;
    if (state.march) state.march.layers.forEach((l) => map.removeLayer(l));
    state.march = null;
    if (state.scope === "march") state.scope = "view";
    setMarchStatus("");
    renderMarch();
  }
  $("march-clear").addEventListener("click", clearMarch);

  function setMarchStatus(html) { $("march-status").innerHTML = html; }

  function renderMarch() {
    const m = state.march;
    $("march-clear").hidden = !m;
    $("march-pick").textContent = m ? "다른 출발점 고르기" : "지도에서 출발점 고르기";
    const km = state.meta.day_march_km;
    if (m?.status === "loading") setMarchStatus(`반경 ${km}km 안의 유적을 찾는 중…`);
    if (m?.status === "error") {
      setMarchStatus(`반경 안의 유적을 불러오지 못했어요. <button type="button" class="btn" id="march-retry">다시 시도</button>`);
      $("march-retry").addEventListener("click", () => runMarch(m.center, { fit: false }));
    }
    if (m?.status === "ready") {
      setMarchStatus(noCats()
        ? "모든 분류가 꺼져 있어 반경 안에서 보여 줄 유적이 없어요."
        : `반경 ${km}km(20 로마마일) 안에 조건에 맞는 유적 ${fmt.format(m.result.count)}곳`);
    }
    if (state.phase === "ready") {
      last = compute();
      renderCounts();
      renderList();
      renderExportScope();
    }
  }

  function startPicking() {
    if (state.phase !== "ready") return;
    locateGen++;
    state.picking = true;
    document.body.classList.add("picking");
    $("pick-banner").hidden = false;
    setMarchStatus("지도에서 출발할 곳을 누르거나, 지도를 옮긴 뒤 ‘지도 중심에서 출발’을 누르세요.");
    if (isNarrow()) setPanel("peek", { focus: false });
    renderCounts();
    $("pick-cancel").focus();
  }

  function stopPicking({ restoreFocus = false } = {}) {
    if (!state.picking) return;
    state.picking = false;
    document.body.classList.remove("picking");
    $("pick-banner").hidden = true;
    if (!state.march) setMarchStatus("");
    renderCounts();
    if (restoreFocus) $("march-pick").focus({ preventScroll: true });
  }

  function pickAt(latlng) {
    stopPicking();
    state.scope = "march";
    runMarch([latlng.lat, latlng.lng], { fit: true });
  }

  $("march-pick").addEventListener("click", () => (state.picking ? stopPicking() : startPicking()));
  $("pick-cancel").addEventListener("click", () => stopPicking({ restoreFocus: !isNarrow() }));
  $("pick-center").addEventListener("click", () => {
    const a = clearArea();
    pickAt(map.containerPointToLatLng([(a.left + a.right) / 2, (a.top + a.bottom) / 2]));
  });
  map.on("click", (e) => { if (state.picking) pickAt(e.latlng); });

  // 현재 위치가 데이터 범위 밖이면 행군 대신 시작 지역·수동 선택을 권한다.
  // (그곳에 로마 유적이 없다는 뜻이 아니라, 이 지도의 데이터가 없다는 뜻)
  function nearestSiteKm(lat, lon) {
    let best = Infinity;
    for (const s of state.sites) {
      const d = haversineKm(lat, lon, s.coordinates[1], s.coordinates[0]);
      if (d < best) best = d;
    }
    return best;
  }

  $("march-here").addEventListener("click", () => {
    stopPicking();
    const outside = "지도에서 출발점을 고르거나 위의 시작 지역을 골라 주세요.";
    if (!navigator.geolocation) {
      setMarchStatus(`이 브라우저에서는 위치를 확인할 수 없어요. ${outside}`);
      return;
    }
    const gen = ++locateGen;
    setMarchStatus("현재 위치를 확인하는 중…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (gen !== locateGen) return;
        const { latitude: lat, longitude: lon } = pos.coords;
        const [w, s, e, n] = state.meta.extent;
        const inExtent = lon >= w && lon <= e && lat >= s && lat <= n;
        if (!inExtent || nearestSiteKm(lat, lon) > 150) {
          setMarchStatus(`현재 위치는 이 지도의 데이터 범위(유럽의 로마 유적) 밖이에요. ${outside}`);
          $("regions-row").classList.add("attention");
          return;
        }
        state.scope = "march";
        runMarch([lat, lon], { fit: true });
      },
      (err) => {
        if (gen !== locateGen) return;
        const msg = err.code === 1
          ? `위치 권한이 거부되어 현재 위치를 쓸 수 없어요. 브라우저 설정에서 허용하거나, ${outside}`
          : err.code === 3
            ? `위치 확인 시간이 초과됐어요. <button type="button" class="btn" id="locate-retry">다시 시도</button> 또는 ${outside}`
            : `현재 위치를 확인하지 못했어요. ${outside}`;
        setMarchStatus(msg);
        $("locate-retry")?.addEventListener("click", () => $("march-here").click());
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  });

  // ── 내보내기 (Google 내 지도용 KML) ────────────
  // 범위: 행군 반경이 있으면 그 안, 없으면 지금 지도 범위. 검색어·분류·유적 상태 필터는 항상 적용
  let exporting = false;

  function exportTarget() {
    const m = state.march;
    if (m) {
      return {
        kind: "march",
        label: `행군 반경 ${state.meta.day_march_km}km 안`,
        count: m.status === "ready" ? m.result.count : null,
      };
    }
    return { kind: "view", label: "지금 지도 범위", count: last.inView.length };
  }

  function renderExportScope() {
    if (state.phase !== "ready") return;
    const t = exportTarget();
    const q = state.filter.q.trim();
    const filters = [q ? `검색어 ‘${q}’` : null, filterSummary()].filter(Boolean).join(", ");
    $("export-scope").textContent =
      `내보낼 범위: ${t.label} · ${filters} 적용 · ${t.count == null ? "조회 중" : `${fmt.format(t.count)}곳`}`;
  }

  function setExportStatus(html) { $("export-status").innerHTML = html; }
  const exportRetry = ' <button type="button" class="btn" data-export-retry>다시 시도</button>';

  $("export-kml").addEventListener("click", exportKml);
  $("export-status").addEventListener("click", (e) => { if (e.target.closest("[data-export-retry]")) exportKml(); });

  async function exportKml() {
    if (exporting || state.phase !== "ready") return;
    const t = exportTarget();
    const max = state.meta.kml_max;
    if (noCats()) return setExportStatus("모든 분류가 꺼져 있어 내보낼 유적이 없어요. 분류를 하나 이상 켜 주세요.");
    if (t.count == null) return setExportStatus("행군 반경을 조회하는 중이에요. 끝난 뒤 다시 눌러 주세요.");
    if (t.count === 0) return setExportStatus(`${t.label}에는 조건에 맞는 유적이 없어요. 지도를 옮기거나 필터를 바꿔 보세요.`);
    if (t.count > max) {
      return setExportStatus(`${t.label}에 유적이 ${fmt.format(t.count)}곳이에요. Google 내 지도는 한 번에 ${fmt.format(max)}곳까지라 지도를 더 확대하거나 필터를 줄여 주세요.`);
    }
    const params = filterParams();
    if (t.kind === "march") {
      params.set("lat", state.march.center[0]);
      params.set("lon", state.march.center[1]);
      params.set("km", state.meta.day_march_km);
    } else {
      const b = map.getBounds();
      params.set("bbox", [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(","));
    }

    exporting = true;
    const btn = $("export-kml");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    setExportStatus("KML 파일을 만드는 중…");
    try {
      let res;
      try {
        res = await fetch(`/api/export.kml?${params}`);
      } catch {
        return setExportStatus(`네트워크 오류로 내보내지 못했어요. 연결을 확인해 주세요.${exportRetry}`);
      }
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !type.includes("kml")) {
        let detail = "";
        try { detail = (await res.json()).detail || ""; } catch { /* JSON이 아닌 오류 */ }
        const reason = res.status === 404 ? "조건에 맞는 유적이 없어요."
          : res.status === 400 && detail ? `${detail}.`
            : `서버 오류(${res.status})로 내보내지 못했어요.`;
        return setExportStatus(`${esc(reason)}${res.status >= 500 || res.ok ? exportRetry : ""}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "via-romana.kml";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setExportStatus(`${esc(t.label)}의 ${fmt.format(t.count)}곳을 담은 KML 다운로드를 시작했어요. <a href="https://www.google.com/maps/d/" target="_blank" rel="noopener">Google 내 지도</a>에서 새 지도 → 가져오기로 올리세요.`);
    } catch {
      setExportStatus(`파일을 받는 중 오류가 났어요.${exportRetry}`);
    } finally {
      exporting = false;
      btn.disabled = state.phase !== "ready";
      btn.removeAttribute("aria-busy");
    }
  }

  // ── 패널 (모바일은 아래 시트: 요약 peek / 목록 list / 상세 detail) ──
  function setPanel(s, { focus = true } = {}) {
    const panel = $("panel");
    panel.dataset.state = s;
    $("panel-handle").setAttribute("aria-expanded", String(s !== "peek"));
    $("view-list").hidden = s === "detail";
    $("view-detail").hidden = s !== "detail";
    if (s === "detail" && focus) $("detail-name")?.focus({ preventScroll: true });
    if (s === "detail") $("panel-main").scrollTop = 0;
    renderCounts();
  }

  $("panel-handle").addEventListener("click", () => {
    const s = $("panel").dataset.state;
    if (!isNarrow()) return;
    if (s !== "peek") setPanel("peek");
    else setPanel(state.selectedId && $("view-list").hidden ? "detail" : "list", { focus: false });
  });

  // 상단 바 실제 높이(검색창 줄 포함, safe-area 반영)를 배너·패널 위치에 쓴다
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--topbar-h", `${document.querySelector(".topbar").offsetHeight}px`);
  }).observe(document.querySelector(".topbar"));

  // 시트 실제 높이만큼 지도 컨트롤·출처 표기를 띄운다
  new ResizeObserver(() => {
    const h = isNarrow() ? $("panel").offsetHeight : 0;
    document.documentElement.style.setProperty("--sheet-h", `${h}px`);
  }).observe($("panel"));
  narrowMq.addEventListener("change", () => {
    if (!isNarrow() && $("panel").dataset.state === "peek") setPanel("list", { focus: false });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.picking) { stopPicking({ restoreFocus: true }); return; }
    const s = $("panel").dataset.state;
    if (s === "detail") backToList();
    else if (s === "list" && isNarrow() && document.activeElement !== $("search")) setPanel("peek");
  });

  // ── 시작 ────────────────────────────────────
  // 자동 테스트가 지도 위치와 내부 상태를 확인할 때 쓰는 읽기용 핸들
  window.viaRomanaDebug = {
    map,
    state,
    markerLayer,
    markerCount: () => markerLayer.getLayers().length,
    marchLayerCount: () => (state.march ? state.march.layers.filter((l) => map.hasLayer(l)).length : 0),
  };
  setPanel(isNarrow() ? "peek" : "list", { focus: false });
  load();
})();
