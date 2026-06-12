import Contacts
import CryptoKit
import Foundation
import SQLite3

struct NativeBridgeConfig: Codable {
  var server: String
  var token: String
  var accountId: String
  var sources: String
}

private struct NativeRpcRequest: Decodable {
  let jsonrpc: String
  let id: Int
  let method: String
  let params: [String: JSONValue]?
}

private enum JSONValue: Codable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  var intValue: Int? {
    if case .number(let value) = self { return Int(value) }
    return nil
  }
}

private let nativeMessagesPath = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Messages/chat.db")
  .path

func nativeMessagesReadable() -> Bool {
  do {
    let db = try NativeMessagesDatabase(path: nativeMessagesPath)
    defer { db.close() }
    _ = try db.chatCount()
    return true
  } catch {
    bridgeLog("native messages preflight failed: \(error.localizedDescription)")
    return false
  }
}

func runNativeBridgeHelperIfRequested() -> Bool {
  let args = CommandLine.arguments
  guard args.contains("--helper") else { return false }
  let configPath = valueAfter("--config", in: args)
  guard let configPath else {
    fputs("Missing --config\n", stderr)
    exit(1)
  }
  do {
    let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
    let config = try JSONDecoder().decode(NativeBridgeConfig.self, from: data)
    if config.sources.contains("imessages") || config.sources.contains("messages") {
      guard nativeMessagesReadable() else {
        fputs("Cannot read Messages database. Enable Full Disk Access for botmem.\n", stderr)
        exit(1)
      }
    }
    NativeAppleTunnel(config: config).runForever()
  } catch {
    fputs("botmem helper failed: \(error.localizedDescription)\n", stderr)
    exit(1)
  }
  return true
}

private func valueAfter(_ name: String, in args: [String]) -> String? {
  guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else {
    return nil
  }
  return args[index + 1]
}

private final class NativeAppleTunnel: NSObject, URLSessionWebSocketDelegate {
  private let config: NativeBridgeConfig
  private var db: NativeMessagesDatabase?
  private var webSocket: URLSessionWebSocketTask?
  private var sessionKey: SymmetricKey?
  private var privateKey: Curve25519.KeyAgreement.PrivateKey?

  init(config: NativeBridgeConfig) {
    self.config = config
    super.init()
  }

  func runForever() {
    connect()
    RunLoop.main.run()
  }

  private func connect() {
    guard let url = URL(string: config.server) else {
      log("Invalid server URL: \(config.server)")
      retry()
      return
    }
    log("Connecting to \(config.server)")
    let session = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue())
    let task = session.webSocketTask(with: url)
    webSocket = task
    task.resume()
    authenticate()
    receiveLoop()
  }

  private func authenticate() {
    let privateKey = Curve25519.KeyAgreement.PrivateKey()
    self.privateKey = privateKey
    let auth: [String: Any] = [
      "event": "auth",
      "data": [
        "token": config.token,
        "publicKey": privateKey.publicKey.rawRepresentation.base64EncodedString(),
        "sources": config.sources,
        "protocolVersion": 2,
      ],
    ]
    sendText(jsonString(auth))
  }

  private func receiveLoop() {
    webSocket?.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let message):
        self.handle(message)
        self.receiveLoop()
      case .failure(let error):
        self.log("WebSocket receive failed: \(error.localizedDescription)")
        self.retry()
      }
    }
  }

  private func handle(_ message: URLSessionWebSocketTask.Message) {
    switch message {
    case .string(let text):
      handleAuth(text)
    case .data(let data):
      handleEncrypted(data)
    @unknown default:
      break
    }
  }

  private func handleAuth(_ text: String) {
    guard
      let raw = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
      let event = raw["event"] as? String,
      event == "auth",
      let data = raw["data"] as? [String: Any],
      let ok = data["ok"] as? Bool
    else {
      log("Invalid auth response")
      return
    }
    guard ok else {
      log("Auth failed: \((data["reason"] as? String) ?? "unknown")")
      exit(1)
    }
    guard
      let publicKeyB64 = data["publicKey"] as? String,
      let publicKeyData = Data(base64Encoded: publicKeyB64),
      let privateKey
    else {
      log("Auth response missing public key")
      exit(1)
    }
    do {
      let serverKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKeyData)
      let secret = try privateKey.sharedSecretFromKeyAgreement(with: serverKey)
      sessionKey = secret.hkdfDerivedSymmetricKey(
        using: SHA256.self,
        salt: Data("botmem-apple-tunnel-v1".utf8),
        sharedInfo: Data("aes-256-gcm-session-key".utf8),
        outputByteCount: 32
      )
      log("Tunnel connected")
    } catch {
      log("Key exchange failed: \(error.localizedDescription)")
      exit(1)
    }
  }

  private func handleEncrypted(_ payload: Data) {
    guard let sessionKey else { return }
    do {
      let box = try AES.GCM.SealedBox(combined: payload)
      let decrypted = try AES.GCM.open(box, using: sessionKey)
      let request = try JSONDecoder().decode(NativeRpcRequest.self, from: decrypted)
      let response = handleRpc(request)
      let responseData = Data(jsonString(response).utf8)
      let sealed = try AES.GCM.seal(responseData, using: sessionKey).combined!
      webSocket?.send(.data(sealed)) { [weak self] error in
        if let error { self?.log("WebSocket send failed: \(error.localizedDescription)") }
      }
    } catch {
      log("Encrypted message failed: \(error.localizedDescription)")
    }
  }

  private func handleRpc(_ request: NativeRpcRequest) -> [String: Any] {
    do {
      switch request.method {
      case "chats.list":
        let limit = request.params?["limit"]?.intValue
        let chats = try messagesDb().chatsList(limit: limit)
        return ok(request.id, ["chats": chats])
      case "messages.history":
        guard let chatId = request.params?["chat_id"]?.intValue else {
          return err(request.id, -32602, "Missing required param: chat_id")
        }
        let start = request.params?["start"]?.stringValue
        let end = request.params?["end"]?.stringValue
        let limit = request.params?["limit"]?.intValue
        let messages = try messagesDb().messagesHistory(chatId: chatId, start: start, end: end, limit: limit)
        return ok(request.id, ["messages": messages])
      case "contacts.list":
        return ok(request.id, ["contacts": nativeContactsList()])
      case "ping":
        return ok(request.id, ["pong": true, "ts": Int(Date().timeIntervalSince1970 * 1000)])
      default:
        return err(request.id, -32601, "Method not found: \(request.method)")
      }
    } catch {
      return err(request.id, -32000, error.localizedDescription)
    }
  }

  private func messagesDb() throws -> NativeMessagesDatabase {
    if let db { return db }
    let next = try NativeMessagesDatabase(path: nativeMessagesPath)
    db = next
    return next
  }

  private func ok(_ id: Int, _ result: [String: Any]) -> [String: Any] {
    ["jsonrpc": "2.0", "id": id, "result": result]
  }

  private func err(_ id: Int, _ code: Int, _ message: String) -> [String: Any] {
    ["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]]
  }

  private func sendText(_ text: String) {
    webSocket?.send(.string(text)) { [weak self] error in
      if let error { self?.log("WebSocket send failed: \(error.localizedDescription)") }
    }
  }

  private func retry() {
    webSocket?.cancel()
    webSocket = nil
    db?.close()
    db = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.connect() }
  }

  private func log(_ message: String) {
    print("\(ISO8601DateFormatter().string(from: Date())) \(message)")
    fflush(stdout)
  }
}

private final class NativeMessagesDatabase {
  private var db: OpaquePointer?

  init(path: String) throws {
    if sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) != SQLITE_OK {
      throw NativeError(sqliteError())
    }
  }

  func close() {
    if db != nil {
      sqlite3_close(db)
      db = nil
    }
  }

  func chatCount() throws -> Int {
    var statement: OpaquePointer?
    defer { sqlite3_finalize(statement) }
    guard sqlite3_prepare_v2(db, "SELECT count(*) FROM chat", -1, &statement, nil) == SQLITE_OK else {
      throw NativeError(sqliteError())
    }
    guard sqlite3_step(statement) == SQLITE_ROW else { return 0 }
    return Int(sqlite3_column_int(statement, 0))
  }

  func chatsList(limit: Int?) throws -> [[String: Any]] {
    var sql = """
      SELECT c.ROWID, COALESCE(c.display_name, ''), c.guid, COALESCE(c.service_name, 'iMessage'), MAX(m.date)
      FROM chat c
      LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      LEFT JOIN message m ON m.ROWID = cmj.message_id
      GROUP BY c.ROWID
      ORDER BY MAX(m.date) DESC
    """
    if limit != nil { sql += " LIMIT ?" }
    var statement: OpaquePointer?
    defer { sqlite3_finalize(statement) }
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw NativeError(sqliteError()) }
    if let limit { sqlite3_bind_int(statement, 1, Int32(limit)) }
    var rows: [[String: Any]] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      let chatId = Int(sqlite3_column_int64(statement, 0))
      let participants = try chatParticipants(chatId)
      let isGroup = participants.count > 1
      let displayName = columnString(statement, 1)
      rows.append([
        "id": chatId,
        "name": displayName.isEmpty ? (isGroup ? "Group Chat" : (participants.first ?? "Unknown")) : displayName,
        "identifier": columnString(statement, 2),
        "guid": columnString(statement, 2),
        "service": columnString(statement, 3),
        "last_message_at": coreDataToISO(sqlite3_column_double(statement, 4)),
        "participants": participants,
        "is_group": isGroup,
      ])
    }
    return rows
  }

  func messagesHistory(chatId: Int, start: String?, end: String?, limit: Int?) throws -> [[String: Any]] {
    let meta = try chatMeta(chatId)
    var sql = """
      SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.date, m.is_from_me, h.id, m.associated_message_guid
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE cmj.chat_id = ?
    """
    var bindIndex: Int32 = 1
    var statement: OpaquePointer?
    var params: [(Int32, Any)] = [(bindIndex, chatId)]
    bindIndex += 1
    if let start {
      sql += " AND m.date >= ?"
      params.append((bindIndex, isoToCoreData(start)))
      bindIndex += 1
    }
    if let end {
      sql += " AND m.date <= ?"
      params.append((bindIndex, isoToCoreData(end)))
      bindIndex += 1
    }
    sql += " ORDER BY m.date ASC"
    if let limit {
      sql += " LIMIT ?"
      params.append((bindIndex, limit))
    }
    defer { sqlite3_finalize(statement) }
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw NativeError(sqliteError()) }
    for (index, value) in params {
      if let value = value as? Int {
        sqlite3_bind_int64(statement, index, sqlite3_int64(value))
      } else if let value = value as? Double {
        sqlite3_bind_double(statement, index, value)
      }
    }
    let participants = try chatParticipants(chatId)
    var messages: [(id: Int, guid: String, sender: String, isFromMe: Bool, text: String, date: Double, replyToGuid: String)] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      let messageId = Int(sqlite3_column_int64(statement, 0))
      let text = columnString(statement, 2)
      messages.append((
        id: messageId,
        guid: columnString(statement, 1).isEmpty ? "apple-msg-local-\(messageId)" : columnString(statement, 1),
        sender: columnString(statement, 6),
        isFromMe: sqlite3_column_int(statement, 5) == 1,
        text: text.isEmpty ? extractAttributedBodyText(columnBlob(statement, 3)) : text,
        date: sqlite3_column_double(statement, 4),
        replyToGuid: columnString(statement, 7)
      ))
    }
    let attachmentsByMessageId = try attachmentsForMessages(messages.map { $0.id })
    return messages.map { message in
      [
        "id": message.id,
        "chat_id": chatId,
        "guid": message.guid,
        "sender": message.sender,
        "is_from_me": message.isFromMe,
        "text": message.text,
        "created_at": coreDataToISO(message.date),
        "attachments": attachmentsByMessageId[message.id] ?? [],
        "reactions": [],
        "chat_identifier": meta.identifier,
        "chat_name": meta.name,
        "participants": participants,
        "is_group": participants.count > 1,
        "reply_to_guid": message.replyToGuid,
      ]
    }
  }

  private func attachmentsForMessages(_ messageIds: [Int]) throws -> [Int: [[String: Any]]] {
    guard !messageIds.isEmpty else { return [:] }

    // ponytail: metadata only; add a file fetch RPC if ingestion needs attachment bytes.
    var byMessageId: [Int: [[String: Any]]] = [:]
    let chunkSize = 900
    for start in stride(from: 0, to: messageIds.count, by: chunkSize) {
      let chunk = Array(messageIds[start..<min(start + chunkSize, messageIds.count)])
      let placeholders = Array(repeating: "?", count: chunk.count).joined(separator: ",")
      let sql = """
        SELECT maj.message_id, a.filename, a.mime_type, a.transfer_name, a.total_bytes, a.uti
        FROM message_attachment_join maj
        JOIN attachment a ON a.ROWID = maj.attachment_id
        WHERE maj.message_id IN (\(placeholders))
      """
      do {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw NativeError(sqliteError()) }
        for (index, messageId) in chunk.enumerated() {
          sqlite3_bind_int64(statement, Int32(index + 1), sqlite3_int64(messageId))
        }
        while sqlite3_step(statement) == SQLITE_ROW {
          let messageId = Int(sqlite3_column_int64(statement, 0))
          var attachment: [String: Any] = [
            "filename": columnString(statement, 1),
            "mime_type": columnString(statement, 2),
            "transfer_name": columnString(statement, 3),
            "uti": columnString(statement, 5),
          ]
          if sqlite3_column_type(statement, 4) != SQLITE_NULL {
            attachment["total_bytes"] = Int(sqlite3_column_int64(statement, 4))
          }
          byMessageId[messageId, default: []].append(attachment)
        }
      }
    }
    return byMessageId
  }

  private func chatParticipants(_ chatId: Int) throws -> [String] {
    var statement: OpaquePointer?
    defer { sqlite3_finalize(statement) }
    let sql = "SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ?"
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw NativeError(sqliteError()) }
    sqlite3_bind_int64(statement, 1, sqlite3_int64(chatId))
    var values: [String] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      values.append(columnString(statement, 0))
    }
    return values
  }

  private func chatMeta(_ chatId: Int) throws -> (name: String, identifier: String) {
    var statement: OpaquePointer?
    defer { sqlite3_finalize(statement) }
    let sql = "SELECT COALESCE(display_name, ''), guid FROM chat WHERE ROWID = ?"
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw NativeError(sqliteError()) }
    sqlite3_bind_int64(statement, 1, sqlite3_int64(chatId))
    guard sqlite3_step(statement) == SQLITE_ROW else { return ("Unknown", "") }
    return (columnString(statement, 0), columnString(statement, 1))
  }

  private func sqliteError() -> String {
    guard let db, let raw = sqlite3_errmsg(db) else { return "SQLite error" }
    return String(cString: raw)
  }
}

private func nativeContactsList() -> [[String: Any]] {
  let store = CNContactStore()
  let keys: [CNKeyDescriptor] = [
    CNContactIdentifierKey as CNKeyDescriptor,
    CNContactGivenNameKey as CNKeyDescriptor,
    CNContactFamilyNameKey as CNKeyDescriptor,
    CNContactMiddleNameKey as CNKeyDescriptor,
    CNContactNicknameKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
    CNContactJobTitleKey as CNKeyDescriptor,
    CNContactBirthdayKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactImageDataAvailableKey as CNKeyDescriptor,
  ]
  var rows: [[String: Any]] = []
  let request = CNContactFetchRequest(keysToFetch: keys)
  try? store.enumerateContacts(with: request) { contact, _ in
    let emails = contact.emailAddresses.map { String($0.value) }.filter { !$0.isEmpty }
    let phones = contact.phoneNumbers.map { $0.value.stringValue }.filter { !$0.isEmpty }
    let displayName = [contact.givenName, contact.middleName, contact.familyName]
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .joined(separator: " ")
    rows.append([
      "id": contact.identifier,
      "displayName": displayName.isEmpty ? contact.organizationName : displayName,
      "givenName": contact.givenName,
      "familyName": contact.familyName,
      "middleName": contact.middleName,
      "nickname": contact.nickname,
      "organization": contact.organizationName,
      "jobTitle": contact.jobTitle,
      "emails": emails,
      "phones": phones,
      "imageAvailable": contact.imageDataAvailable,
    ])
  }
  return rows
}

private func columnString(_ statement: OpaquePointer?, _ index: Int32) -> String {
  guard let raw = sqlite3_column_text(statement, index) else { return "" }
  return String(cString: raw)
}

private func columnBlob(_ statement: OpaquePointer?, _ index: Int32) -> Data? {
  guard let raw = sqlite3_column_blob(statement, index) else { return nil }
  let count = Int(sqlite3_column_bytes(statement, index))
  guard count > 0 else { return nil }
  return Data(bytes: raw, count: count)
}

private func extractAttributedBodyText(_ body: Data?) -> String {
  guard let body, !body.isEmpty else { return "" }

  let nsString = Data("NSString".utf8)
  let marker = Data([0x95, 0x84, 0x01, 0x2b])
  var searchFrom = body.startIndex

  while searchFrom < body.endIndex {
    guard let stringRange = body.range(of: nsString, options: [], in: searchFrom..<body.endIndex) else {
      return ""
    }
    guard let markerRange = body.range(of: marker, options: [], in: stringRange.upperBound..<body.endIndex) else {
      return ""
    }

    let lengthAt = markerRange.upperBound
    guard let parsed = readArchivedStringLength(body, offset: lengthAt) else {
      searchFrom = stringRange.upperBound
      continue
    }

    let start = lengthAt + parsed.offset
    let end = start + parsed.length
    if parsed.length <= 0 || end > body.endIndex {
      searchFrom = stringRange.upperBound
      continue
    }

    let text = (String(data: body[start..<end], encoding: .utf8) ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if isLikelyMessageText(text) { return text }

    searchFrom = stringRange.upperBound
  }

  return ""
}

private func readArchivedStringLength(_ body: Data, offset: Int) -> (length: Int, offset: Int)? {
  guard offset < body.endIndex else { return nil }
  let first = body[offset]
  if first < 0x80 { return (Int(first), 1) }

  let byteCount = Int(first & 0x7f)
  guard byteCount > 0, byteCount <= 4, offset + byteCount < body.endIndex else { return nil }

  var length = 0
  for i in 1...byteCount {
    length = (length << 8) + Int(body[offset + i])
  }

  return (length, 1 + byteCount)
}

private func isLikelyMessageText(_ text: String) -> Bool {
  guard !text.isEmpty, !text.contains("\u{0000}") else { return false }

  let blocked: Set<String> = [
    "NSString",
    "NSMutableString",
    "NSAttributedString",
    "NSMutableAttributedString",
    "NSObject",
    "NSDictionary",
    "NSNumber",
    "NSValue",
    "NSData",
    "NSMutableData",
    "NSKeyedArchiver",
  ]
  if blocked.contains(text) || text.hasPrefix("__kIM") { return false }

  return text.rangeOfCharacter(from: .alphanumerics) != nil
}

private func coreDataToISO(_ value: Double) -> String {
  guard value > 0 else { return ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: 0)) }
  return ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: value / 1_000_000_000 + 978_307_200))
}

private func isoToCoreData(_ value: String) -> Double {
  let formatter = ISO8601DateFormatter()
  let date = formatter.date(from: value) ?? Date(timeIntervalSince1970: 0)
  return (date.timeIntervalSince1970 - 978_307_200) * 1_000_000_000
}

private func jsonString(_ value: Any) -> String {
  let data = try! JSONSerialization.data(withJSONObject: value)
  return String(data: data, encoding: .utf8)!
}

private struct NativeError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
