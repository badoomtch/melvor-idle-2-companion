// Finds the game's save folders. The game uses Godot's custom user dir "Games By Malcs/Melvor Idle 2";
// Steam builds keep saves per Steam account in steam/<SteamID64>/saves (SteamSavePathProvider),
// other builds in saves/.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USER_DIR_NAME = join('Games By Malcs', 'Melvor Idle 2');
const SAVE_FILE = /^save_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sav$/i;

export function defaultUserDir() {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), USER_DIR_NAME);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', USER_DIR_NAME);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), USER_DIR_NAME);
}

// Every folder that may hold saves. Re-run it to pick up folders the game creates later.
export function resolveSaveDirs(override) {
  const explicit = override ?? process.env.MELVOR_SAVE_DIR;
  if (explicit) return [explicit];
  const userDir = defaultUserDir();
  const dirs = [join(userDir, 'saves')];
  try {
    for (const account of readdirSync(join(userDir, 'steam'))) {
      if (/^\d+$/.test(account)) dirs.push(join(userDir, 'steam', account, 'saves'));
    }
  } catch {
    // no Steam saves yet
  }
  return dirs;
}

// Save files across the given folders; if the same save appears twice, the newest copy wins.
export function listSaveFiles(dirs) {
  const byId = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = SAVE_FILE.exec(name);
      if (!m) continue;
      const file = join(dir, name);
      try {
        const entry = { id: m[1].toLowerCase(), file, mtimeMs: statSync(file).mtimeMs };
        if (!byId.has(entry.id) || byId.get(entry.id).mtimeMs < entry.mtimeMs) byId.set(entry.id, entry);
      } catch {
        // deleted between readdir and stat
      }
    }
  }
  return [...byId.values()];
}
