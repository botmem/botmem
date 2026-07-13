import AppKit
import BotmemCore
import BotmemDeviceRuntime
import BotmemPlatform
import SwiftUI

@main
struct BotmemApplication: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("Botmem") {
            ContentView(model: model)
                .frame(minWidth: 720, minHeight: 560)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    model.shutdown()
                }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                    model.refreshAfterActivation()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .appTermination) {
                Button("Quit Botmem") { model.quit() }
                    .keyboardShortcut("q")
            }
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var snapshot: DeviceSnapshot?
    @Published private(set) var error: String?
    @Published var setupPayload = ""
    @Published var deviceName = Host.current().localizedName ?? "My Mac"
    @Published var confirmsLocalErase = false

    private var runtime: BotmemRuntime?

    init() {
        do {
            let runtime = try AppComposition.makeDefault()
            try runtime.start()
            self.runtime = runtime
            refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func send(_ command: DeviceCommand) {
        guard let runtime else { return }
        let response = runtime.router.handle(command)
        if response.ok {
            error = nil
            refresh()
        } else {
            error = response.error ?? "The command failed."
            refresh()
        }
    }

    func setSource(_ source: DeviceSource, enabled: Bool) {
        send(.init(kind: .setSource, source: source, enabled: enabled))
    }

    func sync(_ source: DeviceSource) {
        send(.init(kind: .syncSource, source: source))
    }

    func enroll() {
        guard !setupPayload.isEmpty else {
            error = "Paste the setup payload from Botmem Web."
            return
        }
        send(.init(kind: .enroll, setupPayload: setupPayload, displayName: deviceName))
        setupPayload = ""
    }

    func eraseLocalData() {
        send(.init(kind: .eraseLocalData))
        confirmsLocalErase = false
    }

    func refresh() {
        guard let runtime else { return }
        let response = runtime.router.handle(.init(kind: .status))
        if let snapshot = response.snapshot { self.snapshot = snapshot }
        if !response.ok { error = response.error }
    }

    func refreshAfterActivation() {
        let previouslyReady = Set(snapshot?.sources.compactMap {
            $0.readiness == .ready ? $0.source : nil
        } ?? [])
        refresh()
        let newlyReady = Set(snapshot?.sources.compactMap {
            $0.readiness == .ready && !previouslyReady.contains($0.source) ? $0.source : nil
        } ?? [])
        if !newlyReady.isEmpty {
            try? runtime?.service.requestBackgroundSync(for: newlyReady)
        }
        _ = runtime?.backgroundSync.trigger()
    }

    func shutdown() {
        runtime?.stop()
        runtime = nil
    }

    func quit() {
        send(.init(kind: .quit))
    }
}

private struct ContentView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack {
            Color(red: 0.05, green: 0.05, blue: 0.05).ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    if let error = model.error { errorPanel(error) }
                    sources
                    relay
                    service
                    localData
                }
                .padding(28)
            }
        }
        .foregroundStyle(.white)
        .font(.system(.body, design: .monospaced))
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("BOTMEM // DEVICE")
                .font(.system(size: 28, weight: .black, design: .monospaced))
            Spacer()
            Text(model.snapshot?.service.rawValue.uppercased() ?? "BOOTING")
                .foregroundStyle(accent)
        }
        .padding(.bottom, 14)
        .overlay(alignment: .bottom) { Rectangle().fill(accent).frame(height: 3) }
    }

    private var sources: some View {
        panel("LOCAL SOURCES") {
            ForEach(model.snapshot?.sources ?? []) { source in
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Toggle(
                            source.source.rawValue.uppercased(),
                            isOn: Binding(
                                get: { source.enabled },
                                set: { model.setSource(source.source, enabled: $0) }
                            )
                        )
                        .toggleStyle(.switch)
                        Spacer()
                        status(source.readiness.rawValue)
                    }
                    if let reason = source.reasonCode {
                        Text(reason).font(.caption).foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("RUN PREFLIGHT") {
                            model.send(.init(kind: .preflightSource, source: source.source))
                        }
                        Button("SYNC") { model.sync(source.source) }
                            .disabled(source.readiness != .ready)
                        if source.readiness == .permissionRequired {
                            Button("OPEN FULL DISK ACCESS") {
                                model.send(.init(kind: .openFullDiskAccess))
                            }
                        }
                    }
                    if source.source == .whatsapp {
                        Text(whatsAppGuidance(source))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 8)
                .overlay(alignment: .bottom) { Rectangle().fill(.gray.opacity(0.5)).frame(height: 1) }
            }
        }
    }

    private var relay: some View {
        panel("RELAY ENROLLMENT") {
            TextField("Mac display name", text: $model.deviceName)
                .textFieldStyle(.plain)
                .fieldBorder()
            SecureField("one-time setup payload from Botmem Web", text: $model.setupPayload)
                .textFieldStyle(.plain)
                .fieldBorder()
            HStack {
                Button("PAIR THIS MAC") { model.enroll() }
                Spacer()
                Text(model.snapshot?.enrolled == true ? "KEYCHAIN: READY" : "NOT ENROLLED")
                    .foregroundStyle(model.snapshot?.enrolled == true ? accent : .orange)
            }
            Text("The signed, bundled botmem-tunnel helper starts automatically.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var service: some View {
        panel("SERVICE") {
            HStack {
                Button("START") { model.send(.init(kind: .start)) }
                Button("STOP") { model.send(.init(kind: .stop)) }
                Spacer()
                Text("LOGIN: \(model.snapshot?.loginItem.rawValue.uppercased() ?? "UNKNOWN")")
            }
            HStack {
                Button("ENABLE LOGIN ITEM") {
                    model.send(.init(kind: .setLaunchAtLogin, enabled: true))
                }
                Button("DISABLE LOGIN ITEM") {
                    model.send(.init(kind: .setLaunchAtLogin, enabled: false))
                }
            }
            if let key = model.snapshot?.deviceKeyID {
                Text("DEVICE KEY \(key.prefix(16))…").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var localData: some View {
        panel("LOCAL DATA") {
            Text("Deletes Botmem's derived index, local configuration, and Keychain device identity. Your Messages and WhatsApp databases are never modified.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("ERASE LOCAL BOTMEM DATA", role: .destructive) {
                model.confirmsLocalErase = true
            }
            .confirmationDialog(
                "Erase local Botmem data?",
                isPresented: $model.confirmsLocalErase,
                titleVisibility: .visible
            ) {
                Button("ERASE LOCAL BOTMEM DATA", role: .destructive) {
                    model.eraseLocalData()
                }
                Button("CANCEL", role: .cancel) {}
            } message: {
                Text("The tunnel and login item will stop. Botmem's index, configuration, and device key will be deleted. Source databases are not touched.")
            }
        }
    }

    private func panel<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.headline).foregroundStyle(accent)
            content()
        }
        .padding(18)
        .background(Color.black)
        .overlay(Rectangle().stroke(.white, lineWidth: 2))
        .shadow(color: accent, radius: 0, x: 6, y: 6)
    }

    private func errorPanel(_ message: String) -> some View {
        Text("ERROR // \(message)")
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color.red.opacity(0.25))
            .overlay(Rectangle().stroke(.red, lineWidth: 2))
            .accessibilityLabel("Error: \(message)")
    }

    private func status(_ value: String) -> some View {
        Text(value.uppercased())
            .font(.caption.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .overlay(Rectangle().stroke(.white, lineWidth: 1))
    }

    private var accent: Color { Color(red: 0.77, green: 0.96, blue: 0.23) }

    private func whatsAppGuidance(_ source: SourceState) -> String {
        switch source.readiness {
        case .notInstalled:
            "Install WhatsApp Desktop and pair it there first. Botmem never receives the session credential."
        case .permissionRequired:
            "WhatsApp Desktop is present. Grant Botmem Full Disk Access to read its local store."
        case .schemaUnsupported:
            "This WhatsApp Desktop store schema is not supported by this Botmem release."
        case .ready:
            "WhatsApp Desktop owns the session. Botmem reads its local store in read-only mode."
        default:
            "Preflight verifies the Desktop store, schema, Full Disk Access, and read-only open."
        }
    }
}

private extension View {
    func fieldBorder() -> some View {
        padding(10)
            .background(.white.opacity(0.08))
            .overlay(Rectangle().stroke(.white, lineWidth: 1))
    }
}
