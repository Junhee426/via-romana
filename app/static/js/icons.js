/* 고고학 아이콘 레지스트리 (glyph 9 + outline 9)
 *
 * - SVG 18개를 한 번만 받아 온다 (마커마다 요청하지 않음)
 * - DOM(범례·필터·목록·상세)에는 숨긴 <symbol> 스프라이트를 만들어 <use>로 재사용한다
 * - 지도에는 DOM 마커 대신, 분류별 배지를 미리 캔버스에 그려 두고 지도 캔버스에 찍는다
 *   (유적 1만 곳에 SVG DOM을 만들지 않기 위해)
 */
window.ViaIcons = (() => {
  "use strict";

  const CATS = ["town", "military", "sacred", "arena", "water", "road", "villa", "burial", "industry"];
  const SITE_ICON_PATHS = Object.fromEntries(CATS.map((c) => [c, {
    glyph: `/icons/glyph/${c}.svg`,
    outline: `/icons/outline/${c}.svg`,
  }]));
  const MARBLE = "#F1F2EF";
  const PRESENTATION = ["fill", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"];

  // 배지 크기(CSS px): 배지 지름과 그 안의 아이콘 크기
  const SIZES = {
    glyph: { badge: 22, icon: 14 },
    outline: { badge: 30, icon: 19 },
  };

  const text = {};          // "glyph/town" → SVG 원문
  const badges = new Map(); // "glyph/town/B/2" → 캔버스
  let loading = null;

  function load() {
    if (loading) return loading;
    loading = Promise.all(Object.entries(SITE_ICON_PATHS).flatMap(([cat, p]) =>
      ["glyph", "outline"].map(async (kind) => {
        const res = await fetch(p[kind]);
        if (!res.ok) throw new Error(`아이콘 ${p[kind]}: HTTP ${res.status}`);
        text[`${kind}/${cat}`] = await res.text();
      }))).then(buildSprite);
    loading.catch(() => { loading = null; });   // 실패하면 다음에 다시 시도
    return loading;
  }

  // <svg> 루트의 표현 속성을 <g>로 옮겨 <symbol> 안에서도 같은 모양이 되게 한다
  function buildSprite() {
    if (document.getElementById("via-icon-sprite")) return;
    const ns = "http://www.w3.org/2000/svg";
    const sprite = document.createElementNS(ns, "svg");
    sprite.id = "via-icon-sprite";
    sprite.setAttribute("aria-hidden", "true");
    sprite.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    for (const [key, svg] of Object.entries(text)) {
      const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      const symbol = document.createElementNS(ns, "symbol");
      symbol.id = `ico-${key.replace("/", "-")}`;
      symbol.setAttribute("viewBox", root.getAttribute("viewBox") || "0 0 24 24");
      const g = document.createElementNS(ns, "g");
      for (const a of PRESENTATION) if (root.hasAttribute(a)) g.setAttribute(a, root.getAttribute(a));
      for (const child of Array.from(root.childNodes)) g.appendChild(document.importNode(child, true));
      // 흰 음각 디테일은 CSS 변수(--ico-hole)로 칠할 수 있게: 배지 안에서는 배지 색으로 뚫려 보인다
      g.querySelectorAll('[fill="white"]').forEach((el) => {
        el.removeAttribute("fill");
        el.style.fill = "var(--ico-hole, #fff)";
      });
      symbol.appendChild(g);
      sprite.appendChild(symbol);
    }
    document.body.prepend(sprite);
  }

  // 장식용 아이콘: 스크린리더에는 숨기고 옆의 글자로 뜻을 전한다
  const use = (kind, cat, cls = "") =>
    `<svg class="ico ${cls}" aria-hidden="true" focusable="false"><use href="#ico-${kind}-${cat}"></use></svg>`;

  function svgImage(svg, px, color, hole) {
    let s = svg.replace(/currentColor/g, color);
    // glyph의 흰 음각 디테일(방패 돌기, 도로 표시 등)은 배지 색으로 칠해 뚫린 것처럼 보이게 한다
    if (hole) s = s.replace(/fill="white"/g, `fill="${hole}"`);
    s = s.replace("<svg ", `<svg width="${px}" height="${px}" `);
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
    return img.decode().then(() => img);
  }

  /* 분류 배지를 캔버스에 미리 그린다.
   *   glyph      : 분류 색 원 + 대리석색 채움 아이콘 (중간 줌)
   *   outline B  : 대리석색 원 + 분류 색 테두리·윤곽 아이콘 (높은 줌, 기본)
   *   outline A  : 분류 색 원 + 대리석색 윤곽 아이콘 (비교용)
   */
  async function prepareBadges(colors, dpr, outlineStyle = "B") {
    const jobs = [];
    for (const cat of CATS) {
      const color = colors[cat];
      for (const kind of ["glyph", "outline"]) {
        const key = `${kind}/${cat}/${outlineStyle}/${dpr}`;
        if (badges.has(key)) continue;
        const { badge, icon } = SIZES[kind];
        const light = kind === "outline" && outlineStyle === "B";
        jobs.push(svgImage(text[`${kind}/${cat}`], icon * dpr, light ? color : MARBLE, kind === "glyph" ? color : null).then((img) => {
          const px = (badge + 4) * dpr;   // 테두리 여유
          const cv = document.createElement("canvas");
          cv.width = cv.height = px;
          const ctx = cv.getContext("2d");
          const c = px / 2;
          const r = (badge / 2) * dpr;
          ctx.beginPath();
          ctx.arc(c, c, r, 0, Math.PI * 2);
          ctx.fillStyle = light ? "#FBFAF6" : color;
          ctx.fill();
          ctx.lineWidth = (light ? 2 : 1.5) * dpr;
          ctx.strokeStyle = light ? color : MARBLE;
          ctx.stroke();
          ctx.drawImage(img, c - (icon * dpr) / 2, c - (icon * dpr) / 2);
          badges.set(key, cv);
        }));
      }
    }
    await Promise.all(jobs);
  }

  const badge = (kind, cat, outlineStyle, dpr) => badges.get(`${kind}/${cat}/${outlineStyle}/${dpr}`);

  return { CATS, SITE_ICON_PATHS, SIZES, load, use, prepareBadges, badge, text };
})();
