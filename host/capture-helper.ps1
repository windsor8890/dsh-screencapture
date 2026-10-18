# dsh-screencapture capture helper.
#
# Warm Windows PowerShell worker owned by host/capture.js. It is spawned once
# per DSH Host process (node, ELECTRON_RUN_AS_NODE mode) and stays alive for the
# life of the plugin:
#
#   powershell.exe -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File capture-helper.ps1
#
# Protocol: one command per line on stdin, exactly one response line on stdout.
#
#   capture|<pngPath>     -> OK|capture|<width>|<height>|<pngPath>
#                            ERR|capture|<message>
#   clipboard|<pngPath>   -> OK|clipboard
#                            ERR|clipboard|<message>
#   activate|<pid>        -> OK|activate|<hwnd>   (restore + foreground the
#                                                   process's top-level window)
#                            ERR|activate|<message>
#   prepare-overlay|<pid> -> OK|prepare-overlay|<hwnd>|<changed 0|1>|<showCmd>|<left>|<top>|<right>|<bottom>
#                            Maximize the process's top-level window for the
#                            overlay and remember its exact normal placement
#                            (the rect is the pre-maximize NORMAL rect).
#                            ERR|prepare-overlay|<message>
#   restore-overlay|<hwnd>|<showCmd>|<left>|<top>|<right>|<bottom>
#                         -> OK|restore-overlay
#                            Put the remembered placement back (no-op when the
#                            window was originally maximized); does not change
#                            the foreground.
#                            ERR|restore-overlay|<message>
#   screens               -> OK|screens|<compact-json {screens:[...],virtual:{...}}>
#                            ERR|screens|<message>
#   windows               -> OK|windows|<single-line json array>
#                            Visible top-level windows in Z-order (topmost
#                            first): [{hwnd,title,className,pid,processName,
#                            x,y,width,height}] with DWM extended frame bounds in
#                            physical screen pixels (window-snapping data).
#                            ERR|windows|<message>
#   ping                  -> OK|ping
#   exit                  -> (no response; the process exits)
#
# `<pngPath>` is an absolute path written by the Host process. The process is
# started with -STA because System.Windows.Forms.Clipboard requires a
# single-threaded apartment. Responses are flushed after every command; the
# Node side applies a per-command timeout and restarts this process once if it
# dies or stalls.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Best effort: the Host writes UTF-8 command lines. Redirection may make this a
# no-op on some Windows builds; paths handed to this helper are ASCII in
# practice, so a failure here is not fatal.
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DshScreenshotDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
"@

# Window activation for the global-hotkey flow: find the Electron main window
# by process id and bring it to the foreground WITHOUT changing its placement.
# The previous version called ShowWindowAsync(SW_RESTORE) unconditionally, which
# un-maximizes a maximized window; GetWindowPlacement now gates the restore to
# minimized windows only. Foreground is retried with AttachThreadInput
# attunement to the current-foreground and target threads because Windows
# blocks SetForegroundWindow from background processes.
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshScreenshotWindow
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int GetDwmCloaked(IntPtr hWnd, int attribute, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int GetDwmFrameBounds(IntPtr hWnd, int attribute, out RECT value, int size);

    private const uint GW_OWNER = 4;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;
    private const int TITLE_MAX_CHARS = 200;
    private const int SW_SHOWMINIMIZED = 2;
    private const int SW_MAXIMIZE = 3;
    private const int SW_RESTORE = 9;
    private const int SW_SHOWNOACTIVATE = 4;
    private const int ACTIVATION_ATTEMPTS = 6;
    private const int ACTIVATION_RETRY_DELAY_MS = 25;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

    /// <summary>
    /// Pick the best top-level window of a process: prefer the largest visible
    /// window with a title and no owner (that is the app's main window), then
    /// any visible ownerless window, then any ownerless window. This avoids
    /// hidden framework windows (for example .NET's BroadcastEventWindow) whose
    /// threads do not pump messages and can stall activation.
    /// </summary>
    public static IntPtr FindTopLevelWindow(uint targetProcessId)
    {
        IntPtr bestVisibleTitled = IntPtr.Zero;
        long bestArea = -1;
        IntPtr firstVisible = IntPtr.Zero;
        IntPtr firstAny = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId != targetProcessId) return true;
            if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;
            if (firstAny == IntPtr.Zero) firstAny = hWnd;
            if (!IsWindowVisible(hWnd)) return true;
            if (firstVisible == IntPtr.Zero) firstVisible = hWnd;
            if (GetWindowTextLength(hWnd) == 0) return true;
            RECT rect;
            GetWindowRect(hWnd, out rect);
            long area = (long)(rect.Right - rect.Left) * (long)(rect.Bottom - rect.Top);
            if (area > bestArea)
            {
                bestArea = area;
                bestVisibleTitled = hWnd;
            }
            return true;
        }, IntPtr.Zero);
        if (bestVisibleTitled != IntPtr.Zero) return bestVisibleTitled;
        if (firstVisible != IntPtr.Zero) return firstVisible;
        return firstAny;
    }

    /// <summary>Win32 showCmd of a window: 1 normal, 2 minimized, 3 maximized.</summary>
    public static int GetShowCommand(IntPtr hWnd)
    {
        WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
        placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        if (!GetWindowPlacement(hWnd, ref placement)) return -1;
        return placement.showCmd;
    }

    /// <summary>
    /// {showCmd, normalLeft, normalTop, normalRight, normalBottom} from
    /// GetWindowPlacement. The rectangle is the NORMAL (restored) position, so a
    /// maximized/minimized window can be put back exactly where it was.
    /// </summary>
    public static long[] GetPlacementSnapshot(IntPtr hWnd)
    {
        WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
        placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        if (!GetWindowPlacement(hWnd, ref placement)) return null;
        return new long[]
        {
            placement.showCmd,
            placement.rcNormalPosition.Left,
            placement.rcNormalPosition.Top,
            placement.rcNormalPosition.Right,
            placement.rcNormalPosition.Bottom,
        };
    }

    /// <summary>Maximize a window (asynchronously; the caller polls IsZoomed).</summary>
    public static bool Maximize(IntPtr hWnd)
    {
        if (!IsZoomed(hWnd)) ShowWindowAsync(hWnd, SW_MAXIMIZE);
        return IsZoomed(hWnd);
    }

    public static bool IsZoomedWindow(IntPtr hWnd)
    {
        return IsZoomed(hWnd);
    }

    /// <summary>
    /// Put a window back to its remembered normal rectangle, without activating
    /// it or changing the z-order. A maximized/minimized window is first taken
    /// out of that state (SetWindowPos alone would resize a still-maximized
    /// window while leaving showCmd == SW_SHOWMAXIMIZED), then positioned to
    /// the exact remembered rectangle. SW_SHOWNOACTIVATE is used instead of
    /// SW_RESTORE so closing the overlay can never steal focus from the app the
    /// user switched to.
    /// </summary>
    public static bool RestorePlacement(IntPtr hWnd, int left, int top, int right, int bottom)
    {
        if (!IsWindow(hWnd)) return false;
        if (IsZoomed(hWnd) || IsIconic(hWnd))
        {
            ShowWindowAsync(hWnd, SW_SHOWNOACTIVATE);
            // The window belongs to another app's UI thread; it pumps its own
            // messages, so poll the state briefly (bounded).
            for (int attempt = 0; attempt < 30; attempt++)
            {
                if (!IsZoomed(hWnd) && !IsIconic(hWnd)) break;
                Thread.Sleep(10);
            }
        }
        return SetWindowPos(hWnd, IntPtr.Zero, left, top, right - left, bottom - top, SWP_NOZORDER | SWP_NOACTIVATE);
    }

    /// <summary>
    /// Restore only a MINIMIZED window; leave a normal or maximized window's
    /// placement untouched (SW_RESTORE would un-maximize a maximized window).
    /// </summary>
    private static bool ShouldRestore(IntPtr hWnd)
    {
        return GetShowCommand(hWnd) == SW_SHOWMINIMIZED;
    }

    /// <summary>
    /// Bring a window to the foreground while preserving its placement. Windows
    /// only lets the foreground owner (or a thread attached to it) change the
    /// foreground window, so input queues are attuned and the call is retried.
    /// Returns the final foreground window handle.
    /// </summary>
    public static IntPtr Activate(IntPtr hWnd)
    {
        IntPtr current = GetForegroundWindow();
        if (current == hWnd) return current;
        for (int attempt = 0; attempt < ACTIVATION_ATTEMPTS; attempt++)
        {
            IntPtr foreground = GetForegroundWindow();
            if (foreground == hWnd) return foreground;
            uint ignoredProcessId;
            uint foregroundThread = foreground != IntPtr.Zero
                ? GetWindowThreadProcessId(foreground, out ignoredProcessId) : 0;
            uint targetThread = GetWindowThreadProcessId(hWnd, out ignoredProcessId);
            uint currentThread = GetCurrentThreadId();
            bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread
                && AttachThreadInput(currentThread, foregroundThread, true);
            bool attachedTarget = targetThread != 0 && targetThread != currentThread
                && targetThread != foregroundThread && AttachThreadInput(currentThread, targetThread, true);
            try
            {
                if (ShouldRestore(hWnd)) ShowWindowAsync(hWnd, SW_RESTORE);
                BringWindowToTop(hWnd);
                SetForegroundWindow(hWnd);
            }
            finally
            {
                if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
                if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
            }
            if (GetForegroundWindow() == hWnd) return hWnd;
            Thread.Sleep(ACTIVATION_RETRY_DELAY_MS);
        }
        return GetForegroundWindow();
    }

    // ---------------------------------------------------------------------
    // Captured-time top-level window list (window snapping / hover highlight).
    // ---------------------------------------------------------------------

    /// <summary>
    /// Snapshot of the visible top-level windows in Z-ORDER (topmost first) as
    /// a single-line JSON array. EnumWindows walks top-level windows in Z order;
    /// each entry uses the DWM extended frame bounds (the visually visible
    /// rectangle, shadows excluded) in physical screen pixels, falls back to
    /// GetWindowRect, and is filtered to windows a user could click on:
    /// visible, not minimized, not DWM-cloaked, not a tool window, with a title,
    /// and intersecting the virtual screen.
    /// </summary>
    public static string EnumerateWindows(int virtualLeft, int virtualTop, int virtualRight, int virtualBottom)
    {
        List<string> entries = new List<string>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            if (IsIconic(hWnd)) return true;
            int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
            if ((exStyle & WS_EX_TOOLWINDOW) != 0) return true;
            int titleLength = GetWindowTextLength(hWnd);
            if (titleLength <= 0) return true;
            StringBuilder titleBuilder = new StringBuilder(titleLength + 2);
            GetWindowText(hWnd, titleBuilder, titleBuilder.Capacity);
            string title = titleBuilder.ToString().Trim();
            if (title.Length == 0) return true;
            if (title.Length > TITLE_MAX_CHARS) title = title.Substring(0, TITLE_MAX_CHARS);
            StringBuilder classBuilder = new StringBuilder(256);
            GetClassName(hWnd, classBuilder, classBuilder.Capacity);
            string className = classBuilder.ToString();
            if (IsShellNoiseClass(className)) return true;
            int cloaked = 0;
            if (GetDwmCloaked(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            RECT rect;
            if (GetDwmFrameBounds(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0)
            {
                if (!GetWindowRect(hWnd, out rect)) return true;
            }
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width <= 1 || height <= 1) return true;
            if (rect.Right <= virtualLeft || rect.Left >= virtualRight
                || rect.Bottom <= virtualTop || rect.Top >= virtualBottom) return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            string processName = string.Empty;
            try
            {
                if (processId != 0) processName = Process.GetProcessById((int)processId).ProcessName;
            }
            catch
            {
                // Protected/elevated process: keep the entry with an empty name.
            }
            entries.Add(BuildWindowJsonEntry(hWnd, title, className, processId, processName, rect));
            return true;
        }, IntPtr.Zero);
        StringBuilder json = new StringBuilder();
        json.Append('[');
        for (int index = 0; index < entries.Count; index++)
        {
            if (index > 0) json.Append(',');
            json.Append(entries[index]);
        }
        json.Append(']');
        return json.ToString();
    }

    /// <summary>Shell / desktop-compositor noise the snapping UI must never show.</summary>
    private static bool IsShellNoiseClass(string className)
    {
        switch (className)
        {
            case "Progman":
            case "WorkerW":
            case "Shell_TrayWnd":
            case "Shell_SecondaryTrayWnd":
            case "Windows.UI.Core.CoreWindow":
                return true;
        }
        return className.StartsWith("Windows.Internal.Shell", StringComparison.Ordinal);
    }

    private static string BuildWindowJsonEntry(IntPtr hWnd, string title, string className, uint processId, string processName, RECT rect)
    {
        StringBuilder json = new StringBuilder(256);
        json.Append("{\"hwnd\":").Append(hWnd.ToInt64());
        json.Append(",\"title\":").Append(JsonQuote(title));
        json.Append(",\"className\":").Append(JsonQuote(className));
        json.Append(",\"pid\":").Append(processId);
        json.Append(",\"processName\":").Append(JsonQuote(processName));
        json.Append(",\"x\":").Append(rect.Left);
        json.Append(",\"y\":").Append(rect.Top);
        json.Append(",\"width\":").Append(rect.Right - rect.Left);
        json.Append(",\"height\":").Append(rect.Bottom - rect.Top);
        json.Append('}');
        return json.ToString();
    }

    /// <summary>
    /// JSON string literal with only ASCII output: control characters and any
    /// non-ASCII code unit are \u-escaped, so the protocol line survives any
    /// console code page.
    /// </summary>
    private static string JsonQuote(string text)
    {
        StringBuilder builder = new StringBuilder(text.Length + 2);
        builder.Append('"');
        foreach (char character in text)
        {
            switch (character)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (character < 0x20 || character > 0x7e)
                    {
                        builder.Append("\\u").Append(((int)character).ToString("x4"));
                    }
                    else
                    {
                        builder.Append(character);
                    }
                    break;
            }
        }
        builder.Append('"');
        return builder.ToString();
    }
}
"@

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4. Per-monitor-v2 gives physical
# pixels from CopyFromScreen and from SystemInformation.VirtualScreen on scaled
# displays; SetProcessDPIAware (system DPI aware) is the older fallback.
$dpiAware = $false
try { $dpiAware = [DshScreenshotDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
if (-not $dpiAware) {
  try { [void][DshScreenshotDpi]::SetProcessDPIAware() } catch { }
}

function Write-Response([string]$Text) {
  [Console]::Out.WriteLine($Text)
  [Console]::Out.Flush()
}

function Format-ErrorText([string]$Text) {
  if ($null -eq $Text -or $Text.Length -eq 0) { return 'unknown error' }
  # One response is one line: collapse newlines and cap the length so a stack
  # trace cannot corrupt the protocol.
  $oneLine = ($Text -replace '[\r\n]+', ' ').Trim()
  if ($oneLine.Length -gt 400) { $oneLine = $oneLine.Substring(0, 400) }
  return $oneLine
}

function Get-ScreenInfo {
  $screens = @()
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $bounds = $screen.Bounds
    $screens += [pscustomobject]@{
      x = [int]$bounds.X
      y = [int]$bounds.Y
      width = [int]$bounds.Width
      height = [int]$bounds.Height
      primary = [bool]$screen.Primary
    }
  }
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return [pscustomobject]@{
    screens = @($screens)
    virtual = [pscustomobject]@{
      x = [int]$virtual.X
      y = [int]$virtual.Y
      width = [int]$virtual.Width
      height = [int]$virtual.Height
    }
  }
}

function Invoke-Capture([string]$PngPath) {
  # Capture the whole virtual desktop in physical pixels. This is the warm hot
  # path: one 32bpp bitmap, one CopyFromScreen, one PNG save (~160 ms on
  # 2560x1440).
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    } finally {
      $graphics.Dispose()
    }
    $bitmap.Save($PngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }
  return $bounds
}

function Invoke-SetClipboardImage([string]$PngPath) {
  # Clipboard.SetImage copies the pixels into an HBITMAP data object, so the
  # image can be disposed as soon as the call returns. The clipboard is a
  # machine-wide singleton: retry briefly while another process holds it.
  $image = [System.Drawing.Image]::FromFile($PngPath)
  try {
    $set = $false
    for ($attempt = 0; $attempt -lt 8 -and -not $set; $attempt++) {
      try {
        [System.Windows.Forms.Clipboard]::SetImage($image)
        $set = $true
      } catch {
        Start-Sleep -Milliseconds 60
      }
    }
    if (-not $set) { throw 'the clipboard is busy; could not set the image' }
  } finally {
    $image.Dispose()
  }
}

function Invoke-ActivateProcess([string]$ProcessIdText) {
  $targetPid = 0
  if (-not [int]::TryParse($ProcessIdText.Trim(), [ref]$targetPid) -or $targetPid -le 0) {
    throw 'activate requires a positive process id argument'
  }
  $windowHandle = [DshScreenshotWindow]::FindTopLevelWindow([uint32]$targetPid)
  if ($windowHandle -eq [IntPtr]::Zero) {
    throw ("no top-level window found for process $targetPid")
  }
  # Activate returns the final foreground HWND; suppress it so the function's
  # only output is the target window handle (the protocol has one payload).
  [void][DshScreenshotWindow]::Activate($windowHandle)
  return $windowHandle
}

function Invoke-PrepareOverlay([string]$ProcessIdText) {
  $targetPid = 0
  if (-not [int]::TryParse($ProcessIdText.Trim(), [ref]$targetPid) -or $targetPid -le 0) {
    throw 'prepare-overlay requires a positive process id argument'
  }
  $windowHandle = [DshScreenshotWindow]::FindTopLevelWindow([uint32]$targetPid)
  if ($windowHandle -eq [IntPtr]::Zero) {
    throw ("no top-level window found for process $targetPid")
  }
  $snapshot = [DshScreenshotWindow]::GetPlacementSnapshot($windowHandle)
  if ($null -eq $snapshot -or $snapshot.Length -lt 5) {
    throw ("could not read the window placement of process $targetPid")
  }
  $originalShowCmd = [int]$snapshot[0]
  $changed = $false
  if ($originalShowCmd -ne 3) {
    [void][DshScreenshotWindow]::Maximize($windowHandle)
    # Bounded wait: the target app pumps its messages, so IsZoomed flips shortly.
    $deadline = [DateTime]::UtcNow.AddMilliseconds(600)
    while ([DateTime]::UtcNow -lt $deadline -and -not [DshScreenshotWindow]::IsZoomedWindow($windowHandle)) {
      Start-Sleep -Milliseconds 20
    }
    if (-not [DshScreenshotWindow]::IsZoomedWindow($windowHandle)) {
      throw 'the window could not be maximized for the overlay'
    }
    $changed = $true
  }
  # Same placement-preserving foreground routine used by the global-hotkey flow.
  [void][DshScreenshotWindow]::Activate($windowHandle)
  $changedToken = if ($changed) { '1' } else { '0' }
  $responseText = 'OK|prepare-overlay|' + $windowHandle.ToInt64() + '|' + $changedToken + '|' + $originalShowCmd
  $responseText += '|' + $snapshot[1] + '|' + $snapshot[2] + '|' + $snapshot[3] + '|' + $snapshot[4]
  return $responseText
}

function Invoke-RestoreOverlay([string]$PlacementText) {
  $parts = $PlacementText.Split('|')
  if ($parts.Length -lt 6) {
    throw 'restore-overlay requires <hwnd>|<showCmd>|<left>|<top>|<right>|<bottom>'
  }
  $handleValue = 0L
  if (-not [long]::TryParse($parts[0].Trim(), [ref]$handleValue) -or $handleValue -le 0) {
    throw 'restore-overlay requires a positive window handle'
  }
  $originalShowCmd = 0
  if (-not [int]::TryParse($parts[1].Trim(), [ref]$originalShowCmd)) {
    throw 'restore-overlay requires a numeric showCmd'
  }
  $rectValues = New-Object long[] 4
  for ($index = 0; $index -lt 4; $index++) {
    $parsed = 0L
    if (-not [long]::TryParse($parts[$index + 2].Trim(), [ref]$parsed)) {
      throw ('restore-overlay requires a numeric rectangle (bad component ' + ($index + 2) + ')')
    }
    $rectValues[$index] = $parsed
  }
  # A window that was originally maximized is left exactly as it is.
  if ($originalShowCmd -eq 3) {
    return 'OK|restore-overlay'
  }
  $windowHandle = [IntPtr]::new($handleValue)
  if (-not [DshScreenshotWindow]::IsWindow($windowHandle)) {
    throw 'the overlay window no longer exists'
  }
  $restoredOk = [DshScreenshotWindow]::RestorePlacement(
    $windowHandle, [int]$rectValues[0], [int]$rectValues[1], [int]$rectValues[2], [int]$rectValues[3])
  if (-not $restoredOk) {
    throw 'SetWindowPos failed while restoring the overlay window placement'
  }
  return 'OK|restore-overlay'
}

:mainLoop while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break mainLoop }   # stdin closed: Host is gone
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue mainLoop }

  $separator = $line.IndexOf('|')
  if ($separator -lt 0) {
    $command = $line.ToLowerInvariant()
    $argument = ''
  } else {
    $command = $line.Substring(0, $separator).ToLowerInvariant()
    $argument = $line.Substring($separator + 1)
  }

  switch ($command) {
    'ping' {
      Write-Response 'OK|ping'
    }
    'exit' {
      break mainLoop
    }
    'screens' {
      try {
        $info = Get-ScreenInfo
        Write-Response ('OK|screens|' + ($info | ConvertTo-Json -Compress -Depth 6))
      } catch {
        Write-Response ('ERR|screens|' + (Format-ErrorText $_.Exception.Message))
      }
    }
    'windows' {
      try {
        $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $windowJson = [DshScreenshotWindow]::EnumerateWindows(
          [int]$virtual.Left, [int]$virtual.Top, [int]$virtual.Right, [int]$virtual.Bottom)
        Write-Response ('OK|windows|' + $windowJson)
      } catch {
        Write-Response ('ERR|windows|' + (Format-ErrorText $_.Exception.Message))
      }
    }
    'capture' {
      try {
        if ([string]::IsNullOrWhiteSpace($argument)) { throw 'capture requires a PNG path argument' }
        $bounds = Invoke-Capture $argument
        Write-Response ("OK|capture|$($bounds.Width)|$($bounds.Height)|$argument")
      } catch {
        Write-Response ('ERR|capture|' + (Format-ErrorText $_.Exception.Message))
      }
    }
    'clipboard' {
      try {
        if ([string]::IsNullOrWhiteSpace($argument)) { throw 'clipboard requires a PNG path argument' }
        Invoke-SetClipboardImage $argument
        Write-Response 'OK|clipboard'
      } catch {
        Write-Response ('ERR|clipboard|' + (Format-ErrorText $_.Exception.Message))
      }
    }
    'activate' {
      try {
        if ([string]::IsNullOrWhiteSpace($argument)) { throw 'activate requires a process id argument' }
        $windowHandle = Invoke-ActivateProcess $argument
        Write-Response ('OK|activate|' + $windowHandle.ToInt64())
      } catch {
        Write-Response ('ERR|activate|' + (Format-ErrorText $_.Exception.Message))
      }
    }
    'prepare-overlay' {
      try {
        if ([string]::IsNullOrWhiteSpace($argument)) { throw 'prepare-overlay requires a process id argument' }
        Write-Response (Invoke-PrepareOverlay $argument)
      } catch {
        Write-Response ('ERR|prepare-overlay|' + (Format-ErrorText $_.Exception.Message))
      }
    }
    'restore-overlay' {
      try {
        if ([string]::IsNullOrWhiteSpace($argument)) { throw 'restore-overlay requires placement arguments' }
        Write-Response (Invoke-RestoreOverlay $argument)
      } catch {
        Write-Response ('ERR|restore-overlay|' + (Format-ErrorText $_.Exception.Message))
      }
    }
    default {
      Write-Response ('ERR|' + $command + '|unknown command')
    }
  }
}

exit 0
