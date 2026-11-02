// The Bank entity's wallet (CurrencyWalletComponent.WriteTo) and the selected imbuement
// (MagicSpellsComponent.WriteTo), read from saves written in the game's layout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSave } from '../server/save-reader.js';
import { buildSave } from './save-writer.js';

const slot = (c, item) => c.region((g) => g.i32(1).bool(false).bool(true).str(item));
const combat = (magic) => ['MelvorBase:Combat', [
  ['Equipment', (c) => {
    c.i32(1);
    c.str('MelvorBase:Weapon');
    slot(c, 'MelvorBase:FireStaff');
    c.i32(0);
  }],
  ['MagicSpells', magic],
]];

test('the wallet: each currency is an amount then its id, read to the end of its region', () => {
  const wallet = ['MelvorBase:Bank', [['Wallet', (c) => c.i32(3).i64(538).str('MelvorBase:GoldPieces').i64(1200).str('MelvorBase:PrayerPoints').i64(39082).str('MelvorBase:SlayerCoins')]]];
  const save = parseSave(buildSave({ version: 27, extraEntities: [wallet] }));
  assert.deepEqual(save.warnings.filter((w) => !/No skill data/.test(w)), []);
  assert.deepEqual(save.wallet, { GoldPieces: 538, PrayerPoints: 1200, SlayerCoins: 39082 });
  // Anything left over in the region is a warning, not a wrong number.
  const extra = ['MelvorBase:Bank', [['Wallet', (c) => c.i32(1).i64(5).str('MelvorBase:PrayerPoints').bool(true)]]];
  const bad = parseSave(buildSave({ version: 27, extraEntities: [extra] }));
  assert.equal(bad.wallet, undefined);
  assert.ok(bad.warnings.some((w) => /^Wallet: .*1 unread bytes/.test(w)));
});

test('the selected imbuement comes after the selected spell', () => {
  const tail = (c) => c.bool(false).bool(false).bool(false).i32(0).i32(0);
  const save = parseSave(buildSave({ version: 27, extraEntities: [combat((c) => tail(c.bool(true).str('MelvorBase:FireBolt').bool(true).str('MelvorBase:BurnII')))] }));
  assert.equal(save.combat.spell, 'MelvorBase:FireBolt');
  assert.equal(save.combat.imbuement, 'MelvorBase:BurnII');
  const none = parseSave(buildSave({ version: 27, extraEntities: [combat((c) => tail(c.bool(true).str('MelvorBase:FireBolt').bool(false)))] }));
  assert.equal(none.combat.imbuement, null);
});
