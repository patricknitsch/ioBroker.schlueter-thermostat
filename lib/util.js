'use strict';

function safeId(id) {
  return String(id).replace(/[^\w.-]/g, '_');
}

// Many values come as integer in hundredths of °C (e.g. 2175 => 21.75)
function numToC(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;

  // Heuristic: if value is large (>= 100) treat as hundredths; else already °C
  if (Math.abs(n) >= 100) return Math.round((n / 100) * 100) / 100;
  return Math.round(n * 100) / 100;
}

function cToNum(tempC) {
  if (tempC === undefined || tempC === null) return null;
  const n = Number(tempC);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function deepGet(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

module.exports = { safeId, numToC, cToNum, deepGet };
