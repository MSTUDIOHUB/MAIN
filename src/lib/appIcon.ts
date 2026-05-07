import { invoke, isTauri } from "@tauri-apps/api/core";
import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type AppIconVariant = "light" | "dark";

const ICON_SIZE = 256;
const ICON_INSET = 24;
const ICON_RADIUS = 46;
const M_CENTER_X = 258.98;
const M_CENTER_Y = 263.5;
const M_SCALE = 1.08;
const M_POINTS: Array<[number, number]> = [
  [323.961, 212.5],
  [323.961, 307],
  [297.98, 322],
  [297.98, 243.983],
  [258.98, 266.5],
  [219.98, 243.983],
  [219.98, 322],
  [194, 307],
  [194, 212.5],
  [206.99, 205],
  [258.98, 235.017],
  [310.971, 205],
];

export const APP_ICON_ASSETS: Record<AppIconVariant, string> = {
  light: "/app-icon-light.png",
  dark: "/app-icon-dark.png",
};

export function normalizeAppIconVariant(value: unknown): AppIconVariant {
  return value === "dark" ? "dark" : "light";
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

async function createRuntimeIcon(variant: AppIconVariant): Promise<Image | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const isDark = variant === "dark";
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.beginPath();
  roundedRectPath(
    ctx,
    ICON_INSET,
    ICON_INSET,
    ICON_SIZE - ICON_INSET * 2,
    ICON_SIZE - ICON_INSET * 2,
    ICON_RADIUS,
  );
  ctx.fillStyle = isDark ? "#000000" : "#ffffff";
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  roundedRectPath(
    ctx,
    ICON_INSET,
    ICON_INSET,
    ICON_SIZE - ICON_INSET * 2,
    ICON_SIZE - ICON_INSET * 2,
    ICON_RADIUS,
  );
  ctx.clip();
  ctx.translate(ICON_SIZE / 2, ICON_SIZE / 2);
  ctx.scale(M_SCALE, M_SCALE);
  ctx.translate(-M_CENTER_X, -M_CENTER_Y);
  ctx.beginPath();
  M_POINTS.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = isDark ? "#ffffff" : "#000000";
  ctx.fill();
  ctx.restore();

  const rgba = new Uint8Array(ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data);
  return Image.new(rgba, ICON_SIZE, ICON_SIZE);
}

export async function applyAppIconVariant(value: unknown): Promise<void> {
  if (!isTauri()) return;

  const variant = normalizeAppIconVariant(value);
  const errors: string[] = [];
  let applied = false;
  const icon = await createRuntimeIcon(variant).catch((error) => {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  });

  if (icon) {
    try {
      await getCurrentWindow().setIcon(icon);
      applied = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      icon.close().catch(() => {});
    }
  }

  try {
    await invoke("apply_app_icon_variant", { variant });
    applied = true;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!applied && errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}
