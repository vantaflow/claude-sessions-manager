using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CsmNative;

// Petites fenêtres (saisie d'un texte, nouvelle session), construites en code pour rester proches de l'interface web.
static class Ui
{
    public static readonly Brush Bg = new SolidColorBrush(Color.FromRgb(0x23, 0x23, 0x29));
    public static readonly Brush Fg = new SolidColorBrush(Color.FromRgb(0xE6, 0xE6, 0xEA));
    public static readonly Brush Muted = new SolidColorBrush(Color.FromRgb(0x9A, 0x9A, 0xA6));
    public static Window Dialog(Window owner, string title, double width = 460) => new()
    {
        Owner = owner, Title = title, Width = width, SizeToContent = SizeToContent.Height, ResizeMode = ResizeMode.NoResize,
        WindowStartupLocation = WindowStartupLocation.CenterOwner, Background = Bg, ShowInTaskbar = false,
    };
    public static TextBlock Label(string t) => new() { Text = t, Foreground = Muted, Margin = new Thickness(0, 10, 0, 3) };
    public static StackPanel Buttons(Window w, string ok, Func<bool> onOk)
    {
        var p = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0) };
        var cancel = new Button { Content = "Annuler", IsCancel = true, MinWidth = 90, Margin = new Thickness(0, 0, 8, 0) };
        var go = new Button { Content = ok, IsDefault = true, MinWidth = 110 };
        go.Click += (_, _) => { if (onOk()) w.DialogResult = true; };
        p.Children.Add(cancel); p.Children.Add(go);
        return p;
    }

    public static string? Ask(Window owner, string title, string label, string value = "")
    {
        var w = Dialog(owner, title);
        var box = new TextBox { Text = value, Padding = new Thickness(4) };
        var root = new StackPanel { Margin = new Thickness(18) };
        root.Children.Add(Label(label)); root.Children.Add(box);
        root.Children.Add(Buttons(w, "OK", () => box.Text.Trim().Length > 0));
        w.Content = root;
        w.Loaded += (_, _) => { box.Focus(); box.SelectAll(); };
        return w.ShowDialog() == true ? box.Text.Trim() : null;
    }
}

// Nouvelle session : mêmes champs de base que l'interface web (dossier, nom, groupe, modèle, mode, premier prompt).
public sealed class NewSessionRequest
{
    public string Cwd = "", Name = "", Group = "", Model = "", Mode = "", Prompt = "";
    public string Args => string.Join(" ", new[] { Model.Length > 0 ? $"--model {Model}" : "", Mode.Length > 0 ? $"--permission-mode {Mode}" : "" }.Where(x => x.Length > 0));
}

static class NewSessionDialog
{
    static readonly (string Value, string Label)[] Models = [("", "Par défaut (réglages)"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")];
    static readonly (string Value, string Label)[] Modes = [("", "Par défaut (réglages)"), ("default", "Demander à chaque action"), ("acceptEdits", "Accepter les modifications"), ("plan", "Plan"), ("bypassPermissions", "Tout autoriser (bypass)")];

    public static NewSessionRequest? Show(Window owner, IEnumerable<string> groups, string? group = null)
    {
        var w = Ui.Dialog(owner, "Nouvelle session", 520);
        var root = new StackPanel { Margin = new Thickness(18) };
        var folder = new TextBox { Padding = new Thickness(4) };
        var browse = new Button { Content = "Parcourir…", Margin = new Thickness(6, 0, 0, 0), Padding = new Thickness(10, 2, 10, 2) };
        browse.Click += (_, _) =>
        {
            var d = new Microsoft.Win32.OpenFolderDialog { Title = "Dossier de la session" };
            if (d.ShowDialog(w) == true) { folder.Text = d.FolderName; }
        };
        var row = new DockPanel(); DockPanel.SetDock(browse, Dock.Right); row.Children.Add(browse); row.Children.Add(folder);
        var name = new TextBox { Padding = new Thickness(4) };
        var grp = new ComboBox { IsEditable = true, ItemsSource = groups.ToList(), Text = group ?? "" };
        var model = new ComboBox { ItemsSource = Models.Select(m => m.Label).ToList(), SelectedIndex = 0 };
        var mode = new ComboBox { ItemsSource = Modes.Select(m => m.Label).ToList(), SelectedIndex = 0 };
        var prompt = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Height = 90, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(4) };
        root.Children.Add(Ui.Label("Dossier")); root.Children.Add(row);
        root.Children.Add(Ui.Label("Nom (facultatif : nom du dossier)")); root.Children.Add(name);
        root.Children.Add(Ui.Label("Groupe (facultatif, « Parent/Enfant » pour un sous-groupe)")); root.Children.Add(grp);
        root.Children.Add(Ui.Label("Modèle")); root.Children.Add(model);
        root.Children.Add(Ui.Label("Mode")); root.Children.Add(mode);
        root.Children.Add(Ui.Label("Premier prompt (facultatif, envoyé dès que Claude est prêt)")); root.Children.Add(prompt);
        root.Children.Add(Ui.Buttons(w, "Lancer", () => System.IO.Directory.Exists(folder.Text.Trim())));
        w.Content = root;
        w.Loaded += (_, _) => browse.Focus();
        if (w.ShowDialog() != true) return null;
        return new NewSessionRequest
        {
            Cwd = folder.Text.Trim(), Name = name.Text.Trim(), Group = grp.Text.Trim(),
            Model = Models[Math.Max(0, model.SelectedIndex)].Value, Mode = Modes[Math.Max(0, mode.SelectedIndex)].Value, Prompt = prompt.Text.Trim(),
        };
    }
}
