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
    static readonly Brush FgB = Frozen(0xE8, 0xE6, 0xE1), DimB = Frozen(0xB9, 0xB6, 0xB0), MutedB = Frozen(0x8C, 0x8F, 0x96), Dim2B = Frozen(0x6F, 0x72, 0x7A);
    public static readonly Brush WorkB = Frozen(0xE3, 0xA3, 0x3B), WarnB = Frozen(0xE5, 0x73, 0x4E), OkB = Frozen(0x3F, 0xB8, 0xA5), OffB = Frozen(0x6F, 0x72, 0x7A);
    static Brush Frozen(byte r, byte g, byte b) { var x = new SolidColorBrush(Color.FromRgb(r, g, b)); x.Freeze(); return x; }

    public string Id { get; init; } = "";
    public JsonObject Data { get; private set; } = new();
    string S(string k) => (string?)Data[k] ?? "";
    bool B(string k) => Data[k] is JsonValue v && v.TryGetValue<bool>(out var b) && b;
    public string Name => S("name") is { Length: > 0 } n ? n : "session";
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
    public string Detail => Message.Length > 0 && Message != StatusLabel ? $"{StatusLabel} · {Message}" : Sleeping ? "en veille · se réveille à l'affichage" : StatusLabel;
    public string Badges => string.Join(" ", new[] { QueueCount > 0 ? $"⏳ {QueueCount}" : "", Remote ? "📱" : "", Locked ? "🔒" : "", Muted ? "🔕" : "", Origin.Length > 0 && !Alive ? "⇄" : "" }.Where(x => x.Length > 0));
    public Brush Dot => Locked ? OffB : Status switch { "working" => WorkB, "attention" => WarnB, "idle" => OkB, _ => OffB };
    public Brush StateBrush => Status switch { "working" => WorkB, "attention" => WarnB, "idle" => OkB, _ => MutedB };
    public Brush NameBrush => Alive || Status == "starting" ? FgB : DimB;
    public Brush DetailBrush => Status == "working" ? WorkB : Alive ? MutedB : Dim2B;
    public void Update(JsonObject d) { Data = d; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(null)); }
    public event PropertyChangedEventHandler? PropertyChanged;
}
