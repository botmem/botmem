import AppKit
import Foundation

// ============================================================================
// botmem Apple Bridge — UI shell around the IN-PROCESS Rust engine.
//
// Architecture:
//   • The engine is `@botmem/apple-bridge-engine` (Rust), linked into this app
//     as a static library (libbotmem_engine.a) and driven through the C ABI in
//     botmem_engine.h. It reads WhatsApp/iMessage/Contacts, builds the local FTS
//     index, answers search.query/bridge.status over the encrypted tunnel, and
//     writes structured status to ~/.botmem/bridge-status.json (atomic) — all on
//     its own threads INSIDE this process.
//   • This app is the Swift UI: it
//       1. STARTS/STOPS the engine via the C ABI (botmem_engine_start/stop);
//       2. POLLS ~/.botmem/bridge-status.json (~1.5s) and renders a clean,
//          single-window status UI from it;
//       3. Handles the botmem-apple-bridge://connect deep link: save config,
//          (re)start the engine, show status.
//
// CRITICAL — Full Disk Access (FDA):
//   macOS TCC attributes file access (e.g. ~/Library/Messages/chat.db) to the
//   process doing the read. Because the engine runs IN-PROCESS, its reads are
//   attributed to THIS signed app's FDA grant directly. There is no child
//   process — which matters under ad-hoc signing, where a separate helper of any
//   language would NOT inherit the app's FDA. The LaunchAgent must still launch
//   THIS app at login so the FDA-holding process is running.
//
// Privacy: this app reads ONLY counts/sources/states from the status file and
// never logs or renders user content (message text, names, phone numbers).
// ============================================================================

// MARK: - Config

/// Connection config persisted by this app at ~/.botmem/config.json so it
/// survives relaunch: written by the deep-link handler, loaded at startup and
/// passed to the engine via the C ABI.
struct BridgeConfig: Codable {
  var server: String
  var token: String
  var accountId: String
  var sources: String
}

let DEFAULT_TUNNEL_URL = "wss://api.botmem.xyz/apple-tunnel"

final class ConfigStore {
  /// ~/.botmem — the app's data dir (config, status, logs), shared with the engine.
  let botmemDir: URL
  let configURL: URL
  /// The structured status doc written by the engine's status writer (PROTOCOL.md §6).
  let statusURL: URL
  /// Engine stderr (tracing) log; surfaced via "Open Logs".
  let serviceLogURL: URL

  init() {
    botmemDir = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".botmem", isDirectory: true)
    configURL = botmemDir.appendingPathComponent("config.json", isDirectory: false)
    statusURL = botmemDir.appendingPathComponent("bridge-status.json", isDirectory: false)
    serviceLogURL = botmemDir.appendingPathComponent("service.log", isDirectory: false)
  }

  func load() -> BridgeConfig? {
    guard let data = try? Data(contentsOf: configURL) else { return nil }
    return try? JSONDecoder().decode(BridgeConfig.self, from: data)
  }

  func save(_ config: BridgeConfig) throws {
    try FileManager.default.createDirectory(at: botmemDir, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(config)
    try data.write(to: configURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
  }
}

// MARK: - Bridge status snapshot (exact shape of bridge-status.json)

enum BridgeState: String, Codable {
  case starting, connecting, indexing, live, error, offline
}

struct StatusSource: Codable {
  let source: String
  let count: Int
}

struct IndexingStatus: Codable {
  let active: Bool
  let source: String?
  let done: Int
  let total: Int?
}

struct ActivityEntry: Codable {
  let ts: Double
  let text: String
}

/// Mirrors BridgeStatusSnapshot from status-writer.ts (schema: 1).
struct BridgeStatusSnapshot: Codable {
  let schema: Int
  let state: BridgeState
  let label: String
  let server: String
  let connected: Bool
  let sources: [StatusSource]
  let indexing: IndexingStatus
  let activity: [ActivityEntry]
  let lastError: String?
  let updatedAt: Double
}

// MARK: - Engine controller (in-process Rust engine)

/// Drives the Rust bridge engine, which is linked INTO this app as a static
/// library (`libbotmem_engine.a`) and called through the C ABI in
/// `botmem_engine.h`. The engine reads ~/Library/Messages/chat.db, the WhatsApp
/// container, and Contacts; builds a local FTS index; and runs the encrypted
/// tunnel — all on its own threads inside THIS process.
///
/// FDA: because the engine runs in-process, its file reads are attributed to
/// THIS signed app's Full Disk Access grant directly — there is no child process
/// to inherit (or fail to inherit) the grant. This is the whole reason the
/// engine is a linked library rather than a spawned helper: under ad-hoc
/// signing a separate helper of any language does NOT inherit the app's FDA.
/// The LaunchAgent must still launch THIS app (so the FDA-holding process runs).
final class EngineController {
  private let store: ConfigStore

  /// Non-nil when the engine could not start. Surfaced in the UI. No user content.
  private(set) var failureReason: String?
  /// True while the engine is started (it reconnects internally).
  private(set) var isRunning = false

  /// Called on the main queue after start/stop so the UI refreshes.
  var onStateChange: (() -> Void)?

  init(store: ConfigStore) {
    self.store = store
  }

  /// (Re)start the engine for the given config. The C ABI stops any prior
  /// instance first, so this is also the "reconnect" path.
  func start(config: BridgeConfig) {
    let dataDir = store.botmemDir.appendingPathComponent("apple-bridge", isDirectory: true).path
    let payload: [String: Any] = [
      "token": config.token,
      "server": config.server,
      "sources": config.sources,
      "status_path": store.statusURL.path,
      "data_dir": dataDir,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
      let json = String(data: data, encoding: .utf8)
    else {
      failureReason = "Could not build engine config"
      isRunning = false
      onStateChange?()
      return
    }

    let rc = json.withCString { botmem_engine_start($0) }
    if rc == BOTMEM_OK {
      isRunning = true
      failureReason = nil
    } else {
      isRunning = false
      // Privacy-safe: a numeric code, never the token/config contents.
      failureReason = "Engine failed to start (code \(rc))"
    }
    onStateChange?()
  }

  /// Stop the engine. `intentional` is accepted for call-site symmetry; the
  /// engine has no auto-restart watcher to suppress (it reconnects the tunnel
  /// itself but exits cleanly on stop).
  func stop(intentional: Bool = true) {
    _ = botmem_engine_stop()
    isRunning = false
    onStateChange?()
  }
}

// MARK: - LaunchAgent (launches THIS APP headless at login)

/// Installs a per-user LaunchAgent that launches THIS signed app at login. The
/// app runs the engine in-process, so launching the app (not a helper) is what
/// keeps the FDA-holding process running.
final class LaunchAgentController {
  private let label = "xyz.botmem.apple-bridge.service"

  var plistURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
      .appendingPathComponent("\(label).plist", isDirectory: false)
  }

  /// Ensure the LaunchAgent launches the APP BINARY directly (not `open`).
  /// launchd must supervise the long-lived signed app process itself, so
  /// KeepAlive can restart it on crash; if we launched `/usr/bin/open` instead,
  /// launchd would supervise that short-lived helper and KeepAlive would just
  /// relaunch `open` after the app it spawned had already detached. The app is
  /// a background/menu-bar agent (LSUIElement) so launching the binary directly
  /// does not steal focus or add a Dock icon at login. Rewrites a stale plist
  /// (e.g. an old install that launched `open` or a separate helper).
  func ensureInstalled() {
    let exePath = Bundle.main.executableURL?.path ?? ""
    guard !exePath.isEmpty else { return }

    let desired: [String: Any] = [
      "Label": label,
      "ProgramArguments": [exePath],
      "RunAtLoad": true,
      // Always keep the supervisor app alive; launchd restarts it on crash.
      "KeepAlive": true,
      "ProcessType": "Interactive",
    ]

    if let existing = try? Data(contentsOf: plistURL),
      let plist = try? PropertyListSerialization.propertyList(from: existing, format: nil)
        as? [String: Any],
      let args = plist["ProgramArguments"] as? [String],
      args == (desired["ProgramArguments"] as? [String]),
      (plist["KeepAlive"] as? Bool) == true
    {
      return  // already correct
    }

    try? FileManager.default.createDirectory(
      at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let data = try? PropertyListSerialization.data(
      fromPropertyList: desired, format: .xml, options: 0)
    {
      try? data.write(to: plistURL, options: [.atomic])
    }
  }
}

// MARK: - iMessage readability probe (FDA check)

/// Lightweight Full Disk Access probe: can we read ~/Library/Messages/chat.db?
/// Used only to surface a "Permissions" hint — the engine does the real reads
/// in-process under the same FDA grant.
func messagesReadable() -> Bool {
  let path = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Messages/chat.db", isDirectory: false).path
  guard FileManager.default.fileExists(atPath: path) else {
    // No chat.db (fresh Mac / Messages never used) — don't block on FDA.
    return true
  }
  return FileManager.default.isReadableFile(atPath: path)
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let store = ConfigStore()
  private lazy var engine = EngineController(store: store)
  private let launchAgent = LaunchAgentController()

  private var config: BridgeConfig?
  private var snapshot: BridgeStatusSnapshot?
  private var pollTimer: Timer?

  private var window: NSWindow?
  private var contentView: NSView?

  func applicationDidFinishLaunching(_ notification: Notification) {
    installApplicationMenu()
    NSAppleEventManager.shared().setEventHandler(
      self,
      andSelector: #selector(handleUrlEvent(_:withReplyEvent:)),
      forEventClass: AEEventClass(kInternetEventClass),
      andEventID: AEEventID(kAEGetURL)
    )

    config = store.load()
    launchAgent.ensureInstalled()
    engine.onStateChange = { [weak self] in self?.renderWindow() }

    // If already configured, start the engine immediately (login launch path).
    if let config {
      engine.start(config: config)
    }

    refreshSnapshot()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      self?.refreshSnapshot()
    }

    showWindow()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
  }

  // MARK: Deep link

  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls { configure(from: url) }
  }

  @objc private func handleUrlEvent(
    _ event: NSAppleEventDescriptor, withReplyEvent: NSAppleEventDescriptor
  ) {
    guard let raw = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
      let url = URL(string: raw)
    else { return }
    configure(from: url)
  }

  /// botmem-apple-bridge://connect?server=&token=&accountId=&sources=
  /// Saves config, (re)starts the engine, and shows the status screen.
  private func configure(from url: URL) {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
    let params = Dictionary(
      uniqueKeysWithValues: (components.queryItems ?? []).compactMap { item in
        item.value.map { (item.name, $0) }
      })

    guard let token = params["token"], !token.isEmpty else {
      showWindow()
      return
    }

    // Default server is the apple-tunnel endpoint, NOT app.botmem.xyz.
    let server = params["server"].flatMap { $0.isEmpty ? nil : $0 } ?? DEFAULT_TUNNEL_URL

    let next = BridgeConfig(
      server: server,
      token: token,
      accountId: params["accountId"] ?? "",
      sources: params["sources"] ?? "contacts,imessages,whatsapp"
    )

    do {
      try store.save(next)
      config = next
      launchAgent.ensureInstalled()
      engine.start(config: next)
      refreshSnapshot()
      showWindow()
    } catch {
      showWindow()
    }
  }

  // MARK: Status polling

  /// Atomic-read tolerant: the writer renames a tmp file over the target, so a
  /// failed decode just means we caught a transient gap — keep the last good
  /// snapshot and try again on the next tick.
  private func refreshSnapshot() {
    if let data = try? Data(contentsOf: store.statusURL),
      let decoded = try? JSONDecoder().decode(BridgeStatusSnapshot.self, from: data)
    {
      snapshot = decoded
    }
    updateMenu()
    renderWindow()
  }

  // MARK: Menu bar

  private func installApplicationMenu() {
    let mainMenu = NSMenu()
    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu(title: "botmem")
    appMenu.addItem(
      NSMenuItem(
        title: "About botmem",
        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(NSMenuItem(title: "Quit botmem", action: #selector(quit), keyEquivalent: "q"))
    appMenuItem.submenu = appMenu
    NSApp.mainMenu = mainMenu
  }

  private func updateMenu() {
    statusItem.button?.image = NSImage(named: "logo-mark-128")
    statusItem.button?.image?.size = NSSize(width: 18, height: 18)
    let label = snapshot?.label ?? (config == nil ? "Not connected" : "Starting…")
    statusItem.button?.toolTip = "botmem: \(label)"

    let menu = NSMenu()
    menu.addItem(menuInfo("botmem"))
    menu.addItem(menuInfo(label))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Show Window", action: #selector(showWindowFromMenu), keyEquivalent: ""))
    if config != nil {
      menu.addItem(NSMenuItem(title: "Reconnect", action: #selector(reconnect), keyEquivalent: "r"))
    }
    menu.addItem(NSMenuItem(title: "Open Logs", action: #selector(openLogs), keyEquivalent: ""))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
    statusItem.menu = menu
  }

  private func menuInfo(_ title: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    return item
  }

  // MARK: Window

  @objc private func showWindowFromMenu() { showWindow() }

  private func showWindow() {
    if let window {
      renderWindow()
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    let width: CGFloat = 720
    let height: CGFloat = 560
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: width, height: height),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered, defer: false)
    window.title = "botmem"
    window.center()
    window.backgroundColor = NSColor(calibratedRed: 0.05, green: 0.05, blue: 0.05, alpha: 1)

    let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
    content.wantsLayer = true
    content.layer?.backgroundColor =
      NSColor(calibratedRed: 0.05, green: 0.05, blue: 0.05, alpha: 1).cgColor
    window.contentView = content
    contentView = content
    self.window = window
    renderWindow()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // MARK: Colors / labels

  private func lime() -> NSColor { NSColor(calibratedRed: 0.77, green: 0.96, blue: 0.23, alpha: 1) }
  private func muted() -> NSColor { NSColor(calibratedWhite: 0.72, alpha: 1) }
  private func orange() -> NSColor { NSColor(calibratedRed: 0.98, green: 0.6, blue: 0.2, alpha: 1) }

  private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor)
    -> NSTextField
  {
    let field = NSTextField(labelWithString: text)
    field.font = NSFont.monospacedSystemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.backgroundColor = .clear
    return field
  }

  private func wrapLabel(_ text: String, size: CGFloat, color: NSColor) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    field.textColor = color
    field.backgroundColor = .clear
    return field
  }

  private func actionButton(_ title: String, action: Selector, x: CGFloat, y: CGFloat, width: CGFloat)
    -> NSButton
  {
    let button = NSButton(title: title, target: self, action: action)
    button.frame = NSRect(x: x, y: y, width: width, height: 34)
    button.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)
    button.bezelStyle = .regularSquare
    return button
  }

  // MARK: Render

  private func renderWindow() {
    guard let content = contentView else { return }
    content.subviews.forEach { $0.removeFromSuperview() }

    let border = NSView(frame: NSRect(x: 24, y: 24, width: 672, height: 512))
    border.wantsLayer = true
    border.layer?.borderWidth = 2
    border.layer?.borderColor = NSColor(calibratedWhite: 0.94, alpha: 1).cgColor
    border.layer?.backgroundColor =
      NSColor(calibratedRed: 0.07, green: 0.07, blue: 0.07, alpha: 1).cgColor
    content.addSubview(border)

    let logo = NSImageView(frame: NSRect(x: 52, y: 470, width: 40, height: 40))
    logo.image = NSImage(named: "logo-mark-128")
    logo.imageScaling = .scaleProportionallyUpOrDown
    content.addSubview(logo)

    let eyebrow = label("LOCAL APPLE BRIDGE", size: 11, weight: .semibold, color: lime())
    eyebrow.frame = NSRect(x: 104, y: 492, width: 260, height: 16)
    content.addSubview(eyebrow)

    let title = label("botmem", size: 22, weight: .bold, color: .white)
    title.frame = NSRect(x: 104, y: 462, width: 400, height: 30)
    content.addSubview(title)

    if config == nil {
      renderConnect(on: content)
      return
    }

    renderStatus(on: content)
  }

  private func renderConnect(on content: NSView) {
    let heading = label("Not connected", size: 18, weight: .bold, color: .white)
    heading.frame = NSRect(x: 52, y: 400, width: 580, height: 26)
    content.addSubview(heading)

    let body = wrapLabel(
      "Open Botmem, add the Apple connector, choose your sources, and click Connect. "
        + "Botmem will hand this app a secure link and syncing starts automatically.",
      size: 13, color: muted())
    body.frame = NSRect(x: 52, y: 332, width: 600, height: 60)
    content.addSubview(body)

    let connect = actionButton("OPEN BOTMEM", action: #selector(openBotmem), x: 52, y: 280, width: 150)
    content.addSubview(connect)

    let permissions = actionButton(
      "PERMISSIONS", action: #selector(openFullDiskAccess), x: 216, y: 280, width: 130)
    content.addSubview(permissions)

    let quit = actionButton("QUIT", action: #selector(quit), x: 580, y: 280, width: 80)
    content.addSubview(quit)

    let note = wrapLabel(
      "iMessage history needs Full Disk Access for this app. Grant it once in "
        + "System Settings → Privacy & Security → Full Disk Access.",
      size: 12, color: muted())
    note.frame = NSRect(x: 52, y: 200, width: 600, height: 40)
    content.addSubview(note)
  }

  private func renderStatus(on content: NSView) {
    let snap = snapshot
    let live = snap?.state == .live
    let statusColor: NSColor = {
      switch snap?.state {
      case .live: return lime()
      case .error: return NSColor.systemRed
      case .connecting, .indexing, .starting, .offline, .none: return orange()
      }
    }()

    // Status dot + big label.
    let dot = NSView(frame: NSRect(x: 52, y: 416, width: 12, height: 12))
    dot.wantsLayer = true
    dot.layer?.cornerRadius = 6
    dot.layer?.backgroundColor = statusColor.cgColor
    content.addSubview(dot)

    let statusText = label(
      snap?.label ?? "Starting…", size: 18, weight: .bold, color: live ? lime() : .white)
    statusText.frame = NSRect(x: 76, y: 410, width: 580, height: 26)
    content.addSubview(statusText)

    // Source chips.
    let chips = (snap?.sources ?? []).map { src -> String in
      "\(displaySource(src.source)) \(src.count)"
    }
    let chipText = chips.isEmpty ? "No sources indexed yet" : chips.joined(separator: "  ·  ")
    let chip = label(chipText, size: 13, weight: .semibold, color: muted())
    chip.frame = NSRect(x: 52, y: 378, width: 600, height: 20)
    content.addSubview(chip)

    // Index progress.
    if let indexing = snap?.indexing, indexing.active {
      let src = indexing.source.map { displaySource($0) } ?? "sources"
      let progress: String
      if let total = indexing.total, total > 0 {
        progress = "Indexing \(src) — \(indexing.done)/\(total)"
      } else {
        progress = "Indexing \(src) — \(indexing.done)"
      }
      let p = label(progress, size: 12, weight: .regular, color: orange())
      p.frame = NSRect(x: 52, y: 352, width: 600, height: 18)
      content.addSubview(p)
    }

    // Activity list (status-writer keeps newest LAST; show newest FIRST).
    let activityCaption = label("ACTIVITY", size: 11, weight: .semibold, color: NSColor(calibratedWhite: 0.55, alpha: 1))
    activityCaption.frame = NSRect(x: 52, y: 320, width: 200, height: 16)
    content.addSubview(activityCaption)

    let activity = (snap?.activity ?? []).suffix(12).reversed()
    var y: CGFloat = 296
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    for entry in activity {
      let time = formatter.string(from: Date(timeIntervalSince1970: entry.ts / 1000))
      let row = label("\(time)  \(entry.text)", size: 11, weight: .regular, color: muted())
      row.frame = NSRect(x: 52, y: y, width: 600, height: 16)
      content.addSubview(row)
      y -= 18
      if y < 110 { break }
    }

    // Engine hint (privacy-safe; no content).
    if let reason = engine.failureReason {
      let warn = label("Engine error: \(reason)", size: 11, weight: .semibold, color: NSColor.systemRed)
      warn.frame = NSRect(x: 52, y: 92, width: 600, height: 16)
      content.addSubview(warn)
    } else if !engine.isRunning {
      let warn = label("Engine stopped", size: 11, weight: .semibold, color: orange())
      warn.frame = NSRect(x: 52, y: 92, width: 600, height: 16)
      content.addSubview(warn)
    }

    // Primary + secondary actions.
    let reconnect = actionButton(
      "RECONNECT", action: #selector(reconnect), x: 52, y: 44, width: 140)
    content.addSubview(reconnect)

    let logs = actionButton("OPEN LOGS", action: #selector(openLogs), x: 206, y: 44, width: 120)
    content.addSubview(logs)

    let permissions = actionButton(
      "PERMISSIONS", action: #selector(openFullDiskAccess), x: 340, y: 44, width: 130)
    content.addSubview(permissions)

    let quit = actionButton("QUIT", action: #selector(quit), x: 580, y: 44, width: 80)
    content.addSubview(quit)
  }

  private func displaySource(_ source: String) -> String {
    switch source.lowercased() {
    case "imessage", "imessages", "messages": return "iMessage"
    case "whatsapp": return "WhatsApp"
    case "contacts": return "Contacts"
    default: return source.capitalized
    }
  }

  // MARK: Actions

  @objc private func reconnect() {
    guard let config else { return }
    engine.start(config: config)
    refreshSnapshot()
  }

  @objc private func openLogs() {
    if !FileManager.default.fileExists(atPath: store.serviceLogURL.path) {
      try? FileManager.default.createDirectory(
        at: store.botmemDir, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: store.serviceLogURL.path, contents: nil)
    }
    NSWorkspace.shared.open(store.serviceLogURL)
  }

  @objc private func openBotmem() {
    if let url = URL(string: "https://app.botmem.xyz") {
      NSWorkspace.shared.open(url)
    }
  }

  @objc private func openFullDiskAccess() {
    if let url = URL(
      string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
    {
      NSWorkspace.shared.open(url)
    }
  }

  @objc private func quit() {
    engine.stop(intentional: true)
    NSApplication.shared.terminate(nil)
  }
}

// MARK: - Entry point

/// Append this process's stderr to ~/.botmem/service.log (best-effort) so the
/// linked engine's tracing output is viewable via "Open Logs".
private func redirectStderrToServiceLog() {
  let dir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".botmem", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let logPath = dir.appendingPathComponent("service.log", isDirectory: false).path
  _ = logPath.withCString { freopen($0, "a", stderr) }
}

@main
struct BotmemAppleBridgeMain {
  static func main() {
    // Capture the in-process engine's stderr (tracing logs) into the service log
    // so "Open Logs" surfaces them. The engine logs only states/counts/durations
    // — never user content.
    redirectStderrToServiceLog()

    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    // Accessory/background app (LSUIElement). launchd launches the binary
    // directly at login; .accessory keeps it out of the Dock and stops the
    // login launch from stealing focus, while the window is still shown
    // on demand (deep link, menu-bar item, or reopen).
    app.setActivationPolicy(.accessory)
    app.run()
  }
}
