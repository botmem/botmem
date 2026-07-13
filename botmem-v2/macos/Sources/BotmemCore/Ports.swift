import Foundation

public protocol SourceEnginePort {
    func probe(_ source: DeviceSource) throws -> SourceProbe
    func synchronize(_ source: DeviceSource, reconcile: Bool) throws -> SourceSyncReport
}

public protocol ConfigurationStorePort {
    func load() throws -> DeviceConfiguration
    func save(_ configuration: DeviceConfiguration) throws
    func delete() throws
}

/// Deletes only Botmem's derived local search index. Source databases are not
/// owned by Botmem and must never be passed to an implementation of this port.
public protocol LocalDataEraserPort {
    func eraseIndex() throws
}

public protocol CredentialStorePort {
    func read(account: String) throws -> Data?
    func replace(_ value: Data, account: String) throws
    func delete(account: String) throws
}

public protocol DeviceIdentityPort {
    func currentKeyID() throws -> String?
    func currentPublicKeyBase64URL() throws -> String?
    @discardableResult func createIfMissing() throws -> String
    func signAuthentication(
        deviceID: UUID,
        keyID: String,
        clientNonce: String,
        serverNonce: String
    ) throws -> Data
    func delete() throws
}

public protocol DevicePairingPort {
    func redeem(
        setup: DeviceSetupPayload,
        deviceID: UUID,
        displayName: String,
        keyID: String,
        publicKeyBase64URL: String,
        connectors: [DeviceSource]
    ) throws
}

public protocol LoginItemManagerPort {
    func status() -> LoginItemState
    func setEnabled(_ enabled: Bool) throws
}

public struct TunnelLaunch: Equatable, Sendable {
    public let apiBaseURL: URL
    public let workspaceID: UUID
    public let deviceID: UUID
    public let keyID: String
    public let connectors: [DeviceSource]

    public init(
        apiBaseURL: URL,
        workspaceID: UUID,
        deviceID: UUID,
        keyID: String,
        connectors: [DeviceSource]
    ) {
        self.apiBaseURL = apiBaseURL
        self.workspaceID = workspaceID
        self.deviceID = deviceID
        self.keyID = keyID
        self.connectors = connectors
    }
}

public protocol TunnelManagerPort {
    var state: ServiceLifecycle { get }
    var lastError: String? { get }
    func start(_ launch: TunnelLaunch) throws
    func stop() throws
}

public protocol PermissionSettingsPort {
    func openFullDiskAccess() throws
}
