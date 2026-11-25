using System.IO;
using System.Net.Http;
using System.Text.Json.Nodes;

namespace CsmNative;

// Autotest sans fenêtre (CSM.exe --selftest) : à lancer contre un serveur de test (CSM_PORT, CSM_DATA, CSM_SERVER_JS,
// CSM_CLAUDE=faux claude des tests). Crée une session, reçoit sa sortie par le WebSocket, tape dedans, la ferme.
static class SelfTest
{
    public static async Task<int> Run()
    {
        var log = new List<string>();
        void Say(string s) { log.Add(s); Console.WriteLine(s); }
        var output = Environment.GetEnvironmentVariable("CSM_SELFTEST_LOG");
        try
        {
            await using var server = new CsmServer();
            await server.EnsureRunningAsync();
            Say($"serveur {server.Version} sur le port {server.Port}");
            var sessions = new TaskCompletionSource<JsonArray>();
            var outBuf = new Dictionary<string, string>();
            server.SessionsReceived += l => sessions.TrySetResult(l);
            server.Output += (id, d, replay) => { lock (outBuf) outBuf[id] = (replay ? "" : outBuf.GetValueOrDefault(id, "")) + d; };
            await server.ConnectAsync();
            var list = await sessions.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Say($"liste reçue : {list.Count} session(s)");
            var cwd = Path.Combine(Path.GetTempPath(), "csm-native-selftest");
            Directory.CreateDirectory(cwd);
            var s = await server.Api(HttpMethod.Post, "/api/sessions", new { cwd, name = "natif-selftest" });
            var id = (string?)s?["id"] ?? throw new Exception("pas d'id de session");
            Say($"session créée : {id}");
            string Out() { lock (outBuf) return outBuf.GetValueOrDefault(id, ""); }
            async Task Wait(Func<bool> ok, string what)
            {
                for (var i = 0; i < 150 && !ok(); i++) await Task.Delay(100);
                if (!ok()) throw new Exception($"délai dépassé : {what}\n--- sortie ---\n{Out()}");
                Say($"ok : {what}");
            }
            await Wait(() => Out().Contains("FAUX CLAUDE prêt"), "sortie du terminal reçue (WebSocket)");
            await server.Resize(id, 100, 30);
            await server.Input(id, "bonjour-natif\r");
            await Wait(() => Out().Contains("echo: bonjour-natif"), "saisie envoyée et réponse reçue");
            await server.Shown([id]);
            await server.Api(HttpMethod.Post, $"/api/sessions/{id}/rename", new { name = "natif-renommée" });
            var renamed = (await server.Api(HttpMethod.Get, "/api/sessions"))?.AsArray().FirstOrDefault(x => (string?)x?["id"] == id);
            if ((string?)renamed?["name"] != "natif-renommée") throw new Exception("renommage non appliqué");
            Say("ok : renommage");
            await server.Api(HttpMethod.Delete, $"/api/sessions/{id}?here=1");
            var after = (await server.Api(HttpMethod.Get, "/api/sessions"))?.AsArray().Any(x => (string?)x?["id"] == id);
            if (after == true) throw new Exception("session encore là après Fermer");
            Say("ok : fermeture");
            Say("AUTOTEST RÉUSSI");
            return 0;
        }
        catch (Exception e) { Say("AUTOTEST ÉCHOUÉ : " + e.Message); return 1; }
        finally { if (output != null) File.WriteAllLines(output, log); }
    }
}
