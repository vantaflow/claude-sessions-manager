using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace CsmNative;

// Connexion à Claude dans une fenêtre web intégrée (WebView2, moteur d'Edge) : le serveur lance `claude auth login`
// (lib/auth.js) comme pour l'app Electron ; la page de connexion s'ouvre ici, et le code de fin est récupéré tout
// seul. Profil web jetable, effacé à la fermeture : seul Claude Code garde la connexion. Google refuse sa connexion
// dans une fenêtre intégrée : la page part alors dans le navigateur, et le code se colle à la main.
public sealed class AuthWindow : Screen
{
    readonly WebView2 web = new();
    readonly TextBlock status = Ui.Hint("Ouverture de la page de connexion…");
    readonly TextBox code = Ui.Box();
    readonly string profile = Path.Combine(Path.GetTempPath(), "csm-auth-" + Guid.NewGuid().ToString("N")[..8]);
    string url = "";
    bool sent, done;

    public AuthWindow(MainWindow owner) : base(owner, "Connexion à Claude", 560, 760)
    {
        code.ToolTip = "Code affiché après la connexion (si la page en montre un)";
        var browser = Ui.Btn("Ouvrir dans le navigateur (compte Google)", (_, _) => OpenBrowser());
        browser.Margin = new Thickness(0);
        var send = Ui.Btn("Valider", async (_, _) => await SendCode(code.Text.Trim()), "Primary");
        var close = Ui.Btn("Fermer", (_, _) => Close());
        var codeRow = new DockPanel { Margin = new Thickness(0, 8, 0, 0) }; DockPanel.SetDock(send, Dock.Right); codeRow.Children.Add(send); codeRow.Children.Add(code);
        var foot = Ui.Footer(close); DockPanel.SetDock(browser, Dock.Left); foot.Children.Add(browser);
        var bottom = new StackPanel { Margin = new Thickness(18, 10, 18, 16) };
        bottom.Children.Add(status); bottom.Children.Add(codeRow);
        bottom.Children.Add(Ui.Hint("Même connexion que /login dans Claude Code : rien n'est enregistré par l'app. Les sessions ouvertes utilisent la nouvelle connexion dès leur prochain échange (sinon « Relancer »)."));
        bottom.Children.Add(foot);
        var root = new DockPanel(); DockPanel.SetDock(bottom, Dock.Bottom); root.Children.Add(bottom);
        root.Children.Add(new Border { Margin = new Thickness(18, 18, 18, 0), CornerRadius = new CornerRadius(10), ClipToBounds = true, BorderBrush = Ui.R("Line2"), BorderThickness = new Thickness(1), Child = web });
        Content = root;
        Loaded += async (_, _) => await Start();
        Closed += async (_, _) =>
        {
            if (!done) { try { await main.server.Api(HttpMethod.Post, "/api/auth/cancel"); } catch { } }
            web.Dispose();
            try { Directory.Delete(profile, true); } catch { }
        };
    }

    async Task Start()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, profile);
            await web.EnsureCoreWebView2Async(env);
            web.CoreWebView2.NavigationStarting += (_, e) => OnNavigate(e);
            await main.server.Api(HttpMethod.Post, "/api/auth/renew");
            _ = Poll();
        }
        catch (Exception e) { status.Text = "Fenêtre web indisponible (WebView2) : " + e.Message; }
    }

    // état de `claude auth login` (lib/auth.js) : adresse de la page, fin de la connexion
    async Task Poll()
    {
        while (IsLoaded)
        {
            try
            {
                var v = await main.server.Api(HttpMethod.Get, "/api/auth");
                var u = (string?)v?["url"] ?? "";
                if (u.Length > 0 && u != url) { url = u; web.CoreWebView2.Navigate(u); status.Text = "Connecte-toi ci-dessus : l'app récupère le code toute seule à la fin."; }
                var renewing = (bool?)v?["renewing"] == true;
                if (!renewing && url.Length > 0)
                {
                    var err = (string?)v?["error"] ?? "";
                    if (err.Length > 0) { status.Text = "Connexion non aboutie : " + err; return; }
                    done = true; status.Text = "Connecté.";
                    await Task.Delay(800); Close(); return;
                }
            }
            catch { }
            await Task.Delay(700);
        }
    }

    void OnNavigate(CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var u)) return;
        // Google refuse les fenêtres intégrées : la suite se fait dans le navigateur
        if (u.Host.EndsWith("accounts.google.com", StringComparison.OrdinalIgnoreCase)) { e.Cancel = true; OpenBrowser(); return; }
        // fin de connexion « manuelle » : la page affiche un code à coller ; on le lit dans l'adresse
        if (u.AbsolutePath.Contains("/oauth/code/callback", StringComparison.OrdinalIgnoreCase))
        {
            var q = System.Web.HttpUtility.ParseQueryString(u.Query);
            if (q["code"] is { Length: > 0 } c) _ = SendCode(q["state"] is { Length: > 0 } s ? $"{c}#{s}" : c);
        }
        // fin de connexion vers localhost : c'est Claude Code lui-même qui écoute, la page se charge normalement
    }

    async Task SendCode(string c)
    {
        if (sent || c.Length < 4) return;
        sent = true;
        try { await main.server.Api(HttpMethod.Post, "/api/auth/code", new { code = c }); status.Text = "Code envoyé, connexion en cours…"; }
        catch (Exception e) { sent = false; status.Text = e.Message; }
    }

    void OpenBrowser()
    {
        if (url.Length == 0) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        status.Text = "Page ouverte dans ton navigateur. Si elle affiche un code, colle-le ci-dessous puis « Valider ».";
    }
}

// Aperçu Claude Design d'une session : le design publié par la session (lien claude.ai/artifact/… vu dans son
// terminal), affiché en direct à côté. Profil web gardé (connexion à claude.ai une fois) dans les données de l'app.
public sealed class DesignWindow : Screen
{
    readonly WebView2 web = new();
    readonly string startUrl;
    static string Profile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "claude-sessions-native", "webview-design");

    public DesignWindow(MainWindow owner, string session, string url) : base(owner, $"Aperçu design — {session}", 1100, 820)
    {
        startUrl = url; ShowInTaskbar = true;
        var reload = Ui.Btn("↻", (_, _) => web.CoreWebView2?.Reload()); reload.ToolTip = "Recharger";
        var open = Ui.Btn("Ouvrir dans Claude", (_, _) => { try { Process.Start(new ProcessStartInfo(web.Source?.ToString() ?? startUrl) { UseShellExecute = true }); } catch { } });
        var head = new DockPanel { Margin = new Thickness(14, 10, 14, 10) };
        var right = Ui.Row(reload, open); DockPanel.SetDock(right, Dock.Right); head.Children.Add(right);
        head.Children.Add(new TextBlock { Text = $"Claude Design · {url}", Foreground = Ui.R("Muted"), VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis });
        var root = new DockPanel(); DockPanel.SetDock(head, Dock.Top); root.Children.Add(head); root.Children.Add(web);
        Content = root;
        Loaded += async (_, _) =>
        {
            Directory.CreateDirectory(Profile);
            await web.EnsureCoreWebView2Async(await CoreWebView2Environment.CreateAsync(null, Profile));
            web.CoreWebView2.Navigate(startUrl);
        };
        Closed += (_, _) => web.Dispose();
    }
    public void Show(string url) { if (web.CoreWebView2 != null && web.Source?.ToString() != url) web.CoreWebView2.Navigate(url); Activate(); }
}
