import BotmemCore
import Darwin
import Foundation

public final class ProcessTunnelManager: TunnelManagerPort {
    private static let permanentlyRevokedExitStatus: Int32 = 20
    private let lock = NSRecursiveLock()
    private let queue = DispatchQueue(label: "app.botmem.device.tunnel")
    private let executableURL: URL
    private let indexRoot: URL
    private let identity: DeviceIdentityPort
    private var process: Process?
    private var signer: AuthenticationSigningServer?
    private var retry: DispatchWorkItem?
    private var desiredLaunch: TunnelLaunch?
    private var retryCount = 0
    private var lifecycle: ServiceLifecycle = .stopped
    private var errorMessage: String?

    public init(executableURL: URL, indexRoot: URL, identity: DeviceIdentityPort) {
        self.executableURL = executableURL
        self.indexRoot = indexRoot
        self.identity = identity
    }

    public var state: ServiceLifecycle { lock.withLock { lifecycle } }
    public var lastError: String? { lock.withLock { errorMessage } }

    public func start(_ launch: TunnelLaunch) throws {
        try lock.withLock {
            guard lifecycle == .stopped || lifecycle == .failed else {
                throw DeviceError.serviceAlreadyRunning
            }
            guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
                throw DeviceError.invalidConfiguration("bundled botmem-tunnel helper is missing")
            }
            desiredLaunch = launch
            retryCount = 0
            errorMessage = nil
            lifecycle = .starting
            try launchProcess(launch)
        }
    }

    public func stop() throws {
        lock.withLock {
            guard lifecycle != .stopped else { return }
            lifecycle = .stopping
            desiredLaunch = nil
            retry?.cancel()
            retry = nil
            signer?.stop()
            signer = nil
            guard let process else {
                lifecycle = .stopped
                return
            }
            process.terminationHandler = nil
            if process.isRunning { process.terminate() }
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning, Date() < deadline { usleep(20_000) }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            self.process = nil
            lifecycle = .stopped
        }
    }

    private func launchProcess(_ launch: TunnelLaunch) throws {
        // Darwin limits Unix-domain socket paths to roughly 104 bytes. Keep the
        // private same-user endpoint under a short, mode-0700 runtime directory
        // instead of deriving it from an arbitrarily long Application Support path.
        let signingRoot = URL(
            fileURLWithPath: "/tmp/botmem-signing-\(geteuid())",
            isDirectory: true
        )
        let signingSocket = signingRoot.appendingPathComponent("\(UUID().uuidString).sock")
        let signingServer = AuthenticationSigningServer(
            socketURL: signingSocket,
            identity: identity,
            launch: launch
        )
        try signingServer.start()

        let configuration = TunnelRuntimeConfiguration(
            apiBaseURL: launch.apiBaseURL,
            workspaceID: launch.workspaceID,
            deviceID: launch.deviceID,
            keyID: launch.keyID,
            connectors: launch.connectors,
            indexRoot: indexRoot.path,
            signingSocket: signingSocket.path
        )
        let inputData = try JSONEncoder().encode(configuration)
        guard inputData.count <= 65_536 else {
            signingServer.stop()
            throw DeviceError.invalidConfiguration("tunnel configuration exceeds 64 KiB")
        }

        let child = Process()
        let input = Pipe()
        child.executableURL = executableURL
        child.arguments = []
        child.environment = [
            "HOME": NSHomeDirectory(),
            "LANG": "en_US.UTF-8",
            "PATH": "/usr/bin:/bin",
        ]
        child.standardInput = input
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self, weak child] process in
            guard child === process else { return }
            self?.handleExit(process.terminationStatus)
        }
        do {
            try child.run()
            signer = signingServer
            process = child
            lifecycle = .running
            input.fileHandleForWriting.write(inputData)
            try input.fileHandleForWriting.close()
        } catch {
            signingServer.stop()
            lifecycle = .failed
            errorMessage = "tunnel_launch_failed"
            throw error
        }
    }

    private func handleExit(_ status: Int32) {
        lock.withLock {
            process = nil
            signer?.stop()
            signer = nil
            if status == Self.permanentlyRevokedExitStatus {
                desiredLaunch = nil
                retry?.cancel()
                retry = nil
                retryCount = 0
                lifecycle = .stopped
                errorMessage = "tunnel_revoked"
                return
            }
            guard let launch = desiredLaunch else {
                lifecycle = .stopped
                return
            }
            retryCount += 1
            lifecycle = .reconnecting
            errorMessage = "tunnel_exited_\(status)"
            let delay = min(pow(2, Double(retryCount - 1)), 30)
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.lock.withLock {
                    guard self.desiredLaunch != nil, self.process == nil else { return }
                    do {
                        self.lifecycle = .starting
                        try self.launchProcess(launch)
                    } catch {
                        self.lifecycle = .failed
                        self.errorMessage = "tunnel_launch_failed"
                        self.handleExit(-1)
                    }
                }
            }
            retry = work
            queue.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }
}

private struct TunnelRuntimeConfiguration: Encodable {
    let protocolVersion = "botmem.tunnel.config.v1"
    let apiBaseURL: URL
    let workspaceID: UUID
    let deviceID: UUID
    let keyID: String
    let clientVersion = "botmem-tunnel/0.1.0"
    let connectors: [DeviceSource]
    let indexRoot: String
    let signingSocket: String

    enum CodingKeys: String, CodingKey {
        case protocolVersion
        case apiBaseURL = "apiBaseUrl"
        case workspaceID = "workspaceId"
        case deviceID = "deviceId"
        case keyID = "keyId"
        case clientVersion
        case connectors
        case indexRoot
        case signingSocket
    }
}

private final class AuthenticationSigningServer {
    static let maximumFrameBytes = 16_384

    private let socketURL: URL
    private let identity: DeviceIdentityPort
    private let launch: TunnelLaunch
    private let queue = DispatchQueue(label: "app.botmem.device.signing")
    private var listener: Int32 = -1
    private var source: DispatchSourceRead?

    init(socketURL: URL, identity: DeviceIdentityPort, launch: TunnelLaunch) {
        self.socketURL = socketURL
        self.identity = identity
        self.launch = launch
    }

    func start() throws {
        let directory = socketURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == geteuid(),
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700 else {
            throw DeviceError.invalidConfiguration("signing directory is not private")
        }
        unlink(socketURL.path)
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw signingPOSIX("socket") }
        do {
            var address = try signingAddress(socketURL.path)
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard bound == 0 else { throw signingPOSIX("bind") }
            guard chmod(socketURL.path, S_IRUSR | S_IWUSR) == 0 else {
                throw signingPOSIX("chmod")
            }
            guard Darwin.listen(descriptor, 8) == 0 else { throw signingPOSIX("listen") }
            let flags = fcntl(descriptor, F_GETFL)
            guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
                throw signingPOSIX("fcntl")
            }
        } catch {
            Darwin.close(descriptor)
            unlink(socketURL.path)
            throw error
        }
        listener = descriptor
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptClients() }
        source.resume()
        self.source = source
    }

    func stop() {
        source?.cancel()
        source = nil
        if listener >= 0 {
            Darwin.close(listener)
            listener = -1
        }
        unlink(socketURL.path)
    }

    private func acceptClients() {
        while listener >= 0 {
            let client = Darwin.accept(listener, nil, nil)
            if client < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { return }
                return
            }
            defer { Darwin.close(client) }
            var peerUser: uid_t = 0
            var peerGroup: gid_t = 0
            guard getpeereid(client, &peerUser, &peerGroup) == 0,
                  peerUser == geteuid() else { continue }
            configureSigningTimeout(client)
            handle(client)
        }
    }

    private func handle(_ client: Int32) {
        let response: SigningResponse
        do {
            let data = try readSigningFrame(client)
            let object = try JSONSerialization.jsonObject(with: data)
            guard let dictionary = object as? [String: Any],
                  Set(dictionary.keys) == Set([
                    "protocolVersion", "operation", "deviceId", "keyId",
                    "clientNonce", "serverNonce",
                  ]) else { throw DeviceError.invalidConfiguration("invalid signing request") }
            let request = try JSONDecoder().decode(SigningRequest.self, from: data)
            guard request.protocolVersion == "botmem.signing.ipc.v1",
                  request.operation == "signAuthentication",
                  request.deviceID == launch.deviceID,
                  request.keyID == launch.keyID else {
                throw DeviceError.invalidConfiguration("signing request identity mismatch")
            }
            let signature = try identity.signAuthentication(
                deviceID: request.deviceID,
                keyID: request.keyID,
                clientNonce: request.clientNonce,
                serverNonce: request.serverNonce
            )
            response = SigningResponse(
                ok: true,
                signatureBase64URL: signature.base64URLEncodedString(),
                errorCode: nil
            )
        } catch {
            response = SigningResponse(ok: false, signatureBase64URL: nil, errorCode: "signing_rejected")
        }
        guard var data = try? JSONEncoder().encode(response) else { return }
        data.append(0x0a)
        try? writeSigningFrame(client, data)
    }
}

private struct SigningRequest: Decodable {
    let protocolVersion: String
    let operation: String
    let deviceID: UUID
    let keyID: String
    let clientNonce: String
    let serverNonce: String

    enum CodingKeys: String, CodingKey {
        case protocolVersion
        case operation
        case deviceID = "deviceId"
        case keyID = "keyId"
        case clientNonce
        case serverNonce
    }
}

private struct SigningResponse: Encodable {
    let protocolVersion = "botmem.signing.ipc.v1"
    let ok: Bool
    let signatureBase64URL: String?
    let errorCode: String?

    enum CodingKeys: String, CodingKey {
        case protocolVersion
        case ok
        case signatureBase64URL = "signatureBase64Url"
        case errorCode
    }
}

private func signingAddress(_ path: String) throws -> sockaddr_un {
    let bytes = Array(path.utf8CString)
    var address = sockaddr_un()
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw DeviceError.invalidConfiguration("signing socket path is too long")
    }
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        destination.initializeMemory(as: UInt8.self, repeating: 0)
        bytes.withUnsafeBytes { destination.copyBytes(from: $0) }
    }
    return address
}

private func configureSigningTimeout(_ descriptor: Int32) {
    var timeout = timeval(tv_sec: 3, tv_usec: 0)
    let size = socklen_t(MemoryLayout.size(ofValue: timeout))
    withUnsafePointer(to: &timeout) {
        _ = setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, $0, size)
        _ = setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, $0, size)
    }
}

private func readSigningFrame(_ descriptor: Int32) throws -> Data {
    var result = Data()
    var byte: UInt8 = 0
    while result.count <= AuthenticationSigningServer.maximumFrameBytes {
        let count = Darwin.read(descriptor, &byte, 1)
        if count == 0 { break }
        guard count == 1 else { throw signingPOSIX("read") }
        if byte == 0x0a { return result }
        result.append(byte)
    }
    throw DeviceError.invalidConfiguration("signing frame is invalid")
}

private func writeSigningFrame(_ descriptor: Int32, _ data: Data) throws {
    var offset = 0
    try data.withUnsafeBytes { bytes in
        guard let base = bytes.baseAddress else { return }
        while offset < bytes.count {
            let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw signingPOSIX("write") }
            offset += count
        }
    }
}

private func signingPOSIX(_ operation: String) -> DeviceError {
    .operationFailed("\(operation) failed with errno \(errno)")
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private extension NSRecursiveLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
