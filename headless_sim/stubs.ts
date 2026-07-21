// Minimal browser-global stubs so Babylon's DynamicTexture (name-tag / number
// canvases in entities.ts) can be constructed under Node. We never render, so a
// no-op 2D context is enough. Imported FIRST, before @babylonjs/core.
const ctx: Record<string, unknown> = new Proxy(
  {},
  {
    get: (_t, p) => {
      if (p === "measureText") return () => ({ width: 8 });
      if (p === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (p === "createLinearGradient" || p === "createRadialGradient")
        return () => ({ addColorStop: () => {} });
      if (p === "canvas") return fakeCanvas;
      return () => {};   // every draw method is a no-op
    },
    set: () => true,     // swallow fillStyle/font/etc.
  },
);
const fakeCanvas = {
  width: 0, height: 0,
  getContext: () => ctx,
  toDataURL: () => "",
  style: {},
};
const g = globalThis as Record<string, unknown>;
const setg = (k: string, v: unknown) => {
  try { g[k] = v; } catch { try { Object.defineProperty(g, k, { value: v, configurable: true }); } catch { /* getter-only (e.g. navigator on Node 23) — leave it */ } }
};
setg("document", {
  createElement: (t: string) => (t === "canvas" ? { ...fakeCanvas } : { style: {} }),
  createElementNS: () => ({ style: {} }),
});
setg("window", g);
if (!("navigator" in g)) setg("navigator", { userAgent: "node" });
setg("HTMLCanvasElement", function () {});
setg("OffscreenCanvas", function (w: number, h: number) { return { width: w, height: h, getContext: () => ctx }; });
