import Foundation

public enum DeviceSource: String, CaseIterable, Codable, Sendable {
    case imessage
    case whatsapp
}

public enum SourceReadiness: String, Codable, Sendable {
    case disabled
    case notInstalled = "not_installed"
    case permissionRequired = "permission_required"
    case schemaUnsupported = "schema_unsupported"
    case indexing
    case ready
    case error
}

public struct SourceProbe: Codable, Equatable, Sendable {
    public let source: DeviceSource
    public let readiness: SourceReadiness
    public let readOnly: Bool
    public let reasonCode: String?
    public let schema: SourceSchema?

    public init(
        source: DeviceSource,
        readiness: SourceReadiness,
        readOnly: Bool,
        reasonCode: String? = nil,
        schema: SourceSchema? = nil
    ) {
        self.source = source
        self.readiness = readiness
        self.readOnly = readOnly
        self.reasonCode = reasonCode
        self.schema = schema
    }
}

public struct SourceSchema: Codable, Equatable, Sendable {
    public let family: String
    public let version: UInt16
    public let fingerprint: String

    public init(family: String, version: UInt16, fingerprint: String) {
        self.family = family
        self.version = version
        self.fingerprint = fingerprint
    }
}

public struct SourceSyncReport: Codable, Equatable, Sendable {
    public let source: DeviceSource
    public let mode: String
    public let scanned: UInt64
    public let indexed: UInt64
    public let schemaFingerprint: String

    public init(
        source: DeviceSource,
        mode: String,
        scanned: UInt64,
        indexed: UInt64,
        schemaFingerprint: String
    ) {
        self.source = source
        self.mode = mode
        self.scanned = scanned
        self.indexed = indexed
        self.schemaFingerprint = schemaFingerprint
    }
}

public struct SourceSyncSchedule: Codable, Equatable, Sendable {
    public let source: DeviceSource
    public var lastAttemptAt: Date?
    public var lastSuccessfulAt: Date?
    public var nextAttemptAt: Date
    public var consecutiveFailures: UInt8

    public init(
        source: DeviceSource,
        lastAttemptAt: Date? = nil,
        lastSuccessfulAt: Date? = nil,
        nextAttemptAt: Date,
        consecutiveFailures: UInt8 = 0
    ) {
        self.source = source
        self.lastAttemptAt = lastAttemptAt
        self.lastSuccessfulAt = lastSuccessfulAt
        self.nextAttemptAt = nextAttemptAt
        self.consecutiveFailures = consecutiveFailures
    }
}

public struct BackgroundSyncPolicy: Equatable, Sendable {
    public let imessageCadence: TimeInterval
    public let whatsappCadence: TimeInterval
    public let retryBase: TimeInterval
    public let retryMaximum: TimeInterval
    public let pollInterval: TimeInterval

    public init(
        imessageCadence: TimeInterval,
        whatsappCadence: TimeInterval,
        retryBase: TimeInterval,
        retryMaximum: TimeInterval,
        pollInterval: TimeInterval
    ) {
        self.imessageCadence = imessageCadence
        self.whatsappCadence = whatsappCadence
        self.retryBase = retryBase
        self.retryMaximum = retryMaximum
        self.pollInterval = pollInterval
    }

    public static let production = BackgroundSyncPolicy(
        imessageCadence: 120,
        whatsappCadence: 300,
        retryBase: 30,
        retryMaximum: 300,
        pollInterval: 30
    )

    public func cadence(for source: DeviceSource) -> TimeInterval {
        switch source {
        case .imessage: imessageCadence
        case .whatsapp: whatsappCadence
        }
    }

    public func retryDelay(after failures: UInt8) -> TimeInterval {
        let exponent = min(Int(failures.saturatingSubtractingOne), 8)
        return min(retryBase * pow(2, Double(exponent)), retryMaximum)
    }

    public func validate() throws {
        guard imessageCadence >= 30,
              whatsappCadence >= 30,
              retryBase >= 5,
              retryMaximum >= retryBase,
              pollInterval >= 5 else {
            throw DeviceError.invalidConfiguration("background sync cadence is unsafe")
        }
    }
}

public struct BackgroundSyncRunReport: Equatable, Sendable {
    public let attempted: [DeviceSource]
    public let synchronized: [SourceSyncReport]
    public let failed: [DeviceSource]

    public init(
        attempted: [DeviceSource],
        synchronized: [SourceSyncReport],
        failed: [DeviceSource]
    ) {
        self.attempted = attempted
        self.synchronized = synchronized
        self.failed = failed
    }
}

public enum ServiceLifecycle: String, Codable, Sendable {
    case stopped
    case starting
    case running
    case reconnecting
    case stopping
    case failed
}

public enum LoginItemState: String, Codable, Sendable {
    case enabled
    case disabled
    case requiresApproval = "requires_approval"
    case notFound = "not_found"
    case unsupported
}

public struct SourceState: Codable, Equatable, Sendable, Identifiable {
    public var id: DeviceSource { source }
    public let source: DeviceSource
    public let enabled: Bool
    public let readiness: SourceReadiness
    public let reasonCode: String?
    public let readOnly: Bool

    public init(
        source: DeviceSource,
        enabled: Bool,
        readiness: SourceReadiness,
        reasonCode: String?,
        readOnly: Bool
    ) {
        self.source = source
        self.enabled = enabled
        self.readiness = readiness
        self.reasonCode = reasonCode
        self.readOnly = readOnly
    }
}

public struct DeviceConfiguration: Codable, Equatable, Sendable {
    public var enabledSources: Set<DeviceSource>
    public var apiBaseURL: URL?
    public var workspaceID: UUID?
    public var deviceID: UUID?
    public var sourceSyncSchedules: [SourceSyncSchedule]

    public init(
        enabledSources: Set<DeviceSource> = [],
        apiBaseURL: URL? = nil,
        workspaceID: UUID? = nil,
        deviceID: UUID? = nil,
        sourceSyncSchedules: [SourceSyncSchedule] = []
    ) {
        self.enabledSources = enabledSources
        self.apiBaseURL = apiBaseURL
        self.workspaceID = workspaceID
        self.deviceID = deviceID
        self.sourceSyncSchedules = sourceSyncSchedules
    }

    public func validate() throws {
        if let endpoint = apiBaseURL {
            guard endpoint.scheme == "https", endpoint.host != nil else {
                throw DeviceError.invalidConfiguration("API address must be an absolute HTTPS URL")
            }
            guard endpoint.user == nil, endpoint.password == nil,
                  endpoint.path == "/", endpoint.query == nil, endpoint.fragment == nil else {
                throw DeviceError.invalidConfiguration("API address must be an HTTPS origin without credentials")
            }
        }
        let enrollmentFields = [apiBaseURL != nil, workspaceID != nil, deviceID != nil]
        guard enrollmentFields.allSatisfy({ $0 }) || enrollmentFields.allSatisfy({ !$0 }) else {
            throw DeviceError.invalidConfiguration("enrollment configuration is incomplete")
        }
        guard Set(sourceSyncSchedules.map(\.source)).count == sourceSyncSchedules.count else {
            throw DeviceError.invalidConfiguration("background sync schedule contains duplicates")
        }
        guard sourceSyncSchedules.allSatisfy({ $0.consecutiveFailures <= 32 }) else {
            throw DeviceError.invalidConfiguration("background sync failure count is invalid")
        }
    }

    public var enrolled: Bool {
        apiBaseURL != nil && workspaceID != nil && deviceID != nil
    }

    public func schedule(for source: DeviceSource) -> SourceSyncSchedule? {
        sourceSyncSchedules.first { $0.source == source }
    }

    public mutating func replaceSchedule(_ schedule: SourceSyncSchedule) {
        sourceSyncSchedules.removeAll { $0.source == schedule.source }
        sourceSyncSchedules.append(schedule)
        sourceSyncSchedules.sort { $0.source.rawValue < $1.source.rawValue }
    }

    private enum CodingKeys: String, CodingKey {
        case enabledSources
        case apiBaseURL
        case workspaceID
        case deviceID
        case sourceSyncSchedules
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabledSources = try container.decodeIfPresent(Set<DeviceSource>.self, forKey: .enabledSources) ?? []
        apiBaseURL = try container.decodeIfPresent(URL.self, forKey: .apiBaseURL)
        workspaceID = try container.decodeIfPresent(UUID.self, forKey: .workspaceID)
        deviceID = try container.decodeIfPresent(UUID.self, forKey: .deviceID)
        sourceSyncSchedules = try container.decodeIfPresent(
            [SourceSyncSchedule].self,
            forKey: .sourceSyncSchedules
        ) ?? []
    }
}

private extension UInt8 {
    var saturatingSubtractingOne: UInt8 { self == 0 ? 0 : self - 1 }
}

public let botmemDeviceSetupProtocol = "botmem.device.setup.v1"

public struct DeviceSetupPayload: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let apiBaseURL: URL
    public let workspaceID: UUID
    public let code: String

    public init(protocolVersion: String, apiBaseURL: URL, workspaceID: UUID, code: String) {
        self.protocolVersion = protocolVersion
        self.apiBaseURL = apiBaseURL
        self.workspaceID = workspaceID
        self.code = code
    }

    public static func parse(_ value: String) throws -> DeviceSetupPayload {
        guard let data = value.data(using: .utf8), data.count <= 16_384 else {
            throw DeviceError.invalidConfiguration("setup payload is invalid")
        }
        let payload = try JSONDecoder().decode(DeviceSetupPayload.self, from: data)
        guard payload.protocolVersion == botmemDeviceSetupProtocol,
              payload.code.range(of: #"^BM2-[A-Za-z0-9_-]{24}$"#, options: .regularExpression) != nil else {
            throw DeviceError.invalidConfiguration("setup payload is invalid")
        }
        let configuration = DeviceConfiguration(
            apiBaseURL: payload.apiBaseURL,
            workspaceID: payload.workspaceID,
            deviceID: UUID()
        )
        try configuration.validate()
        return payload
    }
}

public struct DeviceSnapshot: Codable, Equatable, Sendable {
    public let sources: [SourceState]
    public let service: ServiceLifecycle
    public let loginItem: LoginItemState
    public let enrolled: Bool
    public let deviceKeyID: String?
    public let lastError: String?

    public init(
        sources: [SourceState],
        service: ServiceLifecycle,
        loginItem: LoginItemState,
        enrolled: Bool,
        deviceKeyID: String?,
        lastError: String?
    ) {
        self.sources = sources
        self.service = service
        self.loginItem = loginItem
        self.enrolled = enrolled
        self.deviceKeyID = deviceKeyID
        self.lastError = lastError
    }
}

public enum DeviceError: Error, Equatable, LocalizedError {
    case invalidConfiguration(String)
    case permissionRequired(DeviceSource)
    case sourceUnavailable(DeviceSource, SourceReadiness)
    case notEnrolled
    case serviceAlreadyRunning
    case serviceNotRunning
    case unsupported(String)
    case operationFailed(String)

    public var errorDescription: String? {
        switch self {
        case let .invalidConfiguration(message), let .unsupported(message), let .operationFailed(message):
            return message
        case let .permissionRequired(source):
            return "Full Disk Access is required for \(source.rawValue)."
        case let .sourceUnavailable(source, readiness):
            return "\(source.rawValue) is unavailable (\(readiness.rawValue))."
        case .notEnrolled:
            return "This Mac is not enrolled with the Botmem relay."
        case .serviceAlreadyRunning:
            return "The Botmem device service is already running."
        case .serviceNotRunning:
            return "The Botmem device service is not running."
        }
    }

    public var code: String {
        switch self {
        case .invalidConfiguration: return "invalid_configuration"
        case .permissionRequired: return "permission_required"
        case .sourceUnavailable: return "source_unavailable"
        case .notEnrolled: return "not_enrolled"
        case .serviceAlreadyRunning: return "service_already_running"
        case .serviceNotRunning: return "service_not_running"
        case .unsupported: return "unsupported"
        case .operationFailed: return "operation_failed"
        }
    }
}
