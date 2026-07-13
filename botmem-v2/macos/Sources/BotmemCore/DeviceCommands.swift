import Foundation

public let botmemMacIPCProtocol = "botmem.macos.ipc.v1"

public enum DeviceCommandKind: String, Codable, Sendable {
    case status
    case setSource = "set_source"
    case preflightSource = "preflight_source"
    case syncSource = "sync_source"
    case enroll
    case deleteEnrollment = "delete_enrollment"
    case eraseLocalData = "erase_local_data"
    case start
    case stop
    case setLaunchAtLogin = "set_launch_at_login"
    case openFullDiskAccess = "open_full_disk_access"
    case quit
}

public struct DeviceCommand: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let kind: DeviceCommandKind
    public let source: DeviceSource?
    public let enabled: Bool?
    public let reconcile: Bool?
    public let setupPayload: String?
    public let displayName: String?

    public init(
        kind: DeviceCommandKind,
        source: DeviceSource? = nil,
        enabled: Bool? = nil,
        reconcile: Bool? = nil,
        setupPayload: String? = nil,
        displayName: String? = nil
    ) {
        self.protocolVersion = botmemMacIPCProtocol
        self.kind = kind
        self.source = source
        self.enabled = enabled
        self.reconcile = reconcile
        self.setupPayload = setupPayload
        self.displayName = displayName
    }
}

public struct DeviceCommandResponse: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let ok: Bool
    public let snapshot: DeviceSnapshot?
    public let source: SourceState?
    public let sync: SourceSyncReport?
    public let value: String?
    public let errorCode: String?
    public let error: String?

    public init(
        ok: Bool,
        snapshot: DeviceSnapshot? = nil,
        source: SourceState? = nil,
        sync: SourceSyncReport? = nil,
        value: String? = nil,
        errorCode: String? = nil,
        error: String? = nil
    ) {
        self.protocolVersion = botmemMacIPCProtocol
        self.ok = ok
        self.snapshot = snapshot
        self.source = source
        self.sync = sync
        self.value = value
        self.errorCode = errorCode
        self.error = error
    }
}

public final class DeviceCommandRouter {
    private let service: DeviceControlService
    private let quit: () -> Void

    public init(service: DeviceControlService, quit: @escaping () -> Void = {}) {
        self.service = service
        self.quit = quit
    }

    public func handle(_ command: DeviceCommand) -> DeviceCommandResponse {
        guard command.protocolVersion == botmemMacIPCProtocol else {
            return .init(
                ok: false,
                errorCode: "unsupported_protocol",
                error: "unsupported local IPC protocol"
            )
        }
        do {
            switch command.kind {
            case .status:
                return .init(ok: true, snapshot: try service.snapshot())
            case .setSource:
                guard let source = command.source, let enabled = command.enabled else {
                    return invalid("set_source requires source and enabled")
                }
                return .init(ok: true, source: try service.setSource(source, enabled: enabled))
            case .preflightSource:
                guard let source = command.source else {
                    return invalid("preflight_source requires source")
                }
                return .init(ok: true, source: try service.preflight(source))
            case .syncSource:
                guard let source = command.source else {
                    return invalid("sync_source requires source")
                }
                return .init(ok: true, sync: try service.synchronize(
                    source,
                    reconcile: command.reconcile ?? false
                ))
            case .enroll:
                guard let setup = command.setupPayload,
                      let displayName = command.displayName else {
                    return invalid("enroll requires setupPayload and displayName")
                }
                try service.enroll(setupPayload: setup, displayName: displayName)
            case .deleteEnrollment:
                try service.deleteEnrollment()
            case .eraseLocalData:
                try service.eraseLocalData()
            case .start:
                try service.start()
            case .stop:
                try service.stop()
            case .setLaunchAtLogin:
                guard let enabled = command.enabled else {
                    return invalid("set_launch_at_login requires enabled")
                }
                try service.setLaunchAtLogin(enabled)
            case .openFullDiskAccess:
                try service.openFullDiskAccessSettings()
            case .quit:
                try? service.stop()
                quit()
            }
            return .init(ok: true, snapshot: try service.snapshot())
        } catch let error as DeviceError {
            return .init(
                ok: false,
                errorCode: error.code,
                error: error.localizedDescription
            )
        } catch {
            return .init(ok: false, errorCode: "operation_failed", error: error.localizedDescription)
        }
    }

    private func invalid(_ message: String) -> DeviceCommandResponse {
        .init(ok: false, errorCode: "invalid_command", error: message)
    }
}
