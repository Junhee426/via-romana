// via-romana 브라우저 회귀 테스트
//
//   cd tests && npm install && npm run e2e
//
// - 로컬 uvicorn을 띄우고 Chromium으로 연다 (VIA_PYTHON으로 파이썬 경로 지정 가능)
// - Leaflet은 tests/node_modules에서, 지도 타일·글꼴·위키 API는 모두 가짜 응답으로 대체한다
//   → 외부 서비스 장애와 상관없이 같은 결과가 나온다
// - 스크린샷: tests/e2e/screenshots/
// - 특정 테스트만: npm run e2e -- 검색어
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { iconReport, MAX_IOU } from "./icons.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SHOTS = join(HERE, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const LEAFLET_JS = readFileSync(require.resolve("leaflet/dist/leaflet.js"));
const LEAFLET_CSS = readFileSync(require.resolve("leaflet/dist/leaflet.css"));
// 지도 타일 대신 쓰는 옅은 양피지 격자 (캡처가 실제 배경 톤과 비슷하게 보이도록)
const TILE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#f3f1ec"/><path d="M0 128h256M128 0v256" stroke="#e2ded5"/></svg>');
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAE/wH+5dXYhwAAAABJRU5ErkJggg==", "base64");
const META = JSON.parse(readFileSync(join(ROOT, "data", "processed", "meta.json"), "utf8"));
const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = {
  desktop: { width: 1366, height: 768 },
  wide: { width: 1920, height: 1080 },
  mobile: { width: 390, height: 844 },
  small: { width: 360, height: 800 },
};

// ── 서버 ────────────────────────────────────
async function startServer() {
  // 경로로 준 VIA_PYTHON은 지금 폴더(tests/) 기준으로 푼다. 서버는 저장소 루트에서 띄우기 때문
  const env = process.env.VIA_PYTHON;
  const py = env ? (/[\\/]/.test(env) ? resolve(env) : env) : "python3";
  const proc = spawn(py, ["-m", "uvicorn", "app.main:app", "--port", String(PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return proc; } catch { /* 아직 */ }
    await sleep(250);
  }
  proc.kill();
  throw new Error(`서버가 뜨지 않았습니다:\n${log}`);
}

// ── 가짜 위키 응답 ───────────────────────────
// opts.wiki: { photoFail, aboutFail, imageFail: 남은 실패 횟수, delay: { [wd]: ms }, noPhoto: Set<wd> }
function wikiHandler(opts) {
  const w = { photoFail: 0, aboutFail: 0, imageFail: 0, delay: {}, noPhoto: new Set(), calls: [], ...opts };
  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body),
  });
  const handler = async (route) => {
    const u = new URL(route.request().url());
    const action = u.searchParams.get("action");
    const wd = u.searchParams.get("ids") || u.searchParams.get("entity") || (u.pathname.match(/summary\/(Q\d+)/) || [])[1]
      || (u.searchParams.get("titles") || "").match(/Q\d+/)?.[0] || (u.pathname.match(/Q\d+/) || [])[0];
    w.calls.push(`${u.host}:${action || u.pathname.split("/").slice(0, 4).join("/")}:${wd}`);
    if (w.delay[wd]) await sleep(w.delay[wd]);
    if (u.host === "www.wikidata.org" && action === "wbgetentities") {
      const labels = wd === "Q10285" ? { ko: { language: "ko", value: "콜로세움" } } : {};
      const sitelinks = wd === "Q10285" ? { kowiki: { title: "콜로세움" } } : { enwiki: { title: wd } };
      return json(route, { entities: { [wd]: { id: wd, labels, sitelinks } } });
    }
    if (u.host === "www.wikidata.org" && action === "wbgetclaims") {
      if (w.noPhoto.has(wd)) return json(route, { claims: {} });
      if (w.photoFail > 0) { w.photoFail--; return json(route, {}, 503); }
      return json(route, { claims: { P18: [{ mainsnak: { datavalue: { value: `${wd}.jpg` } } }] } });
    }
    if (u.host === "commons.wikimedia.org") {
      const file = u.searchParams.get("titles");
      return json(route, { query: { pages: { 1: { title: file, imageinfo: [{
        thumburl: `https://thumb.wikimedia.org/fixture/${encodeURIComponent(file)}.png`,   // 실제 썸네일 호스트
        descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(file)}`,
        extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Tester">Tester</a>' }, LicenseShortName: { value: "CC BY-SA 4.0" } },
      }] } } } });
    }
    if (u.host.endsWith("wikipedia.org")) {
      if (w.aboutFail > 0) { w.aboutFail--; return json(route, {}, 503); }
      const title = decodeURIComponent(u.pathname.split("/").pop());
      return json(route, { title, extract: `요약: ${title}`, content_urls: { desktop: { page: `https://${u.host}/wiki/${title}` } } });
    }
    if (u.host === "thumb.wikimedia.org" || u.host === "upload.wikimedia.org") {
      if (w.imageFail > 0) { w.imageFail--; return route.fulfill({ status: 404, body: "" }); }
      return route.fulfill({ contentType: "image/png", body: PNG });
    }
    return route.fulfill({ status: 404, body: "" });
  };
  return { w, handler };
}

// ── 페이지 ──────────────────────────────────
// Leaflet은 integrity + crossorigin으로 불러오므로, 가짜 응답도 실제 CDN과 같은 바이트에 CORS 헤더를 붙인다
const leafletRoute = (r) => r.fulfill({
  contentType: r.request().url().endsWith(".js") ? "text/javascript" : "text/css",
  headers: { "access-control-allow-origin": "*" },
  body: r.request().url().endsWith(".js") ? LEAFLET_JS : LEAFLET_CSS,
});

// 테스트 하나를 도는 동안 브라우저가 알린 Content-Security-Policy 위반 (있으면 그 테스트는 실패)
let cspViolations = [];

async function openPage(browser, { viewport = "desktop", wiki = {}, reducedMotion = "no-preference", geolocation, permissions, beforeLoad, wait = true, hash = "" } = {}) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport] || viewport,
    reducedMotion,
    acceptDownloads: true,
    geolocation,
    permissions,
    hasTouch: viewport !== "desktop",
    isMobile: false,
  });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|integrity/i.test(m.text())) cspViolations.push(m.text()); });
  await page.route("https://cdnjs.cloudflare.com/**", leafletRoute);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: "text/css", body: "" }));
  await page.route(/cartocdn\.com|arcgisonline\.com|tile\.googleapis\.com/, (r) => r.fulfill({ contentType: "image/svg+xml", body: TILE }));
  const { w, handler } = wikiHandler(wiki);
  page.wiki = w;
  await page.route(/wikidata\.org|wikipedia\.org|wikimedia\.org/, handler);
  if (beforeLoad) await beforeLoad(page);
  await page.goto(`${BASE}/${hash}`);
  if (wait) await waitReady(page);
  return page;
}

const waitReady = (page) => page.waitForFunction(() => document.body.dataset.phase === "ready", null, { timeout: 30000 });
const text = (page, sel) => page.locator(sel).first().innerText();
const dbg = (page, fn, arg) => page.evaluate(new Function("arg", `const d = window.viaRomanaDebug; return (${fn})(d, arg);`), arg);

async function setView(page, lat, lon, zoom) {
  await dbg(page, "(d, a) => d.map.setView([a.lat, a.lon], a.zoom, { animate: false })", { lat, lon, zoom });
  await page.waitForTimeout(150);
}
async function pointFor(page, lat, lon) {
  return dbg(page, `(d, a) => { const p = d.map.latLngToContainerPoint([a.lat, a.lon]); const r = d.map.getContainer().getBoundingClientRect(); return { x: p.x + r.left, y: p.y + r.top }; }`, { lat, lon });
}
async function matchedCount(page) {
  const line = await text(page, "#count-line");
  return Number(line.match(/조건 일치 ([\d,]+)곳/)[1].replace(/,/g, ""));
}
async function inViewCount(page) {
  const line = await text(page, "#count-line");
  return Number(line.match(/지도 범위 ([\d,]+)곳/)[1].replace(/,/g, ""));
}
async function openList(page) {
  if ((await page.getAttribute("#panel", "data-state")) === "peek") await page.click("#panel-handle");
  await page.waitForSelector("#view-list:not([hidden])");
}
async function openFilters(page) {
  if (!(await page.$eval("#filters", (d) => d.open))) await page.click("#filters summary");
}
async function search(page, q) {
  await page.fill("#search", q);
  await page.press("#search", "Enter");
  await page.waitForTimeout(250);
}
// /api/near 요청을 가로채 원하는 순서·지연으로 돌려준다
async function controlNear(page, plan) {
  const seen = [];
  await page.route("**/api/near?*", async (route) => {
    const i = seen.length;
    seen.push(route.request().url());
    const step = plan[i] || plan[plan.length - 1];
    if (step.delay) await sleep(step.delay);
    if (step.abort) return route.abort().catch(() => {});
    await route.fulfill({ status: step.status || 200, contentType: "application/json", body: JSON.stringify(step.body) }).catch(() => {});
  });
  return seen;
}
const nearBody = (count, ids) => ({ center: [0, 0], km: 29.6, count, sites: ids.map((id, i) => ({ id, name: id, cat: "town", distance_km: i + 0.5 })) });

// ── 테스트 ──────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("API: /healthz와 /api/meta 응답", async () => {
  const h = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.sites, META.total);
  const m = await (await fetch(`${BASE}/api/meta`)).json();
  assert.equal(m.day_march_km, 29.6);
  assert.equal(m.regions.length, 7);
  assert.equal(m.extent.length, 4);
});

test("초기 로딩 중에는 데이터 의존 버튼이 꺼져 있고 눌러도 오류가 없다", async (browser) => {
  const page = await openPage(browser, {
    wait: false,
    beforeLoad: (p) => p.route("**/api/sites", async (r) => { await sleep(1500); await r.continue(); }),
  });
  await page.waitForSelector("body[data-phase=loading]");
  for (const sel of ["#search", "#march-pick", "#march-here", "#export-kml", "#all-off"]) {
    assert.equal(await page.isDisabled(sel), true, `${sel}은 로딩 중 비활성`);
  }
  await page.click("#march-pick", { force: true }).catch(() => {});
  await page.click("#export-kml", { force: true }).catch(() => {});
  assert.match(await text(page, "#count-line"), /불러오는 중/);
  await waitReady(page);
  assert.equal(await page.isDisabled("#search"), false);
  assert.equal(await page.isVisible("#pick-banner"), false, "로딩 중 클릭으로 고르기 모드가 켜지면 안 됨");
  assert.deepEqual(page.errors, []);
});

test("초기 실패 후 다시 시도: 오류 안내, 재시도, 마커·칩 중복 없음", async (browser) => {
  let calls = 0;
  const page = await openPage(browser, {
    wait: false,
    beforeLoad: (p) => p.route("**/api/sites", (r) => (++calls === 1 ? r.fulfill({ status: 500, body: "boom" }) : r.continue())),
  });
  await page.waitForSelector("#load-error:not([hidden])");
  assert.match(await text(page, "#load-error-msg"), /다시 시도/);
  assert.equal(await page.isDisabled("#search"), true);
  await page.click("#retry");
  await waitReady(page);
  assert.equal(await page.isVisible("#load-error"), false);
  assert.equal(await dbg(page, "(d) => d.state.sites.length"), 10580);
  assert.equal(await dbg(page, "(d) => d.markerCount()"), 10580);
  assert.equal(await page.locator(".chip").count(), 9);
  assert.equal(await page.locator(".region").count(), 7);
  // 칩 리스너가 한 번만 붙었는지: 한 번 누르면 꺼진다
  await openFilters(page);
  await page.click(".chip >> nth=0");
  assert.equal(await page.getAttribute(".chip >> nth=0", "aria-pressed"), "false");
  assert.deepEqual(page.errors, []);
});

test("배경 지도 실패는 유적 데이터 오류와 따로 안내한다", async (browser) => {
  const page = await openPage(browser, {
    beforeLoad: (p) => p.route(/cartocdn\.com/, (r) => r.fulfill({ status: 500, body: "" })),
  });
  await page.waitForSelector("#base-error:not([hidden])", { timeout: 8000 });
  assert.equal(await page.isVisible("#load-error"), false);
  assert.match(await text(page, "#count-line"), /조건 일치 10,580곳/);
  await page.click("#base-switch");
  assert.equal(await page.getAttribute('.basemap [data-base="sat"]', "aria-pressed"), "true");
});

test("행군: A가 B보다 늦게 도착해도 B 결과가 남는다", async (browser) => {
  const page = await openPage(browser);
  const seen = await controlNear(page, [
    { delay: 1500, body: nearBody(111, ["285857974"]) },
    { delay: 0, body: nearBody(2, ["149496", "353133531"]) },
  ]);
  await setView(page, 43.9, 4.5, 9);
  await page.click("#march-pick");
  let p = await pointFor(page, 43.95, 4.4);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(100);
  await page.click("#march-pick");
  p = await pointFor(page, 43.9, 4.6);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(2000);
  assert.equal(seen.length, 2);
  assert.match(await text(page, "#march-status"), /유적 2곳/);
  assert.match(await text(page, "#results-summary"), /행군 반경 · 2곳/);
  const ids = await page.$$eval("#results .site-row", (els) => els.map((e) => e.dataset.id));
  assert.deepEqual(ids, ["149496", "353133531"]);
  assert.equal(await dbg(page, "(d) => d.marchLayerCount()"), 2, "반경 원과 출발점만 남음");
});

test("행군 조회 중 반경을 지우면 늦은 응답이 결과를 되살리지 않는다", async (browser) => {
  const page = await openPage(browser);
  await controlNear(page, [{ delay: 1200, body: nearBody(50, ["285857974"]) }]);
  await setView(page, 41.89, 12.49, 11);
  await page.click("#march-pick");
  await page.click("#pick-center");
  await page.waitForSelector("#march-clear:not([hidden])");
  await page.click("#march-clear");
  await page.waitForTimeout(1600);
  assert.equal(await dbg(page, "(d) => d.state.march"), null);
  assert.equal(await page.isVisible('.scope [data-scope="march"]'), false);
  assert.equal(await text(page, "#march-status").catch(() => ""), "");
  assert.doesNotMatch(await text(page, "#results-summary"), /행군/);
});

test("행군 조회 중 모든 분류를 끄면 늦은 응답이 결과를 덮지 않는다", async (browser) => {
  const page = await openPage(browser);
  const seen = await controlNear(page, [{ delay: 1200, body: nearBody(50, ["285857974"]) }]);
  await setView(page, 41.89, 12.49, 11);
  await page.click("#march-pick");
  await page.click("#pick-center");
  await page.waitForTimeout(100);
  await openFilters(page);
  await page.click("#all-off");
  await page.waitForTimeout(1600);
  assert.equal(seen.length, 1, "분류가 없으면 API를 부르지 않는다 (cat 생략 = 전체로 오해 방지)");
  assert.match(await text(page, "#march-status"), /모든 분류가 꺼져/);
  assert.equal(await page.locator("#results .site-row").count(), 0);
  assert.match(await text(page, "#results-empty"), /모든 분류가 꺼져/);
  assert.equal(await dbg(page, "(d) => d.markerCount()"), 0);
  await page.click('#results-empty [data-fix="cats-on"]');
  await page.waitForTimeout(1500);
  assert.equal(seen.length, 2);
});

test("지도를 옮기면 지도 범위 건수와 목록이 함께 바뀐다", async (browser) => {
  const page = await openPage(browser);
  const total = await matchedCount(page);
  await setView(page, 41.8925, 12.4853, 13);
  const rome = await inViewCount(page);
  const romeFirst = await page.getAttribute("#results .site-row >> nth=0", "data-id");
  await setView(page, 49.753, 6.641, 13);
  const trier = await inViewCount(page);
  const trierFirst = await page.getAttribute("#results .site-row >> nth=0", "data-id");
  assert.equal(await matchedCount(page), total, "전체 조건 일치 건수는 지도 이동과 무관");
  assert.ok(rome > 0 && trier > 0 && rome !== trier, `로마 ${rome}, 트리어 ${trier}`);
  assert.notEqual(romeFirst, trierFirst);
  assert.match(await text(page, "#results-summary"), new RegExp(`지금 지도 범위 · ${trier.toLocaleString("en")}곳`));
  const inside = await dbg(page, "(d, id) => { const s = d.state.byId.get(id); return d.map.getBounds().contains([s.coordinates[1], s.coordinates[0]]); }", trierFirst);
  assert.equal(inside, true);
});

test("검색: 서버와 같은 기준으로 세고, 악센트·대소문자·한국어 별칭을 처리한다", async (browser) => {
  const page = await openPage(browser);
  for (const q of ["nimes", "NÎMES", "콜로세움", "Pont du Gard", "  aqua   ", "theat verona"]) {
    await search(page, q);
    const server = (await (await fetch(`${BASE}/api/sites?q=${encodeURIComponent(q)}`)).json()).features.length;
    assert.equal(await matchedCount(page), server, `‘${q}’ 건수`);
    assert.ok(server > 0, `‘${q}’ 결과 있음`);
  }
  await search(page, "콜로세움");
  assert.equal(await page.getAttribute('.scope [data-scope="all"]', "aria-pressed"), "true", "검색하면 전체 범위");
  assert.equal(await page.getAttribute("#results .site-row >> nth=0", "data-id"), "285857974");
  await search(page, "arena");
  const top = await page.$$eval("#results .site-row .name", (els) => els.slice(0, 2).map((e) => e.textContent));
  assert.ok(top.some((n) => /Pula Arena/.test(n)), `단어 시작 일치가 앞에: ${top}`);
  await search(page, "zzzz없는이름");
  assert.match(await text(page, "#results-empty"), /맞는 유적이 없어요/);
  await page.click('#results-empty [data-fix="clear-q"]');
  assert.equal(await page.inputValue("#search"), "");
  assert.equal(await matchedCount(page), 10580);
});

test("검색·목록·지도 선택이 같은 유적을 가리키고, 같은 항목을 다시 골라도 열린다", async (browser) => {
  const page = await openPage(browser);
  const zoomBefore = await dbg(page, "(d) => d.map.getZoom()");
  await search(page, "Pont du Gard");
  assert.equal(await dbg(page, "(d) => d.map.getZoom()"), zoomBefore, "검색만으로 지도를 옮기지 않는다");
  await page.click('#results .site-row[data-id="149496"]');
  await page.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await text(page, "#detail-name"), "Pont du Gard");
  assert.equal(await dbg(page, "(d) => d.state.selectedId"), "149496");
  await page.waitForTimeout(400);
  const inside = await dbg(page, "(d) => d.map.getBounds().contains([43.94725, 4.53529])");
  assert.equal(inside, true, "선택한 유적이 지도에 보인다");
  await page.click("#detail-back");
  assert.equal(await page.getAttribute('#results .site-row[data-id="149496"]', "aria-current"), "true");
  // 같은 위치·같은 줌에서 같은 항목 다시 선택
  await page.click('#results .site-row[data-id="149496"]');
  await page.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await text(page, "#detail-name"), "Pont du Gard");
  // 빠른 연속 선택: 마지막으로 고른 유적이 남는다
  await page.click("#detail-back");
  await search(page, "amphitheat");
  const ids = await page.$$eval("#results .site-row", (els) => els.slice(0, 3).map((e) => e.dataset.id));
  for (const id of ids) {
    await page.click(`#results .site-row[data-id="${id}"]`, { noWaitAfter: true });
    if (id !== ids[ids.length - 1]) await page.click("#detail-back");
  }
  await page.waitForTimeout(800);
  assert.equal(await dbg(page, "(d) => d.state.selectedId"), ids[2]);
  const name = await dbg(page, "(d, id) => d.state.byId.get(id).name", ids[2]);
  assert.equal(await text(page, "#detail-name"), name);
  // 지도 마커를 눌러도 같은 상세가 열린다
  await page.click("#detail-back");
  await page.fill("#search", "");
  await page.press("#search", "Enter");
  await setView(page, 41.89025, 12.49235, 17);
  const p = await pointFor(page, 41.89025, 12.49235);
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await text(page, "#detail-name"), "Amphitheatrum Flavium");
  assert.deepEqual(page.errors, []);
});

test("목록이 많으면 더 보기로 이어서 보여 준다", async (browser) => {
  const page = await openPage(browser);
  await page.click('.scope [data-scope="all"]');
  assert.equal(await page.locator("#results .site-row").count(), 50);
  assert.match(await text(page, "#results-more"), /10,530곳 남음/);
  await page.click("#results-more");
  assert.equal(await page.locator("#results .site-row").count(), 100);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id != null), true, "새 항목으로 포커스");
});

test("모바일: 목록 → 상세 → 목록에서 스크롤·검색·필터가 유지된다", async (browser) => {
  const page = await openPage(browser, { viewport: "mobile" });
  assert.equal(await page.getAttribute("#panel", "data-state"), "peek");
  await search(page, "villa");
  assert.equal(await page.getAttribute("#panel", "data-state"), "list");
  await page.click("#filters summary");
  await page.click(".switch");
  await page.click("#filters summary");
  await page.click("#results-more").catch(() => {});
  await page.evaluate(() => { document.getElementById("panel-main").scrollTop = 900; });
  const before = await page.evaluate(() => document.getElementById("panel-main").scrollTop);
  const row = page.locator("#results .site-row").nth(12);
  const id = await row.getAttribute("data-id");
  await row.click();
  await page.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await page.getAttribute("#panel", "data-state"), "detail");
  await page.screenshot({ path: join(SHOTS, "mobile-detail.png") });
  await page.click("#detail-back");
  assert.equal(await page.getAttribute("#panel", "data-state"), "list");
  const after = await page.evaluate(() => document.getElementById("panel-main").scrollTop);
  assert.ok(Math.abs(after - before) < 5, `스크롤 ${before} → ${after}`);
  assert.equal(await page.inputValue("#search"), "villa");
  assert.equal(await page.isChecked("#visible-only"), true);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), id, "고른 항목으로 포커스 복귀");
  await page.screenshot({ path: join(SHOTS, "mobile-list.png") });
});

test("모바일: 출발점 고르기 중에는 시트를 접어도 취소가 보이고 Escape로도 취소된다", async (browser) => {
  const page = await openPage(browser, { viewport: "mobile" });
  await openList(page);
  await page.click("#march-pick");
  assert.equal(await page.getAttribute("#panel", "data-state"), "peek");
  assert.equal(await page.isVisible("#pick-cancel"), true);
  const colors = await page.$eval("#pick-center", (b) => [getComputedStyle(b).color, getComputedStyle(b.parentElement.parentElement).backgroundColor]);
  assert.notEqual(colors[0], colors[1], "지도 중심 버튼 글자가 배경과 구분된다");
  const box = await page.locator("#pick-cancel").boundingBox();
  assert.ok(box.height >= 44 && box.y > 0 && box.y + box.height < 844, "취소 버튼이 화면 안에 44px 이상");
  await page.screenshot({ path: join(SHOTS, "mobile-picking.png") });
  await page.keyboard.press("Escape");
  assert.equal(await page.isVisible("#pick-banner"), false);
  assert.equal(await dbg(page, "(d) => d.state.picking"), false);
  await openList(page);
  await page.click("#march-pick");
  await page.click("#pick-cancel");
  assert.equal(await dbg(page, "(d) => d.state.picking"), false);
  await openList(page);
  await setView(page, 41.8925, 12.4853, 11);
  await page.click("#march-pick");
  await page.click("#pick-center");
  await page.waitForFunction(() => window.viaRomanaDebug.state.march?.status === "ready");
  assert.match(await text(page, "#count-sub"), /행군 반경 안 [\d,]+곳/);
});

test("사진과 설명은 따로 실패하고 따로 다시 시도한다", async (browser) => {
  const page = await openPage(browser, { wiki: { photoFail: 1 } });
  await search(page, "콜로세움");
  await page.click('#results .site-row[data-id="285857974"]');
  await page.waitForSelector("#photo-retry");
  assert.match(await text(page, "#d-about"), /요약: 콜로세움/, "설명은 사진 실패와 무관하게 보인다");
  assert.match(await text(page, "#d-label"), /콜로세움/);
  await page.click("#photo-retry");
  await page.waitForSelector("#d-photo img");
  assert.match(await text(page, "#d-photo .credit"), /Tester, CC BY-SA 4.0/);

  const page2 = await openPage(browser, { wiki: { aboutFail: 1 } });
  await search(page2, "Pont du Gard");
  await page2.click('#results .site-row[data-id="149496"]');
  await page2.waitForSelector("#about-retry");
  await page2.waitForSelector("#d-photo img");
  await page2.click("#about-retry");
  await page2.waitForSelector("#d-about .d-about-text");
  assert.match(await text(page2, "#d-about"), /요약: Q189764/);
});

test("사진 파일 자체를 못 받으면 오류와 다시 시도를 보여 준다", async (browser) => {
  const page = await openPage(browser, { wiki: { imageFail: 1 } });
  await search(page, "Pont du Gard");
  await page.click('#results .site-row[data-id="149496"]');
  await page.waitForSelector("#photo-retry");
  await page.click("#photo-retry");
  await page.waitForFunction(() => { const i = document.querySelector("#d-photo img"); return i && i.complete && i.naturalWidth > 0; });
});

test("다른 유적으로 옮긴 뒤 도착한 이전 유적의 사진·설명은 현재 상세를 바꾸지 않는다", async (browser) => {
  const page = await openPage(browser, { wiki: { delay: { Q189764: 1200 } } });
  await search(page, "Pont du Gard");
  await page.click('#results .site-row[data-id="149496"]');
  await page.click("#detail-back");
  await search(page, "콜로세움");
  await page.click('#results .site-row[data-id="285857974"]');
  await page.waitForTimeout(1600);
  assert.equal(await text(page, "#detail-name"), "Amphitheatrum Flavium");
  assert.doesNotMatch(await text(page, "#d-about"), /Q189764/);
  assert.match(await page.getAttribute("#d-photo img", "src"), /Q10285/);
  // 같은 유적을 다시 열면 캐시를 쓴다 (중복 요청 없음)
  const before = page.wiki.calls.length;
  await page.click("#detail-back");
  await page.click('#results .site-row[data-id="285857974"]');
  await page.waitForTimeout(300);
  assert.equal(page.wiki.calls.filter((c) => !c.startsWith("thumb")).length, page.wiki.calls.slice(0, before).filter((c) => !c.startsWith("thumb")).length);
});

test("Wikidata가 없는 유적은 사진·설명이 없다고 알리고 Pleiades 설명을 보여 준다", async (browser) => {
  const page = await openPage(browser);
  await search(page, "Segovia aqueduct");
  await page.click('#results .site-row[data-id="237072"]');
  await page.waitForSelector("#view-detail:not([hidden])");
  assert.match(await text(page, "#d-photo"), /연결된 사진 자료가 없어요/);
  assert.equal(page.wiki.calls.length, 0);
});

test("KML: 정상 다운로드, 범위·필터 표시", async (browser) => {
  const page = await openPage(browser);
  await setView(page, 41.8925, 12.4853, 14);
  await search(page, "theat");
  await page.click('.scope [data-scope="view"]');
  const scopeText = await text(page, "#export-scope");
  assert.match(scopeText, /지금 지도 범위 · 검색어 ‘theat’, 모든 분류 적용 · \d+곳/);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-kml")]);
  assert.equal(download.suggestedFilename(), "via-romana.kml");
  const body = readFileSync(await download.path(), "utf8");
  assert.ok(body.startsWith("<?xml") && body.includes("<kml"));
  const n = Number(scopeText.match(/(\d+)곳/)[1]);
  assert.equal((body.match(/<Placemark>/g) || []).length, n, "화면에 적힌 건수와 파일 건수가 같다");
  assert.match(await text(page, "#export-status"), /다운로드를 시작했어요/);
});

test("KML: 0건·상한 초과·분류 없음은 요청 없이 안내한다", async (browser) => {
  const page = await openPage(browser);
  let requests = 0;
  await page.route("**/api/export.kml?*", (r) => { requests++; return r.continue(); });
  await page.click("#export-kml");
  assert.match(await text(page, "#export-status"), /2,000곳까지/);
  await setView(page, 36.0, -30.0, 9);   // 대서양
  await page.click("#export-kml");
  assert.match(await text(page, "#export-status"), /조건에 맞는 유적이 없어요/);
  assert.match(await text(page, "#results-empty"), /데이터 범위\(유럽의 로마 유적\) 밖/);
  await setView(page, 41.8925, 12.4853, 14);
  await openFilters(page);
  await page.click("#all-off");
  await page.click("#export-kml");
  assert.match(await text(page, "#export-status"), /모든 분류가 꺼져/);
  assert.equal(requests, 0);
});

test("KML: 서버 오류·네트워크 오류·404는 파일을 저장하지 않고 다시 시도를 준다, 중복 클릭 방지", async (browser) => {
  const page = await openPage(browser);
  await setView(page, 41.8925, 12.4853, 14);
  let downloads = 0;
  page.on("download", () => downloads++);
  let mode = "500";
  let requests = 0;
  await page.route("**/api/export.kml?*", async (r) => {
    requests++;
    if (mode === "slow") { await sleep(800); return r.continue(); }
    if (mode === "500") return r.fulfill({ status: 500, contentType: "text/html", body: "<h1>error</h1>" });
    if (mode === "404") return r.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"조건에 맞는 유적이 없습니다"}' });
    return r.abort();
  });
  await page.click("#export-kml");
  await page.waitForSelector("#export-status [data-export-retry]");
  assert.match(await text(page, "#export-status"), /서버 오류\(500\)/);
  mode = "net";
  await page.click("#export-status [data-export-retry]");
  await page.waitForFunction(() => /네트워크 오류/.test(document.getElementById("export-status").textContent));
  mode = "404";
  await page.click("#export-kml");
  await page.waitForFunction(() => /조건에 맞는 유적이 없어요/.test(document.getElementById("export-status").textContent));
  assert.equal(downloads, 0);
  assert.equal(new URL(page.url()).pathname, "/", "지도 페이지에 그대로 있다");
  mode = "slow";
  requests = 0;
  await page.click("#export-kml");
  await page.click("#export-kml", { force: true, timeout: 1000 }).catch(() => {});
  await page.waitForEvent("download");
  assert.equal(requests, 1);
});

test("위치: 권한 거부·시간 초과·범위 밖·범위 안", async (browser) => {
  const fake = (mode) => (p) => p.addInitScript((m) => {
    navigator.geolocation.getCurrentPosition = (ok, fail) => setTimeout(() => {
      if (m === "denied") fail({ code: 1 });
      else if (m === "timeout") fail({ code: 3 });
      else if (m === "unavailable") fail({ code: 2 });
      else if (m === "seoul") ok({ coords: { latitude: 37.57, longitude: 126.98 } });
      else if (m === "istanbul-far") ok({ coords: { latitude: 39.9, longitude: 32.85 } });
      else ok({ coords: { latitude: 41.8925, longitude: 12.4853 } });
    }, m === "rome-slow" ? 800 : 50);
  }, mode);
  const expect = { denied: /권한이 거부/, timeout: /시간이 초과/, unavailable: /확인하지 못했어요/, seoul: /데이터 범위\(유럽의 로마 유적\) 밖/, "istanbul-far": /데이터 범위/ };
  for (const [mode, re] of Object.entries(expect)) {
    const page = await openPage(browser, { beforeLoad: fake(mode) });
    await page.click("#march-here");
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById("march-status").textContent), re.source);
    assert.equal(await dbg(page, "(d) => d.state.march"), null, `${mode}: 행군을 시작하지 않는다`);
    await page.waitForTimeout(50);
    if (mode === "timeout") assert.equal(await page.isVisible("#locate-retry"), true);
    assert.doesNotMatch(await text(page, "#march-status"), /유적이 없/, "로마 유적이 없다고 단정하지 않는다");
  }
  const page = await openPage(browser, { beforeLoad: fake("rome") });
  await page.click("#march-here");
  await page.waitForFunction(() => window.viaRomanaDebug.state.march?.status === "ready");
  // 늦게 온 위치 콜백은 다른 행동(고르기 시작) 뒤에 무시된다
  const late = await openPage(browser, { beforeLoad: fake("rome-slow") });
  await late.click("#march-here");
  await late.click("#march-pick");
  await late.waitForTimeout(1200);
  assert.equal(await dbg(late, "(d) => d.state.march === null"), true);
  assert.equal(await dbg(late, "(d) => d.state.picking"), true, "고르기 모드가 유지된다");
});

test("이곳 주변 탐색: 상세에서 행군 반경 목록으로 이어진다", async (browser) => {
  const page = await openPage(browser);
  await search(page, "콜로세움");
  await page.click('#results .site-row[data-id="285857974"]');
  await page.click("#d-explore");
  await page.waitForFunction(() => window.viaRomanaDebug.state.march?.status === "ready");
  assert.equal(await page.getAttribute('.scope [data-scope="march"]', "aria-pressed"), "true");
  assert.match(await text(page, "#results-summary"), /행군 반경에서 ‘콜로세움’ 검색/);
  // 검색어를 지우면 반경 안 전체로 다시 조회
  await page.click("#search-clear");
  await page.waitForFunction(() => window.viaRomanaDebug.state.march?.result?.count > 100);
  assert.match(await text(page, "#results .site-row >> nth=0 >> .dist"), /출발점에서 0\.0km/);
});

test("키보드만으로: 검색 → 목록 → 상세 → 주변 탐색 → 목록 복귀, 고르기 취소", async (browser) => {
  const page = await openPage(browser);
  const tabTo = async (pred, limit = 60) => {
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(pred)) return;
    }
    throw new Error(`Tab으로 도달 못 함: ${pred}`);
  };
  await tabTo(() => document.activeElement.id === "search");
  await page.keyboard.type("pont du gard");
  await page.keyboard.press("Enter");
  await tabTo(() => document.activeElement.classList.contains("site-row"));
  await page.keyboard.press("Enter");
  await page.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await page.evaluate(() => document.activeElement.id), "detail-name");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), "149496");
  await page.keyboard.press("Enter");
  await tabTo(() => document.activeElement.id === "d-explore");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.viaRomanaDebug.state.march?.status === "ready");
  await page.focus("#march-pick");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "pick-cancel");
  await page.keyboard.press("Escape");
  assert.equal(await dbg(page, "(d) => d.state.picking"), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), "march-pick");
});

test("reduced-motion이면 지도 이동 애니메이션을 끈다", async (browser) => {
  const page = await openPage(browser, { reducedMotion: "reduce" });
  assert.equal(await dbg(page, "(d) => d.map.options.zoomAnimation"), false);
  await page.click(".region >> nth=0");
  assert.equal(await dbg(page, "(d) => d.map.getZoom()"), 13, "애니메이션 없이 바로 이동");
});

test("시작 지역마다 실제 유적이 있다", async (browser) => {
  const page = await openPage(browser);
  const n = await page.locator(".region").count();
  for (let i = 0; i < n; i++) {
    await page.click(`.region >> nth=${i}`);
    await page.waitForTimeout(700);
    const label = await page.locator(".region").nth(i).innerText();
    assert.ok(await inViewCount(page) >= 10, `${label}: 지도 범위 안 유적 ${await inViewCount(page)}곳`);
  }
});


// ── 고고학 아이콘·확대 단계 ────────────────────
test("아이콘 품질: 18개를 16/20/24/32px로 렌더링, 헷갈리기 쉬운 쌍의 실루엣 겹침이 기준 이하", async (browser) => {
  const r = await iconReport(browser);
  for (const [k, v] of Object.entries(r)) {
    if (k.includes("↔")) assert.ok(v <= MAX_IOU, `${k} IoU ${v}`);
    if (k.startsWith("ink")) assert.ok(v >= 20, `${k}: 거의 비어 있음 (${v}px)`);
  }
  console.log("    실루엣 IoU:", Object.entries(r).filter(([k]) => k.includes("↔")).map(([k, v]) => `${k} ${v}`).join(", "));
});

test("확대 단계: 4 밀도 → 7 채움형 → 10 윤곽형 → 13 윤곽형+라벨, 사이트별 DOM 마커 없음", async (browser) => {
  const iconRequests = [];
  const page = await openPage(browser, { beforeLoad: (p) => p.on("request", (r) => { if (r.url().includes("/icons/")) iconRequests.push(r.url()); }) });
  const expect = [[4, "density"], [7, "glyph"], [10, "outline"], [13, "outline-label"]];
  for (const [z, mode] of expect) {
    await setView(page, z === 4 ? 46 : 41.8925, z === 4 ? 10 : 12.4853, z);
    await page.waitForTimeout(300);
    const st = await dbg(page, "(d) => d.drawStats()");
    assert.equal(await dbg(page, "(d) => d.mode()"), mode, `줌 ${z}`);
    assert.equal(st.mode, mode);
    if (mode === "density") { assert.ok(st.cells > 50, `밀도 칸 ${st.cells}`); assert.equal(st.drawn, 0); }
    else assert.ok(st.drawn > 20, `줌 ${z} 배지 ${st.drawn}`);
    if (mode === "outline-label") assert.ok(st.labels > 0 && st.labels <= 36, `라벨 ${st.labels}`);
    else assert.equal(st.labels, 0, "줌 12 미만에서는 라벨 없음");
    assert.equal(await page.getAttribute(`.lod-steps li[data-mode="${mode}"]`, "aria-current"), "true");
    await page.screenshot({ path: join(SHOTS, `lod-z${z}.png`) });
  }
  assert.equal(await page.locator(".leaflet-marker-icon").count(), 0, "유적마다 DOM 마커를 만들지 않는다");
  assert.ok(await page.locator("#map svg").count() <= 2);
  assert.equal(new Set(iconRequests).size, 18, "아이콘 18개");
  assert.equal(iconRequests.length, 18, "줌을 바꿔도 아이콘을 다시 받지 않는다");
  assert.equal(await page.locator("#via-icon-sprite symbol").count(), 18);
});

test("밀도 칸을 누르면 그곳으로 확대되고, 선택한 유적은 어느 단계에서나 강조된다", async (browser) => {
  const page = await openPage(browser);
  await setView(page, 43.5, 11, 4);
  const cell = await dbg(page, `(d) => { const c = d.map.getContainer().getBoundingClientRect(); return { x: c.left + c.width / 2, y: c.top + c.height / 2 }; }`);
  // 칸이 있는 점을 찾아 누른다
  const target = await page.evaluate(() => {
    const d = window.viaRomanaDebug; const s = d.state.byId.get("285857974");
    const p = d.map.latLngToContainerPoint([s.coordinates[1], s.coordinates[0]]); return { x: p.x, y: p.y };
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(400);
  assert.equal(await dbg(page, "(d) => d.map.getZoom()"), 6);
  assert.ok(cell);
  await search(page, "콜로세움");
  await page.click('#results .site-row[data-id="285857974"]');
  for (const z of [4, 7, 10, 14]) {
    await setView(page, 41.89025, 12.49235, z);
    assert.equal((await dbg(page, "(d) => d.drawStats()")).selected, true, `줌 ${z}에서 선택 강조`);
  }
});

test("범례·필터: 윤곽 아이콘과 글자를 함께 쓰고, 필터는 aria-pressed·aria-label을 가진다", async (browser) => {
  const page = await openPage(browser);
  await page.click("#legend summary");
  assert.equal(await page.locator("#legend-list li").count(), 9);
  assert.equal(await page.locator('#legend-list li use[href^="#ico-outline-"]').count(), 9);
  assert.equal(await page.locator("#legend-peek use").count(), 9);
  await openFilters(page);
  const chips = await page.$$eval(".chip", (els) => els.map((e) => [e.getAttribute("aria-label"), e.getAttribute("aria-pressed"), !!e.querySelector('use[href^="#ico-outline-"]'), e.querySelector("svg").getAttribute("aria-hidden")]));
  assert.equal(chips.length, 9);
  for (const [label, pressed, icon, hidden] of chips) {
    assert.match(label, /곳$/); assert.equal(pressed, "true"); assert.ok(icon); assert.equal(hidden, "true");
  }
  await page.screenshot({ path: join(SHOTS, "legend.png") });
});

test("glyph ↔ outline 전환은 짧게 겹쳐 바뀌고, reduced-motion이면 바로 바뀐다", async (browser) => {
  const page = await openPage(browser);
  await setView(page, 41.9, 12.5, 8);
  const before = await dbg(page, "(d) => d.fadeCount()");
  await dbg(page, "(d) => d.map.setZoom(9, { animate: false })");
  await page.waitForTimeout(300);
  assert.equal(await dbg(page, "(d) => d.fadeCount()"), before + 1, "glyph → outline 전환에서 크로스페이드");
  await dbg(page, "(d) => d.map.setZoom(10, { animate: false })");
  await page.waitForTimeout(300);
  assert.equal(await dbg(page, "(d) => d.fadeCount()"), before + 1, "같은 outline 단계 안에서는 전환 없음");
  const still = await openPage(browser, { reducedMotion: "reduce" });
  await setView(still, 41.9, 12.5, 8);
  await dbg(still, "(d) => d.map.setZoom(9, { animate: false })");
  await still.waitForTimeout(300);
  assert.equal(await dbg(still, "(d) => d.fadeCount()"), 0, "reduced-motion이면 바로 바뀐다");
});

test("행군: 이정표 XX MP, 낮은 줌에서도 반경 안 유적은 아이콘, 선택하면 출발점 연결선과 로마마일", async (browser) => {
  const page = await openPage(browser);
  await search(page, "Pont du Gard");
  await page.click('#results .site-row[data-id="149496"]');
  await page.click("#d-explore");
  await page.waitForFunction(() => window.viaRomanaDebug.state.march?.status === "ready");
  assert.equal(await page.locator(".milestone").count(), 1);
  assert.match(await page.locator(".milestone").innerText(), /XX\s*MP/);
  await page.click("#search-clear");
  await page.waitForFunction(() => window.viaRomanaDebug.state.march?.result?.count > 5);
  await page.waitForTimeout(300);
  const other = await page.getAttribute("#results .site-row >> nth=3", "data-id");
  assert.equal(await page.locator(".mile-label").count(), 0, "출발점 자신을 고른 동안에는 연결선 없음");
  await page.click(`#results .site-row[data-id="${other}"]`);
  await page.waitForSelector(".mile-label");
  assert.equal(await page.locator(".mile-label").count(), 1);
  assert.match(await page.locator(".mile-label").innerText(), /^(?:[IVXLC]+ MP|I MP 미만) · [\d.]+km$/);
  await page.screenshot({ path: join(SHOTS, "march-connector.png") });
  await page.waitForTimeout(800);   // 선택 후 지도 이동 애니메이션이 끝나기를 기다린다
  await setView(page, 43.9, 4.5, 5);
  const st = await dbg(page, "(d) => d.drawStats()");
  assert.deepEqual(page.errors, []);
  assert.equal(await dbg(page, "(d) => d.map.getZoom()"), 5);
  assert.equal(st.mode, "density");
  assert.ok(st.drawn > 0, "밀도 단계에서도 반경 안 유적은 아이콘으로 보인다");
  await page.click("#detail-back");
  await page.click("#march-clear");
  await page.waitForTimeout(350);   // Leaflet 툴팁은 200ms 페이드 뒤에 DOM에서 빠진다
  assert.equal(await page.locator(".mile-label").count(), 0);
  assert.equal(await page.locator(".milestone").count(), 0);
});

test("박물관 카드: 사진→이름→분류 아이콘→존속 기간 막대→남은 정도→설명→행동, 연대 미상은 막대 없음", async (browser) => {
  const page = await openPage(browser);
  const ids = await dbg(page, `(d) => {
    const dated = d.state.sites.find((s) => s.from != null && s.wd && s.from > -30 && s.to < 400);
    const undated = d.state.sites.find((s) => s.from == null);
    return [dated.id, undated.id];
  }`);
  await search(page, ids[0]);   // Pleiades ID로도 찾는다
  await page.click(`#results .site-row[data-id="${ids[0]}"]`);
  await page.waitForSelector("#d-photo img");
  const order = await page.$$eval("#detail > *", (els) => els.map((e) => e.className || e.tagName).filter(Boolean));
  const idx = (c) => order.findIndex((o) => String(o).includes(c));
  assert.ok(idx("d-photo") < idx("d-name") && idx("d-name") < idx("d-cat") && idx("d-cat") < idx("period")
    && idx("period") < idx("d-remains") && idx("d-remains") < idx("d-about") && idx("d-about") < idx("d-actions"), order.join(" > "));
  assert.equal(await page.locator(".period-bar").count(), 1);
  assert.equal(await page.locator('.d-cat use[href^="#ico-outline-"]').count(), 1);
  await page.screenshot({ path: join(SHOTS, "museum-card.png") });
  await page.click("#detail-back");
  await search(page, ids[1]);
  await page.click(`#results .site-row[data-id="${ids[1]}"]`);
  assert.equal(await page.locator(".period-bar").count(), 0);
  assert.match(await text(page, ".d-period-unknown"), /연대 미상/);
});

test("로마 배경이 기본이고 출처 표기가 남아 있다", async (browser) => {
  const page = await openPage(browser);
  assert.equal(await page.getAttribute('.basemap [data-base="roman"]', "aria-pressed"), "true");
  assert.ok(await page.locator(".tiles-roman").count() > 0);
  const credit = await text(page, ".leaflet-control-attribution");
  assert.match(credit, /OpenStreetMap/); assert.match(credit, /CARTO/); assert.match(credit, /Pleiades/);
  await page.click('.basemap [data-base="sat"]');
  assert.match(await text(page, ".leaflet-control-attribution"), /Esri/);
});

test("Google 저작권은 Google 타일을 볼 때만 붙고, 로마(CARTO) 배경에서는 빠진다", async (browser) => {
  const page = await openPage(browser, {
    beforeLoad: async (p) => {
      await p.route("**/api/meta", async (r) => {
        const res = await r.fetch();
        const meta = await res.json();
        await r.fulfill({ response: res, json: { ...meta, google_maps_key: "TESTKEY" } });
      });
      await p.route("https://tile.googleapis.com/**", (r) => {
        const u = r.request().url();
        if (u.includes("createSession")) return r.fulfill({ json: { session: `S-${JSON.parse(r.request().postData()).mapType}` } });
        if (u.includes("viewport")) return r.fulfill({ json: { copyright: "Map data ©2026 Google" } });
        return r.fulfill({ contentType: "image/png", body: PNG });
      });
    },
  });
  await page.waitForTimeout(500);
  const credit = () => text(page, ".leaflet-control-attribution");
  assert.equal(await page.getAttribute('.basemap [data-base="roman"]', "aria-pressed"), "true");
  assert.doesNotMatch(await credit(), /Google/, "로마 배경(CARTO)에는 Google 저작권을 붙이지 않는다");
  await page.click('.basemap [data-base="map"]');
  await page.waitForFunction(() => /Google/.test(document.querySelector(".leaflet-control-attribution").textContent));
  await page.click('.basemap [data-base="roman"]');
  await page.waitForTimeout(300);
  assert.doesNotMatch(await credit(), /Google/);
  assert.match(await credit(), /CARTO/);
});

test("고배율 기기에서도 지도 캔버스는 2배까지만 만든다", async (browser) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const page = await context.newPage();
  await page.route("https://cdnjs.cloudflare.com/**", leafletRoute);
  await page.route(/fonts\.|cartocdn|arcgisonline|wiki/, (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  await page.goto(BASE + "/");
  await waitReady(page);
  const ratios = await page.$$eval("canvas.via-canvas", (cs) => cs.map((c) => c.width / parseFloat(c.style.width)));
  assert.equal(ratios.length, 3);
  for (const r of ratios) assert.ok(r <= 2.01, `캔버스 배율 ${r}`);
  await page.evaluate(() => window.viaRomanaDebug.map.setView([41.9, 12.5], 7, { animate: false }));
  await page.waitForTimeout(400);
  assert.ok((await page.evaluate(() => window.viaRomanaDebug.drawStats())).drawn > 0);
});

for (const [vp, size] of Object.entries(VIEWPORTS)) {
  test(`레이아웃 ${size.width}×${size.height}: 가로 스크롤 없음, 주요 버튼 44px, 캡처`, async (browser) => {
    const page = await openPage(browser, { viewport: vp });
    await page.screenshot({ path: join(SHOTS, `${vp}-start.png`) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, `가로 넘침 ${overflow}px`);
    await openList(page);
    await search(page, "arena");
    const small = await page.$$eval("#search, .region, .btn:not([hidden]), .site-row, .panel-handle, .link",
      (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44)
        .map((e) => `${e.id || e.className}:${Math.round(e.getBoundingClientRect().height)}`));
    assert.deepEqual(small, []);
    await page.screenshot({ path: join(SHOTS, `${vp}-list.png`) });
    await page.click("#results .site-row >> nth=0");
    await page.waitForSelector("#view-detail:not([hidden])");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${vp}-detail.png`) });
    assert.ok(await page.locator("#d-explore").isVisible());
    assert.deepEqual(page.errors, []);
  });
}

test("공유 주소: 지도 위치와 열린 상세가 주소에 남고, 그 주소로 열면 같은 화면이 된다", async (browser) => {
  const page = await openPage(browser, { permissions: ["clipboard-read", "clipboard-write"] });
  assert.equal(new URL(page.url()).hash, "", "처음에는 주소를 바꾸지 않는다");
  await setView(page, 41.8902, 12.4922, 13);
  assert.match(new URL(page.url()).hash, /^#map=13\/41\.8902\/12\.4922$/);
  await search(page, "콜로세움");
  await page.click("#results .site-row >> nth=0");
  await page.waitForSelector("#view-detail:not([hidden])");
  await page.waitForFunction(() => location.hash.includes("site=285857974"));
  await page.click("#d-share");
  await page.waitForFunction(() => document.getElementById("d-share-status").textContent.includes("복사했어요"));
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, page.url());
  assert.match(copied, /#map=\d+\/[\d.]+\/[\d.]+&site=285857974$/);
  await page.click("#detail-back");
  assert.doesNotMatch(new URL(page.url()).hash, /site=/, "목록으로 돌아가면 유적은 주소에서 빠진다");
  assert.deepEqual(page.errors, []);

  // 복사한 주소로 새로 열기: 같은 유적 상세, 주소에 적힌 줌 그대로
  const linked = await openPage(browser, { hash: "#map=14/41.8902/12.4922&site=285857974" });
  await linked.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await text(linked, "#detail-name"), "Amphitheatrum Flavium");
  assert.equal(await dbg(linked, "(d) => d.map.getZoom()"), 14);
  assert.equal(await dbg(linked, "(d) => d.state.selectedId"), "285857974");
  assert.deepEqual(linked.errors, []);

  // 유적만 적힌 주소: 그 유적으로 확대해서 연다
  const siteOnly = await openPage(browser, { viewport: "mobile", hash: "#site=149496" });
  await siteOnly.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await text(siteOnly, "#detail-name"), "Pont du Gard");
  assert.equal(await siteOnly.getAttribute("#panel", "data-state"), "detail");
  await siteOnly.waitForFunction(() => window.viaRomanaDebug.map.getZoom() >= 12);
  assert.deepEqual(siteOnly.errors, []);

  // 잘못된 주소는 무시하고 기본 화면으로
  const bad = await openPage(browser, { hash: "#map=abc/999/1&site=nope" });
  assert.equal(await dbg(bad, "(d) => d.map.getZoom()"), 5);
  assert.equal(await bad.isVisible("#view-detail"), false);
  assert.deepEqual(bad.errors, []);

  // 같은 탭에서 주소만 바꿔도 따라간다
  await bad.evaluate(() => { location.hash = "#map=12/43.9475/4.5350&site=149496"; });
  await bad.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await text(bad, "#detail-name"), "Pont du Gard");
  assert.equal(await dbg(bad, "(d) => d.map.getZoom()"), 12);
});

test("Wikidata 보강: 한국어 라벨로 검색되고, 널리 알려진 곳이 겹칠 때 먼저 그려진다", async (browser) => {
  const page = await openPage(browser);
  await openList(page);
  await search(page, "바르셀로나");
  const first = page.locator("#results .site-row").first();
  assert.equal(await first.locator(".name").innerText(), "Col. Barcino");
  assert.equal(await first.locator(".ko").innerText(), "바르셀로나");
  // 콜로세움은 Pleiades에 남은 정도 기록이 없지만(unknown) 위키백과 언어판이 많아 가장 높은 단계
  const prio = await dbg(page, `(d) => {
    const all = d.state.sites;
    const pick = (fn) => all.find(fn).prio;
    return {
      colosseum: d.state.byId.get("285857974").prio,
      seenWd: pick((s) => ["substantive", "traces", "restored"].includes(s.remains) && s.wd && (s.links || 0) < 20),
      seen: pick((s) => ["substantive", "traces", "restored"].includes(s.remains) && !s.wd),
      wd: pick((s) => s.remains === "unknown" && s.wd && (s.links || 0) < 20),
      none: pick((s) => s.remains === "unknown" && !s.wd),
    };
  }`);
  assert.ok(prio.colosseum < 1 && prio.colosseum < prio.seenWd, JSON.stringify(prio));
  assert.ok(prio.seenWd < prio.seen && prio.seen < prio.wd && prio.wd < prio.none, JSON.stringify(prio));
  // 로마를 넓게 보는 줌에서도 콜로세움은 겹침에 밀리지 않고 그려진다 (누르면 선택된다)
  await page.click("#search-clear");
  await setView(page, 41.8902, 12.4922, 9);
  const pt = await pointFor(page, 41.89025, 12.49235);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await text(page, "#detail-name"), "Amphitheatrum Flavium");
  assert.deepEqual(page.errors, []);
});

test("남은 정도 필터는 기록 기준임을 건수와 함께 알리고, 이름 없는 곳은 '이름 없는 유적'으로 보인다", async (browser) => {
  const page = await openPage(browser);
  await openList(page);
  await openFilters(page);
  const label = await text(page, ".switch");
  assert.match(label, /남아 있다고 기록된 곳만 \([\d,]+곳\)/);
  const shown = Number(label.match(/\(([\d,]+)곳\)/)[1].replace(/,/g, ""));
  await page.click(".switch");
  await page.waitForTimeout(250);
  assert.equal(await matchedCount(page), shown, "필터를 켠 건수가 라벨의 건수와 같다");
  assert.match(await text(page, "#filter-summary"), /남아 있다고 기록된 곳만/);
  await page.click(".switch");
  await search(page, "untitled");
  assert.equal(await page.locator("#results .site-row .name").first().innerText(), "이름 없는 유적");
  await page.click("#results .site-row >> nth=0");
  await page.waitForSelector("#view-detail:not([hidden])");
  assert.equal(await text(page, "#detail-name"), "이름 없는 유적");
  assert.deepEqual(page.errors, []);
});

test("보안: 지도 페이지에 CSP가 붙고, 사진 저작자 HTML은 실행·요청 없이 글자만 쓴다", async (browser) => {
  const res = await fetch(`${BASE}/`);
  const csp = res.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' https:\/\/cdnjs\.cloudflare\.com;/);
  const html = await res.text();
  assert.equal((html.match(/integrity="sha384-/g) || []).length, 2, "Leaflet css·js에 integrity");
  // 저작자 칸에 이미지·핸들러가 섞여 와도 요청하거나 실행하지 않는다
  const page = await openPage(browser);
  const stray = [];
  await page.route("https://commons.wikimedia.org/**", (route) => route.fulfill({
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ query: { pages: { 1: { imageinfo: [{
      thumburl: "https://thumb.wikimedia.org/fixture/x.png",
      descriptionurl: "https://commons.wikimedia.org/wiki/File:x.png",
      extmetadata: { Artist: { value: '<img src="https://upload.wikimedia.org/stray.png" onerror="window.__ran = 1">Tester' }, LicenseShortName: { value: "CC0" } },
    }] } } } }),
  }));
  page.on("request", (r) => { if (r.url().includes("stray.png")) stray.push(r.url()); });
  await openList(page);
  await search(page, "콜로세움");
  await page.click("#results .site-row >> nth=0");
  await page.waitForSelector("#d-photo img");
  assert.equal(await text(page, "#d-photo .credit"), "사진: Tester, CC0");
  await page.waitForTimeout(300);
  assert.deepEqual(stray, []);
  assert.equal(await page.evaluate(() => window.__ran), undefined);
  // 배경을 바꾸고 KML까지 받아도 CSP에 걸리는 것이 없다 (위반은 실행기가 테스트마다 확인)
  await page.click('.basemap [data-base="sat"]');
  await page.click('.basemap [data-base="map"]');
  await page.waitForTimeout(300);
  assert.deepEqual(page.errors, []);
});

test("성능: 필터 변경·줌 변경 처리 시간 측정", async (browser) => {
  const page = await openPage(browser);
  const t = await page.evaluate(async () => {
    const d = window.viaRomanaDebug;
    const time = async (fn) => { const t0 = performance.now(); await fn(); return Math.round(performance.now() - t0); };
    const chip = document.querySelector(".chip");
    const off = await time(() => chip.click());
    const on = await time(() => chip.click());
    const zoom = await time(() => d.map.setZoom(7, { animate: false }));
    const zoomSameBucket = await time(() => d.map.setZoom(8, { animate: false }));
    return { off, on, zoom, zoomSameBucket };
  });
  console.log("    측정(ms):", JSON.stringify(t));
});

// ── 실행 ────────────────────────────────────
const only = process.argv.slice(2).join(" ");
const server = await startServer();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let failed = 0;
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  const t0 = Date.now();
  cspViolations = [];
  try {
    await t.fn(browser);
    assert.deepEqual(cspViolations, [], "Content-Security-Policy 위반");
    console.log(`✓ ${t.name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failed++;
    console.log(`✗ ${t.name}\n    ${String(err.stack || err).split("\n").slice(0, 9).join("\n    ")}`);
  } finally {
    for (const ctx of browser.contexts()) await ctx.close();
  }
}
await browser.close();
server.kill();
console.log(failed ? `\n실패 ${failed}건` : "\n모두 통과");
process.exit(failed ? 1 : 0);
