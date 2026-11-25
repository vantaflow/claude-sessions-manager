using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Terminal.Wpf;
using Microsoft.Win32;

namespace CsmNative;

// Thème de l'app (réglage « theme » partagé avec l'interface web : system, light, dark). Les couleurs sont des
// ressources dynamiques remplacées en place : tout ce qui est affiché change aussitôt, comme dans l'app Electron
// (palette Atelier de public/style.css, :root et :root[data-theme="light"]).
static class Theme
{
    static readonly Dictionary<string, string> Dark = new()
    {
        ["Bg"] = "#111214", ["Panel"] = "#16171A", ["Panel2"] = "#1E2023", ["Bar"] = "#131417", ["Term"] = "#0E0F11",
        ["Line"] = "#26282D", ["Line2"] = "#2E3036", ["Ring"] = "#34363C", ["Sel"] = "#22242A", ["Hover"] = "#1A1C20",
        ["Fg"] = "#E8E6E1", ["Fg2"] = "#D6D3CC", ["Dim"] = "#B9B6B0", ["Muted"] = "#8C8F96", ["Dim2"] = "#6F727A",
        ["Accent"] = "#D97757", ["OnAccent"] = "#1A1110", ["AccentSoft"] = "#24D97757", ["AccentLine"] = "#66D97757", ["AccentFg"] = "#F0B49D", ["Branch"] = "#E9A07F",
        ["Ok"] = "#3FB8A5", ["Work"] = "#E3A33B", ["Warn"] = "#E5734E", ["WarnSoft"] = "#29E5734E", ["WarnLine"] = "#66E5734E", ["WarnFg"] = "#F09A7E",
    };
    static readonly Dictionary<string, string> Light = new()
    {
        ["Bg"] = "#F4F1EC", ["Panel"] = "#FBFAF8", ["Panel2"] = "#ECE7DF", ["Bar"] = "#F7F4EF", ["Term"] = "#FBFAF8",
        ["Line"] = "#DCD5CA", ["Line2"] = "#D2CABD", ["Ring"] = "#B9B0A3", ["Sel"] = "#ECE7DF", ["Hover"] = "#F0ECE5",
        ["Fg"] = "#1F1B18", ["Fg2"] = "#2A2A2D", ["Dim"] = "#5E5853", ["Muted"] = "#6B6560", ["Dim2"] = "#A39D96",
        ["Accent"] = "#C4613F", ["OnAccent"] = "#FFFFFF", ["AccentSoft"] = "#1FC4613F", ["AccentLine"] = "#66C4613F", ["AccentFg"] = "#A84D2E", ["Branch"] = "#B8552F",
        ["Ok"] = "#1F8A4C", ["Work"] = "#A86F00", ["Warn"] = "#C0392B", ["WarnSoft"] = "#1FC0392B", ["WarnLine"] = "#66C0392B", ["WarnFg"] = "#A93226",
    };

    public static string Setting { get; private set; } = "system";
    public static bool IsLight { get; private set; }
    public static event Action? Changed;

    static bool SystemLight()
    {
        try { return Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 0) is int v && v == 1; }
        catch { return false; }
    }

    public static void Init()
    {
        // titre de fenêtre clair ou sombre pour toutes les fenêtres, à leur ouverture
        EventManager.RegisterClassHandler(typeof(Window), FrameworkElement.LoadedEvent, new RoutedEventHandler((s, _) => TitleBar((Window)s)));
        SystemEvents.UserPreferenceChanged += (_, e) => { if (Setting == "system" && e.Category == UserPreferenceCategory.General) Application.Current.Dispatcher.Invoke(() => Apply(Setting, true)); };
        Apply("system", true);
    }

    public static void Apply(string? setting, bool force = false)
    {
        Setting = setting is "light" or "dark" ? setting : "system";
        var light = Setting == "light" || (Setting == "system" && SystemLight());
        if (!force && light == IsLight) return;
        IsLight = light;
        var res = Application.Current.Resources;
        foreach (var (k, v) in light ? Light : Dark)
        {
            var c = (Color)ColorConverter.ConvertFromString(v);
            var b = new SolidColorBrush(c); b.Freeze(); res[k] = b;
        }
        res["CBg"] = ((SolidColorBrush)res["Bg"]).Color;
        foreach (Window w in Application.Current.Windows) TitleBar(w);
        Changed?.Invoke();
    }

    public static Color C(string key) => ((SolidColorBrush)Application.Current.Resources[key]).Color;

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    static void TitleBar(Window w)
    {
        var h = new WindowInteropHelper(w).Handle; if (h == IntPtr.Zero) return;
        var dark = IsLight ? 0 : 1;
        try { DwmSetWindowAttribute(h, 20, ref dark, 4); } catch { }
    }

    // terminal : couleurs COLORREF (0x00BBGGRR), mêmes palettes que xterm.js dans l'app web
    static uint Ref(string hex) { var c = (Color)ColorConverter.ConvertFromString(hex); return (uint)(c.B << 16 | c.G << 8 | c.R); }
    public static TerminalTheme Terminal => IsLight
        ? new()
        {
            DefaultBackground = Ref("#FBFAF8"), DefaultForeground = Ref("#2A2A2D"), DefaultSelectionBackground = Ref("#E2DFD8"), CursorStyle = CursorStyle.BlinkingBar,
            ColorTable = [Ref("#1C1C1E"), Ref("#C0392B"), Ref("#1F7A3F"), Ref("#9A6B00"), Ref("#1F5FBF"), Ref("#8A3FA0"), Ref("#0E6F86"), Ref("#8A8D93"),
                          Ref("#5E6168"), Ref("#A93226"), Ref("#1A6B36"), Ref("#8A5A00"), Ref("#1A4FA0"), Ref("#7A2F90"), Ref("#0B5F73"), Ref("#1C1C1E")],
        }
        : new()
        {
            DefaultBackground = 0x110F0E, DefaultForeground = 0xCCD3D6, DefaultSelectionBackground = 0x5A4A44, CursorStyle = CursorStyle.BlinkingBar,
            ColorTable = [0x2E2E2E, 0x4E73E5, 0xA5B83F, 0x3BA3E3, 0xE8A061, 0xC778C6, 0xC2B656, 0xE1E6E8,
                          0x75756B, 0x8080FF, 0xA0E08A, 0x9AD7F0, 0xFFB57A, 0xE69BE0, 0xDCD27A, 0xFFFFFF],
        };
}
