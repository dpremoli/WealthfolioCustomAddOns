import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageDrawing } from "../lib/pdf-render";
import { PayslipPageView } from "./payslip-page-view";

const drawing = (over: Partial<PageDrawing> = {}): PageDrawing => ({
  width: 595,
  height: 842,
  texts: [],
  lines: [],
  rects: [],
  images: [],
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("PayslipPageView", () => {
  it("is an svg with the page's viewBox that scales with its container", () => {
    const { container } = render(<PayslipPageView drawing={drawing()} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 595 842");
    expect(svg.getAttribute("width")).toBe("100%");
    expect(svg.getAttribute("height")).toBeNull();
  });

  it("flips y, sets the font and keeps spaces in text", () => {
    const { container } = render(
      <PayslipPageView
        drawing={drawing({
          texts: [
            { x: 20, y: 800, size: 12, font: "mono", text: "  Net Pay" },
            { x: 30, y: 700, size: 10, font: "serif", text: "Example House" },
            { x: 40, y: 600, size: 9, font: "sans", text: "Plain", wordSpacing: 2 },
          ],
        })}
      />,
    );
    const [mono, serif, sans] = [...container.querySelectorAll("text")];
    expect(mono!.textContent).toBe("  Net Pay");
    expect(mono!.getAttribute("x")).toBe("20");
    expect(mono!.getAttribute("y")).toBe("42"); // 842 - 800
    expect(mono!.getAttribute("font-size")).toBe("12");
    expect(mono!.getAttribute("font-family")).toBe("Courier New, Courier, monospace");
    expect(mono!.getAttribute("xml:space")).toBe("preserve");
    expect(serif!.getAttribute("font-family")).toBe("Times New Roman, Times, serif");
    expect(sans!.getAttribute("font-family")).toMatch(/sans-serif$/);
    expect(sans!.getAttribute("word-spacing")).toBe("2");
  });

  it("draws lines and rectangles with flipped y", () => {
    const { container } = render(
      <PayslipPageView
        drawing={drawing({
          lines: [{ x1: 28.35, y1: 524.4, x2: 28.35, y2: 473.4, width: 0.75, color: "#000000" }],
          rects: [{ x: 10, y: 20, w: 30, h: 40, fill: "#00ff00", stroke: "#0000ff", width: 2 }],
        })}
      />,
    );
    const line = container.querySelector("line")!;
    expect(line.getAttribute("x1")).toBe("28.35");
    expect(Number(line.getAttribute("y1"))).toBeCloseTo(317.6);
    expect(Number(line.getAttribute("y2"))).toBeCloseTo(368.6);
    expect(line.getAttribute("stroke-width")).toBe("0.75");
    expect(line.getAttribute("stroke")).toBe("#000000");
    const rect = container.querySelector("rect[fill='#00ff00']")!;
    expect(rect.getAttribute("y")).toBe("782"); // 842 - (20 + 40)
    expect(rect.getAttribute("stroke")).toBe("#0000ff");
  });

  it("draws a zero-width line and a zero-width stroked rectangle hairline thin, not invisible", () => {
    const { container } = render(
      <PayslipPageView
        drawing={drawing({
          lines: [{ x1: 0, y1: 0, x2: 10, y2: 0, width: 0, color: "#000000" }],
          rects: [{ x: 0, y: 0, w: 10, h: 10, stroke: "#000000", width: 0 }],
        })}
      />,
    );
    expect(container.querySelector("line")!.getAttribute("stroke-width")).toBe("0.25");
    expect(container.querySelector("rect[stroke]")!.getAttribute("stroke-width")).toBe("0.25");
  });

  it("sits on a white paper whatever the theme", () => {
    const { container } = render(<PayslipPageView drawing={drawing()} />);
    const paper = container.firstElementChild as HTMLElement;
    expect(paper.className).toMatch(/bg-white/);
    expect(paper.className).toMatch(/text-black/);
  });

  it("draws an image mask through a canvas data URL", () => {
    const putImageData = vi.fn();
    const ctx = { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), putImageData };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAAA");
    const { container } = render(
      <PayslipPageView
        drawing={drawing({
          images: [{ x: 30, y: 738, w: 100, h: 20, widthPx: 2, heightPx: 1, mask: Uint8Array.from([1, 0]), color: "#ff0000" }],
        })}
      />,
    );
    const image = container.querySelector("image")!;
    expect(image.getAttribute("href")).toBe("data:image/png;base64,AAAA");
    expect(image.getAttribute("x")).toBe("30");
    expect(image.getAttribute("y")).toBe("84"); // 842 - (738 + 20)
    expect(image.getAttribute("width")).toBe("100");
    expect(image.getAttribute("height")).toBe("20");
    expect(image.getAttribute("preserveAspectRatio")).toBe("none");
    const pixels = (putImageData.mock.calls[0]![0] as { data: Uint8ClampedArray }).data;
    expect([...pixels]).toEqual([255, 0, 0, 255, 0, 0, 0, 0]); // painted red, then transparent
  });

  it("fills the pixels by direct writes, without allocating an array per pixel", () => {
    const set = vi.spyOn(Uint8ClampedArray.prototype, "set");
    const ctx = { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), putImageData: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAAA");
    render(
      <PayslipPageView
        drawing={drawing({ images: [{ x: 0, y: 0, w: 10, h: 10, widthPx: 3, heightPx: 1, mask: Uint8Array.from([1, 0, 1]), color: "#010203" }] })}
      />,
    );
    expect(set).not.toHaveBeenCalled();
    expect([...(ctx.putImageData.mock.calls[0]![0] as { data: Uint8ClampedArray }).data]).toEqual([1, 2, 3, 255, 0, 0, 0, 0, 1, 2, 3, 255]);
  });

  it("skips images without crashing when there is no canvas", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { container } = render(
      <PayslipPageView
        drawing={drawing({
          texts: [{ x: 0, y: 0, size: 8, font: "mono", text: "still here" }],
          images: [{ x: 0, y: 0, w: 10, h: 10, widthPx: 1, heightPx: 1, mask: Uint8Array.from([1]), color: "#000000" }],
        })}
      />,
    );
    expect(container.querySelector("image")).toBeNull();
    expect(container.querySelector("text")!.textContent).toBe("still here");
  });
});
