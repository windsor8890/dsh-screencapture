# dsh-screencapture test fixture: invisible placement-probe window.
#
# Used only by tests/hotkey-test.mjs to prove that capture-helper's `activate`
# command (a) preserves a window's placement — notably a maximized window must
# stay maximized — and (b) actually reaches the foreground. The window is a
# fully transparent, click-through, tool-window WinForms form; its hidden owner
# (WinForms creates one for ShowInTaskbar=false) is detached so the window looks
# like a normal ownerless app window to FindTopLevelWindow. The main thread pumps
# messages while a background thread reads stdin, exactly like a real app window
# that must remain responsive to cross-thread activation.
#
# `-NoToolWindow` drops WS_EX_TOOLWINDOW so the window also shows up in the
# captured-time window list (`windows` helper command / window snapping).
#
# Protocol (one line per message on stdout):
#   READY|<pid>|<hwnd>    once, after the window exists
#   STATE|<json>          reply to state-maximized / state-minimized /
#                         state-normal / probe
#   ERR|<message>         unknown command
# Commands (stdin): state-maximized, state-minimized, state-normal, probe, quit
# Closing stdin also exits.

param(
  [string]$Title = 'dsh-screencapture placement probe',
  [switch]$NoToolWindow
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing') -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class PlacementProbeNative
{
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] public static extern IntPtr SetWindowLong(IntPtr hWnd, int index, IntPtr newLong);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    public static extern int GetDwmFrameBounds(IntPtr hWnd, int attribute, out RECT rect, int size);

    // GWLP_HWNDPARENT: clears the owner WinForms creates for ShowInTaskbar=false.
    public static void DetachOwner(IntPtr hWnd)
    {
        SetWindowLong(hWnd, -8, IntPtr.Zero);
    }

    /// <summary>Win32 showCmd: 1 normal, 2 minimized, 3 maximized (-1 on error).</summary>
    public static int GetShowCommand(IntPtr hWnd)
    {
        WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
        placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        if (!GetWindowPlacement(hWnd, ref placement)) return -1;
        return placement.showCmd;
    }

    /// <summary>JSON snapshot of placement, rectangle, DWM frame bounds, owner and foreground window.</summary>
    public static string Snapshot(IntPtr hWnd)
    {
        WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
        placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        bool placementOk = GetWindowPlacement(hWnd, ref placement);
        RECT rect;
        bool rectOk = GetWindowRect(hWnd, out rect);
        RECT dwmRect;
        bool dwmOk = GetDwmFrameBounds(hWnd, 9, out dwmRect, Marshal.SizeOf(typeof(RECT))) == 0;
        IntPtr foreground = GetForegroundWindow();
        uint foregroundPid;
        GetWindowThreadProcessId(foreground, out foregroundPid);
        return string.Format(
            "{{\"hwnd\":{0},\"placementOk\":{1},\"showCmd\":{2},\"rectOk\":{3},"
            + "\"left\":{4},\"top\":{5},\"right\":{6},\"bottom\":{7},"
            + "\"dwmOk\":{8},\"dwmLeft\":{9},\"dwmTop\":{10},\"dwmRight\":{11},\"dwmBottom\":{12},"
            + "\"owner\":{13},\"visible\":{14},\"titleLen\":{15},"
            + "\"foregroundHwnd\":{16},\"foregroundPid\":{17}}}",
            hWnd.ToInt64(), placementOk ? "true" : "false", placementOk ? placement.showCmd : -1,
            rectOk ? "true" : "false", rect.Left, rect.Top, rect.Right, rect.Bottom,
            dwmOk ? "true" : "false", dwmRect.Left, dwmRect.Top, dwmRect.Right, dwmRect.Bottom,
            GetWindow(hWnd, 4).ToInt64(), IsWindowVisible(hWnd) ? "true" : "false",
            GetWindowTextLength(hWnd), foreground.ToInt64(), foregroundPid);
    }
}

// Hidden helper form: transparent, click-through; optionally a tool window
// (no taskbar entry) or a plain app window (so it appears in window lists).
public class PlacementProbeForm : Form
{
    public bool IsToolWindow = true;

    public PlacementProbeForm()
    {
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = new System.Drawing.Point(200, 160);
        Size = new System.Drawing.Size(320, 240);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams parameters = base.CreateParams;
            parameters.ExStyle |= 0x20; // WS_EX_TRANSPARENT (click-through)
            if (IsToolWindow) parameters.ExStyle |= 0x80; // WS_EX_TOOLWINDOW
            return parameters;
        }
    }
}

// Background stdin reader so the main (UI) thread can keep pumping messages.
public class PlacementProbeStdin
{
    private readonly ConcurrentQueue<string> lines = new ConcurrentQueue<string>();
    private volatile bool closed;

    public bool Closed { get { return closed; } }
    public ConcurrentQueue<string> Lines { get { return lines; } }

    public void Start()
    {
        Thread thread = new Thread(delegate()
        {
            try
            {
                while (true)
                {
                    string line = Console.In.ReadLine();
                    if (line == null)
                    {
                        closed = true;
                        return;
                    }
                    lines.Enqueue(line);
                }
            }
            catch
            {
                closed = true;
            }
        });
        thread.IsBackground = true;
        thread.Name = "dsh-screencapture-placement-probe-stdin";
        thread.Start();
    }
}
"@

function Write-Line([string]$Text) {
  [Console]::Out.WriteLine($Text)
  [Console]::Out.Flush()
}

$form = New-Object PlacementProbeForm
$form.Text = $Title
$form.Opacity = 0
if ($NoToolWindow) { $form.IsToolWindow = $false }
$form.Show()
$windowHandle = $form.Handle
# Detach WinForms' hidden owner window so FindTopLevelWindow can pick this form.
[PlacementProbeNative]::DetachOwner($windowHandle)
$stdin = New-Object PlacementProbeStdin
$stdin.Start()

Write-Line ("READY|" + $PID + "|" + $windowHandle.ToInt64())

function Get-ProbeSnapshot {
  [System.Windows.Forms.Application]::DoEvents()
  return [PlacementProbeNative]::Snapshot($windowHandle)
}

# Apply a raw Win32 window state (independent of WinForms' cached WindowState,
# which goes stale when another process changes the placement) and wait until
# GetWindowPlacement reports the expected showCmd.
function Set-ProbeWindowState([int]$ShowCommand, [int]$ExpectedShowCmd) {
  [void][PlacementProbeNative]::ShowWindow($windowHandle, $ShowCommand)
  $deadline = [DateTime]::UtcNow.AddMilliseconds(1500)
  while ([DateTime]::UtcNow -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    if ([PlacementProbeNative]::GetShowCommand($windowHandle) -eq $ExpectedShowCmd) { return }
    Start-Sleep -Milliseconds 10
  }
}

:mainLoop while ($true) {
  [System.Windows.Forms.Application]::DoEvents()
  if ($stdin.Closed) { break mainLoop }

  $line = $null
  while ($stdin.Lines.TryDequeue([ref]$line)) {
    $line = $line.Trim()
    switch ($line) {
      'state-maximized' {
        Set-ProbeWindowState 3 3   # SW_MAXIMIZE
        Write-Line ('STATE|' + (Get-ProbeSnapshot))
      }
      'state-minimized' {
        Set-ProbeWindowState 6 2   # SW_MINIMIZE
        Write-Line ('STATE|' + (Get-ProbeSnapshot))
      }
      'state-normal' {
        Set-ProbeWindowState 9 1   # SW_RESTORE
        Write-Line ('STATE|' + (Get-ProbeSnapshot))
      }
      'probe' {
        Write-Line ('STATE|' + (Get-ProbeSnapshot))
      }
      'quit' {
        break mainLoop
      }
      '' { }
      default {
        Write-Line ('ERR|unknown command: ' + $line)
      }
    }
  }

  Start-Sleep -Milliseconds 10
}

$form.Close()
exit 0
