// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BotmemMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "BotmemCore", targets: ["BotmemCore"]),
        .library(name: "BotmemPlatform", targets: ["BotmemPlatform"]),
        .executable(name: "Botmem", targets: ["BotmemMac"]),
        .executable(name: "botmem-device", targets: ["BotmemDeviceCLI"]),
    ],
    targets: [
        .target(name: "BotmemCore"),
        .target(
            name: "CBotmemDeviceFFI",
            publicHeadersPath: "include",
            linkerSettings: [
                .unsafeFlags(["-L", ".build/rust/current"]),
                .linkedLibrary("botmem_device_ffi"),
                .linkedLibrary("sqlite3"),
                .linkedLibrary("iconv"),
                .linkedFramework("Security"),
            ]
        ),
        .target(
            name: "BotmemPlatform",
            dependencies: ["BotmemCore"]
        ),
        .target(
            name: "BotmemDeviceRuntime",
            dependencies: ["BotmemCore", "BotmemPlatform", "CBotmemDeviceFFI"]
        ),
        .executableTarget(
            name: "BotmemMac",
            dependencies: ["BotmemCore", "BotmemPlatform", "BotmemDeviceRuntime"]
        ),
        .executableTarget(
            name: "BotmemDeviceCLI",
            dependencies: ["BotmemCore", "BotmemPlatform"]
        ),
        .testTarget(name: "BotmemCoreTests", dependencies: ["BotmemCore"]),
        .testTarget(
            name: "BotmemPlatformTests",
            dependencies: ["BotmemCore", "BotmemPlatform", "BotmemDeviceRuntime"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
