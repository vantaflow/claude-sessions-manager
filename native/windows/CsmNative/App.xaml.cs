using System.Windows;

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
        base.OnStartup(e);
        new MainWindow().Show();
    }
}
