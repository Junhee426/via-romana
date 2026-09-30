// 아이콘 품질·실루엣 검사: 18개 SVG를 16/20/24/32px로 렌더링한 시트를 캡처하고,
// 헷갈리기 쉬운 쌍의 실루엣 겹침(IoU)을 잰다. 외부 요청 없음.
//   cd tests && node e2e/icons.mjs
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = join(HERE, "..", "..", "app", "static", "icons");
const SHOTS = join(HERE, "screenshots");
mkdirSync(SHOTS, { recursive: true });

export const CATS = ["town", "military", "sacred", "arena", "water", "road", "villa", "burial", "industry"];
export const PAIRS = [["town", "sacred"], ["town", "villa"], ["sacred", "villa"], ["arena", "water"], ["road", "water"], ["burial", "town"], ["industry", "military"]];
export const MAX_IOU = 0.8;   // 이보다 겹치면 작은 크기에서 헷갈린다고 본다

export async function iconReport(browser) {
  const svgs = {};
  for (const kind of ["glyph", "outline"]) for (const c of CATS) svgs[`${kind}/${c}`] = readFileSync(join(ICONS, kind, `${c}.svg`), "utf8");
  const page = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 2 });
  await page.setContent(`<style>body{margin:16px;font:12px sans-serif;background:#F1F2EF;color:#26282C}
    table{border-collapse:collapse} td{padding:6px 10px;text-align:center} th{font-weight:600;padding:4px 8px}
    .g{color:#F1F2EF;background:#8C352D;border-radius:50%;display:inline-grid;place-items:center}
    .o{color:#8C352D;background:#fff;border:2px solid #8C352D;border-radius:50%;display:inline-grid;place-items:center}</style>
    <table><tr><th></th>${CATS.map((c) => `<th>${c}</th>`).join("")}</tr>
    ${[16, 20, 24, 32].map((px) => `<tr><th>glyph ${px}</th>${CATS.map((c) => `<td><span class="g" style="width:${px + 8}px;height:${px + 8}px"><span style="width:${px}px;height:${px}px;display:block">${svgs["glyph/" + c].replace(/fill="white"/g, 'fill="#8C352D"')}</span></span></td>`).join("")}</tr>`).join("")}
    ${[16, 20, 24, 32].map((px) => `<tr><th>outline ${px}</th>${CATS.map((c) => `<td><span class="o" style="width:${px + 10}px;height:${px + 10}px"><span style="width:${px}px;height:${px}px;display:block">${svgs["outline/" + c]}</span></span></td>`).join("")}</tr>`).join("")}
    </table><style>svg{width:100%;height:100%;display:block}</style>`);
  await page.screenshot({ path: join(SHOTS, "icons-sheet.png"), fullPage: true });
  // 실루엣: 불투명 픽셀 마스크의 IoU (glyph 20px, outline 32px)
  const iou = await page.evaluate(async ({ svgs, pairs }) => {
    const mask = async (svg, px) => {
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.replace(/currentColor/g, "#000").replace('xmlns="http://www.w3.org/2000/svg"', `xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}"`));
      await img.decode();
      const cv = document.createElement("canvas"); cv.width = cv.height = px;
      const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0, px, px);
      const d = ctx.getImageData(0, 0, px, px).data;
      const m = []; let n = 0;
      for (let i = 3; i < d.length; i += 4) { m.push(d[i] > 96); if (d[i] > 96) n++; }
      return { m, n };
    };
    const out = {};
    for (const [kind, px] of [["glyph", 20], ["outline", 32]]) {
      for (const [a, b] of pairs) {
        const A = await mask(svgs[`${kind}/${a}`], px), B = await mask(svgs[`${kind}/${b}`], px);
        let inter = 0, uni = 0;
        for (let i = 0; i < A.m.length; i++) { if (A.m[i] && B.m[i]) inter++; if (A.m[i] || B.m[i]) uni++; }
        out[`${kind} ${a}↔${b}`] = Math.round((inter / uni) * 100) / 100;
      }
      for (const c of Object.keys(svgs).filter((k) => k.startsWith(kind))) {
        const m = await mask(svgs[c], px);
        out[`ink ${c}`] = m.n;
      }
    }
    return out;
  }, { svgs, pairs: PAIRS });
  await page.close();
  return iou;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch();
  const r = await iconReport(browser);
  await browser.close();
  let bad = 0;
  for (const [k, v] of Object.entries(r)) {
    const fail = (k.includes("↔") && v > MAX_IOU) || (k.startsWith("ink") && v < 20);
    if (fail) bad++;
    console.log(`${fail ? "✗" : "✓"} ${k}: ${v}`);
  }
  console.log(`시트: ${join(SHOTS, "icons-sheet.png")}`);
  process.exit(bad ? 1 : 0);
}
