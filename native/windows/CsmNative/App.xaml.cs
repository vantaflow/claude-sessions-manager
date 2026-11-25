using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace CsmNative;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // CSM.exe --selftest : vérifie le dialogue avec un serveur CSM (sans fenêtre), code de sortie 0 si tout passe
        if (e.Args.Contains("--selftest"))
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            _ = SelfTest.Run().ContinueWith(t => Dispatcher.Invoke(() => Shutdown(t.Result)));
            return;
        }
        // CSM.exe --verify <fichier> <fichier.sig> : vérifie une signature de mise à jour (code 0 si valide)
        if (e.Args.Length == 3 && e.Args[0] == "--verify")
        {
            Shutdown(Updater.VerifyFile(e.Args[1], e.Args[2]) ? 0 : 1);
            return;
        }
#if UPDATE_TEST
        // compilation de test : --update-test <journal> vérifie, télécharge et installe sans fenêtre ; la nouvelle
        // version est relancée avec --print-version <journal> et y écrit son numéro
        if (e.Args.Length == 2 && e.Args[0] == "--print-version")
        {
            File.AppendAllText(e.Args[1], $"relancé en version {System.Reflection.Assembly.GetExecutingAssembly().GetName().Version}\n");
            Shutdown(0); return;
        }
        if (e.Args.Length == 2 && e.Args[0] == "--update-test")
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            var log = e.Args[1];
            _ = Task.Run(async () =>
            {
                try
                {
                    var ok = await Updater.Check();
                    File.AppendAllText(log, $"version {System.Reflection.Assembly.GetExecutingAssembly().GetName().Version}, mise à jour proposée : {ok}\n");
                    if (!ok) { Dispatcher.Invoke(() => Shutdown(2)); return; }
                    await Updater.Install(() => { File.AppendAllText(log, "installation lancée, fermeture\n"); Dispatcher.Invoke(() => Shutdown(0)); },
                        m => { File.AppendAllText(log, m + "\n"); Dispatcher.Invoke(() => Shutdown(3)); }, $"--print-version \"{log}\"");
                }
                catch (Exception ex) { File.AppendAllText(log, ex + "\n"); Dispatcher.Invoke(() => Shutdown(4)); }
            });
            return;
        }
#endif
        base.OnStartup(e);
        var w = new MainWindow();
#if UPDATE_TEST
        ((Window)w).Title = $"CSM natif — TEST DE MISE À JOUR — version de l'app {System.Reflection.Assembly.GetExecutingAssembly().GetName().Version!.ToString(3)}";
#endif
        // CSM.exe --snapshot <dossier> : fenêtre ouverte hors de l'écran, images de la fenêtre et des écrans, puis sortie
        var i = Array.IndexOf(e.Args, "--snapshot");
        if (i >= 0 && i + 1 < e.Args.Length)
        {
            var dir = e.Args[i + 1];
            Directory.CreateDirectory(dir);
            w.WindowStartupLocation = WindowStartupLocation.Manual; w.Left = -20000; w.Top = 0; w.ShowActivated = false;
            w.Loaded += async (_, _) =>
            {
                await Task.Delay(6000);
                Snap(w, Path.Combine(dir, "main.png"));
                foreach (var (name, make) in new (string, Func<Window>)[]
                {
                    ("new-session", () => new NewSessionWindow(w, null)), ("palette", () => new PaletteWindow(w)), ("history", () => new HistoryWindow(w)),
                    ("prompts", () => new PromptsWindow(w)), ("vault", () => new VaultWindow(w)), ("settings", () => new SettingsWindow(w)),
                    ("attention", () => new AttentionWindow(w)), ("usage", () => new UsageWindow(w)), ("skills", () => new SkillsWindow(w)),
                    ("welcome", () => new WelcomeWindow(w)), ("search", () => new SearchWindow(w)), ("auth", () => new AuthWindow(w)),
                })
                {
                    try
                    {
                        var s = make(); s.WindowStartupLocation = WindowStartupLocation.Manual; s.Left = -20000; s.Top = 0; s.ShowActivated = false;
                        s.Show(); await Task.Delay(2500); Snap(s, Path.Combine(dir, name + ".png")); s.Close();
                    }
                    catch (Exception ex) { File.WriteAllText(Path.Combine(dir, name + ".error.txt"), ex.ToString()); }
                }
                Shutdown(0);
            };
        }
        w.Show();
    }

    static void Snap(Window w, string file)
    {
        w.UpdateLayout();
        var el = (FrameworkElement)w.Content;
        var dpi = VisualTreeHelper.GetDpi(w);
        var bmp = new RenderTargetBitmap((int)(el.ActualWidth * dpi.DpiScaleX), (int)(el.ActualHeight * dpi.DpiScaleY), dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
        var bg = new DrawingVisual();
        using (var dc = bg.RenderOpen()) dc.DrawRectangle(w.Background, null, new Rect(0, 0, el.ActualWidth, el.ActualHeight));
        bmp.Render(bg); bmp.Render(el);
        var enc = new PngBitmapEncoder(); enc.Frames.Add(BitmapFrame.Create(bmp));
        using var fs = File.Create(file); enc.Save(fs);
    }
}
