/* 지도 위 캔버스 레이어 (DOM 마커 없이 유적 1만 곳을 그리기 위한 것)
 *
 * - 화면보다 사방으로 PAD만큼 큰 캔버스를 지정한 pane에 놓고, 이동이 끝나면(moveend) 다시 그린다
 *   → 드래그 중에는 캔버스가 지도와 함께 움직이고 가장자리도 비지 않는다
 * - 줌 애니메이션 중에는 숨겼다가 끝나면 새로 그린다
 * - draw(ctx, view)의 좌표는 지도 컨테이너 픽셀 기준 (map.latLngToContainerPoint)
 */
window.ViaCanvasLayer = L.Layer.extend({
  options: { pane: "overlayPane", pad: 0.35, draw: null },

  initialize(options) { L.setOptions(this, options); },

  onAdd(map) {
    this._canvas = L.DomUtil.create("canvas", "via-canvas");
    this._canvas.setAttribute("aria-hidden", "true");
    map.getPane(this.options.pane).appendChild(this._canvas);
    map.on("moveend zoomend resize viewreset", this.reset, this);
    map.on("zoomstart", this._hide, this);
    this.reset();
  },

  onRemove(map) {
    map.off("moveend zoomend resize viewreset", this.reset, this);
    map.off("zoomstart", this._hide, this);
    this._canvas.remove();
  },

  _hide() { this._canvas.style.visibility = "hidden"; },

  // 위치·크기를 맞추고 다시 그린다
  reset() {
    const map = this._map;
    if (!map) return;
    const size = map.getSize();
    const pad = size.multiplyBy(this.options.pad).round();
    const dpr = window.ViaCanvasLayer.dpr();
    const w = size.x + pad.x * 2;
    const h = size.y + pad.y * 2;
    const cv = this._canvas;
    L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([-pad.x, -pad.y]));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    this._view = { size, pad, dpr, min: L.point(-pad.x, -pad.y), max: L.point(size.x + pad.x, size.y + pad.y) };
    this.redraw();
    cv.style.visibility = "";
  },

  // 위치는 그대로 두고 내용만 다시 그린다 (선택·강조 변경 등)
  redraw() {
    const v = this._view;
    if (!v || !this.options.draw) return;
    const ctx = this._canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    ctx.setTransform(v.dpr, 0, 0, v.dpr, v.pad.x * v.dpr, v.pad.y * v.dpr);
    this.options.draw(ctx, v);
  },
});

// 캔버스 배율. 2배까지만: 3배 기기에서 화면보다 큰 캔버스 세 장이 수백 MB를 쓰지 않게.
// 미리 그려 두는 배지(app.js)도 이 값으로 만들어야 캔버스에 1:1로 찍힌다
window.ViaCanvasLayer.dpr = () => Math.min(2, window.devicePixelRatio || 1);
