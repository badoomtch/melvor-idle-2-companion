// The fight the save shows you in ("Combat - Treant"), with the gear you have on and the stance, spell
// and food you've selected: what it gives, and what it uses up an hour (food, ammo, runes). Worked out
// once per parse of the save. Isomorphic.
import { buildEnemy, buildPlayer, castableSpells, fight, fightableEnemies, pickFood, savedLoadouts } from './combat.js';

const cache = new WeakMap();

export function currentFight(gd, save, levels) {
  if (!gd.combat || !save?.combat || save.header?.activeEntityName !== 'Combat') return null;
  if (!cache.has(save)) cache.set(save, work(gd, save, levels));
  return cache.get(save);
}

function work(gd, save, levels) {
  const name = String(save.header.activeActionName ?? '').toLowerCase();
  const enemy = gd.enemies.find((e) => e.name.toLowerCase() === name);
  const area = enemy && fightableEnemies(gd, levels).find((x) => x.enemy.id === enemy.id)?.area;
  if (!area) return null;
  const [style, kit] = Object.entries(savedLoadouts(gd, save.combat)).find(([, l]) => l.current) ?? [];
  if (!kit) return null;
  const bank = save.bank?.items ?? {};
  const food = pickFood(gd, bank, save.foods?.Combat ?? save.combat.food);
  const weapon = kit.gear.find((id) => gd.items[id]?.equip?.type === 'Weapon');
  const spells = style === 'Magic' ? castableSpells(gd, weapon, levels, bank) : [];
  const spell = spells.find((s) => s.id === save.combat.spell) ?? spells[0] ?? null;
  const slayerTask = Object.values(save.slayer ?? {}).some((t) => t?.task === enemy.id && t.progress < t.length);
  const player = buildPlayer(gd, { gear: kit.gear, stance: kit.stance, spell, imbuement: style === 'Magic' ? save.combat.imbuement ?? null : null, levels, darkness: area.darkness, area, slayerTask, food });
  const result = fight(gd, player, buildEnemy(gd, enemy), { food });
  const uses = [];
  if (result.foodPerHour > 0 && food) uses.push({ item: food, perHour: result.foodPerHour });
  if (result.ammoPerHour > 0 && player.ammoId) uses.push({ item: player.ammoId, perHour: result.ammoPerHour });
  for (const r of result.runesPerHour ?? []) if (r.perHour > 0) uses.push({ item: r.item, perHour: r.perHour });
  // The skill the stance trains most (not Hitpoints), for the time to your next level.
  const skill = Object.entries(result.xpPerHour ?? {}).filter(([s]) => s !== 'Hitpoints' && s !== 'Prayer').sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { enemy, area, style, kit, food, spell, player, result, uses, skill };
}
