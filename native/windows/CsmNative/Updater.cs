using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace CsmNative;

// Mises à jour de l'app native : dernière version publiée sur GitHub (même tag que l'app Electron). La release
// contient l'exécutable « CSM-natif-Windows-x64-v… .exe » et latest-native-windows.json (version, nom, SHA-256),
// signé en ed25519 (.sig) avec la clé des mises à jour de CSM (electron/update-key.js, scripts/sign-update.js).
// Rien n'est installé sans signature valide ni empreinte identique. Vérifiée au lancement puis toutes les 6 h ;
// installée sur demande : l'app se ferme, l'exécutable est remplacé puis relancé. Les sessions continuent : elles
// tournent dans le serveur CSM, pas dans cette fenêtre.
static class Updater
{
#if UPDATE_TEST
    // compilation de test uniquement (-p:DefineConstants=UPDATE_TEST) : faux serveur de releases et clé jetable
    static readonly string Api = Environment.GetEnvironmentVariable("CSM_NATIVE_UPDATE_API")!;
    static readonly string PublicKey = Environment.GetEnvironmentVariable("CSM_NATIVE_UPDATE_KEY")!;
#else
    const string Api = "https://api.github.com/repos/vantaflow/claude-sessions-manager/releases/latest";
    const string PublicKey = "MCowBQYDK2VwAyEA1viF4qWpXWVcM0gRvQE213W8RqOwGW6+n8TOEChYi0c="; // = electron/update-key.js
#endif
    static string? exeUrl, version, sha256;
    static Version Current => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0);
    static HttpClient Http() { var h = new HttpClient(); h.DefaultRequestHeaders.UserAgent.ParseAdd("claude-sessions-native"); return h; }

    public static async Task Loop(MainWindow w)
    {
        if (Environment.GetEnvironmentVariable("CSM_NATIVE_NO_UPDATE") == "1" || Current.Major == 0) return; // compilation locale : pas de mise à jour
        while (w.IsLoaded)
        {
            try { if (await Check()) { w.OfferUpdate(version!); return; } } catch { }
            await Task.Delay(TimeSpan.FromHours(6));
        }
    }

    // signature ed25519 (SPKI DER : les 32 derniers octets sont la clé publique brute)
    static bool Verify(byte[] data, byte[] sig)
    {
        var spki = Convert.FromBase64String(PublicKey);
        var v = new Ed25519Signer();
        v.Init(false, new Ed25519PublicKeyParameters(spki, spki.Length - 32));
        v.BlockUpdate(data, 0, data.Length);
        return v.VerifySignature(sig);
    }

    public static bool VerifyFile(string file, string sigFile)
    {
        try { return Verify(File.ReadAllBytes(file), Convert.FromBase64String(File.ReadAllText(sigFile).Trim())); } catch { return false; }
    }

    internal static async Task<bool> Check()
    {
        using var http = Http();
        var r = JsonNode.Parse(await http.GetStringAsync(Api));
        var assets = (r?["assets"] as JsonArray)?.OfType<JsonObject>().ToList() ?? [];
        string? Url(string name) => (string?)assets.FirstOrDefault(a => (string?)a["name"] == name)?["browser_download_url"];
        var manifestUrl = Url("latest-native-windows.json"); var sigUrl = Url("latest-native-windows.json.sig");
        if (manifestUrl == null || sigUrl == null) return false;
        var manifest = await http.GetByteArrayAsync(manifestUrl);
        var sig = Convert.FromBase64String((await http.GetStringAsync(sigUrl)).Trim());
        if (!Verify(manifest, sig)) return false; // manifeste non signé par CSM : ignoré
        var m = JsonNode.Parse(manifest);
        var tag = ((string?)m?["version"] ?? "").TrimStart('v');
        if (!Version.TryParse(tag, out var latest) || latest <= new Version(Current.Major, Current.Minor, Current.Build)) return false;
        exeUrl = Url((string?)m?["file"] ?? ""); sha256 = ((string?)m?["sha256"] ?? "").ToLowerInvariant(); version = tag;
        return exeUrl != null && sha256.Length == 64;
    }

    public static Task Install(MainWindow w) => Install(w.QuitForUpdate, m => System.Windows.MessageBox.Show(w, m, "Claude Sessions"));

    // relaunchArgs : arguments passés à la nouvelle version au redémarrage (vide en usage normal)
    internal static async Task Install(Action quit, Action<string> fail, string relaunchArgs = "")
    {
        if (exeUrl == null || sha256 == null) return;
        var exe = Environment.ProcessPath!;
        var tmp = Path.Combine(Path.GetTempPath(), $"CSM-natif-{version}.exe");
        try
        {
            using (var http = Http())
            {
                await using var src = await http.GetStreamAsync(exeUrl);
                await using var dst = File.Create(tmp);
                await src.CopyToAsync(dst);
            }
            string got;
            await using (var f = File.OpenRead(tmp)) got = Convert.ToHexString(await SHA256.HashDataAsync(f)).ToLowerInvariant();
            if (got != sha256) { File.Delete(tmp); throw new InvalidOperationException("empreinte différente de celle signée par CSM : fichier rejeté"); }
            // l'exécutable en cours ne peut pas être remplacé : un cmd attend la fin de l'app, copie, relance
            var script = $"/c timeout /t 2 /nobreak >nul & copy /y \"{tmp}\" \"{exe}\" >nul & start \"\" \"{exe}\" {relaunchArgs}";
            Process.Start(new ProcessStartInfo("cmd.exe", script) { CreateNoWindow = true, UseShellExecute = false });
            quit();
        }
        catch (Exception e) { fail("Mise à jour impossible : " + e.Message); }
    }
}
