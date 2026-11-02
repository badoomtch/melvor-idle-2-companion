# Melvor Idle 2 Companion

A free helper that runs alongside Melvor Idle 2. It reads your save every time the game autosaves and tells you the best thing to do next: what to train, what to make, what to fight, what to put on and what to sell.

It runs on your own computer as a small web page. There's no account, no sign-in and nothing to install.

![What next: your plan, with the step you're on](docs/screenshots/next.png)

## What it does for you

**Gives you a plan.** What next lists your next goals in the order that pays off most: the next unlock in each skill, gear worth making, and Mastery Guild ranks. Each goal has concrete steps, such as "Mine 160 Iron Ore", then "Make 159 Steel Bar", then "Train until Crafting 47", with how long each takes. Steps tick off by themselves as you play. If you run short of something, a step to get more goes in, with the shop price when the shop sells it. When the plan is done, you get a new one. Each skill page also shows the quickest way to its next unlock.

**Tells you when you could be doing better.** It grades what you're doing against everything you've unlocked ("Willow Tree gives 70% more XP"), and shows your real XP per hour measured from your saves.

**Uses what you already own.** Plans start from your bank. The Toolbelts page and your plan point out tools and potions sitting in your bank that would make something quicker ("Put on Balaclava instead of Fire Wizard Hat: 13% faster"). The Combat page picks the best gear you own for each style.

**Answers the questions you'd otherwise look up:**
- **Combat:** which style to use against what you're fighting (it compares Melee, Ranged and Magic with your best gear for that enemy, and says why), the best gear you own for it, which enemy gives the most XP or GP per hour, how likely a fight is to kill you, what food lasts longest, and which upgrades are within reach and why.
- **Slayer and dungeons:** whether to keep or reroll a task, the style that kills each task fastest, and what each dungeon run is worth.
- **Money:** the best money makers after the cost of materials and food, crafts worth more than their materials, and items nothing in the game uses.
- **Shop planner:** which upgrades pay for themselves fastest, and whether to buy or make each shop item.
- **Rare items:** how many you've found of each rarity, everything you only get by chance, where to get it, and how long you'd need for a good chance at your levels. What you're doing now gets its own list of what it can give, and each item says how many tries you've already had and how many players would have one by now. Your rare finds are logged as they happen.
- **Bank:** how full it is, and the easiest ways to free slots without losing anything you need.
- **Away planner:** the best thing to leave running while you're away, up to the game's 24-hour offline limit.
- **Any item:** point at it anywhere for a card with its picture, stats and what it's worth.
- **Lookup:** where any item comes from, everything that uses it (recipes, quests, keys and tools, the ranch, traps and bait, gear and food) and what it's worth.
- **And more:** Mastery Guild ranks and the quickest tasks for them, quests, your own level goals, a completion log, your farming plots, ranch and Grain Mill, your history, and calculators.

**Keeps an eye on things.**
- Anything that needs you sits at the top of the page until it's sorted: running out of food, ammo, runes or materials, nothing training, no XP for a while, the game not saving, or a full bank.
- The Overview shows what you're doing (a fight included), how long to your next level, how long your supplies last, and what to make or buy before you start so you can keep going for a few hours.
- A green dot in the menu marks the pages what you're doing touches, such as Combat while you fight or Rare items when your action can give one you haven't found.
- When you come back after a while, the Overview sums up what happened: XP and levels gained, gold, rare finds, and whether anything stopped.
- The same warnings, plus level-ups, rare finds, finished plan steps, ready harvests and hungry ranch animals, can arrive as desktop notifications even with the page closed. Turn them on in Settings.
- The Pop out button gives you a small always-on-top window with what you're doing, what's next and any warnings.

## Screenshots

| | |
| --- | --- |
| ![Overview](docs/screenshots/overview.png) | ![Toolbelts](docs/screenshots/toolbelts.png) |
| Overview: every skill at a glance, what you're doing now and what runs out first | Toolbelts: items in your bank worth putting on, and what each one gives |
| ![Combat](docs/screenshots/combat.png) | ![Rare items](docs/screenshots/rare.png) |
| Combat: the best gear you own for what you're fighting, and what to fight with it | Rare items: your progress by rarity, where to get each one and how long it takes |
| ![Bank](docs/screenshots/bank.png) | ![A skill](docs/screenshots/skill.png) |
| Bank: value, space and the easiest slots to free | A skill: the quickest way to its next unlock, every method, and the quickest Mastery Guild tasks |

It also fits a narrow window, so you can keep it next to the game:

<img src="docs/screenshots/mobile.png" alt="The plan in a narrow window" width="300">

## Download and run

### Windows

1. Download **`MelvorIdle2Companion.exe`** from the [latest release](https://github.com/badoomtch/melvor-idle-2-companion/releases/latest).
2. Double-click it. The first time, Windows may say "Windows protected your PC" because the program isn't signed. Click **More info**, then **Run anyway**.
3. Your browser opens the companion. Start Melvor Idle 2 and the page fills in within a few seconds, then keeps up with every autosave.

To stop it, close the black console window.

### macOS and Linux

1. From the [latest release](https://github.com/badoomtch/melvor-idle-2-companion/releases/latest), download the zip for your system:
   - `MelvorIdle2Companion-macos-apple-silicon.zip` for M1 and newer Macs;
   - `MelvorIdle2Companion-macos-intel.zip` for older Macs;
   - `MelvorIdle2Companion-linux.zip` for Linux.
2. Unzip it and run `MelvorIdle2Companion`.
   - On a Mac, the first time, macOS blocks it because it isn't signed by Apple. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. (On macOS 14 and older you can instead right-click it and choose **Open**.)
   - On Linux, run `./MelvorIdle2Companion` from a terminal in that folder.
3. Your browser opens the companion.

### Running from source

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. Download or clone this repository.
3. Run `./start-companion.sh` (macOS or Linux) or double-click `MelvorCompanion.bat` (Windows). The page opens at <http://127.0.0.1:47820>.

### Where it finds your save

It looks in the game's own save folder and checks every Steam account on the computer:

| System | Folder |
| --- | --- |
| Windows | `%APPDATA%\Games By Malcs\Melvor Idle 2\` |
| macOS | `~/Library/Application Support/Games By Malcs/Melvor Idle 2/` |
| Linux | `~/.local/share/Games By Malcs/Melvor Idle 2/` |

No save yet? Go to **Settings** and choose **Enter by hand** to type in your levels and use the planner anyway.

## Updates

When there's a new version, the companion shows a note at the top of the page with a link to download it. It checks GitHub every few hours. You can turn this off in **Settings → About**.

When the game itself updates, the companion keeps working. If a new game version changes its save format, the companion tells you its numbers may be off until it's updated.

## Is it safe?

- **Your save is only ever read, never changed.** Reading it takes a moment and never locks the file, so it can't get in the way of the game's autosave.
- **Nothing about your game leaves your computer.** The page is only reachable from your own computer. The one thing the companion asks the internet is whether there's a newer version on GitHub, and you can turn that off.
- Your goals and settings stay on your computer.

## How accurate is it?

Rates follow the game's own formulas: action times, success chances, drop tables, the XP curve and the combat formulas. They include your shop upgrades, toolbelt items (and what the used-up ones cost), pets, set bonuses, Mastery Guild ranks, Astrology nodes, the food in each skill's food slot, bonfires and Auroras and, in combat, your gear, prayers, potions and imbuement.

The **Accuracy** page compares the companion's estimates with what each action really gave you between autosaves. Your plan uses those measurements, so its times reflect how fast you actually play.

Combat is checked against a tick-by-tick simulation of the game's fights across every enemy you can fight, and almost every fight comes within 10%. The one known exception is the Elder Vampire: it heals in streaks while Drain is up, which the companion averages, so its kills come about 11% quicker than in the game.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Feedback

Found advice that doesn't match the game? [Open an issue](https://github.com/badoomtch/melvor-idle-2-companion/issues) with a screenshot of the page and what you expected. Settings has a **Save my stats file** button that writes your levels and the companion's estimate-vs-real numbers to a file (no character name), which helps a lot.

## Licence

The companion's code is under the [MIT licence](LICENSE): you can use, change and share it, as long as the licence and copyright notice come with it. Melvor Idle 2's icons and game data belong to the game and aren't covered by it.

## Building it yourself

See [docs/DEVELOPING.md](docs/DEVELOPING.md) for running from source, rebuilding the game data after a game update, building the exe and making a release.
