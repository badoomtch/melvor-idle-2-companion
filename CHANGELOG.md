# Changelog

## 0.3.0

Checked against Melvor Idle 2 0.11.4 (save version 28). The game's data already matched this build. The fixes below are places where the companion's own formulas didn't match the game's code.

### Fixed: skilling rates

- **Farming**
  - Crops that regrow (fruit trees, bushes) were counted as one harvest. One seed now gives every regrow harvest, so fruit trees show about 4.6 times the XP and produce they did.
  - Pests and disease now cut the yield by whatever the plot isn't protected against. Scarecrows and other protection count, and watering is assumed. Carrot, for example, really loses about 62% without protection.
  - Flowers showed XP and produce. They give neither: they protect the plots around them.
  - Product quantity bonuses and seed preservation now count.
- **Hunting**
  - Each catch's size and weight scale its XP and products, and they grow with the animal's journal level. The companion now reads each animal's journal level from your save.
  - Journal level bonuses now count for that animal: faster tracking, better trap success, fewer tracking steps and more doubling.
  - Tracking and trapping interval bonuses, tracking step skips, trap re-attempts and product bonuses now count.
- **Thieving**
  - A failed attempt hits for 1 to the target's max damage, not the max every time, so food use was about double.
  - Heist bonuses (fewer stages, worth up to +67% XP/h on the Forbidden Library) and location distractions now switch on when your save shows their requirements met.
  - Perception, Fortune, gold, loot chance, stun avoidance and damage avoidance bonuses now count. Doubling now applies to thieving loot.
- **Woodcutting**
  - Tree health rounds up, as in the game. With the rank that cuts tree health, Normal trees showed 50% too fast.
  - The instant cut chance now counts: 1.45 to 1.95 times more logs on Yew to Redwood with the axe bindings.
  - Doubling now covers bird nests and other drops, not just logs.
- **Mining**
  - Minimum prospecting (a head start after each break), stone and essence drops (such as the Essence Imbued Pickaxe), and the chance of an extra ore now count.
  - Doubling covers every drop.
- **Fishing**
  - Min and max catch time bonuses, fish chance, junk rerolls and special item bonuses now count.
  - Special items roll rarest first, as in the game.
- **Herblore**
  - Each brewing stage takes its own interval bonus: Heating I to V take a batch from 30 s to 22.5 s.
  - Bottling bonuses now add potions.
- **Cooking, Firemaking, Crafting and the other crafting skills**
  - Preservation now counts for Cooking and Firemaking, not just crafting.
  - Flat interval bonuses now count, applied in the order each skill's code uses.
  - Product quantity percentages and Cooking difficulty bonuses now count.
  - Firemaking doubling covers its drops and its gold.
- **Astrology**
  - The companion now reads which Astrology nodes you've unlocked. Their bonuses count in every rate, including each constellation's bonus per minor node.

### Fixed: combat

- **Enemy armour**
  - Armour is subtracted from every hit until a hit breaks it. The companion treated it as broken for the whole fight, so kills per hour against armoured enemies were up to twice too high. Treant, for example, goes from 191 to 110 kills an hour with the same gear.
  - Your own armour from bonuses never breaks, so it now reduces every enemy hit.
- **Multi-hit special attacks**
  - These were counted as one huge hit, which flagged dragons, wurms and others as one-hit deaths and dropped them from the recommendations. Each hit now counts on its own for death risk, while the total still counts for damage.
  - A multi-hit turn now lasts until its last hit.
  - "Max hit" attacks deal a fixed share of max hit, with no roll.
- **Overkill:** damage stops at the enemy's remaining HP, so a kill takes whole hits. The companion now counts that.
- **Bonuses that were dropped and now count:**
  - Piety, Rigour and Augury's +420 power, the protection prayers and combat potions' protection, and the Forbidden Grimoire's −69.
  - Combat and Slayer XP bonuses from the Mastery Guild.
  - Percent attack, strength, power and protection bonuses.
  - Crit damage bonuses, flat hit chance, and enemy armour cuts (Penance, Black Opal bolts, the Mastery Guild).
  - Spawn time bonuses.
  - Slayer coin bonuses.
  - Ammo, rune, prayer and food preservation.
  - Astrology's combat bonuses.
- **Area effects:**
  - Dragon's Pass −20% accuracy, Windy Plains enemy evasion, Drowned Abyss enemy accuracy, the deserts' food healing penalty and others now apply. A bought removal turns one off.
  - Blood Sanctum is shown as Melee only, since its enemies are immune to Ranged and Magic.
- **Evasion charms** protect against the attacker's style, whatever you fight with.
- **Enemy passives:**
  - Petrify stuns once at the start of the fight.
  - Smoke Body triggers on your misses.
  - Storm Wrapped's stun now counts.
  - Poison stacks up to its maximum.
  - Unavoidable attacks always hit.
  - Healing enemies give XP for the healing you undo.
- **Ammo:** the best ammo is now picked by trying each sensible option in the fight, not just by ranged strength.

### Fixed: what you can do

- **Recipe gates**
  - Recipes now carry their category's unlock, so locked ones are no longer recommended.
  - That covers 96 recipes: Astral Jewellery, Ironsteel and Dragonrune gear, Super potions and Mill Farm crops.
- **Requirements the save already answers** are now checked instead of shown as "unsure":
  - shop purchases (Slayer permits, Super Potion Research);
  - potions brewed and items found;
  - dungeons finished and Slayer tasks;
  - Agility technique levels;
  - finished quest steps;
  - Astrology nodes.
- **Requirement labels** say what's needed, for example "Brew 1,000 Woodcutting Potion P1-A".
- **Mastery Guild tasks:** many more count once done, using the Combat, Slayer, Astrology, Agility, Ranching and Hunting statistics in your save.

### Fixed: other

- Bank slots are counted like the game, with empty placeholders included.
- Agility: the course path that's actually running is recognised. A warning shows when the path picked in the game isn't the one running yet; it changes when you stop and start the course.

### Added

- **Toolbelts page:**
  - items in your bank worth putting in a skill's toolbelt, measured on that skill's best methods;
  - what's waiting for a slot to open;
  - what's in every toolbelt now.
- **Plan steps say what to put on** when a toolbelt item from your bank makes them quicker, or when a step needs a tool you have.
- **Rare items page:** everything you only get by chance, how rare it is, where to get it and how long it takes at your levels.
- **New-version alerts:** the companion tells you when a new version is on GitHub. You can turn this off in Settings.
- **Bank:** empty placeholders are listed as the quickest slots to free.

### Changed

- Renamed to **Melvor Idle 2 Companion**. The program is now `MelvorIdle2Companion.exe`.
- Your plan hides finished goals and steps.
- A cleaner look: no coloured side stripes, no small all-caps labels, plainer wording, and even spacing between boxes on every page.

### Still not modelled

- Your weapon's special attacks.
- Bonuses from the food you have selected.
- Effects from enemy special attacks (bleed, burn and the like).
- Rare hunting species.
- Thieving pickpocketing other targets in the same area.
- Ranching's hourly rounding.
- Bonfires and Aurora events.
- Farming plot timers.
