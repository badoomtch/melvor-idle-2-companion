# Changelog

## 0.4.0

Everything 0.3.0 listed as not modelled, a plan that keeps up with your bank, and more of the game counted.

### Fixed

- **Your plan checks every material, not just the step you're on.** It used to tell you to make something you no longer had enough of, such as a Water Battlewand without enough Unpowered Orbs. It now works through every step with your bank as it is, counting what earlier steps use and make. A step that would run short says how many you need and have.
- **Plan steps offer the shop too.** When the shop sells what a step gathers, the step says how many to buy and what they cost, so you can pick. A Bucket of Sand is 5 GP, far quicker than thieving it. Buying ticks the step off like gathering does. A step that will run short of something the shop sells offers the same.
- **A shortfall tops up your plan instead of replacing it.** When a step will run short (89 Bucket of Sand needed, 85 in the bank), a step that gets the other 4 goes in just before it, with the shop price when the shop sells it, and the rest of the plan stays as it was. Only a shortfall nothing you can do makes up gets you a new plan. This works for every plan, not just one.
- **Fewer quick switches.** Changing what you do now counts as 5 minutes in a plan, up from 2, so it only moves you to another method when that saves more than the hassle.
- **Potions and other toolbelt items you use up now cost something.** A Woodcutting potion is used each hit, a Firemaking potion or Blackstone each log you burn, and so on, as the game does. Only where they apply: a sightings log only on its own rock, a lockpick only on chests, a Smithing potion only on recipes with more than one step. Their value comes off profit an hour, and the method details list them. Toolbelt savings count: the Burning Embers Gloves keep 30% of your Blackstone.
- **Rare items shows your progress.** A box for everything you've found out of every rare item, and one per rarity (Legendary, Very rare, Rare, Uncommon), each with a bar. Pick a box to list only that rarity. The page remembers "Only ones I haven't found" and the rarity you picked.
- **Rare items shows what you're working on.** The rare items your current action can give (the thieving target, or the enemy, area or dungeon you're fighting) get a box of their own at the top, with your odds and the time for an even chance of each.
- **Rare items say which tool to put on.** "Equip the tool it needs first" now names it: put a Meteorite Sightings Log in your Mining toolbelt (you have 235, one used up per hit).
- **Each skill page shows the quickest way to your next unlock**, or to the level you're planning for: which method to do for each stretch, how many actions, what to get first, and how long it takes with what's in your bank.
- **Accuracy compares like with like.** Each measurement now keeps what the companion predicted at the time, with your levels and bonuses then, so a bonus you got later no longer shows up as an error. Older records say they're measured against today's numbers.
- **Grain Mill upgrades** no longer count as a bonus to your Farming crops.

### Added: combat

- **Your weapon's special attacks.** Each turn picks an attack the way the game does. Boomerangs and twin blades use theirs every turn. Every hit rolls on its own, turns last until their last hit, and specials that stun, put to sleep, bleed or poison the enemy now count. The combat page shows your weapon's special under your gear.
- **Effects from enemy special attacks.**
  - Bleed, poison, burn and stings now count as damage over time, so food use and death risk include them.
  - Stuns and sleep cost you turns, followed by the game's slowdown afterwards.
  - Enemies that buff themselves (Haste, Vanished, Guarded) count for the time the buff is up.
  - Your effect avoidance and effect-damage reduction protect you as in the game.
- **Death risk with the game's auto-eat.** Your HP at each enemy attack follows the game's eating rule (as many items as it takes, up to full), so death risk and food per hour match a tick-by-tick simulation within a few percent. Dungeons no longer understate the chance of dying per run.
- **Short fights.** Both sides start a full turn after the spawn wait, and an enemy can still swing on the tick it dies. Damage taken per kill against quick kills is now close to the game.
- **Reflect.** Enemy reflect (Thorn Body, Thornhide, Sharp Skin and others) counts as damage you take. Your own reflect (antler helmets, Retribution, prayer potions and others) counts as damage to the enemy.
- **Stacking debuffs and end-of-turn damage.** Off Balance, Quicksand, Exsanguinate, Deep Wound, Ambush, Storm Surge, Rage and Smoke Body now count.
- **Imbuements.** The imbuement you've selected counts in Magic fights, with its rune cost, and the combat page says whether another one you can use gives more XP.
- **Prayer points.** The companion reads your prayer points and says how long they last.
- **Gear from item upgrades.** The combat page's upgrades now include gear you can get by upgrading items in your bank.
- **The combat page works on what you're fighting.** When your save shows you fighting an enemy, the best gear and the upgrades are for that enemy, with a button for the best fight instead. If another enemy gives clearly more XP, it says which and how much.
- **Better upgrade suggestions.** Small gains are listed when they're quick to get: Studded Leather Chaps take seconds to make from 3 Iron Bars and cut damage taken, but used to be left out for gaining no XP. Quick wins come first. Each upgrade says why in the fight's own numbers: the kill time, your hit chance or max hit, how often the enemy hits you, or the food it saves.
- **Combat accuracy.** Checked against a tick-by-tick simulation of every fight you can do:
  - Ward details now count: double ward damage, and your debuffs only landing once the ward is gone.
  - The same stun from two sources no longer counts twice.
  - Starblight's huge max-hit cut now lasts only while it's up, instead of being averaged over the fight.
  - Rarely broken armour is worked out over the whole fight.
  - Fracture counts only for the hits it covers: +69% kills an hour against Blackstone Roller, not +89%.
  - Enemies that heal themselves (Lifesteal, Bloodlands, Drain on Vampires) now heal in the numbers, so their kills are slower and they hit harder. A Vampire takes about 4 minutes to kill with level 99 rune gear, where it used to show 2.
- **Food bonuses in combat.** The food you've selected adds its bonus to the fight while you have some: light, max hit, evasion, power or protection. "Best food" now fights each food with its own bonus, so a food that adds power or protection can come out on top.

### Added

- **Food bonuses for your skills.** Some foods help a skill while they're selected in that skill's own food slot: sushi adds Thieving stealth, and soups cut Agility damage. The companion reads every skill's food slot from your save, counts the bonus while you have some, and the Toolbelts page suggests a better food from your bank.
- **Bonfires and Auroras.** A lit bonfire's XP bonus counts in every skill until it burns out, and a skill's Aurora counts while it has charges. The Overview shows what's running and how long it has left.
- **Rare hunting species.** A rare species doubles the catch and can drop collectables, such as the Golden Egg from a Golden Chicken. They count in Hunting rates, and the collectables now show where they come from in Lookup and Rare items.
- **Thieving same-area pickpocketing.** With the Ko Major 2 node, a success can also rob the other targets of the same type in the area. Their gold and loot now count.
- **Agility damage.** Damage-taken and damage-avoidance bonuses now count.
- **Farming plots.** The companion reads every plot from your save. The Farming page lists what's growing and when it's ready, and empty and locked plots in short. The side panel shows the next harvest, and an alert says when a plot is ready (switch it off in Settings).
- **Hunting choices.** An animal's preferred bait counts while you have some (faster trapping, one bait per trap attempt). Where trapless hunting is allowed and you have no trap for that animal, its success bonus counts and no traps are used. Survey finds (one per catch at most) now count too.
- **Astrology and Firemaking finds.** Every Astrology study can sight a Meteorite, a Starfall or a Golden Starfall; the find grows with your Astrology level, and Starfall chance bonuses count. Burning logs can turn up the same sightings and Fireflies once the Ameria nodes that allow them are unlocked. They show in rates, in Lookup and on the Rare items page, where the time to a first find uses the chance per action.
- **Pickaxe bonuses.** A shatter triples the ore and doubles the XP, and pickaxes that turn ore into bars now count.
- **Astrology bonus events.** The Blue Moon, Blood Moon or Aurora that Astrology turns up is read from your save. Once you switch it on, its bonus counts until its charges run out (the Aurora makes every skill 3% quicker), and the Overview shows what's waiting or running.
- **Compost and fishing bait.** Farming uses the best compost in your bank, one per planting. The fishing bait you've selected counts while you have some, one per catch.
- **More Mastery Guild tasks count once done.** Astrology node totals and nodes per constellation, Hunting journal levels, rare species caught and collectables found are worked out from your save, as the game does when it loads.
- **Item upgrades.** Upgrading items in the bank shows as a source in Lookup and on the Completion page, which says whether you can do it now and what's missing.
- **The Grain Mill.** The Farming page shows what the mill is making or why it stopped, how long its storage lasts, and how much of your ranch's grain it covers.
- **Ranch breeding.** Each enclosure shows how often a baby is likely while there's room, or why it can't breed (for example, a coop that only holds 2).
- **Your ranch.** The companion reads your herd: each enclosure's animals, their variant, hunger, safety and age. The Ranching page shows what the whole ranch makes per hour. Products are added up across the herd and rounded down every hour as the game does, so a lone chicken really gives no raw chicken. It also flags animals that need attention, with an alert when they're hungry or about to die of old age.

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
