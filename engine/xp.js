// The game's experience curve (StandardExperienceTable.Default), reproduced exactly.
// Runs in Node and in the browser.

export const DEFAULT_XP_TABLE = { scaling: 0.25, exponentScaling: 300, base: Math.pow(2, 1 / 7) };

export function createXpTable(params = DEFAULT_XP_TABLE) {
  const { scaling, exponentScaling, base } = params;
  const cache = [0];
  let xpSum = 0;

  function xpForLevel(level) {
    if (level < 1) return 0;
    for (let i = cache.length; i < level; i++) {
      xpSum += Math.floor(i + exponentScaling * Math.pow(base, i));
      cache.push(Math.floor(scaling * xpSum));
    }
    return cache[level - 1];
  }

  function levelForXp(xp, cap = Infinity) {
    if (!(xp > 0)) return 1;
    let level = 1;
    while (level < cap && xp >= xpForLevel(level + 1)) level++;
    return level;
  }

  // Progress through the current level as 0..1 (1 at the cap).
  function levelProgress(xp, cap = Infinity) {
    const level = levelForXp(xp, cap);
    if (level >= cap) return { level, progress: 1, xpIntoLevel: 0, xpForNext: 0 };
    const start = xpForLevel(level);
    const next = xpForLevel(level + 1);
    return { level, progress: (xp - start) / (next - start), xpIntoLevel: xp - start, xpForNext: next - xp };
  }

  return { xpForLevel, levelForXp, levelProgress };
}

export const defaultXpTable = createXpTable();
