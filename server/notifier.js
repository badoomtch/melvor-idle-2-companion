// Desktop notifications from the companion itself, so alerts arrive with no browser page open.
// Windows: a toast through PowerShell (shown under Windows PowerShell's name, which is registered
// to show toasts). macOS: osascript. Linux: notify-send. Fire and forget; failures are only logged.

import { spawn } from 'node:child_process';

// PowerShell's own app id: toasts need a registered app, and this one always is.
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function windowsCommand(title, body) {
  // The XML goes inside a single-quoted PowerShell string, so single quotes are already escaped as &apos;.
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`;
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('${xml}')`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
  ].join('\n');
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
}

const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function notificationCommand(title, body, platform = process.platform) {
  if (platform === 'win32') return windowsCommand(title, body);
  if (platform === 'darwin') return ['osascript', ['-e', `display notification ${appleString(body)} with title ${appleString(title)}`]];
  return ['notify-send', ['--app-name=Melvor Idle 2 Companion', title, body]];
}

export function createNotifier({ platform = process.platform, run = spawn } = {}) {
  return function notify(title, body = '') {
    const [cmd, args] = notificationCommand(title, body, platform);
    try {
      const child = run(cmd, args, { stdio: 'ignore', windowsHide: true });
      child.on?.('error', (e) => console.error(`Could not show a notification: ${e.message}`));
      child.unref?.();
    } catch (e) {
      console.error(`Could not show a notification: ${e.message}`);
    }
  };
}
