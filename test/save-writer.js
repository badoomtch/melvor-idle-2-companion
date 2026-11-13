// Test helper: writes saves in the same binary layout as the game's SaveWriter, so the reader can
// be exercised without a real save. Mirrors SaveHeader.WriteTo, Game.WriteTo, GameEntity.WriteTo,
// BaseExperience.WriteTo and BankInventoryComponent.WriteTo.
import { brotliCompressSync } from 'node:zlib';

export class Writer {
  constructor() {
    this.parts = [];
  }
  raw(b) {
    this.parts.push(Buffer.from(b));
    return this;
  }
  i32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    return this.raw(b);
  }
  i64(v) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt.asIntN(64, BigInt(v)));
    return this.raw(b);
  }
  f64(v) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    return this.raw(b);
  }
  bool(v) {
    return this.raw([v ? 1 : 0]);
  }
  str(s) {
    const body = Buffer.from(s, 'utf8');
    const len = [];
    let n = body.length;
    while (n >= 0x80) {
      len.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    len.push(n);
    return this.raw(len).raw(body);
  }
  region(fill) {
    const inner = new Writer();
    fill(inner);
    const b = inner.toBuffer();
    return this.i32(b.length).raw(b);
  }
  toBuffer() {
    return Buffer.concat(this.parts);
  }
}

function guidBytes(uuid) {
  const b = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]);
}

// DateTime.Now.ToBinary(): UTC ticks with the Local flag set.
const localBinary = (ms) => BigInt.asIntN(64, (BigInt(Math.round(ms)) * 10000n + 621355968000000000n) | 0x8000000000000000n);

function writeBank(w, bank, version) {
  w.i32(0); // default tab
  w.i32(bank.tabs.length);
  for (const tab of bank.tabs) {
    w.i32(100).i32(0).i32(2147483647).bool(true).bool(false);
    w.i32(tab.stacks.length);
    for (const s of tab.stacks) {
      w.i32(s.qty).bool(!!s.placeholder);
      if (version >= 1) w.bool(!!s.locked);
      w.str(s.item);
    }
    w.str(tab.label ?? '');
    if (version >= 13) {
      w.i32((tab.tags ?? []).length);
      for (const t of tab.tags ?? []) w.bool(!!t.isProduct).bool(!!t.isIngredient).str(t.id);
    }
  }
  // Locked items, default item tabs, custom sort order: the reader stops before these.
  w.i32(0).i32(0).i32(0);
}

/**
 * @param {object} save
 * @param {Array<[string, Buffer | Array<[string, (w: Writer) => void]>]>} [save.extraEntities]
 *   Entities written verbatim: a Buffer is used as the raw region, a list becomes components.
 */
export function buildSave({
  version = 26,
  uuid = '12345678-9abc-def0-1234-56789abcdef0',
  name = 'Tester',
  gamemode = 'Test',
  timestamp = Date.UTC(2026, 9, 1, 12, 0, 0),
  activeEntityName = '',
  activeActionName = '',
  totalLevel = 0,
  gp = 0,
  slayerCoins = 0,
  isDemo = true,
  skills = {},
  bank = null,
  extraEntities = [],
} = {}) {
  const w = new Writer();
  w.i32(version);
  w.raw(guidBytes(uuid)).str(name).str(gamemode).i64(localBinary(timestamp));
  if (version < 9) w.str('');
  else w.str(activeEntityName).str(activeEntityName ? 'res://Assets/Icons/skill.png' : '').str(activeActionName).str(activeActionName ? 'res://Assets/Icons/action.png' : '');
  w.i32(totalLevel).i64(gp).i64(slayerCoins);
  if (version >= 24) w.bool(isDemo);

  const entities = [];
  for (const [skill, s] of Object.entries(skills)) {
    entities.push([
      `MelvorBase:${skill}`,
      [
        ['Experience', (c) => {
          c.f64(s.xp);
          if (version < 25) c.i32(0);
          // From 0.11.5 (29) only the XP is saved.
          if (version < 29) c.i32(s.level);
        }],
        ['Statistics', (c) => c.i32(2).str('noise').f64(3.5)],
      ],
    ]);
  }
  if (bank) entities.push(['MelvorBase:Bank', [['Inventory', (c) => writeBank(c, bank, version)], ['Wallet', (c) => c.i32(0)]]]);
  entities.push(...extraEntities);

  w.i32(entities.length);
  for (const [id, body] of entities) {
    w.str(id);
    if (Buffer.isBuffer(body)) {
      w.i32(body.length).raw(body);
    } else {
      w.region((r) => {
        r.i32(body.length);
        for (const [key, fill] of body) r.str(key).region(fill);
      });
    }
  }
  w.i32(0).f64(42); // ActionManager / RNG state: present in real saves, ignored by the reader
  return brotliCompressSync(w.toBuffer());
}
