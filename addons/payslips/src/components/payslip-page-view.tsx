import { useMemo } from "react";
import type { DrawnImage, DrawnText, PageDrawing } from "../lib/pdf-render";

const FONT_FAMILY: Record<DrawnText["font"], string> = {
  mono: "Courier New, Courier, monospace",
  serif: "Times New Roman, Times, serif",
  sans: "Helvetica, Arial, sans-serif",
};

/** Thinnest stroke drawn: PDF's zero width means "the thinnest line the device can draw". */
const MIN_STROKE = 0.25;

/** A mask painted in `color` on a transparent canvas, as a PNG data URL; null where there is no canvas. */
function maskToDataUrl(image: DrawnImage): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.widthPx;
    canvas.height = image.heightPx;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const rgb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(image.color);
    const [r, g, b] = rgb ? [parseInt(rgb[1]!, 16), parseInt(rgb[2]!, 16), parseInt(rgb[3]!, 16)] : [0, 0, 0];
    const data = ctx.createImageData(image.widthPx, image.heightPx);
    const pixels = data.data;
    for (let i = 0; i < image.mask.length; i++) {
      if (!image.mask[i]) continue;
      const at = i * 4;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
      pixels[at + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    return canvas.toDataURL();
  } catch {
    return null;
  }
}

/**
 * One drawn PDF page as an SVG on white paper. It is a document, so the ink is black whatever
 * the app's theme; the SVG scales to the width of its container and keeps the page's proportions.
 */
export function PayslipPageView({ drawing }: { drawing: PageDrawing }) {
  const { width, height, texts, lines, rects, images } = drawing;
  const pictures = useMemo(
    () => images.flatMap((image) => {
      const href = maskToDataUrl(image);
      return href ? [{ image, href }] : [];
    }),
    [images],
  );

  return (
    <div className="mx-auto w-full max-w-[860px] rounded-sm border border-neutral-300 bg-white text-black shadow-md">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label="Payslip page"
        className="block"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x={0} y={0} width={width} height={height} fill="#ffffff" />
        {rects.map((r, i) => (
          <rect
            key={`r${i}`}
            x={r.x}
            y={height - r.y - r.h}
            width={r.w}
            height={r.h}
            fill={r.fill ?? "none"}
            stroke={r.stroke}
            strokeWidth={r.stroke ? Math.max(r.width ?? 0, MIN_STROKE) : undefined}
          />
        ))}
        {pictures.map(({ image, href }, i) => (
          <image
            key={`i${i}`}
            href={href}
            x={image.x}
            y={height - image.y - image.h}
            width={image.w}
            height={image.h}
            preserveAspectRatio="none"
          />
        ))}
        {lines.map((l, i) => (
          <line
            key={`l${i}`}
            x1={l.x1}
            y1={height - l.y1}
            x2={l.x2}
            y2={height - l.y2}
            stroke={l.color}
            strokeWidth={Math.max(l.width, MIN_STROKE)}
          />
        ))}
        {texts.map((t, i) => (
          <text
            key={`t${i}`}
            x={t.x}
            y={height - t.y}
            fontFamily={FONT_FAMILY[t.font]}
            fontSize={t.size}
            fill="#000000"
            xmlSpace="preserve"
            style={{ whiteSpace: "pre" }}
            wordSpacing={t.wordSpacing}
            letterSpacing={t.charSpacing}
          >
            {t.text}
          </text>
        ))}
      </svg>
    </div>
  );
}
