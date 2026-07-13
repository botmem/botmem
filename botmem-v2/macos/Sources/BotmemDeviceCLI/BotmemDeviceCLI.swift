import BotmemCore
import BotmemPlatform
import Foundation

@main
enum BotmemDeviceCLI {
    static func main() {
        do {
            let command = try parse(Array(CommandLine.arguments.dropFirst()))
            let socket: URL
            if let override = ProcessInfo.processInfo.environment["BOTMEM_DEVICE_SOCKET"] {
                socket = URL(fileURLWithPath: override)
            } else {
                socket = try BotmemPaths.defaultSocketURL()
            }
            let response = try LocalIPCClient(socketURL: socket).send(command)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            FileHandle.standardOutput.write(try encoder.encode(response))
            FileHandle.standardOutput.write(Data([0x0a]))
            if !response.ok { Foundation.exit(1) }
        } catch {
            FileHandle.standardError.write(Data("botmem-device: \(error.localizedDescription)\n".utf8))
            Foundation.exit(2)
        }
    }

    private static func parse(_ arguments: [String]) throws -> DeviceCommand {
        guard let command = arguments.first else { return .init(kind: .status) }
        switch command {
        case "status" where arguments.count == 1:
            return .init(kind: .status)
        case "source" where arguments.count >= 3:
            guard let source = DeviceSource(rawValue: arguments[1]) else { throw CLIError.usage }
            switch arguments[2] {
            case "enable" where arguments.count == 3:
                return .init(kind: .setSource, source: source, enabled: true)
            case "disable" where arguments.count == 3:
                return .init(kind: .setSource, source: source, enabled: false)
            case "sync" where arguments.count == 3:
                return .init(kind: .syncSource, source: source)
            case "reconcile" where arguments.count == 3:
                return .init(kind: .syncSource, source: source, reconcile: true)
            case "preflight" where arguments.count == 3:
                return .init(kind: .preflightSource, source: source)
            default: throw CLIError.usage
            }
        case "enroll" where arguments.count == 2:
            guard let setup = readSetupPayload(), !setup.isEmpty else { throw CLIError.missingCredential }
            return .init(kind: .enroll, setupPayload: setup, displayName: arguments[1])
        case "delete-enrollment" where arguments.count == 1:
            return .init(kind: .deleteEnrollment)
        case "erase-local-data" where arguments == [
            "erase-local-data", "--confirm", "ERASE-LOCAL-BOTMEM-DATA",
        ]:
            return .init(kind: .eraseLocalData)
        case "service" where arguments.count == 2:
            switch arguments[1] {
            case "start": return .init(kind: .start)
            case "stop": return .init(kind: .stop)
            case "quit": return .init(kind: .quit)
            default: throw CLIError.usage
            }
        case "login" where arguments.count == 2:
            if arguments[1] == "enable" { return .init(kind: .setLaunchAtLogin, enabled: true) }
            if arguments[1] == "disable" { return .init(kind: .setLaunchAtLogin, enabled: false) }
            throw CLIError.usage
        case "permission" where arguments == ["permission", "open"]:
            return .init(kind: .openFullDiskAccess)
        default:
            throw CLIError.usage
        }
    }

    private static func readSetupPayload() -> String? {
        guard isatty(STDIN_FILENO) == 0 else { return nil }
        return readLine()?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private enum CLIError: Error, LocalizedError {
    case usage
    case missingCredential

    var errorDescription: String? {
        switch self {
        case .usage:
            return "usage: botmem-device status | source <imessage|whatsapp> <preflight|enable|disable|sync|reconcile> | enroll <display-name> (setup payload on stdin) | delete-enrollment | erase-local-data --confirm ERASE-LOCAL-BOTMEM-DATA | service <start|stop|quit> | login <enable|disable> | permission open"
        case .missingCredential:
            return "provide the one-time setup payload on standard input"
        }
    }
}
