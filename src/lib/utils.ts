// lib/utils.ts
// Shared pure utility functions for the Local Agent IDE
// ──────────────────────────────────────────────────────

/** Generate a short random ID for messages / keys. */
export function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Clamp a number between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Naive token estimator: 1 token ≈ 4 chars (GPT-style approximation). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Format bytes to a human-readable string (KB / MB / GB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Estimate VRAM required for a token count (~130 MB / 1000 tokens). */
export function estimateVramMb(tokens: number): number {
  return Math.ceil((tokens / 1000) * 130);
}

/** Merge CSS class strings (removes falsy values). */
export function cx(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}
