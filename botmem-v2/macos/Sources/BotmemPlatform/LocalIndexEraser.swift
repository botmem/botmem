import BotmemCore
import Foundation

/// Removes exactly `<application support root>/index`. The expected parent and
/// basename checks prevent a configuration mistake from targeting a source DB
/// or a broader user directory. Removing an `index` symlink removes the link,
/// not the directory it points at.
public final class LocalIndexEraser: LocalDataEraserPort {
    private let applicationSupportRoot: URL
    private let indexRoot: URL
    private let files: FileManager

    public init(
        applicationSupportRoot: URL,
        indexRoot: URL,
        fileManager: FileManager = .default
    ) {
        self.applicationSupportRoot = applicationSupportRoot
        self.indexRoot = indexRoot
        self.files = fileManager
    }

    public func eraseIndex() throws {
        let parent = applicationSupportRoot.standardizedFileURL
        let target = indexRoot.standardizedFileURL
        guard parent.isFileURL,
              target.isFileURL,
              parent.path != "/",
              target.lastPathComponent == "index",
              target.deletingLastPathComponent() == parent else {
            throw DeviceError.invalidConfiguration("refusing unsafe local index erase path")
        }
        guard files.fileExists(atPath: target.path) else { return }
        try files.removeItem(at: target)
    }
}
