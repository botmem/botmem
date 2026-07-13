import BotmemCore
import CryptoKit
import Foundation
import Security

public final class KeychainCredentialStore: CredentialStorePort {
    private let service: String

    public init(service: String = "app.botmem.device.v2") {
        self.service = service
    }

    public func read(account: String) throws -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError(status)
        }
        return data
    }

    public func replace(_ value: Data, account: String) throws {
        guard !value.isEmpty else { throw DeviceError.invalidConfiguration("credential is empty") }
        let query = baseQuery(account: account)
        let update = [
            kSecValueData as String: value,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ] as CFDictionary
        let status = SecItemUpdate(query as CFDictionary, update)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = value
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(addStatus) }
        } else if status != errSecSuccess {
            throw KeychainError(status)
        }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }
}

public final class KeychainDeviceIdentity: DeviceIdentityPort {
    private let store: KeychainCredentialStore
    private let account: String

    public init(
        service: String = "app.botmem.device.v2.identity",
        account: String = "ed25519-private-key"
    ) {
        self.store = KeychainCredentialStore(service: service)
        self.account = account
    }

    public func currentKeyID() throws -> String? {
        guard let key = try privateKey() else { return nil }
        return keyID(key.publicKey.rawRepresentation)
    }

    public func currentPublicKeyBase64URL() throws -> String? {
        try privateKey()?.publicKey.rawRepresentation.base64URLEncodedString()
    }

    @discardableResult
    public func createIfMissing() throws -> String {
        if let existing = try privateKey() { return keyID(existing.publicKey.rawRepresentation) }
        return try create()
    }

    public func signAuthentication(
        deviceID: UUID,
        keyID: String,
        clientNonce: String,
        serverNonce: String
    ) throws -> Data {
        guard let key = try privateKey() else { throw IdentityError.missing }
        guard keyID == self.keyID(key.publicKey.rawRepresentation),
              clientNonce.utf8.count >= 16, clientNonce.utf8.count <= 512,
              serverNonce.utf8.count >= 16, serverNonce.utf8.count <= 512 else {
            throw IdentityError.signatureFailed
        }
        let message = "botmem.device.v2\n\(deviceID.uuidString.lowercased())\n\(keyID)\n\(clientNonce)\n\(serverNonce)"
        return try key.signature(for: Data(message.utf8))
    }

    public func delete() throws {
        try store.delete(account: account)
    }

    private func create() throws -> String {
        let key = Curve25519.Signing.PrivateKey()
        try store.replace(key.rawRepresentation, account: account)
        return keyID(key.publicKey.rawRepresentation)
    }

    private func privateKey() throws -> Curve25519.Signing.PrivateKey? {
        guard let bytes = try store.read(account: account) else { return nil }
        guard bytes.count == 32 else { throw IdentityError.creationFailed }
        return try Curve25519.Signing.PrivateKey(rawRepresentation: bytes)
    }

    private func keyID(_ bytes: Data) -> String {
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

public struct KeychainError: Error, LocalizedError {
    public let status: OSStatus

    public init(_ status: OSStatus) { self.status = status }

    public var errorDescription: String? {
        (SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)"
    }
}

public enum IdentityError: Error {
    case missing
    case creationFailed
    case publicKeyUnavailable
    case signatureFailed
}
