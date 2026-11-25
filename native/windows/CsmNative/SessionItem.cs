using System.ComponentModel;
using System.Text.Json.Nodes;
using System.Windows.Media;

namespace CsmNative;

// Une session telle que le serveur la décrit (publicView de server.js), pour la liste.
public sealed class SessionItem : INotifyPropertyChanged
{
    public const string PinnedGroup = "📌 Épinglées", NoGroup = "Sans groupe";
    public string Id { get; init; } = "";
    public JsonObject Data { get; private set; } = new();
    public string Name => (string?)Data["name"] ?? "session";
    public string Status => (string?)Data["status"] ?? "";
    public string Message => (string?)Data["message"] ?? "";
    public string Cwd => (string?)Data["cwd"] ?? "";
    public bool Alive => (bool?)Data["alive"] ?? false;
    public bool Pinned => (bool?)Data["pinned"] ?? false;
    public bool Sleeping => (bool?)Data["sleeping"] ?? false;
    public bool Paused => (bool?)Data["paused"] ?? false;
    public bool NoSleep => (bool?)Data["noSleep"] ?? false;
    public bool Remote => (bool?)Data["remote"] ?? false;
    public bool Muted => (bool?)Data["alerts"]?["mute"] ?? false;
    public bool Locked => (bool?)Data["locked"] ?? false;
    public double Order => (double?)Data["order"] ?? 0;
    // Groupe « Parent/Enfant » (séparateur /, comme l'interface web) affiché « Parent › Enfant »
    public string Group => string.Join("/", ((string?)Data["group"] ?? "").Split('/').Select(p => p.Trim()).Where(p => p.Length > 0));
    public string GroupKey => Pinned ? PinnedGroup : Group.Length == 0 ? NoGroup : Group.Replace("/", " › ");
    public string StatusLabel => Locked ? "verrouillée" : Sleeping ? "en veille" : Paused ? "en pause" : Status switch
    {
        "working" => "travaille", "attention" => "attend ta réponse", "idle" => "prête", "starting" => "démarre", "exited" => "arrêtée", _ => Status,
    };
    public string Detail => Message.Length > 0 && Message != StatusLabel ? $"{StatusLabel} · {Message}" : StatusLabel;
    public Brush Dot => new SolidColorBrush(Status switch
    {
        "working" => Color.FromRgb(0xD9, 0x77, 0x57), "attention" => Color.FromRgb(0xE5, 0xC0, 0x7B),
        "idle" => Color.FromRgb(0x6A, 0xC2, 0x8B), _ => Color.FromRgb(0x6B, 0x6B, 0x75),
    });
    public void Update(JsonObject d) { Data = d; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(null)); }
    public event PropertyChangedEventHandler? PropertyChanged;
}
