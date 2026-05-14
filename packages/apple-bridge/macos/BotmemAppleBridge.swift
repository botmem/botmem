import AppKit
import Contacts
import Foundation

struct BridgeConfig: Codable {
  var server: String
  var token: String
  let accountId: String
  var sources: String
}

struct BridgeSettings: Codable {
  var botmemHost: String
}

struct ContactsPermissionState {
  let allowed: Bool
  let detail: String
  let canRequest: Bool
  let canReset: Bool
}

struct ServiceRuntimeStats {
  let loaded: Bool
  let tunnelConnected: Bool
  let connecting: Bool
  let lastEvent: String
  let lastEventAt: String
  let errorCount: Int
  let reconnectCount: Int
  let connectedCount: Int

  static let empty = ServiceRuntimeStats(
    loaded: false,
    tunnelConnected: false,
    connecting: false,
    lastEvent: "No service activity yet",
    lastEventAt: "",
    errorCount: 0,
    reconnectCount: 0,
    connectedCount: 0
  )
}

let DEFAULT_BOTMEM_HOST = "https://api.botmem.xyz"
let PENDING_CONTACTS_REQUEST_KEY = "xyz.botmem.apple-bridge.pendingContactsRequest"

final class ConfigStore {
  let appSupportURL: URL
  let configURL: URL
  let settingsURL: URL
  let serviceLogURL: URL

  init() {
    appSupportURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("botmem", isDirectory: true)
    configURL = appSupportURL.appendingPathComponent("config.json", isDirectory: false)
    settingsURL = appSupportURL.appendingPathComponent("settings.json", isDirectory: false)
    serviceLogURL = appSupportURL.appendingPathComponent("service.log", isDirectory: false)
  }

  func load() -> BridgeConfig? {
    guard let data = try? Data(contentsOf: configURL) else {
      bridgeLog("config load skipped: missing file")
      return nil
    }
    do {
      return try JSONDecoder().decode(BridgeConfig.self, from: data)
    } catch {
      bridgeLog("config load failed: \(error.localizedDescription)")
      return nil
    }
  }

  func save(_ config: BridgeConfig) throws {
    try FileManager.default.createDirectory(at: appSupportURL, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(config)
    try data.write(to: configURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
    bridgeLog("config saved: \(configURL.path)")
  }

  func loadSettings() -> BridgeSettings {
    guard let data = try? Data(contentsOf: settingsURL),
      let settings = try? JSONDecoder().decode(BridgeSettings.self, from: data)
    else {
      return BridgeSettings(botmemHost: DEFAULT_BOTMEM_HOST)
    }
    return settings
  }

  func save(_ settings: BridgeSettings) throws {
    try FileManager.default.createDirectory(at: appSupportURL, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(settings)
    try data.write(to: settingsURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: settingsURL.path)
  }
}

final class LaunchAgentController {
  private let label = "xyz.botmem.apple-bridge.service"
  private let store: ConfigStore

  init(store: ConfigStore) {
    self.store = store
  }

  var plistURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
      .appendingPathComponent("\(label).plist", isDirectory: false)
  }

  func isLoaded() -> Bool {
    runLaunchctl(["print", serviceTarget()]) == 0
  }

  func removeStaleInstallIfNeeded() {
    guard FileManager.default.fileExists(atPath: plistURL.path),
      let data = try? Data(contentsOf: plistURL),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    else {
      return
    }

    let args = plist["ProgramArguments"] as? [String] ?? []
    let executable = Bundle.main.executableURL?.path ?? ""
    let usesCurrentExecutable = args.first == executable
    let usesCurrentConfig = args.contains(store.configURL.path)

    if usesCurrentExecutable && usesCurrentConfig {
      return
    }

    bridgeLog("removing stale launch agent: \(args.joined(separator: " "))")
    uninstall()
  }

  func install() throws {
    guard let resourceURL = Bundle.main.resourceURL else {
      throw BridgeError("App resources are missing.")
    }

    try FileManager.default.createDirectory(at: store.appSupportURL, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      at: plistURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )

    let plist: [String: Any] = [
      "Label": label,
      "ProgramArguments": [
        Bundle.main.executableURL?.path ?? resourceURL.appendingPathComponent("botmem").path,
        "--helper",
        "--config",
        store.configURL.path,
      ],
      "EnvironmentVariables": [
        "BOTMEM_BRIDGE_RUNNER_NAME": "botmem",
      ],
      "RunAtLoad": true,
      "KeepAlive": [
        "SuccessfulExit": false,
      ],
      "StandardOutPath": store.serviceLogURL.path,
      "StandardErrorPath": store.serviceLogURL.path,
      "WorkingDirectory": resourceURL.path,
    ]

    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: plistURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: plistURL.path)
  }

  func restart() {
    _ = runLaunchctl(["bootout", guiDomain(), plistURL.path])
    _ = runLaunchctl(["bootstrap", guiDomain(), plistURL.path])
    _ = runLaunchctl(["kickstart", "-k", serviceTarget()])
  }

  func uninstall() {
    _ = runLaunchctl(["bootout", guiDomain(), plistURL.path])
    try? FileManager.default.removeItem(at: plistURL)
  }

  private func guiDomain() -> String {
    "gui/\(getuid())"
  }

  private func serviceTarget() -> String {
    "\(guiDomain())/\(label)"
  }

  private func runLaunchctl(_ args: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = args
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    do {
      try process.run()
      process.waitUntilExit()
      bridgeLog("launchctl \(args.joined(separator: " ")) -> \(process.terminationStatus)")
      return process.terminationStatus
    } catch {
      bridgeLog("launchctl failed: \(error.localizedDescription)")
      return 1
    }
  }
}

struct BridgeError: LocalizedError {
  private let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? {
    message
  }
}

func bridgeLog(_ message: String) {
  guard ProcessInfo.processInfo.environment["BOTMEM_APP_DEBUG"] == "1" else {
    return
  }
  let range = NSRange(message.startIndex..<message.endIndex, in: message)
  let redacted = (try? NSRegularExpression(pattern: "token=[^&\\s]+"))?
    .stringByReplacingMatches(in: message, range: range, withTemplate: "token=<redacted>") ?? message
  let line = "\(Date()) \(redacted)\n"
  let url = URL(fileURLWithPath: "/tmp/botmem-apple-bridge.log")
  if let data = line.data(using: .utf8) {
    if FileManager.default.fileExists(atPath: url.path),
      let handle = try? FileHandle(forWritingTo: url)
    {
      _ = try? handle.seekToEnd()
      try? handle.write(contentsOf: data)
      try? handle.close()
    } else {
      try? data.write(to: url)
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let store = ConfigStore()
  private lazy var service = LaunchAgentController(store: store)
  private var config: BridgeConfig?
  private var settings = BridgeSettings(botmemHost: DEFAULT_BOTMEM_HOST)
  private var status = "Not Configured"
  private var window: NSWindow?
  private var contentView: NSView?
  private var hostField: NSTextField?
  private var serverField: NSTextField?
  private var sourceContactsButton: NSButton?
  private var sourceMessagesButton: NSButton?
  private var statusRefreshTimer: Timer?
  private var runtimeStats = ServiceRuntimeStats.empty
  private let contactStore = CNContactStore()

  func applicationDidFinishLaunching(_ notification: Notification) {
    installApplicationMenu()
    NSAppleEventManager.shared().setEventHandler(
      self,
      andSelector: #selector(handleUrlEvent(_:withReplyEvent:)),
      forEventClass: AEEventClass(kInternetEventClass),
      andEventID: AEEventID(kAEGetURL)
    )
    settings = store.loadSettings()
    config = store.load()
    migrateLegacyConfigIfNeeded()
    service.removeStaleInstallIfNeeded()
    refreshStatus()
    statusRefreshTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      self?.refreshStatus()
    }
    showWindow()
    maybeRequestPendingContactsPermission()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(appBecameActive),
      name: NSApplication.didBecomeActiveNotification,
      object: nil
    )
  }

  private func migrateLegacyConfigIfNeeded() {
    let legacySupportURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Botmem Apple Bridge", isDirectory: true)
    let migrations = [
      (
        from: legacySupportURL.appendingPathComponent("config.json", isDirectory: false),
        to: store.configURL
      ),
      (
        from: legacySupportURL.appendingPathComponent("settings.json", isDirectory: false),
        to: store.settingsURL
      ),
    ]

    for migration in migrations {
      guard !FileManager.default.fileExists(atPath: migration.to.path),
        FileManager.default.fileExists(atPath: migration.from.path)
      else {
        continue
      }
      do {
        try FileManager.default.createDirectory(at: store.appSupportURL, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: migration.from, to: migration.to)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: migration.to.path)
        bridgeLog("migrated legacy config: \(migration.from.path) -> \(migration.to.path)")
      } catch {
        bridgeLog("legacy config migration failed: \(error.localizedDescription)")
      }
    }

    settings = store.loadSettings()
    config = store.load()
  }

  private func installApplicationMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)

    let appMenu = NSMenu(title: "botmem")
    appMenu.addItem(
      NSMenuItem(
        title: "About botmem",
        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
        keyEquivalent: ""
      )
    )
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(
      NSMenuItem(
        title: "Quit botmem",
        action: #selector(quit),
        keyEquivalent: "q"
      )
    )
    appMenuItem.submenu = appMenu

    let windowMenuItem = NSMenuItem()
    mainMenu.addItem(windowMenuItem)
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(
      NSMenuItem(
        title: "Show botmem",
        action: #selector(showWindowFromMenu),
        keyEquivalent: "0"
      )
    )
    windowMenu.addItem(NSMenuItem.separator())
    windowMenu.addItem(
      NSMenuItem(
        title: "Minimize",
        action: #selector(NSWindow.performMiniaturize(_:)),
        keyEquivalent: "m"
      )
    )
    windowMenuItem.submenu = windowMenu
    NSApp.windowsMenu = windowMenu

    NSApp.mainMenu = mainMenu
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
  }

  @objc private func appBecameActive() {
    refreshStatus()
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls {
      configure(from: url)
    }
  }

  @objc private func handleUrlEvent(_ event: NSAppleEventDescriptor, withReplyEvent: NSAppleEventDescriptor) {
    guard let rawUrl = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
      let url = URL(string: rawUrl)
    else {
      return
    }
    configure(from: url)
  }

  private func configure(from url: URL) {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      setStatus("Invalid Link")
      return
    }
    let params = Dictionary(
      uniqueKeysWithValues: (components.queryItems ?? []).compactMap { item in
        item.value.map { (item.name, $0) }
      }
    )
    guard let server = params["server"], let token = params["token"] else {
      setStatus("Missing Config")
      return
    }

    let nextConfig = BridgeConfig(
      server: server,
      token: token,
      accountId: params["accountId"] ?? "",
      sources: params["sources"] ?? "contacts,imessages"
    )

    do {
      config = nextConfig
      try store.save(nextConfig)
      setStatus(permissionIssues().isEmpty ? "Ready To Start" : "Permissions Needed")
      showWindow()
    } catch {
      bridgeLog("configure failed: \(error.localizedDescription)")
      setStatus("Setup Failed")
    }
  }

  private func refreshStatus() {
    guard config != nil else {
      runtimeStats = latestRuntimeStats()
      setStatus("Not Configured")
      return
    }
    let issues = permissionIssues()
    if !issues.isEmpty {
      runtimeStats = latestRuntimeStats()
      setStatus("Permissions Needed")
      return
    }
    runtimeStats = latestRuntimeStats()
    if !runtimeStats.loaded {
      setStatus("Service Stopped")
    } else if runtimeStats.tunnelConnected {
      setStatus("Tunnel Connected")
    } else if runtimeStats.connecting {
      setStatus("Connecting")
    } else {
      setStatus("Tunnel Offline")
    }
  }

  private func latestRuntimeStats() -> ServiceRuntimeStats {
    let loaded = service.isLoaded()
    guard let text = try? String(contentsOf: store.serviceLogURL, encoding: .utf8), !text.isEmpty else {
      return ServiceRuntimeStats(
        loaded: loaded,
        tunnelConnected: false,
        connecting: loaded,
        lastEvent: loaded ? "Waiting for service log" : "Service is not loaded",
        lastEventAt: "",
        errorCount: 0,
        reconnectCount: 0,
        connectedCount: 0
      )
    }

    let lines = text.split(whereSeparator: \.isNewline).suffix(240).map(String.init)
    var latestConnected = -1
    var latestConnecting = -1
    var latestFailure = -1
    var errorCount = 0
    var reconnectCount = 0
    var connectedCount = 0

    for (index, line) in lines.enumerated() {
      let lower = line.lowercased()
      if lower.contains("connecting to ") {
        latestConnecting = index
        reconnectCount += 1
      }
      if lower.contains("tunnel connected") {
        latestConnected = index
        connectedCount += 1
      }
      if lower.contains("failed")
        || lower.contains("auth failed")
        || lower.contains("cannot ")
        || lower.contains("denied")
        || lower.contains("bridge disconnected")
        || lower.contains("error")
      {
        latestFailure = index
        errorCount += 1
      }
    }

    let lastLine = lines.last ?? ""
    let parsed = parseLogLine(lastLine)
    let tunnelConnected = loaded && latestConnected >= 0 && latestConnected > latestFailure
    let connecting = loaded && !tunnelConnected && latestConnecting >= 0 && latestConnecting >= latestFailure

    return ServiceRuntimeStats(
      loaded: loaded,
      tunnelConnected: tunnelConnected,
      connecting: connecting,
      lastEvent: parsed.message.isEmpty ? "No service activity yet" : parsed.message,
      lastEventAt: parsed.timestamp,
      errorCount: errorCount,
      reconnectCount: reconnectCount,
      connectedCount: connectedCount
    )
  }

  private func parseLogLine(_ line: String) -> (timestamp: String, message: String) {
    guard let firstSpace = line.firstIndex(of: " ") else {
      return ("", line)
    }
    let timestamp = String(line[..<firstSpace])
    let messageStart = line.index(after: firstSpace)
    return (timestamp, String(line[messageStart...]))
  }

  private func setStatus(_ value: String) {
    status = value
    updateMenu()
    renderWindow()
  }

  private func updateMenu() {
    statusItem.button?.image = NSImage(named: "logo-mark-128")
    statusItem.button?.image?.size = NSSize(width: 18, height: 18)
    statusItem.button?.toolTip = "botmem Apple bridge: \(status)"
    let menu = NSMenu()
    menu.addItem(menuInfo("botmem"))
    menu.addItem(menuInfo("Status: \(status)"))
    if let config {
      menu.addItem(menuInfo("Sources: \(config.sources.replacingOccurrences(of: ",", with: " + "))"))
      menu.addItem(menuInfo("Server: \(config.server)"))
    }
    menu.addItem(menuInfo("Connections: \(runtimeStats.connectedCount)  Attempts: \(runtimeStats.reconnectCount)  Errors: \(runtimeStats.errorCount)"))
    if !runtimeStats.lastEvent.isEmpty {
      let suffix = runtimeStats.lastEventAt.isEmpty ? "" : " @ \(runtimeStats.lastEventAt)"
      menu.addItem(menuInfo("Last: \(runtimeStats.lastEvent)\(suffix)"))
    }
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Show Window", action: #selector(showWindowFromMenu), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Restart Sync Service", action: #selector(reconnect), keyEquivalent: "r"))
    menu.addItem(NSMenuItem(title: "Open Full Disk Access", action: #selector(openFullDiskAccess), keyEquivalent: ""))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
    statusItem.menu = menu
  }

  private func menuInfo(_ title: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    return item
  }

  @objc private func showWindowFromMenu() {
    showWindow()
  }

  private func showWindow() {
    if let window {
      renderWindow()
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    let width: CGFloat = 760
    let height: CGFloat = 520
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: width, height: height),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.title = "botmem"
    window.center()
    window.backgroundColor = NSColor(calibratedRed: 0.05, green: 0.05, blue: 0.05, alpha: 1)

    let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
    content.wantsLayer = true
    content.layer?.backgroundColor = NSColor(calibratedRed: 0.05, green: 0.05, blue: 0.05, alpha: 1).cgColor

    window.contentView = content
    contentView = content
    self.window = window
    renderWindow()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
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

  private func actionButton(_ title: String, action: Selector, x: CGFloat, width: CGFloat) -> NSButton {
    let button = NSButton(title: title, target: self, action: action)
    button.frame = NSRect(x: x, y: 48, width: width, height: 34)
    button.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)
    button.bezelStyle = .regularSquare
    return button
  }

  private func lime() -> NSColor {
    NSColor(calibratedRed: 0.77, green: 0.96, blue: 0.23, alpha: 1)
  }

  private func muted() -> NSColor {
    NSColor(calibratedWhite: 0.72, alpha: 1)
  }

  private func renderWindow() {
    guard let content = contentView else { return }
    content.subviews.forEach { $0.removeFromSuperview() }

    let border = NSView(frame: NSRect(x: 28, y: 28, width: 704, height: 464))
    border.wantsLayer = true
    border.layer?.borderWidth = 2
    border.layer?.borderColor = NSColor(calibratedWhite: 0.94, alpha: 1).cgColor
    border.layer?.backgroundColor = NSColor(calibratedRed: 0.07, green: 0.07, blue: 0.07, alpha: 1).cgColor
    content.addSubview(border)

    let logo = NSImageView(frame: NSRect(x: 56, y: 398, width: 48, height: 48))
    logo.image = NSImage(named: "logo-mark-128")
    logo.imageScaling = .scaleProportionallyUpOrDown
    content.addSubview(logo)

    let eyebrow = label("LOCAL APPLE BRIDGE", size: 12, weight: .semibold, color: lime())
    eyebrow.frame = NSRect(x: 122, y: 424, width: 260, height: 18)
    content.addSubview(eyebrow)

    let title = label("botmem", size: 25, weight: .bold, color: .white)
    title.frame = NSRect(x: 122, y: 388, width: 500, height: 34)
    content.addSubview(title)

    if config == nil {
      renderConnectSetup(on: content)
      return
    }

    let issues = permissionIssues()
    if !issues.isEmpty {
      renderPermissionSetup(on: content, issues: issues)
      return
    }

    renderMainStatus(on: content)
  }

  private func renderConnectSetup(on content: NSView) {
    addStep(on: content, number: "1", title: "Choose Botmem Server", detail: "Use api.botmem.xyz, or enter your own self-hosted Botmem endpoint.", y: 326)

    hostField = NSTextField(string: settings.botmemHost)
    hostField?.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    hostField?.frame = NSRect(x: 86, y: 284, width: 430, height: 28)
    hostField?.bezelStyle = .squareBezel
    if let hostField { content.addSubview(hostField) }

    let save = actionButton("SAVE HOST", action: #selector(saveHost), x: 528, width: 112)
    save.frame.origin.y = 282
    content.addSubview(save)

    addStep(on: content, number: "2", title: "Create Apple Connector", detail: "Open Botmem, choose Apple, select Contacts and/or iMessages, then click Connect Bridge App.", y: 210)

    let openBotmem = actionButton("OPEN BOTMEM", action: #selector(openBotmem), x: 86, width: 136)
    openBotmem.frame.origin.y = 150
    content.addSubview(openBotmem)

    let waiting = wrapLabel("Waiting for setup link from Botmem. This window will advance automatically after the browser opens the bridge link.", size: 12, color: muted())
    waiting.frame = NSRect(x: 240, y: 146, width: 420, height: 44)
    content.addSubview(waiting)

    let quit = actionButton("QUIT", action: #selector(quit), x: 612, width: 72)
    content.addSubview(quit)
  }

  private func renderPermissionSetup(on content: NSView, issues: [String]) {
    let contactsState = contactsPermissionState()
    let configured = wrapLabel(
      "Connected to \(config?.server ?? "Botmem"). Choose sources, then complete only the permissions those sources require.",
      size: 13,
      color: muted()
    )
    configured.frame = NSRect(x: 56, y: 336, width: 620, height: 42)
    content.addSubview(configured)

    addSourceControls(on: content, y: 278)

    let contactsDetail = sourcesContain("contacts") ? contactsState.detail : "Needed only if Contacts was selected."
    addPermissionRow(on: content, title: "Contacts", ok: !issues.contains("contacts"), detail: contactsDetail, y: 220)
    addPermissionRow(on: content, title: "Full Disk Access", ok: !issues.contains("messages"), detail: "Needed for iMessage history because macOS protects ~/Library/Messages.", y: 174)

    let contacts = actionButton("ALLOW CONTACTS", action: #selector(requestContactsPermission), x: 56, width: 148)
    contacts.frame.origin.y = 118
    contacts.isEnabled = issues.contains("contacts") && contactsState.canRequest
    content.addSubview(contacts)

    let resetContacts = actionButton("RESET CONTACTS", action: #selector(resetContactsPermission), x: 220, width: 148)
    resetContacts.frame.origin.y = 118
    resetContacts.isEnabled = issues.contains("contacts") && contactsState.canReset
    content.addSubview(resetContacts)

    let fda = actionButton("OPEN FULL DISK ACCESS", action: #selector(openFullDiskAccess), x: 384, width: 190)
    fda.frame.origin.y = 118
    fda.isEnabled = issues.contains("messages")
    content.addSubview(fda)

    let refresh = actionButton("CHECK AGAIN", action: #selector(checkAgain), x: 590, width: 94)
    refresh.frame.origin.y = 118
    content.addSubview(refresh)

    let note = wrapLabel("After enabling Full Disk Access, return here and click Check Again. macOS may require restarting the bridge app.", size: 12, color: muted())
    note.frame = NSRect(x: 56, y: 76, width: 620, height: 36)
    content.addSubview(note)
  }

  private func renderMainStatus(on content: NSView) {
    addStatusRow(on: content, labelText: "STATUS", value: status, y: 320)
    addStatusRow(on: content, labelText: "SOURCES", value: config?.sources.replacingOccurrences(of: ",", with: " + ") ?? "Unknown", y: 270)
    addStatusRow(on: content, labelText: "SERVER", value: config?.server ?? "Unknown", y: 220)

    serverField = NSTextField(string: config?.server ?? "")
    serverField?.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    serverField?.frame = NSRect(x: 150, y: 172, width: 390, height: 26)
    serverField?.bezelStyle = .squareBezel
    if let serverField { content.addSubview(serverField) }

    let saveServer = actionButton("SAVE SERVER", action: #selector(saveBridgeServer), x: 554, width: 120)
    saveServer.frame.origin.y = 169
    content.addSubview(saveServer)

    let detail = wrapLabel("The background service starts at login and reconnects automatically. Token/config stay in local user config, not Keychain.", size: 12, color: muted())
    detail.frame = NSRect(x: 56, y: 108, width: 620, height: 38)
    content.addSubview(detail)

    let restart = actionButton("RESTART SERVICE", action: #selector(reconnect), x: 56, width: 154)
    content.addSubview(restart)
    let remove = actionButton("REMOVE SERVICE", action: #selector(removeService), x: 226, width: 150)
    content.addSubview(remove)
    let permissions = actionButton("PERMISSIONS", action: #selector(openFullDiskAccess), x: 392, width: 122)
    content.addSubview(permissions)
    let quit = actionButton("QUIT", action: #selector(quit), x: 612, width: 72)
    content.addSubview(quit)
  }

  private func addStep(on content: NSView, number: String, title: String, detail: String, y: CGFloat) {
    let badge = label(number, size: 13, weight: .bold, color: .black)
    badge.alignment = .center
    badge.frame = NSRect(x: 56, y: y + 18, width: 24, height: 24)
    badge.backgroundColor = lime()
    content.addSubview(badge)

    let heading = label(title, size: 17, weight: .bold, color: .white)
    heading.frame = NSRect(x: 92, y: y + 20, width: 540, height: 24)
    content.addSubview(heading)

    let body = wrapLabel(detail, size: 12, color: muted())
    body.frame = NSRect(x: 92, y: y - 10, width: 560, height: 32)
    content.addSubview(body)
  }

  private func addPermissionRow(on content: NSView, title: String, ok: Bool, detail: String, y: CGFloat) {
    let state = label(ok ? "OK" : "TODO", size: 11, weight: .bold, color: ok ? lime() : NSColor.systemRed)
    state.frame = NSRect(x: 56, y: y, width: 56, height: 20)
    content.addSubview(state)

    let heading = label(title, size: 15, weight: .bold, color: .white)
    heading.frame = NSRect(x: 122, y: y, width: 240, height: 20)
    content.addSubview(heading)

    let body = wrapLabel(detail, size: 12, color: muted())
    body.frame = NSRect(x: 300, y: y - 8, width: 360, height: 34)
    content.addSubview(body)
  }

  private func addSourceControls(on content: NSView, y: CGFloat) {
    let caption = label("SOURCES", size: 11, weight: .semibold, color: NSColor(calibratedWhite: 0.58, alpha: 1))
    caption.frame = NSRect(x: 56, y: y + 4, width: 86, height: 18)
    content.addSubview(caption)

    let contacts = NSButton(checkboxWithTitle: "Contacts", target: self, action: #selector(updateSources))
    contacts.frame = NSRect(x: 150, y: y, width: 120, height: 24)
    contacts.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold)
    contacts.contentTintColor = .white
    contacts.state = sourcesContain("contacts") ? .on : .off
    content.addSubview(contacts)
    sourceContactsButton = contacts

    let messages = NSButton(checkboxWithTitle: "Messages", target: self, action: #selector(updateSources))
    messages.frame = NSRect(x: 286, y: y, width: 120, height: 24)
    messages.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold)
    messages.contentTintColor = .white
    messages.state = sourcesContain("imessages") ? .on : .off
    content.addSubview(messages)
    sourceMessagesButton = messages
  }

  private func addStatusRow(on content: NSView, labelText: String, value: String, y: CGFloat) {
    let caption = label(labelText, size: 11, weight: .semibold, color: NSColor(calibratedWhite: 0.58, alpha: 1))
    caption.frame = NSRect(x: 56, y: y, width: 90, height: 18)
    content.addSubview(caption)

    let field = label(value, size: 13, weight: .semibold, color: .white)
    field.frame = NSRect(x: 150, y: y, width: 520, height: 20)
    content.addSubview(field)
  }

  private func sourcesContain(_ source: String) -> Bool {
    let parts = (config?.sources ?? "")
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    return parts.contains(source)
  }

  private func contactsAllowed() -> Bool {
    contactsPermissionState().allowed
  }

  private func contactsPermissionState() -> ContactsPermissionState {
    let status = CNContactStore.authorizationStatus(for: .contacts)
    bridgeLog("contacts authorization status raw=\(status.rawValue)")
    if status == .authorized {
      return ContactsPermissionState(
        allowed: true,
        detail: "Allowed by macOS Contacts privacy.",
        canRequest: false,
        canReset: false
      )
    }

    if status.rawValue == 4 {
      return ContactsPermissionState(
        allowed: true,
        detail: "Allowed by macOS Contacts privacy with limited access.",
        canRequest: false,
        canReset: false
      )
    }

    switch status {
    case .notDetermined:
      return ContactsPermissionState(
        allowed: false,
        detail: "Click Allow Contacts and accept the macOS prompt.",
        canRequest: true,
        canReset: false
      )
    case .denied:
      return ContactsPermissionState(
        allowed: false,
        detail: "macOS reports Contacts denied for this build. Reset it; the app will reopen and ask again.",
        canRequest: false,
        canReset: true
      )
    case .restricted:
      return ContactsPermissionState(
        allowed: false,
        detail: "Contacts access is restricted by macOS policy.",
        canRequest: false,
        canReset: false
      )
    default:
      return ContactsPermissionState(
        allowed: false,
        detail: "Unknown Contacts permission state \(status.rawValue). Reset and allow it again.",
        canRequest: false,
        canReset: true
      )
    }
  }

  private func messagesReadable() -> Bool {
    nativeMessagesReadable()
  }

  private func permissionIssues() -> [String] {
    guard config != nil else { return [] }
    var issues: [String] = []
    if sourcesContain("contacts") && !contactsAllowed() {
      issues.append("contacts")
    }
    if (sourcesContain("imessages") || sourcesContain("messages")) && !messagesReadable() {
      issues.append("messages")
    }
    return issues
  }

  @objc private func updateSources() {
    guard var current = config else { return }
    let contacts = sourceContactsButton?.state == .on
    let messages = sourceMessagesButton?.state == .on
    if !contacts && !messages {
      sourceContactsButton?.state = .on
      current.sources = "contacts"
    } else {
      current.sources = [
        contacts ? "contacts" : nil,
        messages ? "imessages" : nil,
      ].compactMap { $0 }.joined(separator: ",")
    }
    do {
      config = current
      try store.save(current)
      if service.isLoaded() {
        service.restart()
      }
      refreshStatus()
    } catch {
      bridgeLog("sources save failed: \(error.localizedDescription)")
      setStatus("Setup Failed")
    }
  }

  @objc private func openFullDiskAccess() {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
      NSWorkspace.shared.open(url)
    }
  }

  @objc private func saveHost() {
    let raw = hostField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !raw.isEmpty else { return }
    let normalized = raw.contains("://") ? raw : "https://\(raw)"
    settings.botmemHost = normalized
    try? store.save(settings)
    renderWindow()
  }

  @objc private func openBotmem() {
    saveHost()
    guard let url = URL(string: settings.botmemHost) else { return }
    NSWorkspace.shared.open(url)
  }

  @objc private func requestContactsPermission() {
    let status = CNContactStore.authorizationStatus(for: .contacts)
    bridgeLog("contacts request starting from raw status=\(status.rawValue)")
    guard status == .notDetermined else {
      refreshStatus()
      return
    }

    contactStore.requestAccess(for: .contacts) { [weak self] granted, error in
      bridgeLog("contacts request granted=\(granted) error=\(error?.localizedDescription ?? "none")")
      DispatchQueue.main.async {
        self?.refreshStatus()
      }
    }
  }

  @objc private func resetContactsPermission() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
    process.arguments = ["reset", "AddressBook", Bundle.main.bundleIdentifier ?? "xyz.botmem.apple-bridge"]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    do {
      try process.run()
      process.waitUntilExit()
      bridgeLog("tccutil reset AddressBook -> \(process.terminationStatus)")
      UserDefaults.standard.set(true, forKey: PENDING_CONTACTS_REQUEST_KEY)
      relaunchAfterContactsReset()
    } catch {
      bridgeLog("tccutil reset AddressBook failed: \(error.localizedDescription)")
      refreshStatus()
    }
  }

  private func maybeRequestPendingContactsPermission() {
    guard UserDefaults.standard.bool(forKey: PENDING_CONTACTS_REQUEST_KEY),
      config != nil,
      sourcesContain("contacts")
    else {
      return
    }

    let status = CNContactStore.authorizationStatus(for: .contacts)
    bridgeLog("pending contacts request on launch raw=\(status.rawValue)")

    guard status == .notDetermined else {
      UserDefaults.standard.removeObject(forKey: PENDING_CONTACTS_REQUEST_KEY)
      refreshStatus()
      return
    }

    UserDefaults.standard.removeObject(forKey: PENDING_CONTACTS_REQUEST_KEY)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      self?.requestContactsPermission()
    }
  }

  private func relaunchAfterContactsReset() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-n", Bundle.main.bundlePath]
    do {
      try process.run()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
        NSApp.terminate(nil)
      }
    } catch {
      bridgeLog("contacts reset relaunch failed: \(error.localizedDescription)")
      refreshStatus()
    }
  }

  @objc private func checkAgain() {
    refreshStatus()
  }

  @objc private func startService() {
    guard config != nil else {
      setStatus("Not Configured")
      return
    }
    let issues = permissionIssues()
    guard issues.isEmpty else {
      setStatus("Permissions Needed")
      return
    }
    do {
      try service.install()
      service.restart()
      refreshStatus()
    } catch {
      bridgeLog("service start failed: \(error.localizedDescription)")
      setStatus("Setup Failed")
    }
  }

  @objc private func saveBridgeServer() {
    guard var current = config else { return }
    let raw = serverField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !raw.isEmpty else { return }
    current.server = raw
    do {
      config = current
      try store.save(current)
      if service.isLoaded() {
        service.restart()
      }
      refreshStatus()
    } catch {
      bridgeLog("server save failed: \(error.localizedDescription)")
      setStatus("Setup Failed")
    }
  }

  @objc private func reconnect() {
    guard config != nil else {
      setStatus("Not Configured")
      return
    }
    startService()
  }

  @objc private func removeService() {
    service.uninstall()
    setStatus(config == nil ? "Not Configured" : "Service Stopped")
  }

  @objc private func quit() {
    NSApplication.shared.terminate(nil)
  }
}

@main
struct BotmemAppleBridgeMain {
  static func main() {
    if runNativeBridgeHelperIfRequested() {
      return
    }
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
  }
}
