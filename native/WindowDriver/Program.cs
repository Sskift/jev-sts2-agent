using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

// Persistent JSON-lines bridge. Only window-addressed messages are used for input.
// No global input injection, foreground activation, or cursor movement APIs exist here.
internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    private const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101;
    [STAThread]
    private static void Main()
    {
        Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            JsonElement? id = null;
            try
            {
                using var request = JsonDocument.Parse(line);
                var r = request.RootElement;
                if (r.TryGetProperty("id", out var value)) id = value.Clone();
                object result = String(r, "command") switch
                {
                    "list" => ListWindows(),
                    "status" => Status(FindWindow(r)),
                    "capture" => Capture(r),
                    "resize" => Resize(r),
                    "restore" => Restore(r),
                    "click" or "drag" or "move" or "key" => Input(r),
                    "launch" => Launch(r),
                    _ => throw new ArgumentException("Unknown command")
                };
                Console.WriteLine(JsonSerializer.Serialize(new { id, ok = true, result }, JsonOptions));
            }
            catch (Exception error)
            {
                Console.WriteLine(JsonSerializer.Serialize(new { id, ok = false, error = error.Message }, JsonOptions));
            }
        }
    }

    private static string? String(JsonElement r, string name) => r.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
    private static int Number(JsonElement r, string name, int fallback = 0) => r.TryGetProperty(name, out var p) ? p.GetInt32() : fallback;
    private static string Handle(IntPtr hwnd) => "0x" + hwnd.ToInt64().ToString("X");
    private static string Title(IntPtr hwnd)
    {
        var b = new StringBuilder(1024);
        Native.GetWindowText(hwnd, b, b.Capacity);
        return b.ToString();
    }
    private static WindowInfo Describe(IntPtr hwnd)
    {
        Native.GetWindowThreadProcessId(hwnd, out uint pid);
        string name = "";
        try { using var p = Process.GetProcessById((int)pid); name = p.ProcessName; } catch { }
        Native.GetClientRect(hwnd, out var client);
        var origin = new Native.Point();
        Native.ClientToScreen(hwnd, ref origin);
        return new(Handle(hwnd), (int)pid, name, Title(hwnd), new(client.Right, client.Bottom),
            new(origin.X, origin.Y), Native.IsWindowVisible(hwnd), Native.IsIconic(hwnd),
            (Native.GetWindowLongPtr(hwnd, -20).ToInt64() & 0x8) != 0, OverlappingWindowsAbove(hwnd));
    }
    private static int OverlappingWindowsAbove(IntPtr target)
    {
        Native.GetWindowRect(target, out var targetRect);
        int count = 0;
        Native.EnumWindows((candidate, _) =>
        {
            if (candidate == target) return false;
            if (Native.IsWindowVisible(candidate) && !Native.IsIconic(candidate)
                && Native.GetWindowRect(candidate, out var rect)
                && Math.Min(rect.Right, targetRect.Right) > Math.Max(rect.Left, targetRect.Left)
                && Math.Min(rect.Bottom, targetRect.Bottom) > Math.Max(rect.Top, targetRect.Top)) count++;
            return true;
        }, IntPtr.Zero);
        return count;
    }
    private static List<WindowInfo> ListWindows()
    {
        var windows = new List<WindowInfo>();
        Native.EnumWindows((hwnd, _) =>
        {
            if (Native.IsWindowVisible(hwnd) && Native.GetWindowTextLength(hwnd) > 0) windows.Add(Describe(hwnd));
            return true;
        }, IntPtr.Zero);
        return windows;
    }
    private static IntPtr FindWindow(JsonElement r)
    {
        var requested = String(r, "hwnd");
        if (requested != null)
        {
            var value = requested.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? Convert.ToInt64(requested[2..], 16) : long.Parse(requested);
            var hwnd = new IntPtr(value);
            if (!Native.IsWindow(hwnd)) throw new ArgumentException("Window handle no longer exists");
            return hwnd;
        }
        int processId = Number(r, "processId");
        string? processName = String(r, "processName"), title = String(r, "titleContains");
        if (processId == 0 && processName == null && title == null) throw new ArgumentException("A window selector is required");
        var matches = ListWindows().Where(w => (processId == 0 || w.ProcessId == processId)
            && (processName == null || w.ProcessName.Equals(processName, StringComparison.OrdinalIgnoreCase))
            && (title == null || w.Title.Contains(title, StringComparison.OrdinalIgnoreCase))).ToArray();
        if (matches.Length != 1) throw new ArgumentException($"Window selector matched {matches.Length} windows; choose a unique hwnd or processId");
        return new IntPtr(Convert.ToInt64(matches[0].Hwnd[2..], 16));
    }
    private static DesktopState Desktop()
    {
        Native.GetCursorPos(out var point);
        return new(Handle(Native.GetForegroundWindow()), new(point.X, point.Y));
    }
    private static object Status(IntPtr hwnd)
    {
        var window = Describe(hwnd);
        return new { hwnd = window.Hwnd, width = window.ClientSize.Width, height = window.ClientSize.Height,
            window, desktop = Desktop(), inputMethod = "PostMessage", captureMethod = "PrintWindow" };
    }
    private static object Restore(JsonElement r)
    {
        var hwnd = FindWindow(r);
        var before = Desktop();
        if (Native.IsIconic(hwnd)) Native.ShowWindowAsync(hwnd, 4); // SW_SHOWNOACTIVATE
        Thread.Sleep(250);
        var after = Desktop();
        return new { window = Describe(hwnd), before, after, foregroundUnchanged = before.Foreground == after.Foreground, cursorUnchanged = before.Cursor == after.Cursor };
    }
    private static void ValidateWindow(IntPtr hwnd)
    {
        if (!Native.IsWindow(hwnd)) throw new InvalidOperationException("Target window was destroyed");
        if (Native.IsIconic(hwnd)) throw new InvalidOperationException("Target window is minimized; unminimize it before capture or input");
        if (!Native.GetClientRect(hwnd, out var r) || r.Right <= 0 || r.Bottom <= 0) throw new InvalidOperationException("Target has no client surface");
    }
    private static object Capture(JsonElement r)
    {
        var hwnd = FindWindow(r);
        ValidateWindow(hwnd);
        string path = System.IO.Path.GetFullPath(String(r, "path") ?? throw new ArgumentException("Capture path is required"));
        if (!path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Capture path must end in .png");
        var before = Desktop();
        Native.GetClientRect(hwnd, out var rect);
        // GDI does not consistently initialize alpha; RGB guarantees an opaque PNG.
        using var bitmap = new Bitmap(rect.Right, rect.Bottom, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var hdc = graphics.GetHdc();
            try
            {
                if (!Native.PrintWindow(hwnd, hdc, 0x00000001 | 0x00000002))
                    throw new InvalidOperationException("PrintWindow failed; the target may not support background capture");
            }
            finally { graphics.ReleaseHdc(hdc); }
        }
        // A GPU surface can report PrintWindow success while returning an empty buffer.
        var colors = new HashSet<int>();
        int samples = 0, dark = 0;
        for (int y = 0; y < bitmap.Height; y += Math.Max(1, bitmap.Height / 40))
        for (int x = 0; x < bitmap.Width; x += Math.Max(1, bitmap.Width / 60))
        {
            var c = bitmap.GetPixel(x, y);
            colors.Add(c.ToArgb()); samples++;
            if (c.R < 3 && c.G < 3 && c.B < 3) dark++;
        }
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        bitmap.Save(path, ImageFormat.Png);
        var after = Desktop();
        return new { path, width = bitmap.Width, height = bitmap.Height, hwnd = Handle(hwnd), method = "PrintWindow",
            nonBlank = colors.Count > 4, sampledColors = colors.Count, darkFraction = (double)dark / samples,
            before, after, foregroundUnchanged = before.Foreground == after.Foreground, cursorUnchanged = before.Cursor == after.Cursor };
    }
    private static object Resize(JsonElement r)
    {
        var hwnd = FindWindow(r);
        ValidateWindow(hwnd);
        int width = Number(r, "width"), height = Number(r, "height");
        if (width < 320 || height < 200 || width > 8192 || height > 8192)
            throw new ArgumentException("Client resize dimensions must be between 320x200 and 8192x8192 pixels");
        if (!Native.GetWindowRect(hwnd, out var outer) || !Native.GetClientRect(hwnd, out var client))
            throw new InvalidOperationException("Could not measure the target window");
        var before = Desktop();
        var previousSize = new SizeInfo(client.Right, client.Bottom);
        // Existing non-client extents already reflect the window's actual DPI and style.
        int outerWidth = width + (outer.Right - outer.Left - client.Right);
        int outerHeight = height + (outer.Bottom - outer.Top - client.Bottom);
        const uint flags = 0x0002 | 0x0004 | 0x0010 | 0x0200; // NOMOVE | NOZORDER | NOACTIVATE | NOOWNERZORDER
        if (!Native.SetWindowPos(hwnd, IntPtr.Zero, 0, 0, outerWidth, outerHeight, flags))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetWindowPos failed");
        // Let the game commit its render surface; report actual dimensions if it enforces a minimum.
        Thread.Sleep(150);
        var window = Describe(hwnd);
        var after = Desktop();
        return new { hwnd = Handle(hwnd), width = window.ClientSize.Width, height = window.ClientSize.Height,
            requestedWidth = width, requestedHeight = height, previousSize,
            sizeMatched = window.ClientSize.Width == width && window.ClientSize.Height == height,
            method = "SetWindowPos:NOZORDER|NOACTIVATE|NOMOVE|NOOWNERZORDER", before, after,
            foregroundUnchanged = before.Foreground == after.Foreground, cursorUnchanged = before.Cursor == after.Cursor };
    }
    private static void CheckPoint(IntPtr hwnd, int x, int y)
    {
        Native.GetClientRect(hwnd, out var rect);
        if (x < 0 || y < 0 || x >= rect.Right || y >= rect.Bottom || x > 32767 || y > 32767)
            throw new ArgumentException($"Client point ({x},{y}) is outside {rect.Right}x{rect.Bottom}");
    }
    private static IntPtr PointMessage(int x, int y) => new((y << 16) | (x & 0xffff));
    private static void Post(IntPtr hwnd, uint message, int wParam, IntPtr lParam)
    {
        if (!Native.PostMessage(hwnd, message, new IntPtr(wParam), lParam))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "PostMessage failed");
    }
    private static object Input(JsonElement r)
    {
        var hwnd = FindWindow(r);
        ValidateWindow(hwnd);
        Native.GetClientRect(hwnd, out var dimensions);
        int expectedWidth = Number(r, "expectedWidth", dimensions.Right), expectedHeight = Number(r, "expectedHeight", dimensions.Bottom);
        if (expectedWidth != dimensions.Right || expectedHeight != dimensions.Bottom)
            throw new InvalidOperationException("Window client size changed since capture; recapture before input");
        var before = Desktop();
        string command = String(r, "command")!;
        int x = 0, y = 0;
        if (command == "key")
        {
            string key = (String(r, "key") ?? throw new ArgumentException("key is required")).ToUpperInvariant();
            int vk = key switch { "ENTER" => 13, "ESC" or "ESCAPE" => 27, "SPACE" => 32, "TAB" => 9,
                "LEFT" => 37, "UP" => 38, "RIGHT" => 39, "DOWN" => 40,
                _ when key.Length == 1 && char.IsAsciiLetterOrDigit(key[0]) => key[0],
                _ => throw new ArgumentException("Unsupported key") };
            int scan = (int)Native.MapVirtualKey((uint)vk, 0);
            int bits = 1 | (scan << 16) | ((vk >= 37 && vk <= 40) ? (1 << 24) : 0);
            Post(hwnd, WM_KEYDOWN, vk, new IntPtr(bits));
            Thread.Sleep(60);
            Post(hwnd, WM_KEYUP, vk, new IntPtr(unchecked(bits | (int)0xC0000000)));
        }
        else
        {
            if (!r.TryGetProperty("x", out var xp) || !r.TryGetProperty("y", out var yp) || !xp.TryGetInt32(out x) || !yp.TryGetInt32(out y))
                throw new ArgumentException("Integer client x and y coordinates are required");
            CheckPoint(hwnd, x, y);
            if (command == "drag" && (!r.TryGetProperty("endX", out _) || !r.TryGetProperty("endY", out _)))
                throw new ArgumentException("Drag endpoint coordinates are required");
            int endX = Number(r, "endX", x), endY = Number(r, "endY", y);
            if (command == "drag") CheckPoint(hwnd, endX, endY);
            Post(hwnd, WM_MOUSEMOVE, 0, PointMessage(x, y));
            Thread.Sleep(50);
            if (command != "move")
            {
                Post(hwnd, WM_LBUTTONDOWN, 1, PointMessage(x, y));
                try
                {
                    Thread.Sleep(80);
                    if (command == "drag")
                    {
                        int duration = Math.Clamp(Number(r, "durationMs", 450), 100, 2500);
                        int steps = Math.Max(8, duration / 20);
                        for (int i = 1; i <= steps; i++)
                        {
                            int px = x + (endX - x) * i / steps, py = y + (endY - y) * i / steps;
                            Post(hwnd, WM_MOUSEMOVE, 1, PointMessage(px, py));
                            Thread.Sleep(duration / steps);
                        }
                    }
                }
                finally { Post(hwnd, WM_LBUTTONUP, 0, PointMessage(command == "drag" ? endX : x, command == "drag" ? endY : y)); }
            }
        }
        Thread.Sleep(80);
        var after = Desktop();
        return new { command, hwnd = Handle(hwnd), inputMethod = "PostMessage", before, after,
            foregroundUnchanged = before.Foreground == after.Foreground, cursorUnchanged = before.Cursor == after.Cursor };
    }
    private static object Launch(JsonElement r)
    {
        string exe = System.IO.Path.GetFullPath(String(r, "exe") ?? throw new ArgumentException("exe is required"));
        if (!File.Exists(exe)) throw new FileNotFoundException("Game executable was not found", exe);
        string args = String(r, "args") ?? "";
        if (args.Contains('\0')) throw new ArgumentException("Invalid launch arguments");
        var startup = new Native.StartupInfo { cb = Marshal.SizeOf<Native.StartupInfo>(), dwFlags = 1, wShowWindow = 4 };
        var command = new StringBuilder("\"" + exe + "\" " + args);
        var before = Desktop();
        if (!Native.CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero,
                System.IO.Path.GetDirectoryName(exe), ref startup, out var process))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try { return new { processId = process.dwProcessId, exe, args, showMode = "SW_SHOWNOACTIVATE", before, after = Desktop() }; }
        finally { Native.CloseHandle(process.hProcess); Native.CloseHandle(process.hThread); }
    }
    private record SizeInfo(int Width, int Height);
    private record PointInfo(int X, int Y);
    private record DesktopState(string Foreground, PointInfo Cursor);
    private record WindowInfo(string Hwnd, int ProcessId, string ProcessName, string Title, SizeInfo ClientSize, PointInfo ClientOrigin, bool Visible, bool Minimized, bool Topmost, int OverlappingWindowsAbove);
}

internal static class Native
{
    internal delegate bool EnumWindowProc(IntPtr hwnd, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct StartupInfo
    {
        public int cb; public string? lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInformation { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] internal static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] internal static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] internal static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] internal static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string? directory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
}
