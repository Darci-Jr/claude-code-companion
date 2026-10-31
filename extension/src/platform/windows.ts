import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { Listen, Platform, Proc } from './types';

const QUERY = `
$p = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={if ($_.CreationDate) { $_.CreationDate.ToString('o') }}})
$l = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess)
@{ procs = $p; listen = $l } | ConvertTo-Json -Depth 3 -Compress
`;

const asArray = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

let flashing = false;
let flashTimer: NodeJS.Timeout | undefined;

function runFlash(count: number, stop = false) {
  const pid = process.pid;
  // FLASHW_STOP = 0, FLASHW_ALL = 3, FLASHW_TIMERNOFG = 12 → 3|12 = 15
  const flags = stop ? 0 : 15;
  const ps = `
$sig = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class FW {
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public uint cbSize; public IntPtr hwnd; public uint dwFlags;
    public uint uCount; public uint dwTimeout;
  }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
  public static void Flash(int pid, uint flags, uint count) {
    try {
      var p = Process.GetProcessById(pid);
      // Sobe para o processo raiz do VSCode (a janela principal está lá).
      var root = p;
      while (true) {
        try {
          var parentId = 0;
          using (var mo = new System.Management.ManagementObjectSearcher(
            "SELECT ParentProcessId FROM Win32_Process WHERE ProcessId=" + root.Id)) {
            foreach (var o in mo.Get()) { parentId = Convert.ToInt32(o["ParentProcessId"]); break; }
          }
          if (parentId == 0) break;
          var parent = Process.GetProcessById(parentId);
          if (parent.ProcessName.ToLower().Contains("code") || parent.ProcessName.ToLower().Contains("cursor")) {
            root = parent;
          } else break;
        } catch { break; }
      }
      var h = root.MainWindowHandle;
      if (h == IntPtr.Zero) h = p.MainWindowHandle;
      if (h == IntPtr.Zero) return;
      var fi = new FLASHWINFO {
        cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)),
        hwnd = h, dwFlags = flags, uCount = count, dwTimeout = 0
      };
      FlashWindowEx(ref fi);
    } catch {}
  }
}
"@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Management -ErrorAction SilentlyContinue
[FW]::Flash(${pid}, ${flags}, ${count})
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true, stdio: 'ignore'
  });
  child.on('error', (e) => console.error('[ClaudeCodeFlash] flash error:', e));
}

export const windows: Platform = {
  defaultShell: () => 'powershell.exe',

  queryProcesses: () => new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUERY],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }),

  parseProcesses(stdout) {
    const raw = JSON.parse(stdout);
    return { procs: asArray<Proc>(raw.procs), listen: asArray<Listen>(raw.listen) };
  },

  killTree: (pid) => new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  }),

  listenSignals(name, onSignal) {
    const pipe = `\\\\.\\pipe\\${name}`;
    const server = net.createServer((sock) => {
      sock.on('data', () => onSignal());
      sock.on('error', () => {});
    });
    server.on('error', (err) => {
      console.error('[ClaudeCodeFlash] server error:', err);
    });
    server.listen(pipe, () => {
      console.log(`[ClaudeCodeFlash] ouvindo em ${pipe}`);
    });
    return { dispose: () => { try { server.close(); } catch {} } };
  },

  startAttention(count) {
    if (flashing) return;
    flashing = true;
    runFlash(count);
    // Re-disparo a cada 3s caso o Windows pare cedo (count=0 = contínuo).
    if (count === 0) {
      flashTimer = setInterval(() => runFlash(0), 3000);
    }
  },

  stopAttention() {
    if (!flashing) return;
    flashing = false;
    if (flashTimer) { clearInterval(flashTimer); flashTimer = undefined; }
    runFlash(0, true);
  },

  writeHookScript(claudeDir, name) {
    // Escrevemos um .ps1 ao lado de settings.json para evitar problemas de escape de $ quando o Claude Code spawna o hook.
    const scriptPath = path.join(claudeDir, 'claude-code-flash-notify.ps1');
    const scriptBody = `$p = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${name}', 'Out')
try { $p.Connect(500); $b = [System.Text.Encoding]::ASCII.GetBytes('1'); $p.Write($b, 0, 1) } finally { $p.Dispose() }
`;
    fs.writeFileSync(scriptPath, scriptBody);
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  }
};
