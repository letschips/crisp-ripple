// Obsidian-free so the licence state machine and its tests can use it.
/**
 * Chat apps mangle long codes when they are copied: line breaks, spaces (incl. full-width/NBSP),
 * zero-width characters, and surrounding text such as "卡密：…。". Returns the bare code.
 */
export function normalizeLicenseCode(input: unknown): string {
  if (typeof input !== "string") return "";
  const compact = input.replace(/[\s​-‍⁠﻿]/g, "");
  const match = compact.match(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/);
  return match ? match[0] : compact;
}
