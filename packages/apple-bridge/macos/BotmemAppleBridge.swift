import AppKit
import Foundation

// ============================================================================
// botmem Apple Bridge — clean UI shell that SUPERVISES THE NODE BRIDGE.
//
// Architecture (post-rewrite):
//   • The real engine is the Node bridge: `dist/cli.js` (default action) +
//     `src/local-index/*`. It connects the tunnel, builds the FTS index over
//     WhatsApp/iMessage/Contacts, answers search.query/bridge.status, and writes
//     structured status to ~/.botmem/bridge-status.json (atomic).
//   • This app is a thin Swift shell. It does NOT speak the tunnel protocol
//     anymore (the old pure-Swift engine in AppleBridgeNative.swift is retired
//     and no longer compiled). Its only jobs are:
//       1. SPAWN + SUPERVISE the bundled Node binary running dist/cli.js as a
//          CHILD PROCESS of this signed app (restart on crash with backoff).
//       2. POLL ~/.botmem/bridge-status.json (~1.5s) and render a clean,
//          single-window status UI from it.
//       3. Handle the botmem-apple-bridge://connect deep link: save config,
//          (re)start the node child, show status.
//
// CRITICAL — Full Disk Access (FDA) inheritance:
//   macOS TCC attributes file access (e.g. ~/Library/Messages/chat.db) to the
//   *responsible* process. When this signed app spawns Node as a direct child,
//   the child inherits the app's FDA grant under the app's code signature. That
//   is WHY the LaunchAgent must launch THIS APP (headless at login) and the app
//   spawns Node — NOT run Node directly from the LaunchAgent. Running node from
//   launchd would make `launchd`/`node` the responsible process and FDA would
//   not apply, breaking iMessage history reads.
//
// Privacy: this app reads ONLY counts/sources/states from the status file and
// never logs or renders user content (message text, names, phone numbers).
// ============================================================================

// MARK: - Config

/// Shared on-disk config consumed by both the CLI and this app.
/// Stored at ~/.botmem/config.json so the node child (started with
/// --config <that path>) and the deep-link handler agree on one location.
struct BridgeConfig: Codable {
  var server: String
  var token: String
  var accountId: String
  var sources: String
}

let DEFAULT_TUNNEL_URL = "wss://api.botmem.xyz/apple-tunnel"

final class ConfigStore {
  /// ~/.botmem — the single source of truth shared with the node bridge.
  let botmemDir: URL
  let configURL: URL
  /// The structured status doc written by the node bridge (status-writer.ts).
  let statusURL: URL
  /// Node bridge stdout/stderr log; surfaced via "Open Logs".
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

// MARK: - Node supervisor

/// Spawns and supervises the bundled Node bridge as a CHILD of this app.
///
/// FDA inheritance: `Process` makes Node a direct child of this signed app, so
/// TCC attributes its file access to the app's Full Disk Access grant. Do NOT
/// move this spawn into a LaunchAgent or a detached shell — that breaks FDA.
final class NodeSupervisor {
  private let store: ConfigStore
  private var process: Process?
  /// Restart backoff (seconds), reset to base on a clean/long-lived run.
  private var backoff: TimeInterval = 1
  private let maxBackoff: TimeInterval = 30
  /// Set when the user intentionally stops the child (no auto-restart).
  private var stopping = false
  private var restartWork: DispatchWorkItem?
  private var lastStartAt: Date = .distantPast

  /// Dev-only: BOTMEM_ALLOW_SYSTEM_NODE=1 permits falling back to a PATH node
  /// when the bundle has no embedded `node`. NEVER set in release builds — the
  /// bundled node is what carries the app's signature/FDA context.
  private var allowSystemNodeFallback: Bool {
    ProcessInfo.processInfo.environment["BOTMEM_ALLOW_SYSTEM_NODE"] == "1"
  }

  /// Non-nil when the engine cannot run (e.g. missing bundled node). Surfaced
  /// in the UI as a clear error state. Privacy-safe (no user content).
  private(set) var failureReason: String?

  /// Called on the main queue whenever the child exits or restarts, so the UI
  /// can refresh its supervisor line.
  var onStateChange: (() -> Void)?

  init(store: ConfigStore) {
    self.store = store
  }

  var isRunning: Bool {
    process?.isRunning ?? false
  }

  /// Resolve the node binary. Production REQUIRES the bundled Resources/node so
  /// the spawn inherits this signed app's TCC/FDA grant. A PATH node is allowed
  /// ONLY in dev (BOTMEM_ALLOW_SYSTEM_NODE=1).
  private func nodeBinaryURL() -> URL? {
    guard let resources = Bundle.main.resourceURL else { return nil }
    let bundled = resources.appendingPathComponent("node", isDirectory: false)
    if FileManager.default.isExecutableFile(atPath: bundled.path) {
      return bundled
    }
    guard allowSystemNodeFallback else { return nil }
    for candidate in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
      if FileManager.default.isExecutableFile(atPath: candidate) {
        return URL(fileURLWithPath: candidate)
      }
    }
    return nil
  }

  private func cliScriptURL() -> URL? {
    guard let resources = Bundle.main.resourceURL else { return nil }
    let script = resources.appendingPathComponent("dist/cli.js", isDirectory: false)
    return FileManager.default.fileExists(atPath: script.path) ? script : nil
  }

  /// (Re)start the node child. Awaits the previous child's clean exit before
  /// spawning so we never run two tunnel+index processes at once.
  func start() {
    stopping = false
    terminateAndWait(current: process)
    process = nil
    spawn()
  }

  /// Stop the child. `intentional` suppresses the auto-restart watcher.
  func stop(intentional: Bool) {
    if intentional { stopping = true }
    restartWork?.cancel()
    restartWork = nil
    terminateAndWait(current: process)
    process = nil
  }

  /// SIGTERM the child, wait up to `timeout` for a clean exit, then SIGKILL.
  /// Detaches the terminationHandler first so the synchronous wait here does not
  /// also trigger the async restart path.
  private func terminateAndWait(current: Process?, timeout: TimeInterval = 2) {
    guard let proc = current, proc.isRunning else { return }
    proc.terminationHandler = nil
    proc.terminate()  // SIGTERM
    let deadline = Date().addingTimeInterval(timeout)
    while proc.isRunning && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)
    }
    if proc.isRunning {
      kill(proc.processIdentifier, SIGKILL)
      proc.waitUntilExit()
    }
  }

  private func spawn() {
    guard let resources = Bundle.main.resourceURL, let cli = cliScriptURL() else {
      failureReason = "Bundle is missing dist/cli.js"
      onStateChange?()
      return
    }
    guard let node = nodeBinaryURL() else {
      // No bundled node and no dev fallback — do NOT crash-loop; surface a clear
      // error so the UI can tell the user the build is broken.
      failureReason = "Bundled Node runtime is missing from the app"
      onStateChange?()
      return
    }
    failureReason = nil

    let proc = Process()
    proc.executableURL = node
    proc.arguments = [cli.path, "--config", store.configURL.path]
    proc.currentDirectoryURL = resources

    // NODE_PATH lets dist/cli.js resolve the bundled node_modules (better-sqlite3,
    // ws, pdf-parse, mammoth) without a package install at the bundle root.
    var env = ProcessInfo.processInfo.environment
    env["NODE_PATH"] = resources.appendingPathComponent("node_modules", isDirectory: true).path
    env["BOTMEM_BRIDGE_RUNNER_NAME"] = "botmem"
    proc.environment = env

    // Append child stdout/stderr to ~/.botmem/service.log for the Logs button.
    if let handle = logFileHandle() {
      proc.standardOutput = handle
      proc.standardError = handle
    }

    proc.terminationHandler = { [weak self, weak proc] _ in
      guard let self else { return }
      DispatchQueue.main.async {
        // Ignore stale handlers from a child we already replaced.
        guard self.process === proc else { return }
        self.handleExit()
      }
    }

    do {
      try proc.run()
      process = proc
      lastStartAt = Date()
      onStateChange?()
    } catch {
      failureReason = "Failed to launch Node bridge"
      onStateChange?()
      scheduleRestart()
    }
  }

  private func handleExit() {
    process = nil
    onStateChange?()
    guard !stopping else { return }
    // Reset backoff if the previous run survived a while (not a crash loop).
    if Date().timeIntervalSince(lastStartAt) > 60 {
      backoff = 1
    }
    scheduleRestart()
  }

  private func scheduleRestart() {
    guard !stopping else { return }
    let delay = backoff
    backoff = min(backoff * 2, maxBackoff)
    let work = DispatchWorkItem { [weak self] in
      guard let self, !self.stopping else { return }
      self.spawn()
    }
    restartWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  /// Open (creating if needed) the service log for child output.
  private func logFileHandle() -> FileHandle? {
    try? FileManager.default.createDirectory(at: store.botmemDir, withIntermediateDirectories: true)
    let path = store.serviceLogURL.path
    if !FileManager.default.fileExists(atPath: path) {
      FileManager.default.createFile(atPath: path, contents: nil)
    }
    guard let handle = try? FileHandle(forWritingTo: store.serviceLogURL) else { return nil }
    _ = try? handle.seekToEnd()
    return handle
  }
}

// MARK: - LaunchAgent (launches THIS APP headless at login)

/// Installs a per-user LaunchAgent that launches THIS signed app at login (not
/// node). The app, in turn, spawns + supervises node — preserving FDA.
final class LaunchAgentController {
  private let label = "xyz.botmem.apple-bridge.service"

  var plistURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
      .appendingPathComponent("\(label).plist", isDirectory: false)
  }

  /// Ensure the LaunchAgent launches the APP BINARY directly (not `open`, not
  /// node). launchd must supervise the long-lived signed app process itself, so
  /// KeepAlive can restart it on crash; if we launched `/usr/bin/open` instead,
  /// launchd would supervise that short-lived helper and KeepAlive would just
  /// relaunch `open` after the app it spawned had already detached. The app is
  /// a background/menu-bar agent (LSUIElement) so launching the binary directly
  /// does not steal focus or add a Dock icon at login. Rewrites a stale plist
  /// (e.g. an old install that launched node `--helper` or `open`).
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
/// Used only to surface a "Permissions" hint — the node bridge does the real
/// reads. No DB engine is linked into the app anymore.
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
  private lazy var node = NodeSupervisor(store: store)
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
    node.onStateChange = { [weak self] in self?.renderWindow() }

    // If already configured, supervise node immediately (login launch path).
    if config != nil {
      node.start()
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
  /// Saves config, (re)starts the node child, and shows the status screen.
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
      sources: params["sources"] ?? "contacts,imessages"
    )

    do {
      try store.save(next)
      config = next
      launchAgent.ensureInstalled()
      node.start()
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

    // Supervisor hint (privacy-safe; no content).
    if let reason = node.failureReason {
      let warn = label("Engine error: \(reason)", size: 11, weight: .semibold, color: NSColor.systemRed)
      warn.frame = NSRect(x: 52, y: 92, width: 600, height: 16)
      content.addSubview(warn)
    } else if !node.isRunning {
      let warn = label("Node bridge stopped — restarting…", size: 11, weight: .semibold, color: orange())
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
    guard config != nil else { return }
    node.start()
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
    node.stop(intentional: true)
    NSApplication.shared.terminate(nil)
  }
}

// MARK: - Entry point

@main
struct BotmemAppleBridgeMain {
  static func main() {
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
