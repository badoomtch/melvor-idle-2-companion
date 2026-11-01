# Developing the companion

Everything runs on Node.js with no dependencies: `npm test` and `npm start` work straight after a clone.

```
npm start                   # run the companion from source (http://127.0.0.1:47820)
npm test                    # engine formulas, save reader, planner (node:test)
npm run demo                # write a demo save and start the companion against it
node tools/make-demo-save.js --live [--fast]   # keep "playing" and autosaving, to test live updates
npm run build-exe           # one-file dist/MelvorIdle2Companion.exe (needs Node 25.5+)
```

Options for `npm start` (or the launchers):

| Option | What it does |
| --- | --- |
| `--saves <folder>` | Read saves from a different folder (or set `MELVOR_SAVE_DIR`) |
| `--port <n>` | Use a different port (default 47820; the next free one is used if it's taken) |
| `--no-open` | Don't open the browser |

Environment variables: `MELVOR_COMPANION_HISTORY` moves the history folder, and `MELVOR_COMPANION_REPO` (`owner/name`) points the update check at a fork.

## Project layout

```
engine/   shared logic (runs in Node and the browser): XP curve, rates, planner, combat, lookup
server/   local web server, save finder, save reader, alerts, update check (Node built-ins only)
ui/       the web page (plain HTML, CSS and JS; works offline)
tools/    game-data extractor, data builder, icon extractor, exe builder, demo save writer
test/     node:test suites
data/     the companion's game data (built from the game, see below)
docs/     this file and the README screenshots
```

## Updating for a new game version

1. Pull the data package out of the installed game. It only reads the game files:
   ```
   node tools/extract-game-data.js [path/to/Melvor2.exe]
   ```
   With no path it tries the usual Steam folders (Playtest, full game, demo) and writes `data/source/`. Don't commit or ship `data/source/`: it's the full game data.
2. Back up `data/companion-data.json`, then build the new one. With no path, it builds from `data/source/MelvorBase.json`:
   ```
   node tools/build-data.js
   ```
   Check the summary says `MelvorBase.json` with level cap 120. For a demo package it drops everything behind `DemoLocked` and caps levels at 60. `--level-cap` and `--include-locked` override that.
3. See what moved: `npm run compare -- <old companion-data.json>` writes `reports/build-diff.md`.
4. Refresh the icons: `node tools/extract-icons.js [path/to/Melvor2.exe]`.
5. A few values live in the game's code rather than its data (level cap, thieving stun, XP table constants, offline cap, success constants, enemy spawn time). They're in `MECHANICS` at the top of `tools/build-data.js`, each with the code it comes from. Re-check them against the new build.
6. Save format: `server/save-reader.js` documents the layout it reads. If the game raises the save version, read a copy of a new save. It should give no warnings, every region should be read to the end, each skill's level should match its XP, and every bank item should be known. Only then raise `SaveVersion.LatestVerified`. Until then, players see a note that numbers may be off.

## Making a release

The companion checks `https://api.github.com/repos/<repository>/releases/latest`, using the repository in `package.json`. It tells players when the release tag is newer than their version.

1. Raise `version` in `package.json` (for example `0.4.0`).
2. Run `npm test`, then `npm run build-exe`.
3. Create a GitHub release tagged `v<version>` and attach the exe:
   ```
   gh release create v0.4.0 dist/MelvorIdle2Companion.exe --title "0.4.0" --notes "What changed"
   ```

Players on older versions see "Version 0.4.0 of the companion is out" with a link to the release, within six hours or the next time they start it.

### Signing

`npm run build-exe` makes an unsigned program, so Windows SmartScreen asks before the first run.

- **Windows:** sign after building, for example:
  ```
  signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a dist\MelvorIdle2Companion.exe
  ```
  An EV certificate clears SmartScreen straight away. A standard one builds reputation over time.
- **macOS:** build on a Mac, then `codesign --force --options runtime --sign "Developer ID Application: <you>" dist/MelvorIdle2Companion` and notarise it with `xcrun notarytool submit <zip> --wait`.
- **Linux:** no signing needed.

Each build wraps the Node.js it runs on, so build on each system you want a program for. On first run the program unpacks itself to `%LOCALAPPDATA%\MelvorCompanion` (once per version) and keeps its history there.

## For the game's developers

`npm run report` writes `reports/data-report.md`. It covers economy outliers, content above the level cap, items with no source, missing artwork, damage spikes, unlock droughts and shop problems. `npm run compare` shows what moved between two data builds.
