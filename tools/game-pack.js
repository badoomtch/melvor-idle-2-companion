// Reads files out of an installed copy of the game. Read-only.
//
// Godot 4 stores the game's files in a "GDPC" pack: a PE section named "pck" inside Melvor2.exe on
// Windows, a pack appended to the executable, or a separate .pck file.

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

const MAGIC = 0x43504447; // "GDPC"
const PACK_DIR_ENCRYPTED = 1;
const PACK_REL_FILEBASE = 2;
const PACK_FILE_ENCRYPTED = 1;

export const STEAM_CANDIDATES = [
  'C:/Program Files (x86)/Steam/steamapps/common/Melvor Idle 2 Playtest/Melvor2.exe',
  'C:/Program Files (x86)/Steam/steamapps/common/Melvor Idle 2/Melvor2.exe',
  'C:/Program Files (x86)/Steam/steamapps/common/Melvor Idle 2 Demo/Melvor2.exe',
];

export const findGameFile = () => STEAM_CANDIDATES.find((p) => existsSync(p)) ?? null;

export function openGamePack(gameFile) {
  const fd = openSync(gameFile, 'r');
  const fileSize = fstatSync(fd).size;
  const read = (pos, n) => {
    const b = Buffer.alloc(n);
    if (readSync(fd, b, 0, n, pos) !== n) throw new Error(`Short read at ${pos}`);
    return b;
  };

  function findPackStart() {
    if (read(0, 4).readUInt32LE(0) === MAGIC) return 0;
    if (read(0, 2).toString('latin1') === 'MZ') {
      const pe = read(0x3c, 4).readUInt32LE(0);
      const coff = read(pe, 24);
      const sections = coff.readUInt16LE(6);
      const table = read(pe + 24 + coff.readUInt16LE(20), sections * 40);
      for (let i = 0; i < sections; i++) {
        const s = table.subarray(i * 40, i * 40 + 40);
        if (s.subarray(0, 8).toString('latin1').replace(/\0+$/, '') === 'pck') return s.readUInt32LE(20);
      }
    }
    const tail = read(fileSize - 12, 12);
    if (tail.readUInt32LE(8) === MAGIC) return fileSize - 12 - Number(tail.readBigUInt64LE(0));
    return -1;
  }

  try {
    const packStart = findPackStart();
    if (packStart < 0 || read(packStart, 4).readUInt32LE(0) !== MAGIC) throw new Error(`No Godot pack found in ${gameFile}`);
    const header = read(packStart, 40);
    const formatVersion = header.readUInt32LE(4);
    const godot = `${header.readUInt32LE(8)}.${header.readUInt32LE(12)}.${header.readUInt32LE(16)}`;
    const flags = header.readUInt32LE(20);
    if (flags & PACK_DIR_ENCRYPTED) throw new Error('This pack has an encrypted file list; it cannot be read without the game\'s key');
    let fileBase = Number(header.readBigUInt64LE(24));
    if (flags & PACK_REL_FILEBASE) fileBase += packStart;
    // Format 3+ stores the file list at an offset; older packs keep it after a 16 x u32 reserved block.
    let pos = formatVersion >= 3 ? packStart + Number(header.readBigUInt64LE(32)) : packStart + 40 + 64;
    const count = read(pos, 4).readUInt32LE(0);
    pos += 4;
    if (count > 1_000_000) throw new Error(`Implausible file count ${count}; unsupported pack format ${formatVersion}`);
    const files = new Map();
    for (let i = 0; i < count; i++) {
      const len = read(pos, 4).readUInt32LE(0);
      pos += 4;
      const path = read(pos, len).toString('utf8').replace(/\0+$/, '').replace(/^res:\/\//, '');
      pos += len;
      const entry = read(pos, 36);
      pos += 36;
      files.set(path, { offset: fileBase + Number(entry.readBigUInt64LE(0)), size: Number(entry.readBigUInt64LE(8)), encrypted: (entry.readUInt32LE(32) & PACK_FILE_ENCRYPTED) !== 0 });
    }
    return {
      gameFile,
      godot,
      formatVersion,
      files,
      readFile(path) {
        const f = files.get(path.replace(/^res:\/\//, ''));
        if (!f || f.encrypted) return null;
        return read(f.offset, f.size);
      },
      close: () => closeSync(fd),
    };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

// Turns a res:// image path into its image bytes. Imported images live in .godot/imported/*.ctex
// ("GST2"); lossless ones embed a PNG or WebP that can be used directly.
export function readImage(pack, resPath) {
  const path = resPath.replace(/^res:\/\//, '');
  const direct = /\.(png|webp|svg)$/i.test(path) ? pack.readFile(path) : null;
  if (direct && !pack.files.has(`${path}.import`)) return { ext: path.split('.').pop().toLowerCase(), data: direct };
  const importFile = pack.readFile(`${path}.import`);
  if (!importFile) return null;
  const m = /^path="res:\/\/([^"]+\.ctex)"/m.exec(importFile.toString('utf8'));
  if (!m) return null; // VRAM-compressed variants only; nothing a browser can show
  const ctex = pack.readFile(m[1]);
  if (!ctex || ctex.length < 60 || ctex.toString('latin1', 0, 4) !== 'GST2') return null;
  const dataFormat = ctex.readUInt32LE(36); // 1 = PNG, 2 = WebP
  const size = ctex.readUInt32LE(52);
  const data = ctex.subarray(56, 56 + size);
  if (dataFormat === 2 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', data };
  if (dataFormat === 1 && data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG') return { ext: 'png', data };
  return null;
}
