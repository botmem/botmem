import AppKit
import BotmemCore
import BotmemPlatform
import Foundation

public final class BotmemRuntime {
    public let service: DeviceControlService
    public let router: DeviceCommandRouter
    public let server: LocalIPCServer
    public let socketURL: URL
    public let backgroundSync: BackgroundSyncScheduler
    private var wakeObserver: NSObjectProtocol?

    public init(
        service: DeviceControlService,
        router: DeviceCommandRouter,
        server: LocalIPCServer,
        socketURL: URL,
        backgroundSync: BackgroundSyncScheduler
    ) {
        self.service = service
        self.router = router
        self.server = server
        self.socketURL = socketURL
        self.backgroundSync = backgroundSync
    }

    public func start() throws {
        try server.start()
        try service.resumeAtLoginIfNeeded()
        try backgroundSync.start()
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: nil
        ) { [weak backgroundSync] _ in
            _ = backgroundSync?.trigger()
        }
    }

    public func stop() {
        backgroundSync.stop()
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
            self.wakeObserver = nil
        }
        server.stop()
        _ = router.handle(.init(kind: .stop))
    }
}

public enum AppComposition {
    public static func makeDefault() throws -> BotmemRuntime {
        let root = try applicationSupportRoot()
        let configuration = FileConfigurationStore(fileURL: root.appendingPathComponent("config.json"))
        let bundledTunnel = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Helpers/botmem-tunnel")
        guard FileManager.default.isExecutableFile(atPath: bundledTunnel.path) else {
            throw DeviceError.invalidConfiguration("bundled botmem-tunnel helper is missing")
        }
        let indexRoot = root.appendingPathComponent("index", isDirectory: true)
        let engine = RustSourceEngine(storeRoot: indexRoot)
        let identity = KeychainDeviceIdentity()
        let tunnel = ProcessTunnelManager(
            executableURL: bundledTunnel,
            indexRoot: indexRoot,
            identity: identity
        )
        let service = DeviceControlService(
            engine: engine,
            configurations: configuration,
            identity: identity,
            pairing: URLSessionDevicePairingClient(),
            loginItem: MacLoginItemManager(),
            tunnel: tunnel,
            localData: LocalIndexEraser(
                applicationSupportRoot: root,
                indexRoot: indexRoot
            ),
            settings: FullDiskAccessSettings()
        )
        let router = DeviceCommandRouter(service: service) {
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
        let socketURL = try BotmemPaths.defaultSocketURL()
        let server = LocalIPCServer(socketURL: socketURL, router: router)
        let backgroundSync = BackgroundSyncScheduler(service: service)
        return BotmemRuntime(
            service: service,
            router: router,
            server: server,
            socketURL: socketURL,
            backgroundSync: backgroundSync
        )
    }

    private static func applicationSupportRoot() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return base.appendingPathComponent("Botmem", isDirectory: true)
    }
}
