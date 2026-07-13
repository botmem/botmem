import BotmemCore
import BotmemDeviceRuntime
import BotmemPlatform
import Darwin
import Foundation
import XCTest

final class PlatformTests: XCTestCase {
    func testRustFFI_isStaticallyAvailable() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let engine = RustSourceEngine(storeRoot: root)
        XCTAssertEqual(engine.version, "botmem.device.ffi.v1")
    }

    func testFileConfigurationStore_roundTripsWithPrivatePermissions() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("config.json")
        let store = FileConfigurationStore(fileURL: file)
        let configuration = DeviceConfiguration(enabledSources: [.imessage])

        try store.save(configuration)

        XCTAssertEqual(try store.load(), configuration)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        try store.delete()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(try store.load(), DeviceConfiguration())
    }

    func testLocalIndexEraser_removesOnlyDirectBotmemIndex() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("Botmem")
        let index = root.appendingPathComponent("index")
        let source = root.appendingPathComponent("MessagesSource.sqlite")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: index, withIntermediateDirectories: true)
        try Data("derived".utf8).write(to: index.appendingPathComponent("index.sqlite"))
        try Data("source".utf8).write(to: source)

        try LocalIndexEraser(applicationSupportRoot: root, indexRoot: index).eraseIndex()

        XCTAssertFalse(FileManager.default.fileExists(atPath: index.path))
        XCTAssertEqual(try Data(contentsOf: source), Data("source".utf8))
    }

    func testLocalIndexEraser_rejectsParentAndBasenameEscapes() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("Botmem")
        let source = root.deletingLastPathComponent().appendingPathComponent("source.sqlite")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("source".utf8).write(to: source)

        XCTAssertThrowsError(
            try LocalIndexEraser(applicationSupportRoot: root, indexRoot: source).eraseIndex()
        )
        XCTAssertEqual(try Data(contentsOf: source), Data("source".utf8))
        XCTAssertThrowsError(
            try LocalIndexEraser(
                applicationSupportRoot: root,
                indexRoot: root.appendingPathComponent("not-index")
            ).eraseIndex()
        )
    }

    func testLocalIPC_roundTripsCanonicalCommandWithoutDatabaseAccess() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let socket = root.appendingPathComponent("device.sock")
        let router = StubRouter()
        let server = LocalIPCServer(socketURL: socket, router: router.router)
        try server.start()
        defer { server.stop() }

        let actual = try LocalIPCClient(socketURL: socket).send(.init(kind: .status))

        XCTAssertTrue(actual.ok)
        XCTAssertNotNil(actual.snapshot)
        let attributes = try FileManager.default.attributesOfItem(atPath: socket.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testLocalIPC_secondAppCannotReplaceLiveSocket() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let socket = root.appendingPathComponent("device.sock")
        let router = StubRouter().router
        let first = LocalIPCServer(socketURL: socket, router: router)
        let second = LocalIPCServer(socketURL: socket, router: router)
        try first.start()
        defer { first.stop() }

        XCTAssertThrowsError(try second.start())
        XCTAssertTrue(try LocalIPCClient(socketURL: socket).send(.init(kind: .status)).ok)
    }

    func testProcessTunnel_passesBoundedNonSecretConfigurationOnStdinAndStopsCleanly() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let captured = root.appendingPathComponent("captured.json")
        let helper = try makeHelper(
            root: root,
            body: "cat > \"\(captured.path)\"\nsleep 10"
        )
        let manager = ProcessTunnelManager(
            executableURL: helper,
            indexRoot: root.appendingPathComponent("index"),
            identity: StubIdentity()
        )
        let launch = TunnelLaunch(
            apiBaseURL: try XCTUnwrap(URL(string: "https://api.botmem.test/")),
            workspaceID: UUID(),
            deviceID: UUID(),
            keyID: "fixture",
            connectors: [.imessage]
        )

        try manager.start(launch)
        XCTAssertEqual(manager.state, .running)
        XCTAssertThrowsError(try manager.start(launch))
        let deadline = Date().addingTimeInterval(2)
        while ((try? Data(contentsOf: captured).isEmpty) ?? true), Date() < deadline {
            usleep(10_000)
        }
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: captured)) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), Set([
            "protocolVersion", "apiBaseUrl", "workspaceId", "deviceId", "keyId",
            "clientVersion", "connectors", "indexRoot", "signingSocket",
        ]))
        XCTAssertNil(object["credential"])
        try manager.stop()
        XCTAssertEqual(manager.state, .stopped)
    }

    func testProcessTunnel_unexpectedExitSchedulesReconnectUntilStopped() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = ProcessTunnelManager(
            executableURL: URL(fileURLWithPath: "/usr/bin/false"),
            indexRoot: root.appendingPathComponent("index"),
            identity: StubIdentity()
        )
        try manager.start(.init(
            apiBaseURL: try XCTUnwrap(URL(string: "https://api.botmem.test/")),
            workspaceID: UUID(),
            deviceID: UUID(),
            keyID: "fixture",
            connectors: [.imessage]
        ))

        let deadline = Date().addingTimeInterval(2)
        while manager.lastError == nil, Date() < deadline { usleep(10_000) }

        XCTAssertNotNil(manager.lastError)
        XCTAssertNotEqual(manager.state, .stopped)
        try manager.stop()
        XCTAssertEqual(manager.state, .stopped)
    }

    func testProcessTunnel_permanentRevokeExitStopsWithoutReconnect() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let helper = try makeHelper(root: root, body: "exit 20")
        let manager = ProcessTunnelManager(
            executableURL: helper,
            indexRoot: root.appendingPathComponent("index"),
            identity: StubIdentity()
        )
        try manager.start(.init(
            apiBaseURL: try XCTUnwrap(URL(string: "https://api.botmem.test/")),
            workspaceID: UUID(),
            deviceID: UUID(),
            keyID: "fixture",
            connectors: [.imessage]
        ))

        let deadline = Date().addingTimeInterval(2)
        while manager.state != .stopped, Date() < deadline { usleep(10_000) }
        XCTAssertEqual(manager.state, .stopped)
        XCTAssertEqual(manager.lastError, "tunnel_revoked")
        usleep(1_200_000)
        XCTAssertEqual(manager.state, .stopped)
    }

    func testPackagedCLI_statusMatchesDirectGUIRouterResponse() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let socket = root.appendingPathComponent("device.sock")
        let stub = StubRouter()
        let server = LocalIPCServer(socketURL: socket, router: stub.router)
        try server.start()
        defer { server.stop() }
        let process = Process()
        let output = Pipe()
        process.executableURL = Bundle(for: PlatformTests.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("botmem-device")
        process.arguments = ["status"]
        process.environment = ["BOTMEM_DEVICE_SOCKET": socket.path]
        process.standardOutput = output
        process.standardError = Pipe()

        try process.run()
        process.waitUntilExit()
        let cliResponse = try JSONDecoder().decode(
            DeviceCommandResponse.self,
            from: output.fileHandleForReading.readDataToEndOfFile()
        )
        let guiResponse = stub.router.handle(.init(kind: .status))

        XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertEqual(cliResponse, guiResponse)
    }

    private func makeHelper(root: URL, body: String) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let helper = root.appendingPathComponent("botmem-tunnel")
        try Data("#!/bin/sh\nset -eu\n\(body)\n".utf8).write(to: helper, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        return helper
    }
}

private final class StubRouter {
    let router: DeviceCommandRouter

    init() {
        let service = DeviceControlService(
            engine: StubEngine(),
            configurations: StubConfiguration(),
            identity: StubIdentity(),
            pairing: StubPairing(),
            loginItem: StubLogin(),
            tunnel: StubTunnel(),
            localData: StubLocalData(),
            settings: StubSettings()
        )
        router = DeviceCommandRouter(service: service)
    }
}

private final class StubEngine: SourceEnginePort {
    func probe(_ source: DeviceSource) throws -> SourceProbe {
        .init(source: source, readiness: .notInstalled, readOnly: false)
    }
    func synchronize(_ source: DeviceSource, reconcile: Bool) throws -> SourceSyncReport {
        throw DeviceError.sourceUnavailable(source, .notInstalled)
    }
}

private final class StubConfiguration: ConfigurationStorePort {
    var value = DeviceConfiguration()
    func load() throws -> DeviceConfiguration { value }
    func save(_ configuration: DeviceConfiguration) throws { value = configuration }
    func delete() throws { value = DeviceConfiguration() }
}

private final class StubLocalData: LocalDataEraserPort {
    func eraseIndex() throws {}
}

private final class StubIdentity: DeviceIdentityPort {
    func currentKeyID() throws -> String? { nil }
    func currentPublicKeyBase64URL() throws -> String? { "fixture-public-key" }
    func createIfMissing() throws -> String { "fixture" }
    func signAuthentication(
        deviceID: UUID,
        keyID: String,
        clientNonce: String,
        serverNonce: String
    ) throws -> Data { Data(repeating: 1, count: 64) }
    func delete() throws {}
}

private final class StubPairing: DevicePairingPort {
    func redeem(
        setup: DeviceSetupPayload,
        deviceID: UUID,
        displayName: String,
        keyID: String,
        publicKeyBase64URL: String,
        connectors: [DeviceSource]
    ) throws {}
}

private final class StubLogin: LoginItemManagerPort {
    func status() -> LoginItemState { .disabled }
    func setEnabled(_ enabled: Bool) throws {}
}

private final class StubTunnel: TunnelManagerPort {
    var state: ServiceLifecycle = .stopped
    var lastError: String?
    func start(_ launch: TunnelLaunch) throws { state = .running }
    func stop() throws { state = .stopped }
}

private final class StubSettings: PermissionSettingsPort {
    func openFullDiskAccess() throws {}
}
