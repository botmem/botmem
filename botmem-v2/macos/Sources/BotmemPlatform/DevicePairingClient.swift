import BotmemCore
import Foundation

public final class URLSessionDevicePairingClient: DevicePairingPort {
    private let session: URLSession
    private let timeout: TimeInterval

    public init(session: URLSession? = nil, timeout: TimeInterval = 15) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.urlCredentialStorage = nil
            self.session = URLSession(configuration: configuration)
        }
        self.timeout = timeout
    }

    public func redeem(
        setup: DeviceSetupPayload,
        deviceID: UUID,
        displayName: String,
        keyID: String,
        publicKeyBase64URL: String,
        connectors: [DeviceSource]
    ) throws {
        let endpoint = setup.apiBaseURL
            .appendingPathComponent("v2/workspaces")
            .appendingPathComponent(setup.workspaceID.uuidString.lowercased())
            .appendingPathComponent("devices/pair")
        var request = URLRequest(url: endpoint, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.httpBody = try JSONEncoder().encode(PairingRequest(
            code: setup.code,
            deviceID: deviceID,
            displayName: displayName,
            keyID: keyID,
            publicKeyBase64URL: publicKeyBase64URL,
            connectors: connectors
        ))

        let semaphore = DispatchSemaphore(value: 0)
        let box = PairingResponseBox()
        let task = session.dataTask(with: request) { data, response, error in
            box.store(data: data, response: response, error: error)
            semaphore.signal()
        }
        task.resume()
        guard semaphore.wait(timeout: .now() + timeout + 1) == .success else {
            task.cancel()
            throw DeviceError.operationFailed("pairing request timed out")
        }
        let result = box.load()
        if let error = result.error {
            throw DeviceError.operationFailed(error.localizedDescription)
        }
        guard let response = result.response as? HTTPURLResponse,
              response.statusCode == 201,
              let data = result.data,
              let body = try? JSONDecoder().decode(PairingResponse.self, from: data),
              body.deviceID == deviceID,
              body.state == "paired" else {
            throw DeviceError.operationFailed("pairing code was rejected")
        }
    }
}

private struct PairingRequest: Encodable {
    let code: String
    let deviceID: UUID
    let displayName: String
    let keyID: String
    let publicKeyBase64URL: String
    let connectors: [DeviceSource]

    enum CodingKeys: String, CodingKey {
        case code
        case deviceID = "deviceId"
        case displayName
        case keyID = "keyId"
        case publicKeyBase64URL = "publicKeyBase64Url"
        case connectors
    }
}

private struct PairingResponse: Decodable {
    let deviceID: UUID
    let state: String

    enum CodingKeys: String, CodingKey {
        case deviceID = "deviceId"
        case state
    }
}

private final class PairingResponseBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: (Data?, URLResponse?, Error?) = (nil, nil, nil)

    func store(data: Data?, response: URLResponse?, error: Error?) {
        lock.lock()
        value = (data, response, error)
        lock.unlock()
    }

    func load() -> (data: Data?, response: URLResponse?, error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
