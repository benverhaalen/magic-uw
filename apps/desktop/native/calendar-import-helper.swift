import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// owner: calendar-import. Google Calendar import in the student's default browser.
// One JSON request on stdin, one JSON result on stdout. The only window this helper
// acts on is the one it saw appear for the browser after asking for a NEW window
// (Core Graphics window number), and later only when exactly one Accessibility
// window has that frame and its page is https://calendar.google.com. It never
// reads cookies, profiles or other tabs, never moves or closes windows, and never
// presses Google's Import or Create calendar buttons: the student confirms those.
// File chooser: it presses Google's own "Select file from your computer", fills the
// chooser's Go-to field with a file Magic wrote, and presses Open only when the
// chooser's selected file name is exactly the expected one; otherwise it cancels.
struct Request: Decodable {
    let action: String
    let url: String?
    let pid: Int32?
    let bundleId: String?
    let windowNumber: Int?
    let path: String?
    let expectedName: String?
    let label: String?
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
func newWindowArguments(_ family: Family, _ url: String) -> [String]? {
    switch family {
    case .firefox: return ["-new-window", url]
    case .chromium: return ["--new-window", url]
    default: return nil   // Safari needs Apple Events automation; not implemented.
    }
}
/** Only Google Calendar pages; no credentials, no other host. */
func calendarURL(_ raw: String?) -> URL? {
    guard let raw, raw.count <= 500, let url = URL(string: raw), url.scheme == "https",
          url.host == "calendar.google.com", url.user == nil, url.password == nil, url.path.hasPrefix("/calendar") else { return nil }
    return url
}
/** Google's own labels this helper may press. Import and Create calendar are deliberately absent. */
let pressable: Set<String> = ["select file from your computer", "import & export", "create new calendar"]
/** Files Magic wrote: a private magic-calendar-* directory, a plain name, .ics. */
func exportFile(_ path: String?, _ expected: String?) -> URL? {
    guard let path, let expected, path.hasPrefix("/"), !path.contains("/../"), expected.count <= 120,
          expected.range(of: #"^Magic-[A-Za-z0-9-]+\.ics$"#, options: .regularExpression) != nil else { return nil }
    let url = URL(fileURLWithPath: path).standardizedFileURL
    guard url.lastPathComponent == expected, url.deletingLastPathComponent().lastPathComponent.hasPrefix("magic-calendar-") else { return nil }
    return url
}
func importCounts(_ text: String) -> (Int, Int)? {
    guard let match = text.range(of: #"Imported ([0-9]+) (?:out )?of ([0-9]+) events?"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
    let numbers = text[match].split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    return numbers.count == 2 ? (numbers[0], numbers[1]) : nil
}

func defaultBrowser() -> (bundleId: String, app: URL, family: Family)? {
    guard let probe = URL(string: "https://calendar.google.com"),
          let app = NSWorkspace.shared.urlForApplication(toOpen: probe),
          let id = Bundle(url: app)?.bundleIdentifier else { return nil }
    return (id, app, family(id))
}

// MARK: Core Graphics identity
func cgWindows(pid: Int32) -> [Int: CGRect] {
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [:] }
    var out: [Int: CGRect] = [:]
    for info in list {
        guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = (info[kCGWindowNumber as String] as? NSNumber)?.intValue,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              frame.width >= 100, frame.height >= 100 else { continue }
        out[number] = frame
    }
    return out
}

// MARK: Accessibility
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String? {
    (attribute(element, name) as? String).flatMap { $0.isEmpty ? nil : $0 }
}
func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func children(_ e: AXUIElement) -> [AXUIElement] { attribute(e, kAXChildrenAttribute as String) as? [AXUIElement] ?? [] }
func role(_ e: AXUIElement) -> String { string(e, kAXRoleAttribute as String) ?? "" }
func axWindows(pid: Int32) -> [AXUIElement] { attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute as String) as? [AXUIElement] ?? [] }
func axFrame(_ window: AXUIElement) -> CGRect? {
    var point = CGPoint.zero, size = CGSize.zero
    guard let p = attribute(window, kAXPositionAttribute as String), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = attribute(window, kAXSizeAttribute as String), CFGetTypeID(s) == AXValueGetTypeID(),
          AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func near(_ a: CGRect, _ b: CGRect, _ tolerance: CGFloat = 2) -> Bool {
    abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance &&
        abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
}
/** Bounded breadth-first walk; web pages can be large. */
func descendants(_ root: AXUIElement, limit: Int = 6000, where match: (AXUIElement) -> Bool) -> [AXUIElement] {
    var queue = [root], found: [AXUIElement] = [], seen = 0
    while !queue.isEmpty && seen < limit {
        let next = queue.removeFirst(); seen += 1
        if match(next) { found.append(next) }
        queue.append(contentsOf: children(next))
    }
    return found
}
/** Accessible name: title, description, or a link's own static text. */
func name(_ e: AXUIElement) -> String {
    if let t = string(e, kAXTitleAttribute as String) ?? string(e, kAXDescriptionAttribute as String) { return t }
    if ["AXLink", "AXButton", "AXMenuItem", "AXGroup"].contains(role(e)) {
        return children(e).compactMap { role($0) == "AXStaticText" ? string($0, kAXValueAttribute as String) : nil }.joined(separator: " ")
    }
    return (attribute(e, kAXValueAttribute as String) as? String) ?? ""
}
func normalized(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
func wait(_ seconds: Double, _ check: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline { if check() { return true }; Thread.sleep(forTimeInterval: 0.15) }
    return check()
}

// MARK: The one owned window
struct Target { let app: NSRunningApplication; let appElement: AXUIElement; let window: AXUIElement; let web: AXUIElement; let url: URL }
/** Refuses a gone browser, a missing or ambiguous window, or a window now showing another site or tab. */
func target(_ request: Request) -> Target {
    guard AXIsProcessTrusted() else { fail("accessibility_required") }
    guard let pid = request.pid, let bundleId = request.bundleId, let number = request.windowNumber,
          let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == bundleId else { fail("browser_process_gone") }
    guard let frame = cgWindows(pid: pid)[number] else { fail("window_gone") }
    let appElement = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(appElement, 2)
    let matches = axWindows(pid: pid).filter { axFrame($0).map { near($0, frame) } ?? false }
    guard matches.count == 1, let window = matches.first else { fail("window_ambiguous") }
    // Chromium exposes page content to Accessibility clients that ask for it; no other setting changes.
    AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    var web: AXUIElement?
    _ = wait(3) { web = descendants(window, limit: 400) { role($0) == "AXWebArea" }.first; return web != nil }
    guard let web else { fail("page_not_observed") }
    guard let raw = attribute(web, "AXURL"), let url = (raw as? URL) ?? (raw as? NSURL).map({ $0 as URL }) ?? (raw as? String).flatMap(URL.init(string:)),
          url.scheme == "https", url.host == "calendar.google.com" else { fail("not_google_calendar") }
    return Target(app: app, appElement: appElement, window: window, web: web, url: url)
}
func labelled(_ t: Target, _ label: String) -> [AXUIElement] {
    descendants(t.web) { ["AXLink", "AXButton", "AXMenuItem", "AXGroup", "AXStaticText"].contains(role($0)) && normalized(name($0)) == label }
}
func pageText(_ t: Target) -> [String] {
    descendants(t.web) { role($0) == "AXStaticText" }.compactMap { string($0, kAXValueAttribute as String) }
}
/** Google's "Add to calendar" choice on the import form, read only. */
func destination(_ t: Target) -> String? {
    for e in descendants(t.web, where: { ["AXPopUpButton", "AXComboBox", "AXListBox"].contains(role($0)) }) {
        let label = normalized(string(e, kAXDescriptionAttribute as String) ?? string(e, kAXTitleAttribute as String) ?? "")
        guard label.contains("add to calendar") || label.contains("calendar") else { continue }
        if let v = string(e, kAXValueAttribute as String) { return v }
        if let selected = (attribute(e, kAXSelectedChildrenAttribute as String) as? [AXUIElement])?.first { return name(selected) }
    }
    return nil
}
func pageState(_ t: Target, expectedName: String?) -> [String: Any] {
    let text = pageText(t)
    var out: [String: Any] = ["event": "page", "path": t.url.path,
        "importForm": !labelled(t, "select file from your computer").isEmpty,
        "createForm": !descendants(t.web) { role($0) == "AXButton" && normalized(name($0)) == "create calendar" }.isEmpty]
    if let d = destination(t) { out["destination"] = String(d.prefix(200)) }
    if let expectedName { out["pageShowsFile"] = text.contains { $0.contains(expectedName) } }
    if let counts = text.lazy.compactMap(importCounts).first { out["imported"] = counts.0; out["total"] = counts.1 }
    return out
}

// MARK: The native file chooser
/** A chooser attached to the owned window (sheet), or a dialog that appeared after the press. */
func chooser(_ t: Target, before: [AXUIElement]) -> (AXUIElement, String)? {
    if let sheet = children(t.window).first(where: { role($0) == "AXSheet" }) { return (sheet, "sheet") }
    let fresh = axWindows(pid: t.app.processIdentifier).filter { w in !before.contains { CFEqual($0, w) } && string(w, kAXSubroleAttribute as String) == "AXDialog" }
    return fresh.count == 1 ? (fresh[0], "dialog") : nil
}
func postKey(_ pid: Int32, _ key: CGKeyCode, _ flags: CGEventFlags = []) {
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down) else { continue }
        event.flags = flags
        event.postToPid(pid)
    }
}
func selectedNames(_ panel: AXUIElement) -> [String] {
    var names: [String] = []
    for view in descendants(panel, limit: 3000, where: { ["AXOutline", "AXTable", "AXList", "AXBrowser"].contains(role($0)) }) {
        let rows = (attribute(view, kAXSelectedRowsAttribute as String) as? [AXUIElement]) ?? (attribute(view, kAXSelectedChildrenAttribute as String) as? [AXUIElement]) ?? []
        for row in rows {
            let texts = descendants(row, limit: 60) { ["AXTextField", "AXStaticText"].contains(role($0)) }.compactMap { string($0, kAXValueAttribute as String) }
            if let first = texts.first(where: { $0.lowercased().hasSuffix(".ics") }) ?? texts.first { names.append(first) }
        }
    }
    return Array(Set(names))
}
func press(_ e: AXUIElement) -> Bool { AXUIElementPerformAction(e, kAXPressAction as CFString) == .success }
func cancel(_ panel: AXUIElement) {
    if let button = element(attribute(panel, kAXCancelButtonAttribute as String)) ?? descendants(panel, limit: 800, where: { role($0) == "AXButton" && normalized(name($0)) == "cancel" }).first { _ = press(button) }
}

guard let line = readLine(), let data = line.data(using: .utf8),
      let request = try? JSONDecoder().decode(Request.self, from: data) else { fail("invalid_request") }

switch request.action {
case "selftest":
    // Pure checks only: no browser, no window server, no files.
    let ok = calendarURL("https://calendar.google.com/calendar/r/settings/export") != nil &&
        calendarURL("https://calendar.google.com.evil.test/calendar") == nil && calendarURL("http://calendar.google.com/calendar") == nil &&
        calendarURL("https://u:p@calendar.google.com/calendar") == nil &&
        exportFile("/tmp/magic-calendar-x1/Magic-Lectures-2026-09-27-ab12.ics", "Magic-Lectures-2026-09-27-ab12.ics") != nil &&
        exportFile("/tmp/other/Magic-Lectures-2026-09-27-ab12.ics", "Magic-Lectures-2026-09-27-ab12.ics") == nil &&
        exportFile("/tmp/magic-calendar-x1/Magic-Lectures.ics", "Magic-Other.ics") == nil &&
        exportFile("/tmp/magic-calendar-x1/../x/Magic-A.ics", "Magic-A.ics") == nil &&
        importCounts("Imported 12 out of 12 events.").map { $0 == (12, 12) } == true && importCounts("Import") == nil &&
        !pressable.contains("import") && !pressable.contains("create calendar") && newWindowArguments(.safari, "https://a.b") == nil
    emit(["event": ok ? "selftest_passed" : "selftest_failed"], code: ok ? 0 : 1)

case "status":
    guard let browser = defaultBrowser() else { fail("no_default_browser") }
    emit(["event": "status", "bundleId": browser.bundleId, "name": FileManager.default.displayName(atPath: browser.app.path),
          "family": browser.family.rawValue, "newWindow": newWindowArguments(browser.family, "https://a.b") != nil,
          "accessibility": AXIsProcessTrusted(),
          "running": NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleId).count])

case "request_access":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    emit(["event": "access", "accessibility": AXIsProcessTrustedWithOptions(options)])

case "open":
    guard let url = calendarURL(request.url) else { fail("invalid_url") }
    guard let browser = defaultBrowser() else { fail("no_default_browser") }
    guard let arguments = newWindowArguments(browser.family, url.absoluteString),
          let executable = Bundle(url: browser.app)?.executableURL else { fail("new_window_unsupported", ["bundleId": browser.bundleId]) }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleId)
    guard running.count <= 1 else { fail("several_browser_processes") }
    let before = running.first.map { cgWindows(pid: $0.processIdentifier) } ?? [:]
    if running.isEmpty {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = arguments
        configuration.activates = true
        let launched = DispatchSemaphore(value: 0)
        var launchError: Error?
        NSWorkspace.shared.openApplication(at: browser.app, configuration: configuration) { _, error in launchError = error; launched.signal() }
        _ = launched.wait(timeout: .now() + 10)
        if launchError != nil { fail("launch_failed") }
    } else {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { fail("launch_failed") }
    }
    let deadline = Date().addingTimeInterval(Double(min(max(request.timeoutMs ?? 8000, 1000), 20000)) / 1000)
    while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.2)
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleId).first else { continue }
        let fresh = cgWindows(pid: app.processIdentifier).filter { before[$0.key] == nil }
        if fresh.isEmpty { continue }
        // A restored session can open several windows; none of them is known to be ours.
        guard fresh.count == 1, let number = fresh.keys.first else { fail("ambiguous_new_window") }
        emit(["event": "opened", "bundleId": browser.bundleId, "family": browser.family.rawValue,
              "pid": Int(app.processIdentifier), "windowNumber": number, "accessibility": AXIsProcessTrusted()])
    }
    fail("new_window_not_observed")

case "page":
    let t = target(request)
    // The page may still be loading after sign-in; wait briefly for either form.
    _ = wait(Double(min(max(request.timeoutMs ?? 4000, 500), 15000)) / 1000) {
        !labelled(t, "select file from your computer").isEmpty || !labelled(t, "create new calendar").isEmpty
    }
    emit(pageState(t, expectedName: request.expectedName))

case "press":
    guard let label = request.label.map(normalized), pressable.contains(label) else { fail("label_not_allowed") }
    let t = target(request)
    let found = labelled(t, label)
    guard found.count >= 1 else { fail("control_not_found") }
    // Chromium exposes a link and its own text; press the outermost actionable one only when unambiguous.
    let actionable = found.filter { ["AXLink", "AXButton", "AXMenuItem"].contains(role($0)) }
    guard let control = actionable.count == 1 ? actionable[0] : (actionable.isEmpty && found.count == 1 ? found[0] : nil) else { fail("control_ambiguous") }
    guard press(control) else { fail("control_not_pressed") }
    emit(["event": "pressed", "label": label])

case "attach":
    guard let file = exportFile(request.path, request.expectedName), let expected = request.expectedName else { fail("invalid_file") }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory), !isDirectory.boolValue else { fail("file_missing") }
    let t = target(request)
    guard children(t.window).first(where: { role($0) == "AXSheet" }) == nil else { fail("chooser_already_open") }
    let controls = labelled(t, "select file from your computer")
    let actionable = controls.filter { ["AXLink", "AXButton", "AXGroup"].contains(role($0)) }
    guard let control = actionable.first ?? controls.first, actionable.count <= 1 else { fail(controls.isEmpty ? "import_form_not_observed" : "control_ambiguous") }
    let windowsBefore = axWindows(pid: t.app.processIdentifier)
    guard press(control) else { fail("control_not_pressed") }
    var found: (AXUIElement, String)?
    guard wait(6, { found = chooser(t, before: windowsBefore); return found != nil }), let hit = found else { fail("chooser_not_observed") }
    let (panel, context) = hit
    // Keystrokes go to the browser process only while its focus is inside this chooser.
    let focused = element(attribute(t.appElement, kAXFocusedWindowAttribute as String))
    guard let focused, CFEqual(focused, context == "sheet" ? t.window : panel) || CFEqual(focused, panel) else { cancel(panel); fail("focus_moved") }
    let pid = t.app.processIdentifier
    let fieldsBefore = descendants(panel, limit: 3000) { ["AXTextField", "AXComboBox"].contains(role($0)) }
    postKey(pid, 5, [.maskCommand, .maskShift])   // Go to folder (Command-Shift-G)
    var goField: AXUIElement?
    _ = wait(3) {
        goField = descendants(panel, limit: 3000) { e in ["AXTextField", "AXComboBox"].contains(role(e)) && !fieldsBefore.contains { CFEqual($0, e) } }.first
        return goField != nil
    }
    guard let goField else { cancel(panel); fail("go_to_field_not_observed") }
    guard AXUIElementSetAttributeValue(goField, kAXValueAttribute as CFString, file.path as CFString) == .success else { cancel(panel); fail("go_to_field_not_set") }
    Thread.sleep(forTimeInterval: 0.3)
    if AXUIElementPerformAction(goField, "AXConfirm" as CFString) != .success { postKey(pid, 36) }   // Return
    var names: [String] = []
    _ = wait(4) { names = selectedNames(panel); return names == [expected] }
    guard names == [expected] else {
        cancel(panel)
        fail("filename_mismatch", ["observedCount": names.count, "observedName": names.count == 1 ? String(names[0].prefix(120)) : ""])
    }
    guard let open = element(attribute(panel, kAXDefaultButtonAttribute as String)), (attribute(open, kAXEnabledAttribute as String) as? Bool) != false, press(open) else { cancel(panel); fail("open_not_pressed") }
    let closed = wait(5) { chooser(t, before: windowsBefore) == nil }
    var state = pageState(t, expectedName: expected)
    _ = wait(3) { state = pageState(t, expectedName: expected); return state["pageShowsFile"] as? Bool == true }
    state["event"] = "attached"; state["chooser"] = context; state["observedFileName"] = expected; state["chooserClosed"] = closed
    emit(state)

case "cancel":
    let t = target(request)
    if let sheet = children(t.window).first(where: { role($0) == "AXSheet" }) { cancel(sheet); emit(["event": "cancelled"]) }
    emit(["event": "no_chooser"])

default:
    fail("unsupported_action")
}
