// dsh-desktop-alerts — native effects overlay (WPF).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

using Path = System.IO.Path;
using Rectangle = System.Windows.Shapes.Rectangle;

namespace DshDesktopAlerts.Overlay
{
    internal static class Program
    {
        internal static readonly string DataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-desktop-alerts");

        internal static readonly string LogPath = Path.Combine(DataDir, "overlay.log");
        private static readonly object LogLock = new object();

        [STAThread]
        private static int Main(string[] args)
        {
            string configPath = null;
            double previewSeconds = 0;
            bool edgePreview = false;

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (string.Equals(a, "-ConfigPath", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    configPath = args[++i];
                }
                else if (string.Equals(a, "-Preview", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    double.TryParse(args[++i], NumberStyles.Float, CultureInfo.InvariantCulture, out previewSeconds);
                }
                else if (string.Equals(a, "-EdgePreview", StringComparison.OrdinalIgnoreCase))
                {
                    edgePreview = true;
                }
            }

            if (configPath == null) configPath = Path.Combine(DataDir, "widget.json");

            try
            {
                Directory.CreateDirectory(DataDir);
            }
            catch
            {
            }

            Log("overlay start pid=" + System.Diagnostics.Process.GetCurrentProcess().Id
                + " preview=" + previewSeconds.ToString(CultureInfo.InvariantCulture)
                + " edgePreview=" + edgePreview);

            try
            {
                Config cfg = Config.Load(configPath, Log);
                Application app = new Application();
                app.ShutdownMode = ShutdownMode.OnMainWindowClose;
                OverlayWindow window = new OverlayWindow(cfg, previewSeconds, edgePreview);
                app.Run(window);
                Log("overlay exit ok");
                return 0;
            }
            catch (Exception ex)
            {
                Log("fatal: " + ex);
                return 1;
            }
        }

        internal static void Log(string message)
        {
            lock (LogLock)
            {
                try
                {
                    File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                        + "  " + message + "\r\n", Encoding.UTF8);
                }
                catch
                {
                }
            }
        }
    }

    /// <summary>Handoff file written by the host plugin (widget.json).</summary>
    internal sealed class Config
    {
        internal string Origin = "";
        internal string BasePath = "";
        internal string Token = "";

        internal static Config Load(string path, Action<string> log)
        {
            Config cfg = new Config();
            try
            {
                string text = File.ReadAllText(path, Encoding.UTF8);
                Dictionary<string, object> map = Json.Objects(text);
                cfg.Origin = Json.Str(map, "origin");
                cfg.BasePath = Json.Str(map, "base");
                cfg.Token = Json.Str(map, "token");
            }
            catch (Exception ex)
            {
                log("config load failed: " + ex.Message);
            }
            if (cfg.BasePath.Length == 0) cfg.BasePath = "/dsh-desktop-alerts/api";
            log("config origin=" + cfg.Origin + " base=" + cfg.BasePath + " token=" + (cfg.Token.Length > 0 ? "yes" : "no"));
            return cfg;
        }
    }

    internal static class Json
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

        internal static Dictionary<string, object> Objects(string text)
        {
            object parsed = Serializer.DeserializeObject(text);
            Dictionary<string, object> map = parsed as Dictionary<string, object>;
            return map ?? new Dictionary<string, object>();
        }

        internal static Dictionary<string, object> Obj(Dictionary<string, object> map, string key)
        {
            if (map == null) return null;
            object value;
            if (!map.TryGetValue(key, out value)) return null;
            return value as Dictionary<string, object>;
        }

        internal static System.Collections.IList List(Dictionary<string, object> map, string key)
        {
            if (map == null) return null;
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return null;
            // JavaScriptSerializer 把数组反序列化成 object[]（不是 List<object>），
            // 所以统一按 IList 取，object[]/ArrayList 都能覆盖。
            return value as System.Collections.IList;
        }

        internal static string Str(Dictionary<string, object> map, string key)
        {
            if (map == null) return "";
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return "";
            return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        }

        internal static bool Bool(Dictionary<string, object> map, string key, bool fallback)
        {
            if (map == null) return fallback;
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return fallback;
            if (value is bool) return (bool)value;
            return fallback;
        }

        internal static double Num(Dictionary<string, object> map, string key, double fallback)
        {
            if (map == null) return fallback;
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return fallback;
            try
            {
                return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }
    }

    internal sealed class PendingItem
    {
        internal string Id = "";
        internal string Kind = "";
        internal double ExpiresAt;
        internal bool CanDecide = true;
    }

    internal sealed class CelebrateItem
    {
        internal string Id = "";
        internal string Kind = "done";
    }

    internal sealed class Snapshot
    {
        internal bool HasPage;
        internal bool PageVisible;
        /// <summary>页面窗口在屏幕坐标里的矩形（物理像素）；页面没上报时为 false。</summary>
        internal bool HasPageRect;
        internal double PageX;
        internal double PageY;
        internal double PageW;
        internal double PageH;
        internal readonly List<PendingItem> Pending = new List<PendingItem>();
        internal readonly List<CelebrateItem> Celebrate = new List<CelebrateItem>();
    }

    /// <summary>
    /// 显示器布局。Screen.Bounds 是物理像素，而 WPF 用 DIP，所以要按主屏比例换算；
    /// 多屏缩放率不同时会有误差，那种情况下特效只是略微错位，不影响"两块屏都亮"。
    /// </summary>
    internal static class Screens
    {
        internal struct Info
        {
            internal Rect Dip;
            internal System.Drawing.Rectangle Px;
            internal bool Primary;
        }

        internal static double DipScale()
        {
            try
            {
                System.Windows.Forms.Screen[] all = System.Windows.Forms.Screen.AllScreens;
                for (int i = 0; i < all.Length; i += 1)
                {
                    if (!all[i].Primary) continue;
                    if (all[i].Bounds.Width <= 0) break;
                    return Math.Max(0.25, SystemParameters.PrimaryScreenWidth / all[i].Bounds.Width);
                }
            }
            catch
            {
            }
            return 1.0;
        }

        internal static List<Info> All()
        {
            List<Info> list = new List<Info>();
            double scale = DipScale();
            try
            {
                System.Windows.Forms.Screen[] all = System.Windows.Forms.Screen.AllScreens;
                for (int i = 0; i < all.Length; i += 1)
                {
                    Info info = new Info();
                    info.Px = all[i].Bounds;
                    info.Primary = all[i].Primary;
                    info.Dip = new Rect(
                        all[i].Bounds.Left * scale,
                        all[i].Bounds.Top * scale,
                        all[i].Bounds.Width * scale,
                        all[i].Bounds.Height * scale);
                    list.Add(info);
                }
            }
            catch
            {
            }
            if (list.Count == 0)
            {
                Info info = new Info();
                info.Primary = true;
                info.Dip = new Rect(0, 0,
                    Math.Max(320, SystemParameters.PrimaryScreenWidth),
                    Math.Max(240, SystemParameters.PrimaryScreenHeight));
                info.Px = new System.Drawing.Rectangle(0, 0,
                    (int)info.Dip.Width, (int)info.Dip.Height);
                list.Add(info);
            }
            return list;
        }

        internal static Rect VirtualDip(List<Info> all)
        {
            double left = double.MaxValue;
            double top = double.MaxValue;
            double right = double.MinValue;
            double bottom = double.MinValue;
            for (int i = 0; i < all.Count; i += 1)
            {
                Rect r = all[i].Dip;
                if (r.Left < left) left = r.Left;
                if (r.Top < top) top = r.Top;
                if (r.Right > right) right = r.Right;
                if (r.Bottom > bottom) bottom = r.Bottom;
            }
            if (right <= left || bottom <= top) return new Rect(0, 0, 1024, 768);
            return new Rect(left, top, right - left, bottom - top);
        }
    }

    /// <summary>An over-the-desktop, click-through, always-on-top effect surface.</summary>
    internal sealed class OverlayWindow : Window
    {
        private const int GwlExStyle = -20;
        private const int WsExTransparent = 0x20;
        private const int WsExToolWindow = 0x80;
        private const int WsExNoActivate = 0x08000000;

        private const double PollMs = 1500;
        private const double EdgeBreatheMs = 1600;
        private const double BurstMs = 2800;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowLong(IntPtr hwnd, int index);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int SetWindowLong(IntPtr hwnd, int index, int newStyle);

        private readonly Config _cfg;
        private readonly FxLayer _fx;
        private readonly Canvas _edgeLayer;
        private readonly DispatcherTimer _pollTimer;

        /// <summary>
        /// 每块显示器四条边带 + 一圈描边。窗口铺满整个虚拟桌面，边带按屏幕矩形各自摆放：
        /// 用四条独立窄带而不是一圈径向渐变——径向渐变在四个角会饱和成亮块。
        /// </summary>
        private readonly List<Rectangle> _edgeBands = new List<Rectangle>();
        private readonly List<int> _bandDirs = new List<int>();
        private readonly List<Rectangle> _edgeLines = new List<Rectangle>();
        private List<Screens.Info> _screens;
        private Rect _virtualBounds;
        private string _edgeKey = "";
        private List<Rect> _zones = new List<Rect>();
        private string _zonesKey = "";

        private readonly HashSet<string> _seenCelebrate = new HashSet<string>();
        private bool _seeded;
        private bool _fetching;
        private int _failures;
        private int _polls;
        private static readonly bool _verbose = Environment.GetEnvironmentVariable("DSH_FX_VERBOSE") == "1";
        private string _edgeLevel = "";
        private double _burstUntil;
        private bool _shown;

        internal OverlayWindow(Config cfg, double previewSeconds, bool edgePreview)
        {
            _cfg = cfg;
            _screens = Screens.All();
            _virtualBounds = Screens.VirtualDip(_screens);

            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            ShowActivated = false;
            ResizeMode = ResizeMode.NoResize;
            IsHitTestVisible = false;
            Focusable = false;
            SnapsToDevicePixels = false;
            UseLayoutRounding = false;
            Left = _virtualBounds.Left;
            Top = _virtualBounds.Top;
            Width = Math.Max(320, _virtualBounds.Width);
            Height = Math.Max(240, _virtualBounds.Height);

            for (int i = 0; i < _screens.Count; i += 1)
            {
                Program.Log("screen #" + i + " px=" + _screens[i].Px.Left + "," + _screens[i].Px.Top + " "
                    + _screens[i].Px.Width + "x" + _screens[i].Px.Height
                    + " dip=" + _screens[i].Dip.Left.ToString("F0") + "," + _screens[i].Dip.Top.ToString("F0") + " "
                    + _screens[i].Dip.Width.ToString("F0") + "x" + _screens[i].Dip.Height.ToString("F0")
                    + (_screens[i].Primary ? " (primary)" : ""));
            }
            Program.Log("virtual desktop " + _virtualBounds.Left.ToString("F0") + "," + _virtualBounds.Top.ToString("F0")
                + " " + _virtualBounds.Width.ToString("F0") + "x" + _virtualBounds.Height.ToString("F0"));

            _edgeLayer = new Canvas { IsHitTestVisible = false, Opacity = 1 };
            _fx = new FxLayer { IsHitTestVisible = false };

            Grid root = new Grid();
            root.Children.Add(_edgeLayer);
            root.Children.Add(_fx);
            Content = root;

            _pollTimer = new DispatcherTimer(DispatcherPriority.Background);
            _pollTimer.Interval = TimeSpan.FromMilliseconds(PollMs);
            _pollTimer.Tick += delegate { Poll(); };

            Loaded += delegate
            {
                Program.Log("window loaded " + Width.ToString("F0") + "x" + Height.ToString("F0")
                    + " screens=" + _screens.Count);
                if (previewSeconds > 0)
                {
                    UseAllScreens();
                    StartFireworks(_zones);
                    DispatcherTimer stop = new DispatcherTimer { Interval = TimeSpan.FromSeconds(previewSeconds) };
                    stop.Tick += delegate
                    {
                        stop.Stop();
                        Application.Current.Shutdown();
                    };
                    stop.Start();
                    return;
                }
                if (edgePreview)
                {
                    UseAllScreens();
                    SetEdge("approval");
                    DispatcherTimer stop = new DispatcherTimer { Interval = TimeSpan.FromSeconds(6) };
                    stop.Tick += delegate
                    {
                        stop.Stop();
                        Application.Current.Shutdown();
                    };
                    stop.Start();
                    return;
                }
                Poll();
                _pollTimer.Start();
            };

            Closed += delegate
            {
                _pollTimer.Stop();
                Program.Log("window closed");
            };
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            try
            {
                IntPtr hwnd = new WindowInteropHelper(this).Handle;
                int style = GetWindowLong(hwnd, GwlExStyle);
                SetWindowLong(hwnd, GwlExStyle, style | WsExTransparent | WsExToolWindow | WsExNoActivate);
                Program.Log("extended style set (click-through, no-activate, toolwindow)");
            }
            catch (Exception ex)
            {
                Program.Log("style set failed: " + ex.Message);
            }
        }

        // ---------------------------------------------------------------- polling

        private void Poll()
        {
            if (_fetching) return;
            if (_cfg.Origin.Length == 0 || _cfg.Token.Length == 0) return;
            _fetching = true;
            _polls++;
            if (_verbose && _polls % 20 == 0) Program.Log("poll heartbeat #" + _polls);
            ThreadPool.QueueUserWorkItem(delegate
            {
                Snapshot snap = null;
                try
                {
                    snap = Fetch();
                }
                catch (Exception ex)
                {
                    snap = null;
                    if (_failures < 3) Program.Log("poll failed: " + ex.Message);
                }
                try
                {
                    Dispatcher.BeginInvoke(new Action(delegate { Apply(snap); }));
                }
                catch
                {
                }
            });
        }

        private Snapshot Fetch()
        {
            string url = _cfg.Origin + _cfg.BasePath + "/state?token=" + Uri.EscapeDataString(_cfg.Token);
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Timeout = 2500;
            request.ReadWriteTimeout = 2500;
            request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                string text = reader.ReadToEnd();
                return Parse(text);
            }
        }

        private static Snapshot Parse(string text)
        {
            Snapshot snap = new Snapshot();
            Dictionary<string, object> map = Json.Objects(text);

            Dictionary<string, object> page = Json.Obj(map, "page");
            if (page != null)
            {
                snap.HasPage = true;
                snap.PageVisible = Json.Bool(page, "visible", false);
                Dictionary<string, object> rect = Json.Obj(page, "rect");
                if (rect != null)
                {
                    double w = Json.Num(rect, "w", 0);
                    double h = Json.Num(rect, "h", 0);
                    if (w > 0 && h > 0)
                    {
                        snap.HasPageRect = true;
                        snap.PageX = Json.Num(rect, "x", 0);
                        snap.PageY = Json.Num(rect, "y", 0);
                        snap.PageW = w;
                        snap.PageH = h;
                    }
                }
            }

            System.Collections.IList pending = Json.List(map, "pending");
            if (pending != null)
            {
                for (int i = 0; i < pending.Count; i++)
                {
                    Dictionary<string, object> item = pending[i] as Dictionary<string, object>;
                    if (item == null) continue;
                    PendingItem entry = new PendingItem();
                    entry.Id = Json.Str(item, "id");
                    entry.Kind = Json.Str(item, "kind");
                    entry.ExpiresAt = Json.Num(item, "expiresAt", 0);
                    entry.CanDecide = Json.Bool(item, "canDecide", true);
                    if (entry.Id.Length > 0) snap.Pending.Add(entry);
                }
            }

            System.Collections.IList celebrate = Json.List(map, "celebrate");
            if (celebrate != null)
            {
                for (int i = 0; i < celebrate.Count; i++)
                {
                    Dictionary<string, object> item = celebrate[i] as Dictionary<string, object>;
                    if (item == null) continue;
                    CelebrateItem entry = new CelebrateItem();
                    entry.Id = Json.Str(item, "id");
                    entry.Kind = Json.Str(item, "kind");
                    if (entry.Id.Length > 0) snap.Celebrate.Add(entry);
                }
            }
            return snap;
        }

        private void Apply(Snapshot snap)
        {
            try
            {
                ApplyCore(snap);
            }
            catch (Exception ex)
            {
                Program.Log("apply error: " + ex);
            }
        }

        /// <summary>
        /// 这次该在哪几块屏幕上画（窗口坐标）。
        ///
        /// 页面在前台时它自己已经在页面窗口里画了，所以只跳过**页面所在那块屏**，
        /// 其余屏幕照旧由这一层负责——否则双屏用户只看得到一块屏的提醒。
        /// 页面不在前台 / 没有页面 → 每块屏都画。
        /// </summary>
        private List<Rect> ActiveZones(Snapshot snap)
        {
            List<Rect> zones = new List<Rect>();
            bool skipPageScreen = snap.HasPage && snap.PageVisible;
            int skipIndex = -1;
            if (skipPageScreen)
            {
                for (int i = 0; i < _screens.Count; i += 1)
                {
                    if (!IntersectsPage(snap, _screens[i])) continue;
                    skipIndex = i;
                    break;
                }
            }
            for (int i = 0; i < _screens.Count; i += 1)
            {
                if (i == skipIndex) continue;
                Rect r = _screens[i].Dip;
                zones.Add(new Rect(r.Left - _virtualBounds.Left, r.Top - _virtualBounds.Top, r.Width, r.Height));
            }
            if (skipPageScreen && skipIndex < 0 && _screens.Count > 1)
            {
                // 页面没上报窗口矩形：保守地认为它在主屏，其余屏幕仍然要提醒。
                zones.Clear();
                for (int i = 0; i < _screens.Count; i += 1)
                {
                    if (_screens[i].Primary) continue;
                    Rect r = _screens[i].Dip;
                    zones.Add(new Rect(r.Left - _virtualBounds.Left, r.Top - _virtualBounds.Top, r.Width, r.Height));
                }
            }
            return zones;
        }

        private static bool IntersectsPage(Snapshot snap, Screens.Info screen)
        {
            if (!snap.HasPageRect) return false;
            Rect page = new Rect(snap.PageX, snap.PageY, snap.PageW, snap.PageH);
            System.Drawing.Rectangle px = screen.Px;
            Rect area = new Rect(px.Left, px.Top, px.Width, px.Height);
            Rect overlap = Rect.Intersect(page, area);
            if (overlap.IsEmpty) return false;
            // 覆盖到该屏 40% 以上才算"页面在这块屏上"，避免一条边压到邻屏就被判整块跳过。
            return (overlap.Width * overlap.Height) >= (area.Width * area.Height * 0.4);
        }

        private List<Rect> AllZones()
        {
            List<Rect> zones = new List<Rect>();
            for (int i = 0; i < _screens.Count; i += 1)
            {
                Rect r = _screens[i].Dip;
                zones.Add(new Rect(r.Left - _virtualBounds.Left, r.Top - _virtualBounds.Top, r.Width, r.Height));
            }
            return zones;
        }

        /// <summary>预览/自检用：不依赖 /state，直接在每块屏上画。</summary>
        private void UseAllScreens()
        {
            _zones = AllZones();
            _zonesKey = ZonesKey(_zones);
            RebuildEdgeVisuals();
            _edgeKey = "";
        }

        private static string ZonesKey(List<Rect> zones)
        {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < zones.Count; i += 1)
            {
                sb.Append((int)zones[i].Left).Append(',').Append((int)zones[i].Top).Append(',')
                  .Append((int)zones[i].Width).Append('x').Append((int)zones[i].Height).Append(';');
            }
            return sb.ToString();
        }

        private void ApplyCore(Snapshot snap)
        {
            _fetching = false;
            if (snap == null)
            {
                _failures++;
                if (_failures == 5) Program.Log("five consecutive poll failures; will keep retrying");
                return;
            }
            _failures = 0;

            List<Rect> zones = ActiveZones(snap);
            _zones = zones;
            string zonesKey = ZonesKey(zones);
            if (!string.Equals(zonesKey, _zonesKey))
            {
                _zonesKey = zonesKey;
                RebuildEdgeVisuals();
                _edgeKey = "";
            }
            if (_verbose)
            {
                Program.Log(
                    "apply #" + _polls + " visible=" + (snap.HasPage ? snap.PageVisible.ToString() : "n/a")
                    + " pageRect=" + (snap.HasPageRect
                        ? snap.PageX.ToString("F0") + "," + snap.PageY.ToString("F0") + " " + snap.PageW.ToString("F0") + "x" + snap.PageH.ToString("F0")
                        : "n/a")
                    + " zones=" + zones.Count + "/" + _screens.Count
                    + " pending=" + snap.Pending.Count + " celebrate=" + snap.Celebrate.Count);
            }

            if (zones.Count == 0)
            {
                // 页面在前台且只有一块屏：页面自己在画，这一层完全退让。
                if (_edgeKey.Length > 0) SetEdge("");
                _fx.Stop();
                HideSurface();
                RememberCelebrate(snap, false);
                return;
            }

            if (!_seeded)
            {
                // First snapshot: old signals are history, do not replay them.
                RememberCelebrate(snap, true);
                _seeded = true;
            }

            UpdateEdge(snap);
            ConsumeCelebrate(snap, zones);
            if (_edgeKey.Length > 0 || _fx.Running) ShowSurface();
        }

        private void RememberCelebrate(Snapshot snap, bool seedOnly)
        {
            for (int i = 0; i < snap.Celebrate.Count; i++)
            {
                string id = snap.Celebrate[i].Id;
                if (id.Length > 0) _seenCelebrate.Add(id);
            }
            if (_seenCelebrate.Count > 400) _seenCelebrate.Clear();
            if (seedOnly) Program.Log("seeded " + snap.Celebrate.Count + " historical celebrate signal(s)");
        }

        private void ConsumeCelebrate(Snapshot snap, List<Rect> zones)
        {
            for (int i = 0; i < snap.Celebrate.Count; i++)
            {
                CelebrateItem item = snap.Celebrate[i];
                if (item.Id.Length == 0 || _seenCelebrate.Contains(item.Id)) continue;
                _seenCelebrate.Add(item.Id);
                if (string.Equals(item.Kind, "error", StringComparison.OrdinalIgnoreCase))
                {
                    Program.Log("celebrate error " + item.Id + " -> burst");
                    Burst();
                }
                else
                {
                    Program.Log("celebrate done " + item.Id + " -> fireworks on " + zones.Count + " screen(s)");
                    StartFireworks(zones);
                }
            }
        }

        private void UpdateEdge(Snapshot snap)
        {
            string level = "";
            bool planPending = false;
            double now = Now();
            for (int i = 0; i < snap.Pending.Count; i++)
            {
                PendingItem item = snap.Pending[i];
                if (item.ExpiresAt > 0 && now > item.ExpiresAt) continue;
                // approval = 工具授权确认；question = ask_user_question 那种"等你选/填"。
                // 两者都是"对话停在你这里"，一律深绿；计划确认仍走琥珀。
                bool needsYou = string.Equals(item.Kind, "approval", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(item.Kind, "question", StringComparison.OrdinalIgnoreCase);
                if (needsYou)
                {
                    level = "approval";
                    break;
                }
                if (string.Equals(item.Kind, "plan-review", StringComparison.OrdinalIgnoreCase) || !item.CanDecide) planPending = true;
            }
            if (level.Length == 0 && planPending) level = "plan";

            if (level.Length == 0 && _burstUntil > now) level = "burst";
            SetEdge(level);
        }

        private void Burst()
        {
            _burstUntil = Now() + BurstMs;
            SetEdge("burst");
            ShowSurface();
        }

        // ---------------------------------------------------------------- drawing

        /// <summary>
        /// Unix 毫秒。必须和宿主 /state 里 expiresAt 的口径一致（JS Date.now()）：
        /// 早前拿 DateTime.Ticks 当毫秒用，导致每条待审批都被判成"已过期"而跳过。
        /// </summary>
        private static double Now()
        {
            return (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        /// <summary>按当前"该画的屏幕"重建每块屏一套光罩（屏幕数/位置变了才重建）。</summary>
        private void RebuildEdgeVisuals()
        {
            _edgeLayer.Children.Clear();
            _edgeBands.Clear();
            _bandDirs.Clear();
            _edgeLines.Clear();
            for (int i = 0; i < _zones.Count; i += 1)
            {
                Rect zone = _zones[i];
                // 四条独立窄带（不是一圈径向渐变）：角上不再叠加，四条边亮度完全一致。
                double band = Math.Max(16.0, Math.Min(58.0, zone.Height * 0.055));
                double midW = Math.Max(1.0, zone.Width - band * 2);
                double midH = Math.Max(1.0, zone.Height - band * 2);

                AddBand(zone.Left, zone.Top, zone.Width, band, 0);
                AddBand(zone.Left, zone.Top + zone.Height - band, zone.Width, band, 1);
                AddBand(zone.Left, zone.Top + band, band, midH, 2);
                AddBand(zone.Left + zone.Width - band, zone.Top + band, band, midH, 3);

                Rectangle line = new Rectangle
                {
                    IsHitTestVisible = false,
                    Opacity = 0,
                    StrokeThickness = 1,
                    RadiusX = 1,
                    RadiusY = 1,
                };
                Canvas.SetLeft(line, zone.Left + 0.5);
                Canvas.SetTop(line, zone.Top + 0.5);
                line.Width = Math.Max(1, zone.Width - 1);
                line.Height = Math.Max(1, zone.Height - 1);

                _edgeLayer.Children.Add(line);
                _edgeLines.Add(line);
            }
            Program.Log("edge layer rebuilt for " + _zones.Count + " screen(s), bands=" + _edgeBands.Count);
        }

        private void AddBand(double x, double y, double w, double h, int dir)
        {
            Rectangle band = new Rectangle { IsHitTestVisible = false, Opacity = 0 };
            Canvas.SetLeft(band, x);
            Canvas.SetTop(band, y);
            band.Width = Math.Max(1, w);
            band.Height = Math.Max(1, h);
            _edgeLayer.Children.Add(band);
            _edgeBands.Add(band);
            _bandDirs.Add(dir);
        }

        /// <summary>
        /// 一条向外亮、向内透明线性渐变带。dir: 0=上 1=下 2=左 3=右（峰值贴屏幕边）。
        /// </summary>
        private static LinearGradientBrush BandBrush(Color tint, int dir)
        {
            LinearGradientBrush brush = new LinearGradientBrush();
            brush.MappingMode = BrushMappingMode.RelativeToBoundingBox;
            switch (dir)
            {
                case 1:
                    brush.StartPoint = new Point(0, 1);
                    brush.EndPoint = new Point(0, 0);
                    break;
                case 2:
                    brush.StartPoint = new Point(0, 0);
                    brush.EndPoint = new Point(1, 0);
                    break;
                case 3:
                    brush.StartPoint = new Point(1, 0);
                    brush.EndPoint = new Point(0, 0);
                    break;
                default:
                    brush.StartPoint = new Point(0, 0);
                    brush.EndPoint = new Point(0, 1);
                    break;
            }
            // 峰值贴屏幕边 45%、向内 58px 快速淡出：窄但够亮，
            // 早前 70% × 300px 宽带被嫌"太显眼"，而 15% 又被反馈"完全看不到"。
            brush.GradientStops.Add(new GradientStop(Color.FromArgb(0x73, tint.R, tint.G, tint.B), 0.0));
            brush.GradientStops.Add(new GradientStop(Color.FromArgb(0x3D, tint.R, tint.G, tint.B), 0.35));
            brush.GradientStops.Add(new GradientStop(Color.FromArgb(0x14, tint.R, tint.G, tint.B), 0.70));
            brush.GradientStops.Add(new GradientStop(Color.FromArgb(0x00, tint.R, tint.G, tint.B), 1.0));
            brush.Freeze();
            return brush;
        }

        private void SetEdge(string level)
        {
            string next = level ?? "";
            string key = next + "@" + _zonesKey;
            if (string.Equals(_edgeKey, key)) return;
            _edgeKey = key;
            _edgeLevel = next;

            if (next.Length == 0)
            {
                for (int i = 0; i < _edgeBands.Count; i += 1)
                {
                    _edgeBands[i].BeginAnimation(OpacityProperty, null);
                    _edgeBands[i].Opacity = 0;
                }
                for (int i = 0; i < _edgeLines.Count; i += 1)
                {
                    _edgeLines[i].BeginAnimation(OpacityProperty, null);
                    _edgeLines[i].Opacity = 0;
                }
                Program.Log("edge off");
                UpdateSurfaceVisibility();
                return;
            }

            if (_edgeBands.Count == 0) return;

            bool plan = string.Equals(next, "plan", StringComparison.OrdinalIgnoreCase);
            bool burstEdge = string.Equals(next, "burst", StringComparison.OrdinalIgnoreCase);
            // 审批用深绿（#15803D），不再是刺眼的红；计划琥珀；出错保留红（但同样收窄）
            Color tint = plan
                ? Color.FromRgb(0xFF, 0x9F, 0x0A)
                : (burstEdge ? Color.FromRgb(0xFF, 0x45, 0x3A) : Color.FromRgb(0x15, 0x80, 0x3D));

            // 四条边各一条 58px 线性渐变带：峰值贴在屏幕边、向内 58px 内淡出，
            // 角上不再有叠加/饱和（早前用径向渐变，四个角会堆成亮块）。
            // 描边保持 1px，但亮度提上来（0x8C ≈ 55%），让"细线 + 窄带"一起被看见
            SolidColorBrush line = new SolidColorBrush(Color.FromArgb(0x8C, tint.R, tint.G, tint.B));
            line.Freeze();

            LinearGradientBrush brush0 = BandBrush(tint, 0);
            LinearGradientBrush brush1 = BandBrush(tint, 1);
            LinearGradientBrush brush2 = BandBrush(tint, 2);
            LinearGradientBrush brush3 = BandBrush(tint, 3);
            for (int i = 0; i < _edgeBands.Count; i += 1)
            {
                Rectangle band = _edgeBands[i];
                band.BeginAnimation(OpacityProperty, null);
                switch (_bandDirs[i])
                {
                    case 1: band.Fill = brush1; break;
                    case 2: band.Fill = brush2; break;
                    case 3: band.Fill = brush3; break;
                    default: band.Fill = brush0; break;
                }

                if (burstEdge)
                {
                    DoubleAnimation burst = new DoubleAnimation(0.0, 0.55, TimeSpan.FromMilliseconds(360));
                    burst.AutoReverse = true;
                    burst.RepeatBehavior = new RepeatBehavior(2);
                    burst.EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut };
                    band.BeginAnimation(OpacityProperty, burst);
                }
                else
                {
                    DoubleAnimation breath = new DoubleAnimation(0.5, 1.0, TimeSpan.FromMilliseconds(EdgeBreatheMs));
                    breath.AutoReverse = true;
                    breath.RepeatBehavior = RepeatBehavior.Forever;
                    breath.EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut };
                    band.BeginAnimation(OpacityProperty, breath);
                }
            }

            for (int i = 0; i < _edgeLines.Count; i += 1)
            {
                Rectangle l = _edgeLines[i];
                l.BeginAnimation(OpacityProperty, null);
                l.Stroke = line;
                if (burstEdge)
                {
                    DoubleAnimation burst = new DoubleAnimation(0.0, 0.4, TimeSpan.FromMilliseconds(360));
                    burst.AutoReverse = true;
                    burst.RepeatBehavior = new RepeatBehavior(2);
                    burst.EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut };
                    l.BeginAnimation(OpacityProperty, burst);
                }
                else
                {
                    DoubleAnimation lineBreath = new DoubleAnimation(0.55, 1.0, TimeSpan.FromMilliseconds(EdgeBreatheMs));
                    lineBreath.AutoReverse = true;
                    lineBreath.RepeatBehavior = RepeatBehavior.Forever;
                    lineBreath.EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut };
                    l.BeginAnimation(OpacityProperty, lineBreath);
                }
            }

            if (burstEdge)
            {
                DispatcherTimer clear = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(BurstMs) };
                clear.Tick += delegate
                {
                    clear.Stop();
                    _burstUntil = 0;
                    SetEdge("");
                };
                clear.Start();
            }

            Program.Log("edge " + next + " on " + _zones.Count + " screen(s), bands=" + _edgeBands.Count);
            ShowSurface();
        }

        private void StartFireworks(List<Rect> zones)
        {
            if (zones == null || zones.Count == 0) return;
            _fx.Start(zones);
            ShowSurface();
        }

        private void ShowSurface()
        {
            if (!_shown)
            {
                _shown = true;
                Visibility = Visibility.Visible;
                Program.Log("surface visible");
            }
            else if (Visibility != Visibility.Visible)
            {
                Visibility = Visibility.Visible;
            }
        }

        private void HideSurface()
        {
            if (!_shown && Visibility != Visibility.Visible) return;
            _shown = false;
            if (Visibility != Visibility.Hidden)
            {
                Visibility = Visibility.Hidden;
                Program.Log("surface hidden (page is visible)");
            }
        }

        private void UpdateSurfaceVisibility()
        {
            if (_edgeLevel.Length == 0 && !_fx.Running) HideSurface();
        }

        /// <summary>Called by the particle surface once the last burst has faded.</summary>
        internal void NotifyEffectsIdle()
        {
            UpdateSurfaceVisibility();
        }
    }

    /// <summary>Particle surface. One visual, redrawn per frame, no effect objects.</summary>
    internal sealed class FxLayer : FrameworkElement
    {
        private const double FireworkMs = 2200;
        private const int MaxParticles = 1300;

        private sealed class Particle
        {
            internal double X;
            internal double Y;
            internal double Vx;
            internal double Vy;
            internal double Life;
            internal double MaxLife;
            internal double Size;
            internal Color Tint;
        }

        private static readonly Color[] DarkPalette =
        {
            Color.FromRgb(0x0A, 0x84, 0xFF), Color.FromRgb(0x5E, 0x5C, 0xE6), Color.FromRgb(0xBF, 0x5A, 0xF2),
            Color.FromRgb(0xFF, 0x37, 0x5F), Color.FromRgb(0xFF, 0x9F, 0x0A), Color.FromRgb(0x30, 0xD1, 0x58),
            Color.FromRgb(0x64, 0xD2, 0xFF), Color.FromRgb(0xFF, 0xD6, 0x0A),
        };

        private readonly List<Particle> _particles = new List<Particle>();
        private readonly Random _random = new Random();
        private readonly double[] _shotAt = { 0, 470, 980 };
        private readonly double[] _shotX = { 0.30, 0.63, 0.46 };
        private readonly double[] _shotY = { 0.27, 0.21, 0.34 };
        private readonly int[] _shotCount = { 210, 235, 195 };

        private double _scale = 1.0;
        private double _startedAt;
        private double _lastFrame;
        private int _nextShot;
        private bool _running;
        private bool _hooked;
        private readonly List<Rect> _zones = new List<Rect>();

        internal bool Running
        {
            get { return _running; }
        }

        internal int ActiveEllipseCount()
        {
            return _particles.Count;
        }

        /// <summary>
        /// zones 是"这次要放烟花的屏幕矩形"（窗口坐标）。每块屏都有自己的一轮，
        /// 于是双屏用户两边同时看到烟花，而不是只在一整块大画布上随机撒。
        /// </summary>
        internal void Start(List<Rect> zones)
        {
            _zones.Clear();
            if (zones != null)
            {
                for (int i = 0; i < zones.Count; i += 1)
                {
                    if (zones[i].Width >= 8 && zones[i].Height >= 8) _zones.Add(zones[i]);
                }
            }
            if (_zones.Count == 0) return;

            double widest = 0;
            for (int i = 0; i < _zones.Count; i += 1) widest = Math.Max(widest, _zones[i].Width);
            // Higher-resolution screens need physically larger particles to read the same.
            _scale = Math.Max(1.0, widest / 1600.0);
            _particles.Clear();
            _nextShot = 0;
            _running = true;
            _startedAt = DateTime.UtcNow.Ticks / 10000.0;
            _lastFrame = _startedAt;
            if (!_hooked)
            {
                _hooked = true;
                CompositionTarget.Rendering += OnFrame;
            }
            Program.Log("fireworks start on " + _zones.Count + " screen(s) scale=" + _scale.ToString("F2"));
            InvalidateVisual();
        }

        internal void Stop()
        {
            if (!_running && _particles.Count == 0) return;
            _running = false;
            _particles.Clear();
            InvalidateVisual();
        }

        private static double Now()
        {
            return DateTime.UtcNow.Ticks / 10000.0;
        }

        private void OnFrame(object sender, EventArgs e)
        {
            if (!_running)
            {
                if (_hooked)
                {
                    _hooked = false;
                    CompositionTarget.Rendering -= OnFrame;
                }
                return;
            }

            double now = Now();
            double dt = now - _lastFrame;
            if (dt <= 0) return;
            if (dt > 60) dt = 60;
            _lastFrame = now;
            double step = dt / 16.6667;

            while (_nextShot < _shotAt.Length && now - _startedAt >= _shotAt[_nextShot])
            {
                // 每一发都换一块屏（round-robin）：两块屏各自得到完整的烟花序列。
                for (int z = 0; z < _zones.Count; z += 1)
                {
                    Rect zone = _zones[(z + _nextShot) % _zones.Count];
                    double cx = zone.Left + zone.Width * (_shotX[_nextShot] + _random.NextDouble() * 0.1);
                    double cy = zone.Top + zone.Height * (_shotY[_nextShot] + _random.NextDouble() * 0.08);
                    Spawn(cx, cy, _shotCount[_nextShot]);
                }
                _nextShot++;
            }

            double damping = Math.Pow(0.986, step);
            for (int i = _particles.Count - 1; i >= 0; i--)
            {
                Particle p = _particles[i];
                p.Vy += 0.055 * step;
                p.Vx *= damping;
                p.Vy *= damping;
                p.X += p.Vx * step;
                p.Y += p.Vy * step;
                p.Life -= dt;
                if (p.Life <= 0) _particles.RemoveAt(i);
            }

            if (now - _startedAt > FireworkMs + 500 || (now - _startedAt > FireworkMs && _particles.Count == 0))
            {
                _running = false;
                _particles.Clear();
                if (_hooked)
                {
                    _hooked = false;
                    CompositionTarget.Rendering -= OnFrame;
                }
                Application.Current.Dispatcher.BeginInvoke(new Action(delegate
                {
                    OverlayWindow host = Window.GetWindow(this) as OverlayWindow;
                    if (host != null) host.NotifyEffectsIdle();
                    else Program.Log("fx idle but host window missing");
                }));
            }

            InvalidateVisual();
        }

        private void Spawn(double cx, double cy, int count)
        {
            Color a = DarkPalette[_random.Next(DarkPalette.Length)];
            Color b = DarkPalette[_random.Next(DarkPalette.Length)];
            for (int i = 0; i < count; i++)
            {
                if (_particles.Count >= MaxParticles) return;
                double angle = _random.NextDouble() * Math.PI * 2;
                double speed = (0.9 + _random.NextDouble() * 4.1) * _scale;
                double life = 680 + _random.NextDouble() * 820;
                Particle p = new Particle();
                p.X = cx;
                p.Y = cy;
                p.Vx = Math.Cos(angle) * speed;
                p.Vy = Math.Sin(angle) * speed - 0.55 * _scale;
                p.Life = life;
                p.MaxLife = life;
                p.Size = (1.9 + _random.NextDouble() * 2.3) * _scale;
                p.Tint = _random.NextDouble() < 0.5 ? a : b;
                _particles.Add(p);
            }
        }

        protected override void OnRender(DrawingContext dc)
        {
            // Transparent background: only particles paint, everything else stays clear.
            for (int i = 0; i < _particles.Count; i++)
            {
                Particle p = _particles[i];
                double alpha = Math.Max(0, p.Life / p.MaxLife);
                if (alpha <= 0) continue;
                byte core = (byte)Math.Round(alpha * 255);
                byte halo = (byte)Math.Round(alpha * alpha * 90);
                byte trail = (byte)Math.Round(alpha * 150);

                // Soft glow first, then the bright core on top: cheap 3-pass sprite.
                SolidColorBrush haloBrush = new SolidColorBrush(Color.FromArgb(halo, p.Tint.R, p.Tint.G, p.Tint.B));
                haloBrush.Freeze();
                dc.DrawEllipse(haloBrush, null, new Point(p.X, p.Y), p.Size * 2.6, p.Size * 2.6);

                Pen pen = new Pen(new SolidColorBrush(Color.FromArgb(trail, p.Tint.R, p.Tint.G, p.Tint.B)), p.Size * 1.1);
                pen.Freeze();
                dc.DrawLine(pen, new Point(p.X - p.Vx * 2.4, p.Y - p.Vy * 2.4), new Point(p.X, p.Y));

                SolidColorBrush coreBrush = new SolidColorBrush(Color.FromArgb(core, p.Tint.R, p.Tint.G, p.Tint.B));
                coreBrush.Freeze();
                dc.DrawEllipse(coreBrush, null, new Point(p.X, p.Y), p.Size, p.Size);
            }
        }
    }
}