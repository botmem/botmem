import BotmemCore
import Darwin
import Foundation

public enum BotmemPaths {
    public static func defaultSocketURL() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return base
            .appendingPathComponent("Botmem", isDirectory: true)
            .appendingPathComponent("device.sock")
    }
}

public enum LocalIPCError: Error, LocalizedError {
    case invalidPath
    case socket(String)
    case responseTooLarge
    case disconnected

    public var errorDescription: String? {
        switch self {
        case .invalidPath: return "the IPC socket path is invalid or too long"
        case let .socket(message): return message
        case .responseTooLarge: return "the IPC frame exceeds one MiB"
        case .disconnected: return "the Botmem app is not accepting local commands"
        }
    }
}

public final class LocalIPCServer {
    public static let maximumFrameBytes = 1_048_576

    private let socketURL: URL
    private let router: DeviceCommandRouter
    private let queue = DispatchQueue(label: "app.botmem.device.ipc")
    private var listener: Int32 = -1
    private var source: DispatchSourceRead?

    public init(socketURL: URL, router: DeviceCommandRouter) {
        self.socketURL = socketURL
        self.router = router
    }

    public func start() throws {
        guard listener == -1 else { return }
        let directory = socketURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        if FileManager.default.fileExists(atPath: socketURL.path), socketIsLive(socketURL.path) {
            throw LocalIPCError.socket("another Botmem app already owns the local IPC socket")
        }
        unlink(socketURL.path)

        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw posix("socket") }
        do {
            var address = try unixAddress(socketURL.path)
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard result == 0 else { throw posix("bind") }
            guard chmod(socketURL.path, S_IRUSR | S_IWUSR) == 0 else { throw posix("chmod") }
            guard Darwin.listen(descriptor, 16) == 0 else { throw posix("listen") }
            let flags = fcntl(descriptor, F_GETFL)
            guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
                throw posix("fcntl")
            }
        } catch {
            Darwin.close(descriptor)
            unlink(socketURL.path)
            throw error
        }

        listener = descriptor
        let dispatchSource = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        dispatchSource.setEventHandler { [weak self] in self?.acceptReadyClients() }
        dispatchSource.resume()
        source = dispatchSource
    }

    public func stop() {
        source?.cancel()
        source = nil
        if listener >= 0 {
            Darwin.close(listener)
            listener = -1
        }
        unlink(socketURL.path)
    }

    deinit { stop() }

    private func acceptReadyClients() {
        while listener >= 0 {
            let client = Darwin.accept(listener, nil, nil)
            if client < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { return }
                return
            }
            var peerUser: uid_t = 0
            var peerGroup: gid_t = 0
            guard getpeereid(client, &peerUser, &peerGroup) == 0, peerUser == geteuid() else {
                Darwin.close(client)
                continue
            }
            let flags = fcntl(client, F_GETFL)
            if flags >= 0 { _ = fcntl(client, F_SETFL, flags & ~O_NONBLOCK) }
            configureTimeout(client)
            handle(client)
            Darwin.close(client)
        }
    }

    private func handle(_ client: Int32) {
        let response: DeviceCommandResponse
        do {
            let data = try readFrame(client)
            let command = try JSONDecoder().decode(DeviceCommand.self, from: data)
            response = router.handle(command)
        } catch LocalIPCError.disconnected {
            return
        } catch {
            response = .init(ok: false, errorCode: "invalid_ipc_frame", error: error.localizedDescription)
        }
        do {
            var data = try JSONEncoder().encode(response)
            data.append(0x0a)
            try writeAll(client, data)
        } catch {
            // The client may have disconnected; no user data is logged here.
        }
    }
}

public final class LocalIPCClient {
    private let socketURL: URL

    public init(socketURL: URL) { self.socketURL = socketURL }

    public func send(_ command: DeviceCommand) throws -> DeviceCommandResponse {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw posix("socket") }
        defer { Darwin.close(descriptor) }
        configureTimeout(descriptor)
        var address = try unixAddress(socketURL.path)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { throw LocalIPCError.disconnected }
        var request = try JSONEncoder().encode(command)
        request.append(0x0a)
        try writeAll(descriptor, request)
        Darwin.shutdown(descriptor, SHUT_WR)
        let data = try readFrame(descriptor)
        return try JSONDecoder().decode(DeviceCommandResponse.self, from: data)
    }
}

private func unixAddress(_ path: String) throws -> sockaddr_un {
    let bytes = Array(path.utf8CString)
    var address = sockaddr_un()
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard bytes.count <= capacity else { throw LocalIPCError.invalidPath }
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
        buffer.initializeMemory(as: UInt8.self, repeating: 0)
        bytes.withUnsafeBytes { source in
            buffer.copyBytes(from: source)
        }
    }
    return address
}

private func socketIsLive(_ path: String) -> Bool {
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return true }
    defer { Darwin.close(descriptor) }
    guard var address = try? unixAddress(path) else { return true }
    return withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
        }
    }
}

private func configureTimeout(_ descriptor: Int32) {
    var timeout = timeval(tv_sec: 3, tv_usec: 0)
    var noSigPipe: Int32 = 1
    withUnsafePointer(to: &timeout) { pointer in
        _ = setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, pointer, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, pointer, socklen_t(MemoryLayout<timeval>.size))
    }
    withUnsafePointer(to: &noSigPipe) { pointer in
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, pointer, socklen_t(MemoryLayout<Int32>.size))
    }
}

private func readFrame(_ descriptor: Int32) throws -> Data {
    var output = Data()
    var buffer = [UInt8](repeating: 0, count: 8_192)
    while output.count <= LocalIPCServer.maximumFrameBytes {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count == 0 { break }
        if count < 0 {
            if errno == EINTR { continue }
            throw posix("read")
        }
        if let newline = buffer[..<count].firstIndex(of: 0x0a) {
            output.append(contentsOf: buffer[..<newline])
            return output
        }
        output.append(contentsOf: buffer[..<count])
    }
    guard output.count <= LocalIPCServer.maximumFrameBytes else { throw LocalIPCError.responseTooLarge }
    guard !output.isEmpty else { throw LocalIPCError.disconnected }
    return output
}

private func writeAll(_ descriptor: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { bytes in
        guard let base = bytes.baseAddress else { return }
        var sent = 0
        while sent < bytes.count {
            let count = Darwin.write(descriptor, base.advanced(by: sent), bytes.count - sent)
            if count < 0 {
                if errno == EINTR { continue }
                throw posix("write")
            }
            sent += count
        }
    }
}

private func posix(_ operation: String) -> LocalIPCError {
    LocalIPCError.socket("\(operation) failed: \(String(cString: strerror(errno)))")
}
