/* via-romana 지도 */
(() => {
  "use strict";

  const REMAINS_LABEL = {
    substantive: "상당 부분 남아 있음",
    restored: "복원되어 있음",
    traces: "흔적이 남아 있음",
    notvisible: "지표에서 보이지 않음",
    none: "남아 있지 않음",
    unknown: "정보 없음",
  };
  const VISIBLE = new Set(["substantive", "traces", "restored"]);

  const state = {
    meta: null,
    catByKey: {},
    active: new Set(),
    visibleOnly: false,
    picking: false,
    markers: [],        // { marker, props }
    markerById: {},
    march: null,        // { center: [lat, lon], layers: [] }
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const fmt = new Intl.NumberFormat("ko-KR");
  const year = (y) => (y < 0 ? `기원전 ${-y}년` : `${y}년`);

  // ── 지도 ────────────────────────────────────
  const map = L.map("map", {
    center: [45.5, 10.5],
    zoom: 5,
    minZoom: 3,
    zoomControl: false,
    preferCanvas: true,
    worldCopyJump: true,
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const renderer = L.canvas({ padding: 0.5, tolerance: 8 });

  const bases = {
    map: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
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
  bases.map.addTo(map);
  map.attributionControl.addAttribution('유적: <a href="https://pleiades.stoa.org">Pleiades</a>');

  function showBase(key) {
    baseKey = key;
    Object.entries(bases).forEach(([k, layer]) => {
      if (k === key) layer.addTo(map); else map.removeLayer(layer);
    });
    document.querySelectorAll(".basemap button").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.base === key)));
    if (google) updateGoogleCredit();
  }
  document.querySelectorAll(".basemap button").forEach((btn) => {
    btn.addEventListener("click", () => showBase(btn.dataset.base));
  });

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

  const markerLayer = L.layerGroup().addTo(map);

  function radiusForZoom(z) {
    if (z < 6) return 3;
    if (z < 9) return 4.5;
    return 6.5;
  }

  // ── 사진·설명 (Wikidata → 위키백과·위키미디어 공용) ──
  // 유적에 Wikidata ID(wd)가 있으면 팝업을 연 뒤에 불러온다. 모두 키 없이 쓰는 공개 API
  const wikiCache = new Map();   // wd → { photo, about } (실패하면 null)

  const getJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    return res.json();
  };
  const stripTags = (html) => {
    const div = document.createElement("div");
    div.innerHTML = html || "";
    return div.textContent.trim();
  };

  async function loadWiki(wd) {
    const api = "https://www.wikidata.org/w/api.php?format=json&origin=*";
    const [entity, claims] = await Promise.all([
      getJson(`${api}&action=wbgetentities&ids=${wd}&props=sitelinks|labels&languages=ko&sitefilter=kowiki|enwiki`),
      getJson(`${api}&action=wbgetclaims&entity=${wd}&property=P18`),
    ]);
    const item = entity.entities?.[wd] || {};
    const link = item.sitelinks?.kowiki || item.sitelinks?.enwiki;
    const lang = item.sitelinks?.kowiki ? "ko" : "en";
    const file = claims.claims?.P18?.[0]?.mainsnak?.datavalue?.value;

    const [summary, image] = await Promise.all([
      link
        ? getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(link.title)}`).catch(() => null)
        : null,
      file
        ? getJson("https://commons.wikimedia.org/w/api.php?format=json&origin=*&action=query&prop=imageinfo"
            + `&iiprop=url|extmetadata&iiurlwidth=640&iiextmetadatafilter=Artist|LicenseShortName&titles=${encodeURIComponent("File:" + file)}`)
            .then((d) => Object.values(d.query?.pages || {})[0]?.imageinfo?.[0]).catch(() => null)
        : null,
    ]);

    let photo = null;
    if (image?.thumburl) {
      const meta = image.extmetadata || {};
      const credit = [stripTags(meta.Artist?.value), meta.LicenseShortName?.value].filter(Boolean).join(", ");
      photo = { src: image.thumburl, href: image.descriptionurl, credit: credit || "Wikimedia Commons" };
    } else if (summary?.thumbnail?.source) {
      photo = { src: summary.thumbnail.source, href: summary.content_urls?.desktop?.page, credit: "위키백과" };
    }
    const about = summary?.extract
      ? { text: summary.extract, lang, href: summary.content_urls?.desktop?.page }
      : null;
    return { label: item.labels?.ko?.value, photo, about };
  }

  // ── 팝업 ────────────────────────────────────
  function popupHtml(p, wiki) {
    const cat = state.catByKey[p.cat];
    const period = p.from == null ? "연대 미상" : `${year(p.from)} ~ ${year(p.to)}`;
    const remains = REMAINS_LABEL[p.remains];
    const [lon, lat] = p.coordinates;
    const loading = p.wd && wiki === undefined;
    const photo = wiki?.photo;
    const about = wiki?.about;
    const label = wiki?.label && wiki.label !== p.name ? wiki.label : "";
    return `
      ${loading ? '<div class="pop-photo pop-loading" aria-hidden="true"></div>' : ""}
      ${photo ? `
        <figure class="pop-photo">
          <img src="${esc(photo.src)}" alt="${esc(p.name)}">
          <figcaption><a href="${esc(photo.href)}" target="_blank" rel="noopener">사진: ${esc(photo.credit)}</a></figcaption>
        </figure>` : ""}
      <p class="pop-name">${esc(p.name)}</p>
      ${label ? `<p class="pop-label">${esc(label)}</p>` : ""}
      <span class="pop-cat" style="--c:${cat.color}"><span class="swatch"></span>${esc(cat.label)}</span>
      <dl class="pop-facts">
        <dt>시기</dt><dd>${period}</dd>
        ${remains ? `<dt>유적</dt><dd>${remains}</dd>` : ""}
        ${p.certain ? "" : "<dt>위치</dt><dd>추정 위치</dd>"}
      </dl>
      ${about ? `
        <p class="pop-about" lang="${about.lang}">${esc(about.text)}</p>
        <p class="pop-source"><a href="${esc(about.href)}" target="_blank" rel="noopener">${about.lang === "ko" ? "위키백과" : "영어 위키백과"}에서 더 읽기</a></p>`
        : loading ? '<p class="pop-desc">사진과 설명을 불러오는 중…</p>'
        : p.desc ? `<p class="pop-desc" lang="en">${esc(p.desc)}</p>` : ""}
      <div class="pop-links">
        <a href="https://pleiades.stoa.org/places/${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Pleiades에서 보기</a>
        <a href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}" target="_blank" rel="noopener">구글맵에서 보기</a>
        <a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" rel="noopener">길찾기</a>
      </div>`;
  }

  // ── 마커 ────────────────────────────────────
  function buildMarkers(features) {
    const r = radiusForZoom(map.getZoom());
    for (const f of features) {
      const p = { ...f.properties, coordinates: f.geometry.coordinates };
      const color = state.catByKey[p.cat].color;
      const strong = VISIBLE.has(p.remains);
      const [lon, lat] = p.coordinates;
      const marker = L.circleMarker([lat, lon], {
        renderer,
        radius: r,
        color: "#ffffff",
        weight: 1,
        fillColor: color,
        fillOpacity: strong ? 0.95 : 0.45,
      });
      // 출발점 고르기 중에는 점을 눌러도 그 자리를 출발점으로 쓴다
      marker.on("click", (e) => {
        if (state.picking) pickAt(e.latlng);
        else openSite(p);
      });
      state.markers.push({ marker, props: p });
      state.markerById[p.id] = { marker, props: p };
    }
  }

  const popup = L.popup({ maxWidth: 300 });
  let popupSite = null;
  // 사진 칸은 높이가 고정이라 사진이 늦게 떠도 팝업 크기는 그대로다
  const showPopup = (p) => popup.setContent(popupHtml(p, wikiCache.get(p.wd)));
  function openSite(p) {
    const [lon, lat] = p.coordinates;
    popupSite = p;
    // 상단 바와 패널(모바일은 아래 시트)에 가리지 않게 여백을 두고 지도를 옮긴다
    const narrow = window.matchMedia("(max-width: 899px)").matches;
    popup.options.autoPanPaddingTopLeft = L.point(narrow ? 12 : 390, 72);
    popup.options.autoPanPaddingBottomRight = L.point(12, narrow ? $("panel").offsetHeight + 12 : 12);
    popup.setLatLng([lat, lon]);
    popup.openOn(map);
    showPopup(p);
    if (p.wd && !wikiCache.has(p.wd)) {
      loadWiki(p.wd)
        .catch(() => null)
        .then((wiki) => {
          wikiCache.set(p.wd, wiki);
          // 그사이 다른 유적을 열었거나 팝업을 닫았으면 그대로 둔다
          if (popupSite === p && popup.isOpen()) showPopup(p);
        });
    }
  }

  function passes(p) {
    return state.active.has(p.cat) && (!state.visibleOnly || VISIBLE.has(p.remains));
  }

  function render() {
    markerLayer.clearLayers();
    let n = 0;
    for (const { marker, props } of state.markers) {
      if (passes(props)) { markerLayer.addLayer(marker); n++; }
    }
    $("count-line").textContent = `지도에 유적 ${fmt.format(n)}곳`;
    if (state.march) runMarch(state.march.center, { keepView: true });
  }

  map.on("zoomend", () => {
    const r = radiusForZoom(map.getZoom());
    for (const { marker } of state.markers) marker.setRadius(r);
  });

  // ── 분류 필터 ────────────────────────────────
  function buildChips() {
    const box = $("chips");
    box.innerHTML = "";
    for (const c of state.meta.categories) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.style.setProperty("--c", c.color);
      btn.setAttribute("aria-pressed", "true");
      btn.innerHTML = `<span class="swatch"></span>${esc(c.label)} <span class="n">${fmt.format(c.count)}</span>`;
      btn.addEventListener("click", () => {
        if (state.active.has(c.key)) state.active.delete(c.key); else state.active.add(c.key);
        btn.setAttribute("aria-pressed", String(state.active.has(c.key)));
        render();
      });
      box.appendChild(btn);
    }
  }

  function setAll(on) {
    state.active = new Set(on ? state.meta.categories.map((c) => c.key) : []);
    document.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", String(on)));
    render();
  }
  $("all-on").addEventListener("click", () => setAll(true));
  $("all-off").addEventListener("click", () => setAll(false));
  $("visible-only").addEventListener("change", (e) => {
    state.visibleOnly = e.target.checked;
    render();
  });

  // ── 하루 행군 ────────────────────────────────
  function clearMarch() {
    if (state.march) state.march.layers.forEach((l) => map.removeLayer(l));
    state.march = null;
    $("near-list").innerHTML = "";
    $("march-status").textContent = "";
    $("march-line").hidden = true;
    $("march-actions").innerHTML = `
      <button type="button" class="btn primary" id="march-pick">지도에서 출발점 고르기</button>
      <button type="button" class="btn" id="march-here">내 위치에서 출발</button>`;
    bindMarchButtons();
  }

  function setPicking(on) {
    state.picking = on;
    document.body.classList.toggle("picking", on);
    const pick = $("march-pick");
    if (pick) pick.textContent = on ? "고르기 취소" : "지도에서 출발점 고르기";
    $("march-status").textContent = on ? "지도에서 출발할 곳을 누르세요." : "";
    if (on) setPanel("peek");
  }

  function bindMarchButtons() {
    $("march-pick")?.addEventListener("click", () => setPicking(!state.picking));
    $("march-here")?.addEventListener("click", () => {
      if (!navigator.geolocation) {
        $("march-status").textContent = "이 브라우저에서는 위치를 확인할 수 없어요. 지도에서 출발점을 골라 주세요.";
        return;
      }
      $("march-status").textContent = "현재 위치를 확인하는 중…";
      navigator.geolocation.getCurrentPosition(
        (pos) => runMarch([pos.coords.latitude, pos.coords.longitude]),
        () => { $("march-status").textContent = "위치 권한이 없어 확인하지 못했어요. 지도에서 출발점을 골라 주세요."; },
        { enableHighAccuracy: false, timeout: 10000 },
      );
    });
  }

  function pickAt(latlng) {
    setPicking(false);
    runMarch([latlng.lat, latlng.lng]);
  }
  map.on("click", (e) => { if (state.picking) pickAt(e.latlng); });

  async function runMarch(center, { keepView = false } = {}) {
    const [lat, lon] = center;
    const km = state.meta.day_march_km;
    const params = new URLSearchParams({ lat, lon, km, limit: 60 });
    if (state.active.size !== state.meta.categories.length) {
      params.set("cat", [...state.active].join(","));
    }
    if (state.visibleOnly) params.set("visible", "true");

    if (state.march) state.march.layers.forEach((l) => map.removeLayer(l));
    const ring = L.circle(center, {
      radius: km * 1000,
      color: "#26282C",
      weight: 2,
      dashArray: "6 6",
      fill: true,
      fillColor: "#26282C",
      fillOpacity: 0.04,
      interactive: false,
    }).addTo(map);
    const stone = L.circleMarker(center, {
      radius: 6, color: "#F1F2EF", weight: 2, fillColor: "#26282C", fillOpacity: 1, interactive: false,
    }).addTo(map);
    stone.bindTooltip(`XX MP (${km}km)`, {
      permanent: true, direction: "top", offset: [0, -8], className: "milestone-label",
    });
    state.march = { center, layers: [ring, stone] };
    if (!keepView) {
      const narrow = window.matchMedia("(max-width: 899px)").matches;
      map.fitBounds(ring.getBounds(), narrow
        ? { paddingTopLeft: [20, 80], paddingBottomRight: [20, 110] }
        : { paddingTopLeft: [390, 40], paddingBottomRight: [40, 40] });
    }

    if (state.active.size === 0) {
      renderNear({ count: 0, sites: [] });
      return;
    }
    $("march-status").textContent = "반경 안의 유적을 찾는 중…";
    try {
      const res = await fetch(`/api/near?${params}`);
      if (!res.ok) throw new Error(res.status);
      renderNear(await res.json());
    } catch {
      $("march-status").textContent = "유적을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.";
    }
  }

  function renderNear(data) {
    const km = state.meta.day_march_km;
    const mile = state.meta.roman_mile_km;
    $("march-status").textContent = data.count
      ? `하루 걸음(${km}km) 안에 유적 ${fmt.format(data.count)}곳${data.count > data.sites.length ? `, 가까운 ${data.sites.length}곳을 보여 드려요` : ""}.`
      : `하루 걸음(${km}km) 안에는 조건에 맞는 유적이 없어요. 분류를 더 켜거나 다른 곳을 골라 보세요.`;

    const line = $("march-line");
    line.hidden = false;
    line.textContent = data.count
      ? `하루 행군 반경 안에 ${fmt.format(data.count)}곳, 눌러서 목록 보기`
      : "하루 행군 반경 안에 조건에 맞는 유적 없음";

    const list = $("near-list");
    list.innerHTML = "";
    for (const s of data.sites) {
      const cat = state.catByKey[s.cat];
      const li = document.createElement("li");
      li.innerHTML = `
        <button type="button" style="--c:${cat.color}">
          <span class="swatch"></span>
          <span class="name">${esc(s.name)}</span>
          <span class="dist">${s.distance_km.toFixed(1)}km (${(s.distance_km / mile).toFixed(1)} 로마마일)</span>
        </button>`;
      li.querySelector("button").addEventListener("click", () => {
        const site = state.markerById[s.id];
        if (!site) return;
        map.flyTo(site.marker.getLatLng(), Math.max(map.getZoom(), 12), { duration: 0.6 });
        map.once("moveend", () => openSite(site.props));
        if (window.matchMedia("(max-width: 899px)").matches) setPanel("peek");
      });
      list.appendChild(li);
    }

    $("march-actions").innerHTML = `
      <button type="button" class="btn" id="march-pick">다른 출발점 고르기</button>
      <button type="button" class="btn" id="march-clear">반경 지우기</button>`;
    bindMarchButtons();
    $("march-clear").addEventListener("click", clearMarch);
  }

  // ── Google 내 지도(My Maps)로 내보내기 ──────────
  // 행군 반경이 있으면 그 안의 유적, 없으면 지금 화면에 보이는 유적을 KML로 받는다
  $("export-kml").addEventListener("click", () => {
    const status = $("export-status");
    if (state.active.size === 0) {
      status.textContent = "켜진 분류가 없어요. 분류를 하나 이상 켜 주세요.";
      return;
    }
    const params = new URLSearchParams();
    if (state.active.size !== state.meta.categories.length) {
      params.set("cat", [...state.active].join(","));
    }
    if (state.visibleOnly) params.set("visible", "true");
    if (state.march) {
      const [lat, lon] = state.march.center;
      params.set("lat", lat);
      params.set("lon", lon);
      params.set("km", state.meta.day_march_km);
    } else {
      const b = map.getBounds();
      const n = state.markers.filter(({ marker, props }) =>
        passes(props) && b.contains(marker.getLatLng())).length;
      if (n === 0) {
        status.textContent = "지금 화면에 유적이 없어요.";
        return;
      }
      if (n > state.meta.kml_max) {
        status.textContent = `화면에 유적이 ${fmt.format(n)}곳이에요. 내 지도는 한 번에 ${fmt.format(state.meta.kml_max)}곳까지라 지도를 더 확대해 주세요.`;
        return;
      }
      params.set("bbox", [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(","));
    }
    status.innerHTML = 'KML 파일을 받았어요. <a href="https://www.google.com/maps/d/" target="_blank" rel="noopener">Google 내 지도</a>에서 새 지도 → 가져오기로 올리세요.';
    window.location.href = `/api/export.kml?${params}`;
  });

  // ── 아래 시트(모바일) ─────────────────────────
  function setPanel(s) {
    $("panel").dataset.state = s;
    $("panel-handle").setAttribute("aria-expanded", String(s === "open"));
  }
  // 접힌 시트 높이만큼 지도 컨트롤을 띄운다
  new ResizeObserver(() => {
    const panel = $("panel");
    if (panel.dataset.state === "peek") {
      document.documentElement.style.setProperty("--sheet-h", `${panel.offsetHeight}px`);
    }
  }).observe($("panel"));
  $("panel-handle").addEventListener("click", () => {
    setPanel($("panel").dataset.state === "open" ? "peek" : "open");
  });

  // ── 시작 ────────────────────────────────────
  async function init() {
    try {
      const [meta, sites] = await Promise.all([
        fetch("/api/meta").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch("/api/sites").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      ]);
      state.meta = meta;
      state.catByKey = Object.fromEntries(meta.categories.map((c) => [c.key, c]));
      state.active = new Set(meta.categories.map((c) => c.key));
      $("march-lede").textContent =
        `로마 군단은 하루 20 로마마일(약 ${meta.day_march_km}km)을 걸었어요. 출발점을 정하면 그 안의 유적을 가까운 순으로 보여 드려요.`;
      if (meta.google_maps_key) useGoogle(meta.google_maps_key);
      buildChips();
      buildMarkers(sites.features);
      bindMarchButtons();
      render();
    } catch {
      $("count-line").textContent = "유적 데이터를 불러오지 못했어요. 새로고침해 주세요.";
    }
  }
  init();
})();
