import Foundation

public enum BackgroundSyncTriggerResult: Equatable, Sendable {
    case started
    case coalesced
    case stopped
}

/// One in-process owner for launch, wake, retry, and periodic incremental sync.
/// Multiple triggers collapse into at most one follow-up pass.
public final class BackgroundSyncScheduler: @unchecked Sendable {
    private let service: DeviceControlService
    private let policy: BackgroundSyncPolicy
    private let clock: @Sendable () -> Date
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var running = false
    private var rerunRequested = false
    private var stopped = true

    public init(
        service: DeviceControlService,
        policy: BackgroundSyncPolicy = .production,
        clock: @escaping @Sendable () -> Date = { Date() },
        queue: DispatchQueue = DispatchQueue(label: "app.botmem.device.background-sync")
    ) {
        self.service = service
        self.policy = policy
        self.clock = clock
        self.queue = queue
    }

    public func start() throws {
        try policy.validate()
        lock.withLock {
            guard stopped else { return }
            stopped = false
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(
                deadline: .now() + policy.pollInterval,
                repeating: policy.pollInterval,
                leeway: .seconds(2)
            )
            timer.setEventHandler { [weak self] in _ = self?.trigger() }
            timer.resume()
            self.timer = timer
        }
        _ = trigger()
    }

    public func stop() {
        lock.withLock {
            stopped = true
            rerunRequested = false
            timer?.cancel()
            timer = nil
        }
    }

    @discardableResult
    public func trigger() -> BackgroundSyncTriggerResult {
        let result: BackgroundSyncTriggerResult = lock.withLock {
            guard !stopped else { return .stopped }
            if running {
                rerunRequested = true
                return .coalesced
            }
            running = true
            return .started
        }
        if result == .started { queue.async { [weak self] in self?.drain() } }
        return result
    }

    /// Deterministic entry point for tests and explicit maintenance commands.
    @discardableResult
    public func runNow() -> BackgroundSyncTriggerResult {
        let result: BackgroundSyncTriggerResult = lock.withLock {
            guard !stopped else {
                stopped = false
                running = true
                return .started
            }
            if running {
                rerunRequested = true
                return .coalesced
            }
            running = true
            return .started
        }
        if result == .started { drain() }
        return result
    }

    private func drain() {
        while true {
            _ = service.synchronizeDueSources(at: clock())
            let continueRunning = lock.withLock {
                guard !stopped else {
                    running = false
                    rerunRequested = false
                    return false
                }
                if rerunRequested {
                    rerunRequested = false
                    return true
                }
                running = false
                return false
            }
            if !continueRunning { return }
        }
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () -> T) -> T {
        lock()
        defer { unlock() }
        return operation()
    }
}
