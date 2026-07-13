import Foundation

public final class DeviceControlService {
    private let engine: SourceEnginePort
    private let configurations: ConfigurationStorePort
    private let identity: DeviceIdentityPort
    private let pairing: DevicePairingPort
    private let loginItem: LoginItemManagerPort
    private let tunnel: TunnelManagerPort
    private let localData: LocalDataEraserPort
    private let settings: PermissionSettingsPort
    private let backgroundSyncPolicy: BackgroundSyncPolicy
    private let lock = NSRecursiveLock()

    public init(
        engine: SourceEnginePort,
        configurations: ConfigurationStorePort,
        identity: DeviceIdentityPort,
        pairing: DevicePairingPort,
        loginItem: LoginItemManagerPort,
        tunnel: TunnelManagerPort,
        localData: LocalDataEraserPort,
        settings: PermissionSettingsPort,
        backgroundSyncPolicy: BackgroundSyncPolicy = .production
    ) {
        self.engine = engine
        self.configurations = configurations
        self.identity = identity
        self.pairing = pairing
        self.loginItem = loginItem
        self.tunnel = tunnel
        self.localData = localData
        self.settings = settings
        self.backgroundSyncPolicy = backgroundSyncPolicy
    }

    public func snapshot() throws -> DeviceSnapshot {
        try lock.withLock {
            let configuration = try configurations.load()
            let states = DeviceSource.allCases.map { source -> SourceState in
                guard configuration.enabledSources.contains(source) else {
                    return SourceState(
                        source: source,
                        enabled: false,
                        readiness: .disabled,
                        reasonCode: nil,
                        readOnly: false
                    )
                }
                do {
                    let probe = try engine.probe(source)
                    return SourceState(
                        source: source,
                        enabled: true,
                        readiness: probe.readiness,
                        reasonCode: probe.reasonCode,
                        readOnly: probe.readOnly
                    )
                } catch {
                    return SourceState(
                        source: source,
                        enabled: true,
                        readiness: .error,
                        reasonCode: "source_probe_failed",
                        readOnly: false
                    )
                }
            }
            let keyID = try identity.currentKeyID()
            return DeviceSnapshot(
                sources: states,
                service: tunnel.state,
                loginItem: loginItem.status(),
                enrolled: configuration.enrolled && keyID != nil,
                deviceKeyID: keyID,
                lastError: tunnel.lastError
            )
        }
    }

    @discardableResult
    public func setSource(_ source: DeviceSource, enabled: Bool) throws -> SourceState {
        try lock.withLock {
            var configuration = try configurations.load()
            if enabled {
                configuration.enabledSources.insert(source)
            } else {
                configuration.enabledSources.remove(source)
            }
            try configuration.validate()
            try configurations.save(configuration)
            guard enabled else {
                return SourceState(
                    source: source,
                    enabled: false,
                    readiness: .disabled,
                    reasonCode: nil,
                    readOnly: false
                )
            }
            let probe = try engine.probe(source)
            return SourceState(
                source: source,
                enabled: true,
                readiness: probe.readiness,
                reasonCode: probe.reasonCode,
                readOnly: probe.readOnly
            )
        }
    }

    public func preflight(_ source: DeviceSource) throws -> SourceState {
        try lock.withLock {
            let configuration = try configurations.load()
            let probe = try engine.probe(source)
            return SourceState(
                source: source,
                enabled: configuration.enabledSources.contains(source),
                readiness: probe.readiness,
                reasonCode: probe.reasonCode,
                readOnly: probe.readOnly
            )
        }
    }

    @discardableResult
    public func synchronize(_ source: DeviceSource, reconcile: Bool = false) throws -> SourceSyncReport {
        try lock.withLock {
            let configuration = try configurations.load()
            guard configuration.enabledSources.contains(source) else {
                throw DeviceError.sourceUnavailable(source, .disabled)
            }
            let probe = try engine.probe(source)
            guard probe.readiness != .permissionRequired else {
                throw DeviceError.permissionRequired(source)
            }
            guard probe.readiness == .ready, probe.readOnly else {
                throw DeviceError.sourceUnavailable(source, probe.readiness)
            }
            return try engine.synchronize(source, reconcile: reconcile)
        }
    }

    /// Runs only due enabled sources and always uses Rust's durable incremental
    /// cursor. Schedule state is committed before the scan so a crash cannot
    /// create a hot launch loop; success or bounded retry replaces that lease.
    public func synchronizeDueSources(at now: Date = Date()) -> BackgroundSyncRunReport {
        lock.withLock {
            var attempted: [DeviceSource] = []
            var synchronized: [SourceSyncReport] = []
            var failed: [DeviceSource] = []
            guard (try? backgroundSyncPolicy.validate()) != nil,
                  var configuration = try? configurations.load() else {
                return BackgroundSyncRunReport(
                    attempted: attempted,
                    synchronized: synchronized,
                    failed: DeviceSource.allCases
                )
            }
            let dueSources = configuration.enabledSources
                .filter { configuration.schedule(for: $0)?.nextAttemptAt ?? .distantPast <= now }
                .sorted { $0.rawValue < $1.rawValue }

            for source in dueSources {
                attempted.append(source)
                var schedule = configuration.schedule(for: source) ?? SourceSyncSchedule(
                    source: source,
                    nextAttemptAt: now
                )
                schedule.lastAttemptAt = now
                schedule.nextAttemptAt = now.addingTimeInterval(backgroundSyncPolicy.retryBase)
                configuration.replaceSchedule(schedule)
                do {
                    try configurations.save(configuration)
                    let probe = try engine.probe(source)
                    guard probe.readiness == .ready, probe.readOnly else {
                        throw DeviceError.sourceUnavailable(source, probe.readiness)
                    }
                    let report = try engine.synchronize(source, reconcile: false)
                    schedule.lastSuccessfulAt = now
                    schedule.consecutiveFailures = 0
                    schedule.nextAttemptAt = now.addingTimeInterval(
                        backgroundSyncPolicy.cadence(for: source)
                    )
                    configuration.replaceSchedule(schedule)
                    try configurations.save(configuration)
                    synchronized.append(report)
                } catch {
                    schedule.consecutiveFailures = min(schedule.consecutiveFailures + 1, 32)
                    schedule.nextAttemptAt = now.addingTimeInterval(
                        backgroundSyncPolicy.retryDelay(after: schedule.consecutiveFailures)
                    )
                    configuration.replaceSchedule(schedule)
                    try? configurations.save(configuration)
                    failed.append(source)
                }
            }
            return BackgroundSyncRunReport(
                attempted: attempted,
                synchronized: synchronized,
                failed: failed
            )
        }
    }

    public func requestBackgroundSync(
        for sources: Set<DeviceSource>,
        at now: Date = Date()
    ) throws {
        try lock.withLock {
            var configuration = try configurations.load()
            for source in sources.intersection(configuration.enabledSources) {
                var schedule = configuration.schedule(for: source) ?? SourceSyncSchedule(
                    source: source,
                    nextAttemptAt: now
                )
                schedule.nextAttemptAt = now
                configuration.replaceSchedule(schedule)
            }
            try configurations.save(configuration)
        }
    }

    public func enroll(setupPayload: String, displayName: String) throws {
        try lock.withLock {
            let setup = try DeviceSetupPayload.parse(setupPayload)
            let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.utf8.count <= 128 else {
                throw DeviceError.invalidConfiguration("device name must contain 1 to 128 bytes")
            }
            var configuration = try configurations.load()
            if configuration.enabledSources.isEmpty {
                let available = DeviceSource.allCases.filter {
                    (try? engine.probe($0).readiness) != .notInstalled
                }
                configuration.enabledSources = Set(available.isEmpty ? [.imessage] : available)
            }
            let deviceID = configuration.deviceID ?? UUID()
            let keyID = try identity.createIfMissing()
            guard let publicKey = try identity.currentPublicKeyBase64URL() else {
                throw DeviceError.operationFailed("device public key is unavailable")
            }
            try pairing.redeem(
                setup: setup,
                deviceID: deviceID,
                displayName: name,
                keyID: keyID,
                publicKeyBase64URL: publicKey,
                connectors: DeviceSource.allCases
            )
            configuration.apiBaseURL = setup.apiBaseURL
            configuration.workspaceID = setup.workspaceID
            configuration.deviceID = deviceID
            try configuration.validate()
            try configurations.save(configuration)
            try loginItem.setEnabled(true)
            let loginState = loginItem.status()
            guard loginState == .enabled || loginState == .requiresApproval else {
                throw DeviceError.operationFailed("launch at login could not be registered")
            }
            if tunnel.state == .stopped || tunnel.state == .failed {
                try start()
            }
        }
    }

    public func deleteEnrollment() throws {
        try lock.withLock {
            if tunnel.state != .stopped {
                try tunnel.stop()
            }
            try identity.delete()
            var configuration = try configurations.load()
            configuration.apiBaseURL = nil
            configuration.workspaceID = nil
            configuration.deviceID = nil
            try configurations.save(configuration)
        }
    }

    /// Explicitly removes Botmem's derived device data and enrollment. This is
    /// deliberately distinct from remote workspace deletion: a server notice
    /// can revoke a tunnel, but cannot erase files on an offline Mac.
    public func eraseLocalData() throws {
        try lock.withLock {
            var firstFailure: Error?
            func attempt(_ operation: () throws -> Void) {
                do {
                    try operation()
                } catch {
                    if firstFailure == nil { firstFailure = error }
                }
            }

            attempt {
                if tunnel.state != .stopped { try tunnel.stop() }
            }
            attempt { try loginItem.setEnabled(false) }
            attempt { try identity.delete() }
            attempt { try configurations.delete() }
            attempt { try localData.eraseIndex() }

            if firstFailure != nil {
                throw DeviceError.operationFailed("local Botmem data erase was incomplete")
            }
        }
    }

    public func start() throws {
        try lock.withLock {
            let configuration = try configurations.load()
            try configuration.validate()
            guard let apiBaseURL = configuration.apiBaseURL,
                  let workspaceID = configuration.workspaceID,
                  let deviceID = configuration.deviceID,
                  !configuration.enabledSources.isEmpty else {
                throw DeviceError.notEnrolled
            }
            let keyID = try identity.createIfMissing()
            try tunnel.start(TunnelLaunch(
                apiBaseURL: apiBaseURL,
                workspaceID: workspaceID,
                deviceID: deviceID,
                keyID: keyID,
                connectors: configuration.enabledSources.sorted { $0.rawValue < $1.rawValue }
            ))
        }
    }

    public func stop() throws {
        try lock.withLock { try tunnel.stop() }
    }

    public func setLaunchAtLogin(_ enabled: Bool) throws {
        try lock.withLock { try loginItem.setEnabled(enabled) }
    }

    /// Called by the signed app at process launch. A persisted enrollment is
    /// resumed only when the OS reports the main-app login item as enabled;
    /// no setup payload or replacement identity is accepted on this path.
    @discardableResult
    public func resumeAtLoginIfNeeded() throws -> Bool {
        try lock.withLock {
            guard loginItem.status() == .enabled, tunnel.state == .stopped else { return false }
            let configuration = try configurations.load()
            guard configuration.enrolled, try identity.currentKeyID() != nil else { return false }
            try start()
            return true
        }
    }

    /// This is deliberately separate from probing. It is called only by an
    /// explicit GUI click or explicit CLI command.
    public func openFullDiskAccessSettings() throws {
        try settings.openFullDiskAccess()
    }
}

private extension NSRecursiveLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
