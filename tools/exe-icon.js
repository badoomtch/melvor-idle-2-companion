// Gives a Windows exe a new program icon: replaces its icon resources (the first icon group and the
// images in it) with the images in an .ico file, through Windows' own resource functions from
// PowerShell. Everything else in the exe stays as it was. Windows writes the changed resources at the end
// of the file and leaves the old ones in place, so tools/build-exe.js calls it on a copy of Node before
// the companion is packed in, while they're small. Windows only.
import { execFileSync } from 'node:child_process';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
public static class ExeIcon {
  delegate bool NamesProc(IntPtr h, IntPtr type, IntPtr name, IntPtr param);
  delegate bool LangsProc(IntPtr h, IntPtr type, IntPtr name, ushort lang, IntPtr param);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool EnumResourceNames(IntPtr h, IntPtr type, NamesProc cb, IntPtr param);
  [DllImport("kernel32.dll")] static extern bool EnumResourceLanguages(IntPtr h, IntPtr type, IntPtr name, LangsProc cb, IntPtr param);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResource(IntPtr h, bool discard);

  public static string Set(string exe, string ico) {
    // The icon images (type 3) and icon groups (type 14) there now, by number and language.
    var old = new List<long[]>();
    IntPtr lib = LoadLibraryEx(exe, IntPtr.Zero, 0x2);
    if (lib == IntPtr.Zero) throw new Exception("Can't open " + exe + ": error " + Marshal.GetLastWin32Error());
    foreach (int type in new[] { 3, 14 }) {
      var names = new List<IntPtr>();
      EnumResourceNames(lib, (IntPtr)type, (h, t, n, p) => { names.Add(n); return true; }, IntPtr.Zero);
      foreach (var n in names) {
        if (((long)n >> 16) != 0) continue;
        EnumResourceLanguages(lib, (IntPtr)type, n, (h, t, nn, l, p) => { old.Add(new long[] { type, (long)n, l }); return true; }, IntPtr.Zero);
      }
    }
    FreeLibrary(lib);
    // The new group takes the place of the first one, which is the icon Windows shows.
    long groupId = 1;
    ushort lang = 1033;
    foreach (var o in old) if (o[0] == 14) { groupId = o[1]; lang = (ushort)o[2]; break; }

    byte[] icoBytes = File.ReadAllBytes(ico);
    int count = BitConverter.ToUInt16(icoBytes, 4);
    IntPtr upd = BeginUpdateResource(exe, false);
    if (upd == IntPtr.Zero) throw new Exception("Can't change " + exe + ": error " + Marshal.GetLastWin32Error());
    foreach (var o in old) UpdateResource(upd, (IntPtr)o[0], (IntPtr)o[1], (ushort)o[2], null, 0);
    var group = new MemoryStream();
    var w = new BinaryWriter(group);
    w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)count);
    for (int i = 0; i < count; i++) {
      int e = 6 + 16 * i;
      int len = BitConverter.ToInt32(icoBytes, e + 8), off = BitConverter.ToInt32(icoBytes, e + 12);
      byte[] img = new byte[len];
      Array.Copy(icoBytes, off, img, 0, len);
      if (!UpdateResource(upd, (IntPtr)3, (IntPtr)(i + 1), lang, img, (uint)len)) throw new Exception("Icon image " + (i + 1) + ": error " + Marshal.GetLastWin32Error());
      w.Write(icoBytes, e, 12);
      w.Write((ushort)(i + 1));
    }
    byte[] g = group.ToArray();
    if (!UpdateResource(upd, (IntPtr)14, (IntPtr)groupId, lang, g, (uint)g.Length)) throw new Exception("Icon group: error " + Marshal.GetLastWin32Error());
    if (!EndUpdateResource(upd, false)) throw new Exception("Saving " + exe + ": error " + Marshal.GetLastWin32Error());
    return count + " icon sizes in place of " + old.Count + " old icon resources";
  }
}
"@
[ExeIcon]::Set($env:COMPANION_EXE, $env:COMPANION_ICO)
`;

/** Puts the icons in `ico` into the Windows exe at `exe`. Returns what it did, in words. */
export function setExeIcon(exe, ico) {
  if (process.platform !== 'win32') throw new Error('Program icons can only be set on Windows.');
  // The script goes in encoded on the command line, so no script file (or script policy) is involved.
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
    env: { ...process.env, COMPANION_EXE: exe, COMPANION_ICO: ico },
    encoding: 'utf8',
  }).trim();
}
