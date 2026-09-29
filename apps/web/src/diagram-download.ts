/**
 * 把 SVG 栅格化成 PNG 并下载（DOM 部分，与 diagram-export.ts 的纯逻辑分开）。
 */
import { DIAGRAM_BACKGROUND, PNG_SCALE, svgSize, svgToDataUrl } from "./diagram-export.ts";
import { downloadBlob } from "./download.ts";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("SVG 载入失败"));
    img.src = src;
  });
}

/**
 * 导出 PNG：按 viewBox 的自然尺寸放大 PNG_SCALE 倍，先铺背景色再画图。
 * 失败一律抛错，由调用方就地提示——不能让用户以为下载成功了却没文件。
 */
export async function downloadDiagramPng(
  filename: string,
  svg: string,
  scale: number = PNG_SCALE,
  background: string = DIAGRAM_BACKGROUND,
): Promise<void> {
  const img = await loadImage(svgToDataUrl(svg));
  const size = svgSize(svg) ?? { width: img.naturalWidth, height: img.naturalHeight };
  if (!(size.width > 0) || !(size.height > 0)) throw new Error("SVG 没有可用尺寸，无法栅格化");
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(size.width * scale);
  canvas.height = Math.ceil(size.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("拿不到 2D 绘图上下文");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG 编码失败");
  downloadBlob(blob, filename);
}
