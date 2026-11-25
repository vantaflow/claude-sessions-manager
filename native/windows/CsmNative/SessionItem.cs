using System.ComponentModel;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Media;

namespace CsmNative;

// Une session telle que le serveur la décrit (publicView de server.js), pour la liste et les panneaux.
public sealed class SessionItem : INotifyPropertyChanged
{
    public const string PinnedGroup = "📌 ÉPINGLÉES", NoGroup = "SANS GROUPE";
    // couleurs du thème en cours (clair ou sombre), lues à chaque affichage
    static Brush FgB => Ui.R("Fg"); static Brush DimB => Ui.R("Dim"); static Brush MutedB => Ui.R("Muted"); static Brush Dim2B => Ui.R("Dim2");
    public static Brush WorkB => Ui.R("Work"); public static Brush WarnB => Ui.R("Warn"); public static Brush OkB => Ui.R("Ok"); public static Brush OffB => Ui.R("Dim2");

    public string Id { get; init; } = "";
    public JsonObject Data { get; private set; } = new();
    string S(string k) => (string?)Data[k] ?? "";
    bool B(string k) => Data[k] is JsonValue v && v.TryGetValue<bool>(out var b) && b;
    public string Name => S("name") is { Length: > 0 } n ? n : "session";
    public string Initial => Name.TrimStart('●', ' ').Length > 0 ? Name.TrimStart('●', ' ')[..1].ToUpperInvariant() : "?";
    public string Status => S("status");
    public string Message => S("message");
    public string Cwd => S("cwd");
    public string Args => S("args");
    public bool Alive => B("alive");
    public bool Pinned => B("pinned");
    public bool Sleeping => B("sleeping");
    public bool Paused => B("paused");
    public bool NoSleep => B("noSleep");
    public bool Remote => B("remote");
    public bool Locked => B("locked");
    public bool Muted => Data["alerts"]?["mute"] is JsonValue m && m.TryGetValue<bool>(out var x) && x;
    public JsonObject? Worktree => Data["worktree"] as JsonObject;
    public string Branch => (string?)Worktree?["branch"] ?? "";
    public Visibility BranchVisibility => Branch.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    public int QueueCount => (Data["queue"] as JsonArray)?.Count ?? 0;
    public string Origin => S("origin");
    public double Order => Data["order"] is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0;
    // Groupe « Parent/Enfant » (séparateur /, comme l'interface web) affiché « PARENT › ENFANT »
    public string Group => string.Join("/", S("group").Split('/').Select(p => p.Trim()).Where(p => p.Length > 0));
    public string GroupKey => Pinned ? PinnedGroup : Group.Length == 0 ? NoGroup : Group.Replace("/", " › ").ToUpperInvariant();
    public string Model => Arg("--model");
    public string Mode => Arg("--permission-mode");
    string Arg(string flag) { var m = Regex.Match(Args, $@"(?:^|\s){Regex.Escape(flag)}[ =](\S+)"); return m.Success ? m.Groups[1].Value : ""; }

    public string StatusLabel => Locked ? "verrouillée" : Sleeping ? "en veille" : Paused ? "en pause" : Status switch
    {
        "working" => "travaille", "attention" => "attend ta réponse", "idle" => "prête", "starting" => "démarre", "exited" => "arrêtée", _ => Status,
    };
    // comme la liste de l'app web : état, message, depuis combien de temps (« travaille · 4 min · Edit app.js »)
    public string Detail => Sleeping ? "en veille · se réveille à l'affichage" : string.Join(" · ", new[] { StatusLabel, Ago, Message.Length > 0 && Message != StatusLabel ? Message : "" }.Where(x => x.Length > 0));
    public string Ago
    {
        get
        {
            if (Data["statusSince"] is not JsonValue v || !v.TryGetValue<double>(out var ms)) return "";
            var s = Math.Max(0, (DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds((long)ms)).TotalSeconds);
            return s < 60 ? $"{(int)s} s" : s < 3600 ? $"{(int)(s / 60)} min" : s < 86400 ? $"{(int)(s / 3600)} h" : $"{(int)(s / 86400)} j";
        }
    }
    // dossier personnel abrégé en ~ (chemin long ou court 8.3)
    static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    public static string Tilde(string p)
    {
        foreach (var h in new[] { Home, ShortPath(Home) }) if (h.Length > 0 && p.StartsWith(h, StringComparison.OrdinalIgnoreCase)) return "~" + p[h.Length..].Replace('\\', '/');
        return p;
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] static extern int GetShortPathName(string l, System.Text.StringBuilder s, int n);
    static string ShortPath(string p) { var b = new System.Text.StringBuilder(512); return GetShortPathName(p, b, 512) > 0 ? b.ToString() : ""; }
    public string Badges => string.Join(" ", new[] { QueueCount > 0 ? $"⏳ {QueueCount}" : "", Remote ? "📱" : "", Locked ? "🔒" : "", Muted ? "🔕" : "", Origin.Length > 0 && !Alive ? "⇄" : "" }.Where(x => x.Length > 0));
    public Brush Dot => Locked ? OffB : Status switch { "working" => WorkB, "attention" => WarnB, "idle" => OkB, _ => OffB };
    public Brush StateBrush => Status switch { "working" => WorkB, "attention" => WarnB, "idle" => OkB, _ => MutedB };
    public Brush NameBrush => Alive || Status == "starting" ? FgB : DimB;
    public Brush DetailBrush => Status == "working" ? WorkB : Alive ? MutedB : Dim2B;
    public void Update(JsonObject d) { Data = d; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(null)); }
    public event PropertyChangedEventHandler? PropertyChanged;
}
