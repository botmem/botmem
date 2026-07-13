import BotmemCore
import Foundation
import XCTest

final class DeviceControlServiceTests: XCTestCase {
    func testEnable_whenProtectedDatabaseCannotOpen_reportsPermissionWithoutOpeningSettings() throws {
        let harness = Harness()
        harness.engine.probes[.imessage] = .init(
            source: .imessage,
            readiness: .permissionRequired,
            readOnly: false,
            reasonCode: "source_permission_required"
        )

        let result = try harness.service.setSource(.imessage, enabled: true)

        XCTAssertEqual(result.readiness, .permissionRequired)
        XCTAssertEqual(harness.settings.openCount, 0)
        XCTAssertThrowsError(try harness.service.synchronize(.imessage)) { error in
            XCTAssertEqual(error as? DeviceError, .permissionRequired(.imessage))
        }
        try harness.service.openFullDiskAccessSettings()
        XCTAssertEqual(harness.settings.openCount, 1)
    }

    func testSynchronize_whenProbeIsReadOnlyReady_delegatesToRustPort() throws {
        let harness = Harness()
        harness.engine.probes[.imessage] = .init(
            source: .imessage,
            readiness: .ready,
            readOnly: true
        )
        _ = try harness.service.setSource(.imessage, enabled: true)

        let report = try harness.service.synchronize(.imessage, reconcile: true)

        XCTAssertEqual(report.source, .imessage)
        XCTAssertEqual(harness.engine.syncCalls, [.init(source: .imessage, reconcile: true)])
    }

    func testEnrollment_redeemsPublicSetupAndKeepsStableDeviceIdentity() throws {
        let harness = Harness()
        harness.engine.probes[.imessage] = .init(source: .imessage, readiness: .ready, readOnly: true)
        let setup = try makeSetupPayload()

        try harness.service.enroll(setupPayload: setup, displayName: "My Mac")

        let call = try XCTUnwrap(harness.pairing.calls.first)
        XCTAssertEqual(call.displayName, "My Mac")
        XCTAssertEqual(call.keyID, "key-1")
        XCTAssertEqual(call.publicKeyBase64URL, "fixture-public-key")
        XCTAssertEqual(call.connectors, DeviceSource.allCases)
        XCTAssertEqual(harness.identity.createCount, 1)
        XCTAssertEqual(harness.tunnel.state, .running)
        XCTAssertEqual(harness.tunnel.launches.first?.deviceID, call.deviceID)
        XCTAssertEqual(harness.config.value.deviceID, call.deviceID)
        XCTAssertEqual(harness.config.value.enabledSources, [.imessage])
        XCTAssertEqual(harness.login.status(), .enabled)

        try harness.service.deleteEnrollment()

        XCTAssertEqual(harness.identity.deleteCount, 1)
        XCTAssertFalse(harness.config.value.enrolled)
        XCTAssertEqual(harness.tunnel.state, .stopped)
    }

    func testEraseLocalData_stopsRuntimeAndDeletesOnlyOwnedState() throws {
        let harness = Harness()
        try harness.service.enroll(setupPayload: makeSetupPayload(), displayName: "My Mac")
        try harness.service.setLaunchAtLogin(true)

        try harness.service.eraseLocalData()

        XCTAssertEqual(harness.tunnel.state, .stopped)
        XCTAssertEqual(harness.login.status(), .disabled)
        XCTAssertEqual(harness.identity.deleteCount, 1)
        XCTAssertEqual(harness.config.deleteCount, 1)
        XCTAssertEqual(harness.localData.eraseCount, 1)
        XCTAssertFalse(try harness.service.snapshot().enrolled)
    }

    func testEnrollment_rejectsNonOriginOrCredentialBearingSetupAddress() throws {
        let harness = Harness()
        let bad = try JSONEncoder().encode(DeviceSetupPayload(
            protocolVersion: botmemDeviceSetupProtocol,
            apiBaseURL: try XCTUnwrap(URL(string: "https://user:secret@api.botmem.test/path")),
            workspaceID: UUID(),
            code: "BM2-abcdefghijklmnopqrstuvwx"
        ))

        XCTAssertThrowsError(try harness.service.enroll(
            setupPayload: String(decoding: bad, as: UTF8.self),
            displayName: "My Mac"
        ))
        XCTAssertTrue(harness.pairing.calls.isEmpty)
        XCTAssertTrue(harness.tunnel.launches.isEmpty)
    }

    func testLifecycle_enrollmentAutoStartsThenSharedManagersCanStopAndStart() throws {
        let harness = Harness()
        try harness.service.enroll(setupPayload: makeSetupPayload(), displayName: "My Mac")

        XCTAssertEqual(harness.tunnel.state, .running)
        XCTAssertThrowsError(try harness.service.start())
        try harness.service.stop()
        XCTAssertEqual(harness.tunnel.state, .stopped)
        try harness.service.start()
        XCTAssertEqual(harness.tunnel.state, .running)
        XCTAssertEqual(harness.login.status(), .enabled)
    }

    func testColdLoginResume_usesPersistedEnrollmentWithoutRedeemingSetupAgain() throws {
        let harness = Harness()
        try harness.service.enroll(setupPayload: makeSetupPayload(), displayName: "My Mac")
        try harness.service.stop()
        let restartedTunnel = FakeTunnel()
        let restartedService = DeviceControlService(
            engine: harness.engine,
            configurations: harness.config,
            identity: harness.identity,
            pairing: harness.pairing,
            loginItem: harness.login,
            tunnel: restartedTunnel,
            localData: harness.localData,
            settings: harness.settings
        )

        XCTAssertTrue(try restartedService.resumeAtLoginIfNeeded())
        XCTAssertEqual(restartedTunnel.state, .running)
        XCTAssertEqual(restartedTunnel.launches.first?.deviceID, harness.config.value.deviceID)
        XCTAssertEqual(harness.pairing.calls.count, 1, "cold login must not redeem setup again")
        XCTAssertEqual(harness.identity.createCount, 1, "cold login must preserve the device identity")
    }

    func testColdLoginResume_whenLoginItemIsDisabled_doesNotStart() throws {
        let harness = Harness()
        try harness.service.enroll(setupPayload: makeSetupPayload(), displayName: "My Mac")
        try harness.service.stop()
        try harness.service.setLaunchAtLogin(false)

        XCTAssertFalse(try harness.service.resumeAtLoginIfNeeded())
        XCTAssertEqual(harness.tunnel.state, .stopped)
        XCTAssertEqual(harness.pairing.calls.count, 1)
    }

    func testBackgroundSync_dueSourceRunsIncrementallyAndPersistsNextCadence() throws {
        let now = Date(timeIntervalSince1970: 1_752_400_800)
        let harness = Harness(backgroundSyncPolicy: testPolicy)
        harness.engine.probes[.imessage] = .init(
            source: .imessage,
            readiness: .ready,
            readOnly: true
        )
        _ = try harness.service.setSource(.imessage, enabled: true)
        let scheduler = BackgroundSyncScheduler(
            service: harness.service,
            policy: testPolicy,
            clock: { now }
        )

        XCTAssertEqual(scheduler.runNow(), .started)

        XCTAssertEqual(harness.engine.syncCalls, [.init(source: .imessage, reconcile: false)])
        let schedule = try XCTUnwrap(harness.config.value.schedule(for: .imessage))
        XCTAssertEqual(schedule.lastSuccessfulAt, now)
        XCTAssertEqual(schedule.nextAttemptAt, now.addingTimeInterval(30))
        XCTAssertEqual(schedule.consecutiveFailures, 0)
    }

    func testBackgroundSync_notDueDoesNotOpenProtectedSource() throws {
        let now = Date(timeIntervalSince1970: 1_752_400_800)
        let harness = Harness(backgroundSyncPolicy: testPolicy)
        harness.engine.probes[.imessage] = .init(
            source: .imessage,
            readiness: .ready,
            readOnly: true
        )
        _ = try harness.service.setSource(.imessage, enabled: true)
        harness.config.value.replaceSchedule(.init(
            source: .imessage,
            nextAttemptAt: now.addingTimeInterval(1)
        ))
        let scheduler = BackgroundSyncScheduler(
            service: harness.service,
            policy: testPolicy,
            clock: { now }
        )

        XCTAssertEqual(scheduler.runNow(), .started)

        XCTAssertTrue(harness.engine.syncCalls.isEmpty)
    }

    func testBackgroundSync_concurrentTriggersCoalesceIntoSingleFlight() throws {
        let now = Date(timeIntervalSince1970: 1_752_400_800)
        let harness = Harness(backgroundSyncPolicy: testPolicy)
        harness.engine.probes[.imessage] = .init(
            source: .imessage,
            readiness: .ready,
            readOnly: true
        )
        _ = try harness.service.setSource(.imessage, enabled: true)
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        harness.engine.synchronizeStarted = started
        harness.engine.synchronizeRelease = release
        let scheduler = BackgroundSyncScheduler(
            service: harness.service,
            policy: testPolicy,
            clock: { now }
        )

        DispatchQueue.global().async {
            _ = scheduler.runNow()
            finished.signal()
        }
        XCTAssertEqual(started.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(scheduler.runNow(), .coalesced)
        release.signal()
        XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)

        XCTAssertEqual(harness.engine.syncCalls.count, 1)
    }

    func testBackgroundSync_restartUsesPersistedRetryAndRustIncrementalMode() throws {
        let now = Date(timeIntervalSince1970: 1_752_400_800)
        let harness = Harness(backgroundSyncPolicy: testPolicy)
        harness.engine.probes[.whatsapp] = .init(
            source: .whatsapp,
            readiness: .ready,
            readOnly: true
        )
        harness.engine.syncError = DeviceError.operationFailed("fixture failure")
        _ = try harness.service.setSource(.whatsapp, enabled: true)
        _ = BackgroundSyncScheduler(
            service: harness.service,
            policy: testPolicy,
            clock: { now }
        ).runNow()
        let failedSchedule = try XCTUnwrap(harness.config.value.schedule(for: .whatsapp))
        XCTAssertEqual(failedSchedule.nextAttemptAt, now.addingTimeInterval(5))
        XCTAssertEqual(failedSchedule.consecutiveFailures, 1)

        harness.engine.syncError = nil
        let restartedService = DeviceControlService(
            engine: harness.engine,
            configurations: harness.config,
            identity: harness.identity,
            pairing: harness.pairing,
            loginItem: harness.login,
            tunnel: harness.tunnel,
            localData: harness.localData,
            settings: harness.settings,
            backgroundSyncPolicy: testPolicy
        )
        _ = BackgroundSyncScheduler(
            service: restartedService,
            policy: testPolicy,
            clock: { now.addingTimeInterval(4) }
        ).runNow()
        XCTAssertEqual(harness.engine.syncCalls.count, 1)
        _ = BackgroundSyncScheduler(
            service: restartedService,
            policy: testPolicy,
            clock: { now.addingTimeInterval(5) }
        ).runNow()

        XCTAssertEqual(harness.engine.syncCalls.count, 2)
        XCTAssertEqual(harness.engine.syncCalls.last, .init(source: .whatsapp, reconcile: false))
        XCTAssertEqual(harness.config.value.schedule(for: .whatsapp)?.consecutiveFailures, 0)
    }

    func testActivationReprobe_canMakeNewlyReadySourceImmediatelyDue() throws {
        let now = Date(timeIntervalSince1970: 1_752_400_800)
        let harness = Harness(backgroundSyncPolicy: testPolicy)
        harness.engine.probes[.imessage] = .init(
            source: .imessage,
            readiness: .permissionRequired,
            readOnly: false
        )
        _ = try harness.service.setSource(.imessage, enabled: true)
        harness.config.value.replaceSchedule(.init(
            source: .imessage,
            nextAttemptAt: now.addingTimeInterval(300)
        ))
        harness.engine.probes[.imessage] = .init(
            source: .imessage,
            readiness: .ready,
            readOnly: true
        )

        XCTAssertEqual(try harness.service.snapshot().sources.first?.readiness, .ready)
        try harness.service.requestBackgroundSync(for: [.imessage], at: now)
        let report = harness.service.synchronizeDueSources(at: now)

        XCTAssertEqual(report.synchronized.map(\.source), [.imessage])
    }

    func testCommandRouter_producesIdenticalGuiAndCliSemantics() throws {
        let gui = Harness()
        let cli = Harness()
        gui.engine.probes[.whatsapp] = .init(source: .whatsapp, readiness: .notInstalled, readOnly: false)
        cli.engine.probes = gui.engine.probes
        let guiRouter = DeviceCommandRouter(service: gui.service)
        let cliRouter = DeviceCommandRouter(service: cli.service)
        let commands: [DeviceCommand] = [
            .init(
                kind: .enroll,
                setupPayload: try makeSetupPayload(),
                displayName: "Parity Mac"
            ),
            .init(kind: .setSource, source: .whatsapp, enabled: true),
            .init(kind: .preflightSource, source: .whatsapp),
            .init(kind: .setLaunchAtLogin, enabled: true),
            .init(kind: .eraseLocalData),
            .init(kind: .status),
        ]

        for command in commands {
            XCTAssertEqual(guiRouter.handle(command), cliRouter.handle(command))
        }
        XCTAssertEqual(gui.config.value, cli.config.value)
        XCTAssertEqual(gui.login.status(), cli.login.status())
    }

    func testCommandRouter_rejectsUnknownProtocolVersion() throws {
        let data = Data(#"{"protocolVersion":"botmem.macos.ipc.v0","kind":"status"}"#.utf8)
        let command = try JSONDecoder().decode(DeviceCommand.self, from: data)
        let response = DeviceCommandRouter(service: Harness().service).handle(command)

        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "unsupported_protocol")
    }

    private func makeSetupPayload() throws -> String {
        let payload = DeviceSetupPayload(
            protocolVersion: botmemDeviceSetupProtocol,
            apiBaseURL: try XCTUnwrap(URL(string: "https://api.botmem.test/")),
            workspaceID: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            code: "BM2-abcdefghijklmnopqrstuvwx"
        )
        return String(decoding: try JSONEncoder().encode(payload), as: UTF8.self)
    }
}

private final class Harness {
    let engine = FakeEngine()
    let config = MemoryConfigurationStore()
    let identity = FakeIdentity()
    let pairing = FakePairing()
    let login = FakeLoginItem()
    let tunnel = FakeTunnel()
    let localData = FakeLocalData()
    let settings = FakeSettings()
    let service: DeviceControlService

    init(backgroundSyncPolicy: BackgroundSyncPolicy = .production) {
        service = DeviceControlService(
            engine: engine,
            configurations: config,
            identity: identity,
            pairing: pairing,
            loginItem: login,
            tunnel: tunnel,
            localData: localData,
            settings: settings,
            backgroundSyncPolicy: backgroundSyncPolicy
        )
    }
}

private final class FakeEngine: SourceEnginePort {
    struct SyncCall: Equatable { let source: DeviceSource; let reconcile: Bool }
    var probes: [DeviceSource: SourceProbe] = [:]
    var syncCalls: [SyncCall] = []
    var syncError: Error?
    var synchronizeStarted: DispatchSemaphore?
    var synchronizeRelease: DispatchSemaphore?

    func probe(_ source: DeviceSource) throws -> SourceProbe {
        probes[source] ?? .init(source: source, readiness: .notInstalled, readOnly: false)
    }

    func synchronize(_ source: DeviceSource, reconcile: Bool) throws -> SourceSyncReport {
        syncCalls.append(.init(source: source, reconcile: reconcile))
        synchronizeStarted?.signal()
        if let synchronizeRelease {
            _ = synchronizeRelease.wait(timeout: .now() + 2)
        }
        if let syncError { throw syncError }
        return .init(
            source: source,
            mode: reconcile ? "reconcile" : "incremental",
            scanned: 1,
            indexed: 1,
            schemaFingerprint: "fixture"
        )
    }
}

private let testPolicy = BackgroundSyncPolicy(
    imessageCadence: 30,
    whatsappCadence: 30,
    retryBase: 5,
    retryMaximum: 30,
    pollInterval: 5
)

private final class MemoryConfigurationStore: ConfigurationStorePort {
    var value = DeviceConfiguration()
    var deleteCount = 0
    func load() throws -> DeviceConfiguration { value }
    func save(_ configuration: DeviceConfiguration) throws { value = configuration }
    func delete() throws { deleteCount += 1; value = DeviceConfiguration() }
}

private final class FakeLocalData: LocalDataEraserPort {
    var eraseCount = 0
    func eraseIndex() throws { eraseCount += 1 }
}

private final class FakeIdentity: DeviceIdentityPort {
    var value: String?
    var createCount = 0
    var deleteCount = 0
    func currentKeyID() throws -> String? { value }
    func currentPublicKeyBase64URL() throws -> String? {
        value == nil ? nil : "fixture-public-key"
    }
    func createIfMissing() throws -> String {
        if let value { return value }
        createCount += 1
        value = "key-1"
        return "key-1"
    }
    func signAuthentication(
        deviceID: UUID,
        keyID: String,
        clientNonce: String,
        serverNonce: String
    ) throws -> Data {
        Data(repeating: 1, count: 64)
    }
    func delete() throws { deleteCount += 1; value = nil }
}

private final class FakePairing: DevicePairingPort {
    struct Call: Equatable {
        let setup: DeviceSetupPayload
        let deviceID: UUID
        let displayName: String
        let keyID: String
        let publicKeyBase64URL: String
        let connectors: [DeviceSource]
    }
    var calls: [Call] = []
    func redeem(
        setup: DeviceSetupPayload,
        deviceID: UUID,
        displayName: String,
        keyID: String,
        publicKeyBase64URL: String,
        connectors: [DeviceSource]
    ) throws {
        calls.append(.init(
            setup: setup,
            deviceID: deviceID,
            displayName: displayName,
            keyID: keyID,
            publicKeyBase64URL: publicKeyBase64URL,
            connectors: connectors
        ))
    }
}

private final class FakeLoginItem: LoginItemManagerPort {
    private var value: LoginItemState = .disabled
    func status() -> LoginItemState { value }
    func setEnabled(_ enabled: Bool) throws { value = enabled ? .enabled : .disabled }
}

private final class FakeTunnel: TunnelManagerPort {
    var state: ServiceLifecycle = .stopped
    var lastError: String?
    var launches: [TunnelLaunch] = []
    func start(_ launch: TunnelLaunch) throws {
        guard state == .stopped else { throw DeviceError.serviceAlreadyRunning }
        launches.append(launch)
        state = .running
    }
    func stop() throws { state = .stopped }
}

private final class FakeSettings: PermissionSettingsPort {
    var openCount = 0
    func openFullDiskAccess() throws { openCount += 1 }
}
