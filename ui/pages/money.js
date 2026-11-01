// Money: ranked money makers.
import { bestMoney } from '/engine/advisor.js';
import { esc } from '/ui/format.js';
import { methodRows, pageHead, table } from './shared.js';

// ---------- Money ----------

export function money(ctx) {
  const { gd, state } = ctx;
  const m = bestMoney(gd, ctx.levels, { bank: ctx.stock, limit: 15 });
  const foodSelect = `<label>Food you eat when hit <select id="food-select" data-bind="food">${gd.foods
    .map((f) => `<option value="${esc(f.item)}"${f.item === (state.food ?? gd.defaultFood) ? ' selected' : ''}>${esc(gd.itemName(f.item))} (heals ${f.heal}, sells ${f.value})</option>`)
    .join('')}</select></label>`;
  const head = ['Method', 'Skill', '#Lvl', '#XP / h', '#GP / h', 'Notes'];
  return `${pageHead('Making money', 'Ranked by profit per hour at your levels, after paying for materials and food.', foodSelect)}
    <h2>No materials needed</h2>
    <p class="small muted">Gathering and thieving: you can start these with an empty bank.</p>
    ${table(head, methodRows(ctx, m.selfSufficient))}
    ${ctx.bank ? `<h2>With what's in your bank</h2><p class="small muted">Crafts you can run right now. "Lasts" is how long your current materials keep it going.</p>${table(['Method', 'Skill', '#Lvl', '#XP / h', '#GP / h', '#Lasts', 'Notes'], methodRows(ctx, m.fromBank, { sustain: true }), 'Nothing profitable to craft from your bank right now.')}` : ''}
    <h2>Crafting for profit</h2>
    <p class="small muted">Value added: the product sells for more than its materials. You need the materials. Gather them yourself to earn the gathering profit too.</p>
    ${table(head, methodRows(ctx, m.crafting))}
    <h2>Passive: farming (per plot)</h2>
    ${table(head, methodRows(ctx, m.passive))}
    ${m.conditional.length ? `<h2>If you have the right gear</h2><p class="small muted">These need a tool you don't have yet${ctx.state.levelSource === 'save' && ctx.save ? '' : ' (load a save to check your toolbelts)'}, or something the companion can't see in your save, so they're left out of the rankings above.</p>${table(head, methodRows(ctx, m.conditional, { markBest: false }))}` : ''}`;
}
