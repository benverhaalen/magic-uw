import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Task windows in the student's default browser. One JSON request on stdin, one
// JSON result on stdout. A window is identified by the Core Graphics window number
// that newly appeared for the browser process after this helper asked the browser
// for a NEW window. Later actions only touch window numbers the caller supplies and
// only when exactly one Accessibility window has that window's frame; anything
// ambiguous is refused, so unrelated windows are never moved, raised or closed.
// No keystrokes, page reads, profiles, cookies or tab access.
struct Area: Codable { let x: Double; let y: Double; let w: Double; let h: Double }
struct Request: Decodable {
    let action: String
    let url: String?
    let side: String?          // "left" | "right" | "none"
    let area: Area?            // screen area from an earlier open, top-left coordinates
    let pid: Int32?
    let bundleId: String?
    let windows: [Int]?
    let timeoutMs: Int?
}

func emit(_ value: [String: Any], code: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value),
       let line = String(data: data, encoding: .utf8) { print(line) }
    fflush(stdout)
    exit(code)
}
func fail(_ code: String, _ extra: [String: Any] = [:]) -> Never {
    emit(extra.merging(["event": "error", "code": code]) { a, _ in a }, code: 1)
}

enum Family: String { case firefox, chromium, safari, other }
func family(_ bundleId: String) -> Family {
    let id = bundleId.lowercased()
    if id.hasPrefix("org.mozilla.") { return .firefox }
    if ["com.google.chrome", "com.google.chrome.beta", "com.google.chrome.dev", "com.google.chrome.canary",
        "org.chromium.chromium", "com.microsoft.edgemac", "com.brave.browser", "com.vivaldi.vivaldi"].contains(id) { return .chromium }
    if id == "com.apple.safari" { return .safari }
    return .other
}
/** The documented command-line switch that asks a running browser for a new window. */
func newWindowArguments(_ family: Family, _ url: String) -> [String]? {
    switch family {
    case .firefox: return ["-new-window", url]
    case .chromium: return ["--new-window", url]
    default: return nil   // Safari needs Apple Events automation; not implemented.
    }
}
func checkedURL(_ raw: String?) -> URL? {
    guard let raw, raw.count <= 2000, let url = URL(string: raw), url.scheme == "https",
          url.host != nil, url.user == nil, url.password == nil else { return nil }
    return url
}

func defaultBrowser() -> (bundleId: String, app: URL, family: Family)? {
    guard let probe = URL(string: "https://example.com"),
          let app = NSWorkspace.shared.urlForApplication(toOpen: probe),
          let id = Bundle(url: app)?.bundleIdentifier else { return nil }
    return (id, app, family(id))
}

// MARK: Core Graphics identity (no permission needed for number, owner and bounds)
func cgWindows(pid: Int32) -> [Int: (frame: CGRect, onScreen: Bool)] {
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [:] }
    var out: [Int: (CGRect, Bool)] = [:]
    for info in list {
        guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = (info[kCGWindowNumber as String] as? NSNumber)?.intValue,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              frame.width >= 100, frame.height >= 100 else { continue }
        out[number] = (frame, (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false)
    }
    return out
}

// MARK: Accessibility (needs the Accessibility grant)
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func axWindows(pid: Int32) -> [AXUIElement] {
    attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute as String) as? [AXUIElement] ?? []
}
func axFrame(_ window: AXUIElement) -> CGRect? {
    var point = CGPoint.zero, size = CGSize.zero
    guard let p = attribute(window, kAXPositionAttribute as String), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = attribute(window, kAXSizeAttribute as String), CFGetTypeID(s) == AXValueGetTypeID(),
          AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func close(_ a: CGRect, _ b: CGRect, _ tolerance: CGFloat = 2) -> Bool {
    abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance &&
        abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
}
/** The single Accessibility window with this frame, or nil when none or several match. */
func uniqueAXWindow(pid: Int32, frame: CGRect) -> AXUIElement? {
    let matches = axWindows(pid: pid).filter { axFrame($0).map { close($0, frame) } ?? false }
    return matches.count == 1 ? matches[0] : nil
}

// MARK: Geometry. CG and AX share top-left global coordinates; NSScreen is bottom-left.
func topLeft(_ cocoa: CGRect) -> CGRect {
    let primary = NSScreen.screens.first?.frame.height ?? 0
    return CGRect(x: cocoa.minX, y: primary - cocoa.maxY, width: cocoa.width, height: cocoa.height)
}
func screenArea(containing frame: CGRect) -> CGRect? {
    let center = CGPoint(x: frame.midX, y: frame.midY)
    let areas = NSScreen.screens.map { topLeft($0.visibleFrame) }
    return areas.first { $0.contains(center) } ?? areas.first
}
func half(_ area: CGRect, _ side: String) -> CGRect {
    let width = floor(area.width / 2)
    return CGRect(x: side == "left" ? area.minX : area.minX + width, y: area.minY, width: side == "left" ? width : area.width - width, height: area.height)
}
func place(_ window: AXUIElement, _ target: CGRect) {
    var point = target.origin, size = target.size
    if let position = AXValueCreate(.cgPoint, &point), let extent = AXValueCreate(.cgSize, &size) {
        AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position)
        AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, extent)
        AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position)
    }
}
func json(_ r: CGRect) -> [String: Double] { ["x": r.minX, "y": r.minY, "w": r.width, "h": r.height] }

/** The pid must still belong to the browser the caller named (pids can be reused). */
func browserProcess(_ request: Request) -> NSRunningApplication {
    guard let pid = request.pid, let bundleId = request.bundleId,
          let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == bundleId else { fail("browser_process_gone") }
    return app
}

guard let line = readLine(), let data = line.data(using: .utf8),
      let request = try? JSONDecoder().decode(Request.self, from: data) else { fail("invalid_request") }

switch request.action {
case "selftest":
    // Pure checks only: no browser, no window server writes.
    let area = CGRect(x: 0, y: 25, width: 1441, height: 875)
    let ok = half(area, "left") == CGRect(x: 0, y: 25, width: 720, height: 875) &&
        half(area, "right") == CGRect(x: 720, y: 25, width: 721, height: 875) &&
        checkedURL("https://sites.google.com/x/home") != nil && checkedURL("http://a.b") == nil &&
        checkedURL("https://u:p@a.b") == nil && family("org.mozilla.firefox") == .firefox &&
        newWindowArguments(.safari, "https://a.b") == nil
    emit(["event": ok ? "selftest_passed" : "selftest_failed"], code: ok ? 0 : 1)

case "status":
    guard let browser = defaultBrowser() else { fail("no_default_browser") }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleId).map { Int($0.processIdentifier) }
    emit(["event": "status", "bundleId": browser.bundleId, "name": FileManager.default.displayName(atPath: browser.app.path),
          "family": browser.family.rawValue, "newWindow": newWindowArguments(browser.family, "https://a.b") != nil,
          "accessibility": AXIsProcessTrusted(), "running": running])

case "request_access":
    // Shows the system Accessibility prompt; only sent after the student asks.
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    emit(["event": "access", "accessibility": AXIsProcessTrustedWithOptions(options)])

case "open":
    guard let url = checkedURL(request.url) else { fail("invalid_url") }
    guard let browser = defaultBrowser() else { fail("no_default_browser") }
    guard let arguments = newWindowArguments(browser.family, url.absoluteString),
          let executable = Bundle(url: browser.app)?.executableURL else {
        fail("new_window_unsupported", ["bundleId": browser.bundleId, "family": browser.family.rawValue])
    }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleId)
    // Several instances (for example two Firefox profiles) make the receiving process unknowable.
    guard running.count <= 1 else { fail("several_browser_processes", ["bundleId": browser.bundleId]) }
    let trusted = AXIsProcessTrusted()
    let beforeCG = running.first.map { cgWindows(pid: $0.processIdentifier) } ?? [:]
    let beforeAX = running.first.map { axWindows(pid: $0.processIdentifier) } ?? []
    if running.isEmpty {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = arguments
        configuration.activates = true
        let launched = DispatchSemaphore(value: 0)
        var launchError: Error?
        NSWorkspace.shared.openApplication(at: browser.app, configuration: configuration) { _, error in
            launchError = error; launched.signal()
        }
        _ = launched.wait(timeout: .now() + 10)
        if launchError != nil { fail("launch_failed", ["bundleId": browser.bundleId]) }
    } else {
        // The browser binary forwards the request to the running instance and exits.
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { fail("launch_failed", ["bundleId": browser.bundleId]) }
    }
    emit(observeNewWindow())

    func observeNewWindow() -> [String: Any] {
        let deadline = Date().addingTimeInterval(Double(min(max(request.timeoutMs ?? 8000, 1000), 20000)) / 1000)
        var base: [String: Any] = ["bundleId": browser.bundleId, "family": browser.family.rawValue, "accessibility": trusted]
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.2)
            guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleId).first else { continue }
            let pid = app.processIdentifier
            let fresh = cgWindows(pid: pid).filter { beforeCG[$0.key] == nil }
            if fresh.isEmpty { continue }
            // A newly launched browser may restore a previous session: several new windows.
            guard fresh.count == 1, let (number, window) = fresh.first.map({ ($0.key, $0.value) }) else {
                base["event"] = "error"; base["code"] = "ambiguous_new_window"; base["pid"] = Int(pid); return base
            }
            base["event"] = "opened"; base["pid"] = Int(pid); base["windowNumber"] = number; base["frame"] = json(window.frame)
            let side = request.side ?? "none"
            guard side == "left" || side == "right" else { base["placed"] = false; return base }
            guard trusted else { base["placed"] = false; base["placeReason"] = "accessibility_required"; return base }
            // Pair the new CG window with the one new AX window of the same frame.
            let newAX = axWindows(pid: pid).filter { w in !beforeAX.contains { CFEqual($0, w) } }
            guard newAX.count == 1, let ax = newAX.first, let frame = axFrame(ax), close(frame, window.frame, 4) else {
                base["placed"] = false; base["placeReason"] = "window_not_matched"; return base
            }
            guard let area = request.area.map({ CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) }) ?? screenArea(containing: window.frame) else {
                base["placed"] = false; base["placeReason"] = "no_screen"; return base
            }
            let target = half(area, side)
            place(ax, target)
            Thread.sleep(forTimeInterval: 0.3)
            let actual = cgWindows(pid: pid)[number]?.frame ?? window.frame
            base["frame"] = json(actual); base["area"] = json(area)
            base["placed"] = close(actual, target, 8)
            if !(base["placed"] as! Bool) { base["placeReason"] = "browser_kept_its_size" }
            return base
        }
        base["event"] = "error"; base["code"] = "new_window_not_observed"; return base
    }

case "list":
    let app = browserProcess(request)
    let present = cgWindows(pid: app.processIdentifier)
    emit(["event": "listed", "windows": (request.windows ?? []).map { number -> [String: Any] in
        guard let found = present[number] else { return ["windowNumber": number, "present": false] }
        return ["windowNumber": number, "present": true, "onScreen": found.onScreen, "frame": json(found.frame)]
    }])

case "focus", "close":
    let app = browserProcess(request)
    guard AXIsProcessTrusted() else { fail("accessibility_required") }
    let present = cgWindows(pid: app.processIdentifier)
    var results: [[String: Any]] = []
    for number in request.windows ?? [] {
        guard let found = present[number] else { results.append(["windowNumber": number, "state": "missing"]); continue }
        guard let window = uniqueAXWindow(pid: app.processIdentifier, frame: found.frame) else {
            results.append(["windowNumber": number, "state": "ambiguous"]); continue
        }
        if request.action == "focus" {
            AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            let raised = AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
            results.append(["windowNumber": number, "state": raised ? "focused" : "not_raised"])
        } else {
            guard let button = attribute(window, kAXCloseButtonAttribute as String), CFGetTypeID(button) == AXUIElementGetTypeID(),
                  AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success else {
                results.append(["windowNumber": number, "state": "not_closed"]); continue
            }
            results.append(["windowNumber": number, "state": "pressed"])
        }
    }
    if request.action == "focus" {
        if results.contains(where: { ($0["state"] as? String) == "focused" }) { app.activate() }
    } else {
        // A browser may ask before closing several tabs; only a vanished window is closed.
        Thread.sleep(forTimeInterval: 0.8)
        let after = cgWindows(pid: app.processIdentifier)
        results = results.map { r in
            guard (r["state"] as? String) == "pressed", let n = r["windowNumber"] as? Int else { return r }
            return ["windowNumber": n, "state": after[n] == nil ? "closed" : "still_open"]
        }
    }
    emit(["event": request.action == "focus" ? "focused" : "closed", "windows": results])

default:
    fail("unsupported_action")
}
