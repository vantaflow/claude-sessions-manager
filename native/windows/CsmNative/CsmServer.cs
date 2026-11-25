using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CsmNative;

// Client du serveur CSM local (le même que celui de l'app Electron) : API HTTP + WebSocket /ws.
// Le serveur garde tout (sessions, terminaux, synchro, mémoire, veille) : cette app n'est qu'un affichage natif.
public sealed class CsmServer : IAsyncDisposable
{
    public int Port { get; }
    public string DataDir { get; }
    public string Token { get; private set; } = "";
    readonly HttpClient http = new();
    ClientWebSocket? ws;
    readonly CancellationTokenSource cts = new();
    readonly SemaphoreSlim sendLock = new(1, 1);

    public event Action<JsonArray>? SessionsReceived;      // { t: 'sessions', list }
    public event Action<JsonObject>? SessionUpdated;       // { t: 'session', s }
    public event Action<string>? SessionRemoved;           // { t: 'removed', id }
    public event Action<string, string, bool>? Output;     // id, données, replay (contenu complet)
    public event Action<string>? Clear;                    // { t: 'clear', id }
    public event Action<JsonObject>? Raw;                  // tous les messages (unlock-result, auth, schedules…)
    public event Action? Quota;                          // { t: 'quota' } : relevé de quota à relire (/api/quota)
    public string Version { get; private set; } = "";
    public event Action<string>? Disconnected;

    public CsmServer(int port = 7890)
    {
        Port = int.TryParse(Environment.GetEnvironmentVariable("CSM_PORT"), out var p) ? p : port;
        var root = Environment.GetEnvironmentVariable("CSM_DATA")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "claude-sessions");
        DataDir = Port == 7890 || Environment.GetEnvironmentVariable("CSM_DATA") != null ? root : $"{root}-{Port}";
        http.BaseAddress = new Uri($"http://127.0.0.1:{Port}");
        http.Timeout = TimeSpan.FromSeconds(60);
    }

    async Task<bool> Alive()
    {
        try { using var r = await http.GetAsync("/", cts.Token); return r.IsSuccessStatusCode; } catch { return false; }
    }

    // Serveur déjà lancé (app Electron, tâche planifiée) : utilisé tel quel ; sinon lancé ici.
    public async Task EnsureRunningAsync()
    {
        if (!await Alive())
        {
            StartServer();
            for (var i = 0; i < 60 && !await Alive(); i++) await Task.Delay(500, cts.Token);
            if (!await Alive()) throw new InvalidOperationException($"Le serveur CSM ne répond pas sur le port {Port}.");
        }
        var tokenFile = Path.Combine(DataDir, "token");
        for (var i = 0; i < 20 && !File.Exists(tokenFile); i++) await Task.Delay(250, cts.Token);
        Token = File.ReadAllText(tokenFile).Trim();
        http.DefaultRequestHeaders.Remove("X-CSM-Token");
        http.DefaultRequestHeaders.Add("X-CSM-Token", Token);
        try { Version = (string?)(await Api(HttpMethod.Get, "/api/version"))?["version"] ?? ""; } catch { }
    }

    // Serveur à lancer (s'il ne tourne pas déjà, lancé par l'app Electron ou une autre fenêtre) :
    // - CSM_SERVER_JS (développement, dépôt avec ses node_modules) : avec le node du système ;
    // - sinon le serveur EMBARQUÉ dans cet exécutable (server.zip : node.exe + code du serveur de la même version),
    //   extrait une fois dans %LOCALAPPDATA%\claude-sessions-native\server\<version> : rien à installer ;
    // - à défaut (compilation sans serveur embarqué), celui de l'app CSM installée, avec son runtime Electron.
    // Détaché : il survit à la fermeture de la fenêtre, les sessions continuent.
    void StartServer()
    {
        var psi = new ProcessStartInfo { UseShellExecute = false, CreateNoWindow = true };
        var dev = Environment.GetEnvironmentVariable("CSM_SERVER_JS");
        string serverJs;
        if (!string.IsNullOrEmpty(dev))
        {
            serverJs = dev;
            psi.FileName = FindOnPath("node.exe") ?? throw new FileNotFoundException("node.exe introuvable (CSM_SERVER_JS).");
        }
        else if (Embedded() is { } dir)
        {
            serverJs = Path.Combine(dir, "server.js");
            psi.FileName = Path.Combine(dir, "node.exe");
        }
        else
        {
            var installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "claude-sessions-manager");
            serverJs = Path.Combine(installed, "resources", "app", "server.js");
            if (!File.Exists(serverJs)) throw new FileNotFoundException("Serveur CSM introuvable.", serverJs);
            psi.FileName = Directory.GetFiles(installed, "*.exe").FirstOrDefault(f => !Path.GetFileName(f).StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase))
                ?? throw new FileNotFoundException("app CSM installée introuvable.");
            psi.Environment["ELECTRON_RUN_AS_NODE"] = "1";
        }
        psi.WorkingDirectory = Path.GetDirectoryName(serverJs)!;
        // langue du système (comme l'app Electron) : réponses et textes du serveur dans la bonne langue
        psi.Environment["CSM_SYS_LANG"] = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName;
        psi.ArgumentList.Add(serverJs);
        psi.ArgumentList.Add($"--port={Port}");
        Process.Start(psi);
    }

    // Extrait le serveur embarqué (une fois par version de l'app) ; null si l'exécutable n'en contient pas.
    static string? Embedded()
    {
        var asm = typeof(CsmServer).Assembly;
        using var res = asm.GetManifestResourceStream("server.zip");
        if (res == null) return null;
        var ver = asm.GetName().Version?.ToString() ?? "0";
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "claude-sessions-native", "server");
        var dir = Path.Combine(root, $"{ver}-{res.Length}");
        if (File.Exists(Path.Combine(dir, ".ok"))) return dir;
        var tmp = dir + ".tmp-" + Environment.ProcessId;
        if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
        System.IO.Compression.ZipFile.ExtractToDirectory(res, tmp);
        File.WriteAllText(Path.Combine(tmp, ".ok"), DateTime.Now.ToString("O"));
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); Directory.Move(tmp, dir); }
        catch { if (!File.Exists(Path.Combine(dir, ".ok"))) throw; Directory.Delete(tmp, true); } // extrait en même temps par une autre fenêtre
        // anciennes versions extraites : supprimées seulement si aucun serveur n'y tourne encore
        var running = Process.GetProcessesByName("node").Select(x => { try { return x.MainModule?.FileName ?? ""; } catch { return ""; } }).ToList();
        foreach (var old in Directory.GetDirectories(root).Where(d => !string.Equals(d, dir, StringComparison.OrdinalIgnoreCase)))
            if (!running.Any(r => r.StartsWith(old + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))) try { Directory.Delete(old, true); } catch { }
        return dir;
    }

    static string? FindOnPath(string exe) =>
        (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
            .Select(d => { try { return Path.Combine(d.Trim(), exe); } catch { return ""; } })
            .FirstOrDefault(File.Exists);

    public async Task ConnectAsync()
    {
        ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Host", $"127.0.0.1:{Port}");
        await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{Port}/ws?token={Uri.EscapeDataString(Token)}"), cts.Token);
        _ = Task.Run(ReceiveLoop);
    }

    async Task ReceiveLoop()
    {
        var buf = new byte[1 << 16];
        var ms = new MemoryStream();
        try
        {
            while (ws!.State == WebSocketState.Open && !cts.IsCancellationRequested)
            {
                var r = await ws.ReceiveAsync(buf, cts.Token);
                if (r.MessageType == WebSocketMessageType.Close) break;
                ms.Write(buf, 0, r.Count);
                if (!r.EndOfMessage) continue;
                var text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                ms.SetLength(0);
                Dispatch(text);
            }
        }
        catch (Exception e) when (e is not OperationCanceledException) { Disconnected?.Invoke(e.Message); return; }
        Disconnected?.Invoke("connexion fermée");
    }

    void Dispatch(string text)
    {
        JsonObject? m;
        try { m = JsonNode.Parse(text) as JsonObject; } catch { return; }
        if (m == null) return;
        Raw?.Invoke(m);
        switch ((string?)m["t"])
        {
            case "sessions": if (m["list"] is JsonArray l) SessionsReceived?.Invoke(l); break;
            case "session": if (m["s"] is JsonObject s) SessionUpdated?.Invoke(s); break;
            case "removed": SessionRemoved?.Invoke((string?)m["id"] ?? ""); break;
            case "replay": Output?.Invoke((string?)m["id"] ?? "", (string?)m["d"] ?? "", true); break;
            case "out": Output?.Invoke((string?)m["id"] ?? "", (string?)m["d"] ?? "", false); break;
            case "clear": Clear?.Invoke((string?)m["id"] ?? ""); break;
            case "quota": Quota?.Invoke(); break;
        }
    }

    public async Task SendAsync(object msg)
    {
        if (ws?.State != WebSocketState.Open) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(msg);
        await sendLock.WaitAsync();
        try { await ws.SendAsync(bytes, WebSocketMessageType.Text, true, cts.Token); }
        catch { }
        finally { sendLock.Release(); }
    }

    public Task Input(string id, string d) => SendAsync(new { t = "input", id, d });
    public Task Resize(string id, int cols, int rows) => SendAsync(new { t = "resize", id, cols, rows });
    public Task Shown(IEnumerable<string> ids) => SendAsync(new { t = "shown", ids = ids.ToArray() });

    public async Task<JsonNode?> Api(HttpMethod method, string path, object? body = null)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body != null) req.Content = JsonContent.Create(body);
        using var r = await http.SendAsync(req, cts.Token);
        var txt = await r.Content.ReadAsStringAsync();
        JsonNode? j = null;
        try { j = string.IsNullOrWhiteSpace(txt) ? null : JsonNode.Parse(txt); } catch { }
        if (!r.IsSuccessStatusCode) throw new InvalidOperationException((string?)j?["error"] ?? $"{(int)r.StatusCode} {r.ReasonPhrase}");
        return j;
    }

    // envoi d'un fichier brut (import .csmx : /api/transfer/upload)
    public async Task Upload(string path, HttpContent content)
    {
        using var r = await http.PostAsync(path, content, cts.Token);
        if (!r.IsSuccessStatusCode) throw new InvalidOperationException((string?)JsonNode.Parse(await r.Content.ReadAsStringAsync())?["error"] ?? r.ReasonPhrase);
    }

    public async ValueTask DisposeAsync()
    {
        cts.Cancel();
        try { if (ws?.State == WebSocketState.Open) await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
        ws?.Dispose(); http.Dispose();
    }
}
