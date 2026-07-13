import AppKit
import BotmemCore
import Foundation
import ServiceManagement

public final class MacLoginItemManager: LoginItemManagerPort {
    private let service: SMAppService

    public init(service: SMAppService = .mainApp) {
        self.service = service
    }

    public func status() -> LoginItemState {
        switch service.status {
        case .enabled: return .enabled
        case .notRegistered: return .disabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        @unknown default: return .unsupported
        }
    }

    public func setEnabled(_ enabled: Bool) throws {
        if enabled {
            if service.status != .enabled { try service.register() }
        } else if service.status != .notRegistered {
            try service.unregister()
        }
    }
}

public final class FullDiskAccessSettings: PermissionSettingsPort {
    public init() {}

    public func openFullDiskAccess() throws {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"),
              NSWorkspace.shared.open(url) else {
            throw DeviceError.operationFailed("System Settings could not open Full Disk Access")
        }
    }
}
