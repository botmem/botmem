// Swift↔Rust link smoke test: proves the Swift host can drive the in-process
// Rust engine through the C ABI. Run via scripts/smoke/run.sh.
import BotmemEngine
import Foundation

let tmp = NSTemporaryDirectory() + "botmem-smoke-\(getpid())"
let statusPath = tmp + "/bridge-status.json"
let config = """
{"token":"apple_bt_smoke","server":"wss://api.botmem.xyz/apple-tunnel",\
"status_path":"\(statusPath)","data_dir":"\(tmp)"}
"""

func check(_ cond: Bool, _ msg: String) {
    if !cond { FileHandle.standardError.write("FAIL: \(msg)\n".data(using: .utf8)!); exit(1) }
}

let rc = config.withCString { botmem_engine_start($0) }
check(rc == BOTMEM_OK, "start returned \(rc), expected \(BOTMEM_OK)")

guard let ptr = botmem_engine_status_json() else {
    check(false, "status_json returned NULL while running"); fatalError()
}
let json = String(cString: ptr)
botmem_engine_free_string(ptr)
check(json.contains("\"schema\": 1"), "status missing schema 1")
check(json.contains("apple-tunnel"), "status missing server")

// Status file should exist on disk too.
check(FileManager.default.fileExists(atPath: statusPath), "status file not written")

let stopRc = botmem_engine_stop()
check(stopRc == BOTMEM_OK, "stop returned \(stopRc)")
check(botmem_engine_status_json() == nil, "status_json should be NULL after stop")

print("OK: Swift↔Rust FFI link verified (start → status → file → stop)")
