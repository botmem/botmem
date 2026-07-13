import BotmemCore
import Foundation

public final class FileConfigurationStore: ConfigurationStorePort {
    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()
    private let lock = NSLock()

    public init(fileURL: URL) {
        self.fileURL = fileURL
        self.encoder = JSONEncoder()
        self.encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }

    public func load() throws -> DeviceConfiguration {
        try lock.withLock {
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                return DeviceConfiguration()
            }
            let data = try Data(contentsOf: fileURL, options: [.mappedIfSafe])
            let value = try decoder.decode(DeviceConfiguration.self, from: data)
            try value.validate()
            return value
        }
    }

    public func save(_ configuration: DeviceConfiguration) throws {
        try lock.withLock {
            try configuration.validate()
            let directory = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: directory.path
            )
            let data = try encoder.encode(configuration)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: fileURL.path
            )
        }
    }

    public func delete() throws {
        try lock.withLock {
            guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
            try FileManager.default.removeItem(at: fileURL)
        }
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
