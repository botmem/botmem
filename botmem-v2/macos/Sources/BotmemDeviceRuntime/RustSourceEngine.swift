import BotmemCore
import CBotmemDeviceFFI
import Foundation

public final class RustSourceEngine: SourceEnginePort {
    private let storeRoot: URL
    private let decoder = JSONDecoder()

    public init(storeRoot: URL) {
        self.storeRoot = storeRoot
    }

    public var version: String {
        String(cString: botmem_device_ffi_version())
    }

    public func probe(_ source: DeviceSource) throws -> SourceProbe {
        try invoke(source.rawValue) { sourcePointer in
            botmem_device_probe(sourcePointer)
        }
    }

    public func synchronize(_ source: DeviceSource, reconcile: Bool) throws -> SourceSyncReport {
        try source.rawValue.withCString { sourcePointer in
            try storeRoot.path.withCString { rootPointer in
                try decode(botmem_device_sync(sourcePointer, rootPointer, reconcile))
            }
        }
    }

    private func invoke<T: Decodable>(
        _ string: String,
        operation: (UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
    ) throws -> T {
        try string.withCString { pointer in
            try decode(operation(pointer))
        }
    }

    private func decode<T: Decodable>(_ pointer: UnsafeMutablePointer<CChar>?) throws -> T {
        guard let pointer else {
            throw DeviceError.operationFailed("device core returned an empty response")
        }
        defer { botmem_device_string_free(pointer) }
        let data = Data(String(cString: pointer).utf8)
        let envelope = try decoder.decode(FFIEnvelope<T>.self, from: data)
        if let value = envelope.value, envelope.ok {
            return value
        }
        throw DeviceError.operationFailed(envelope.error ?? "device core operation failed")
    }
}

private struct FFIEnvelope<Value: Decodable>: Decodable {
    let ok: Bool
    let value: Value?
    let error: String?
}
