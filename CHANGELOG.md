# Changelog

## 0.4.4

### Changed

- **Updated for Melvor Idle 2 0.11.5 (alpha.2).**
  - **Saves from 0.11.5 read again.** The game no longer saves levels, only XP, and each quest task has a new flag. With a 0.11.5 save the companion read no skills, quests, Agility techniques or hunting journal. It now works out each level from XP the way the game does: skills up to 120, Agility techniques up to their cap, journal entries up to 25. The formulas give the same levels older saves stored, and they add up to the total level the game saves.
  - **Rune Packs** no longer need Runecrafting 70 or 95, only their Mastery Guild rank.
  - **Agility Marks:** courses drop them at new rates. The Arena's charms and technique cheat sheets now cost Agility Marks in place of Arena Reward Tokens, and the charms no longer need a technique level.
  - **Silted Oasis and Sea Cliffside** open once their quest is finished, not after its first step. The quests' fights moved to areas of their own, which plans leave out. Moonscarred Crater also needs the Silver Slayer Permit now.
  - **Farming:** Compost gives +40% crops (was +20%), Super Compost +45% (was +40%).
  - **Gear:** 60 pieces need lower levels, for example upgraded Mithril armour needs Defence 40 (was 43). The Ceedyr Cape's bonus now applies on a Slayer task, not in Slayer areas.
  - **Drops:** burning Blessed Logs can give Blessed Fragments, Quiet Bend can give Rope, the Stone Mason gives more Clay, and Yellowtail Birds have a second rare species, the Dreamtail.
  - **Prices:** jewellery, staves and wands sell for more, Feathers for less (1 GP, was 4). The Arena Entry Ticket costs 750 GP (was 1,000).
  - **Shop:** four new combat utility items (Thorned Buckle, Sentinel Charm, Icy Strand, Mending Flesh, 25,000 GP each), plus basic arrows, javelins, boomerangs and Topaz Bolts.
  - **Toolbelt:** Fireflies in a Jar (Farming) is used once per harvest, and Warped Cacti Water once per kill.
  - The Stone Spear Head is gone, and new icons replace missing artwork.

## 0.4.3

### Fixed

- **Plans craft long material chains instead of pickpocketing the bottom of them.** The planner only looked 3 steps deep for materials, and beyond that it only used sources that need nothing, which means pickpocketing. Hunting chains are longer: Thornback Lizard Spikes are hunted with Nets, Nets need Rope and String, String needs Flax. So a Beastcrafting goal sent you to the Craftsman for 40 String (437 pickpockets) and the Thug for Rope, while another step in the same goal crafted String anyway. It now looks 6 steps deep. For Beastcrafting 28 to 31 with an empty bank, the plan goes from about 3h 26m to 1h 16m.
- **Materials for one recipe no longer count on the same bank twice.** Thornback Camo pieces use String, and so do the Nets their spikes are hunted with. Each was worked out as if it had all your String, so the plan made too little and you ran short part-way. Each material now comes out of what the others leave.
- **Running short part-way through a goal gets you enough for the rest of it in one go.** The companion added a top-up before each step that ran out, so you made String three times for one goal. A top-up now covers every later step in that goal that uses the item.
- **A goal never lists the same thing twice.** When the plan put the training you were already doing first in a goal, the shortfall check counted it before the goal's own stocking up. The training looked short, so it got a top-up of its own: "Make 20 Sapphire", added because you had less than expected, then the goal's "Make 56 more Sapphire" right after. Stocking up now counts first, as the page lists it. When you really are short, the goal's own step for that item does more ("20 more than planned") in place of a second step. It makes the extra the same way as that step, even if another way would now be quicker.

  Training is one run per method too. A plan could leave a method for a short detour (a few of something better while your materials last) and come back to it: "Mithril 2H Crossbow × 75", "Mithril Spear × 30", "Mithril 2H Crossbow × 32". The runs now join, with the detour after them: "Mithril 2H Crossbow × 107", then "Mithril Spear × 30". It's the same actions and XP. This applies to plans and to each skill's training path.
- **"Do this now" lists what the step uses**, for example "Uses 22 Rabbit Fur, 66 Leather and 66 String", so a step can't be mixed up with a similar-looking recipe in the game.
- **Your measured speed no longer changes what each action uses.** Being a little slower than the estimate means fewer actions an hour, but the plan also counted more material per action (about 2% in one case). That made shortfall warnings come early and gathering steps a little too long.

- **Heist tasks are timed by heists, not attempts.** The game only counts a heist once every stage is stolen, but the Mastery Guild plan counted each pickpocket attempt. At 11.5% success on the Forbidden Library's 10 stages, "Complete 10 Heists in Mage Tower" showed under a minute. It now shows about 1h 13m. These tasks now use the game's wording: "Complete 10 Heists" and "Steal from 300 NPCs" in place of "Pickpocket 10 Heists targets".
- **Targets that can kill you aren't planned as if you could leave them running.** A failed pickpocket or Agility obstacle can hit for more than the HP where auto-eat tops you up, and then one hit can take you to 0. Dying stops the skill and can lose a toolbelt item. The companion now works this out from your Hitpoints, your auto-eat bonuses and the food picked for that skill. Anything that would kill you within 8 hours is handled like a risky fight:
  - Mastery Guild plans leave it out. The skill page lists those tasks under "Left out", with their time if you eat by hand.
  - Training plans pick something else.
  - Method lists mark it "Could kill you" and don't call it the best. Its details say how big the hits are, when auto-eat eats, and the Hitpoints level from which it's safe.
- **Item pages give your real chances and put the best source first.** The chances added in 0.4.2 were the game's base numbers, so thieving loot ignored your success chance: a Cursed Circlet from the Forbidden Library showed 1 in 237 attempts when at 11.5% success it's about 1 in 2,000. They also left out your bonuses, and "likeliest first" compared a hit with a steal attempt or a kill. Now every chance counts your success chance and bonuses (cooking counts burnt food too). Each source you can do says how many it gives you an hour, fights included.
  - Sources are ordered: sure ways (the shop, upgrades, the Grain Mill), then what you can do now, most an hour first, then the rest.
  - Anything that can kill you comes after the safe ones and is marked.
  - A source you can't do yet says what it needs.

  For Bird Nests, every tree you can cut (about 9.5 an hour) now comes before the Bandit Woodcutter (2.5 an hour, and it can kill you).
- **Plan steps no longer say "until" a level you already have.** When your bank only has materials for part of a level, the plan uses them up and then moves to something else. That step gains no level, but it still said "Make Fire Battlewand × 16 more until Runecrafting 41" when you were already 41. It now says "for Runecrafting XP, until you run out of Fire Rune". Plans made before this update say "as far as your materials go". The skill page's training path says "at level 41" for these steps in place of "level 41 → 41".
- **Hunting says what to tick in the game.** With no Butterfly Kit, the plan said "Hunt Green Butterfly" and counted on trapless hunting, but never said the game only does that with "Enable Trapless Hunting" ticked for that animal. The companion now reads each animal's settings from your save. Plan steps and method details say what's missing:
  - tick "Enable Trapless Hunting" when the plan counts on it;
  - tick "Use Bait?" when it counts on bait, since the game only uses bait with it ticked;
  - select a trap you have, when none is selected or you've run out of the one that is.

  An animal with trapless hunting ticked is now planned without traps, as the game hunts it.
- **Trapless hunting checks your Agility techniques.** Butterflies can be hunted without a trap from a Hunting level once enough Agility techniques are high enough (2 at level 10 for the Green Butterfly). The companion didn't read that condition and assumed you had it. It now checks your technique levels from the save.

## 0.4.2

### Added

- **Item pages show how likely each source is.** Every way to get an item says its chance per action (0.25% per hit, 1 in 400), and the likeliest come first. Thanks to luosky for this one.

### Fixed

- **Typing in a number box no longer jumps the cursor to the start.** Typing 120 in "Level to plan for" gave 21, because the page redrew the box after each key. The box you're typing in now stays as it is: Level to plan for, the Away planner's hours and the Calculators' boxes all type normally, cursor and all.
- **"No XP" waits as long as the action really takes.** It used to warn after 90 seconds without XP, which a single hunting catch often takes. Now it waits for the longest the action normally goes between XP, slower only 1 time in 10,000. That's about 8 minutes for a Bushland Rabbit, and longer for slower animals, the last stage of a heist or a hard Agility course. Quick actions still warn after 90 seconds. Switching to another action, or closing the game, starts the wait again.

## 0.4.1

### Fixed

- **Fights show in Right now.** The Overview, the side panel and the pop-out window used to say a fight "isn't analysed yet". They now show it with the gear you have on: XP an hour, a kill every so many seconds, the time to your next level, the risk, and whether another style or your best gear does clearly better. Its food, ammo and runes count as supplies from the first autosave, not after a minute of play.
- **"What uses it" no longer calls useful items safe to sell.** It only looked at recipes and shop costs, so a Thug Chest Key, gear, ranch treats, quest items and hunting traps all showed "Nothing. Safe to sell". It now covers every place the game asks for an item:
  - recipes, including the quest-only ones;
  - keys and tools a target or rock needs;
  - quest hand-ins and objectives;
  - ranch food, treats and buildings;
  - bait and traps, and runes for spells and imbuements;
  - entry, upgrade, shop and automation costs;
  - what the item is: gear, food, a toolbelt item, something to open or bury.

  When nothing uses an item, it says so without calling it safe to sell. The Bank page's list is now "Nothing uses these" and leaves out rare finds.
- **Rare item odds for thieving are per successful steal**, since loot only rolls on a success, with your success rate beside them.
- **Combat is closer to the game.** Checked against a tick-by-tick simulation of the fights:
  - Stacks and effects enemy passives put on you now count: Acid Burns, Plague Touch, Burning Flame, Corrupting Touch, Blind and Sandstorm. They were left out, so some enemies hit far harder than shown. A Flamberian Defector does 224k damage a kill, not 46k.
  - Your percentage protection now counts, and so do Pestilent's extra poison damage and Burning Shield's armour.
  - Kill times follow your weapon's special attacks hit by hit, so specials that take longer some turns are no longer averaged. Griffin Claws: 3.6s a Golbin, matching the simulation.
  - Fracture counts its protection and armour cuts separately: +62% kills an hour against Blackstone Roller, not +69%.
  - Enemies that heal (Silt Mosquito) heal turn by turn against your actual hits, and healing at full HP is lost. Silt Mosquito with a Magic Bow takes 142s, not 117s.
- **Combat checked against every enemy.** A sweep of almost a thousand fights against the simulation found and fixed:
  - Starblight covers your whole next attack, and the Starblighted that follows (less max hit and accuracy for 5 turns) now counts. Every Starblight enemy is within 4%, from 8 to 15% off.
  - Effects an enemy puts on you count by the attacks they cover, not by time.
  - Avoidance from effects that are up (Poison Weak, Bleed Weak) and Wall of Blood's extra ward count.
  - Shambling Protection's armour and evasion drop count together.
  - Damage over time from enemies that hit several times a turn runs hit by hit. Blood Fiend's Bleed was 9% low and Soulsmith Corruptor's Poison 18% low; both are now within 4%.
  - Enemies that heal come a hit at a time. Silt Mosquito against Fire Wave is within 3%, from 10%.
  - King Oyadazminis counted one bonus twice and was up to 75% off; it's now within 2%.
  - Armour breaking follows your hits when your turns vary (Blackstone Golem with a greatsword, 30% off, now 2%).
  - Stuns end with the fight, a stun no longer cuts Storm Surge short, and a rounding slip in damage over time is fixed.
- **An empty quiver counts as empty.** An emptied ammo or food slot used to count as one left, so you'd see "under a minute left" instead of "Out of".
- **Food for skilling is the food you selected.** Thieving and Agility damage now uses the food in that skill's food slot in the game, for its cost and for how long it lasts. It used to use the companion's own pick, so it could warn you'd run out of a food you weren't using. With no food selected, there's no food warning, since the game doesn't eat.

### Added

- **Point at any item to see what it is.** A card shows its picture, stats, what it needs, what it's worth and how many you have, without leaving the page.
- **Item pages show what an item does.** Gear lists its attack and defence bonuses for each style, strength, attack speed, power, protection, extra bonuses and level requirements. Toolbelt items list their effects, food its healing.
- **Every item has a picture.** About 300 items have no art in the game itself; they now show the game's own placeholder instead of nothing. Enemies in "Where to get it" have their pictures too.
- **A ? beside each gear swap says why.** Hover it for what changes (attack speed, attack and strength bonuses, power, protection, extra bonuses) and how much XP that one piece gains on its own against the enemy.
- **Rare finds.** When you find a Rare, Very rare or Legendary item, the companion logs it and sends a desktop notification (switch it off in Settings). The Rare items page shows your last two finds. The log keeps only the latest 200, so it stays small.
- **Tries so far.** Each rare item says how many tries you've already had at it, from your save's own counts (successful steals and tries, kills, catches, runs, studies, logs cut, ores mined, chests opened), about how long that took, and how many players would have one by then. The odds now shown are at your level, the same the time is worked out with.
- **While you were away.** Come back after 30 minutes or more and the Overview sums up what happened: XP and levels gained, gold, rare finds, and whether the game stopped saving, went idle or stopped gaining XP.
- **Stock up before you start.** The Overview's Supplies card works out what you'd run out of in 1, 2, 4, 8 or 12 hours, and the quickest way to get enough: making it, materials first (ore, bars, arrowtips, shafts and feathers for arrows), or the shop price when it sells it.
- **A style for each Slayer task.** "Fight with" is now the style that kills fastest with the best gear you own for that enemy, with the other styles' kills an hour beside it and a link to the gear.
- **Desktop notifications, asked once.** The page asks whether to turn them on, since they're off until you do.
- **The pop-out window shows the warnings and fights** as the top bar and Right now do.
- **A Mastery dot in the menu** when your action counts towards an open Mastery Guild task.
- **An optional tone** when you run out of something or stop gaining XP, switched on in Settings.
- **An MIT licence**, so others can use and build on the companion's code.
- **Mac and Linux downloads.** Each release now builds the companion for macOS (Apple Silicon and Intel) and Linux and attaches them to the release.
- **Warnings in the top bar.** What needs you now sits next to the title until it's sorted:
  - out of something your action uses, such as arrows, food, runes or materials;
  - about to run out (within the minutes set in Settings);
  - nothing training, or no XP for 90 seconds;
  - the game hasn't saved for a couple of minutes;
  - a full bank.

  The pop-ups and desktop notifications still come too, but these stay put, so you can't miss them.
- **The menu shows what you're working on.** A green dot beside a page means what you're doing in the game touches it, whichever page you're on; hover it for why. Combat when you're fighting, Slayer when that's your task, Skills while you train, What next when you're on your plan's step, Rare items when your action can give one you haven't found, and Goals when you're training towards one.
- **The Combat page recommends a style.** A box at the top compares Melee, Ranged and Magic, each with the best gear you own, against what you're fighting. It says whether to keep your style or switch and how much more XP that gives, then why: hit chance, kill time and damage taken against your current style, any extra food it costs, and the combat triangle when it gives one style the edge. It also names a better fight elsewhere when there is one.

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
