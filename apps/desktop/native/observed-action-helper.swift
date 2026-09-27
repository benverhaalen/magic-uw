import AppKit
import ApplicationServices
import Foundation

// Browser actions use the student's current default browser through macOS AX.
// One request per process; no profile, tab, coordinate, AppleScript, or CUA bridge.
struct Request: Decodable {
    let action: String
    let bundleId: String?
    let pid: Int32?
    let windowNumber: Int?
    let expectedURL: String?
    let path: [Int]?
    let role: String?
    let title: String?
    let targetURL: String?
}
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) else { return }
    print(line); fflush(stdout)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let text = value as? String { return text }
    if let url = value as? URL { return url.absoluteString }
    return nil
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    if let items = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] { return items }
    if let items = attribute(element, kAXVisibleChildrenAttribute as String) as? [AXUIElement] { return items }
    return []
}
func webURL(_ raw: String?) -> String? {
    guard var raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
    if !raw.contains("://") && raw.contains(".") && !raw.contains(" ") { raw = "https://" + raw }
    guard let url = URL(string: raw), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
          url.host != nil, url.user == nil, url.password == nil else { return nil }
    return url.absoluteString
}
func safeNavigation(_ raw: String?) -> String? {
    guard let raw, raw.count <= 2000, let url = URL(string: raw), url.scheme == "https",
          url.host != nil, url.user == nil, url.password == nil, url.port == nil else { return nil }
    return url.absoluteString
}
struct Candidate {
    let path: [Int]
    let role: String
    let title: String
    let targetURL: String
    func json() -> [String: Any] { ["path": path, "role": role, "title": title, "targetURL": targetURL] }
}
struct Snapshot {
    let bundleId: String
    let pid: Int32
    let windowNumber: Int?
    let title: String
    let url: String
    let focusedRole: String
    let focusedTitle: String
    let text: String
    let candidates: [Candidate]
    func json() -> [String: Any] {
        var result: [String: Any] = ["event": "observed", "bundleId": bundleId, "pid": pid,
            "title": title, "url": url, "focusedRole": focusedRole, "focusedTitle": focusedTitle,
            "text": text, "candidates": candidates.map { $0.json() }]
        if let windowNumber { result["windowNumber"] = windowNumber }
        return result
    }
}
func focusedWindow(_ pid: Int32) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    guard let value = attribute(app, kAXFocusedWindowAttribute as String), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func snapshot(bundleId: String, pid: Int32, window: AXUIElement) -> Snapshot? {
    let title = string(window, kAXTitleAttribute as String) ?? ""
    let windowNumber = (attribute(window, "AXWindowNumber") as? NSNumber)?.intValue
    var addresses: [String] = [], documents: [String] = [], staticTexts: [String] = [], candidates: [Candidate] = []
    var queue: [(AXUIElement, [Int], Bool)] = [(window, [], false)]
    var index = 0
    let deadline = Date().addingTimeInterval(0.7)
    while index < queue.count && index < 1400 && Date() < deadline {
        let (element, path, inWebArea) = queue[index]; index += 1
        let role = string(element, kAXRoleAttribute as String) ?? ""
        let isWeb = inWebArea || role == "AXWebArea"
        if role == "AXWebArea", let value = webURL(string(element, "AXURL")), !documents.contains(value) { documents.append(value) }
        if !isWeb && ["AXTextField", "AXComboBox"].contains(role), let value = webURL(string(element, kAXValueAttribute as String)), !addresses.contains(value) { addresses.append(value) }
        if isWeb && role == (kAXStaticTextRole as String), let value = string(element, kAXValueAttribute as String), !value.isEmpty { staticTexts.append(value) }
        if isWeb && role == "AXLink", let targetURL = safeNavigation(string(element, "AXURL")) {
            let label = (string(element, kAXTitleAttribute as String) ?? string(element, kAXValueAttribute as String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !label.isEmpty && candidates.count < 40 { candidates.append(Candidate(path: path, role: role, title: String(label.prefix(200)), targetURL: targetURL)) }
        }
        if queue.count < 1400 {
            for (childIndex, child) in children(element).enumerated() { queue.append((child, path + [childIndex], isWeb)) }
        }
    }
    guard !title.isEmpty, addresses.count <= 1 else { return nil }
    if let address = addresses.first, let document = documents.first, address != document { return nil }
    guard let url = addresses.first ?? documents.first else { return nil }
    let app = AXUIElementCreateApplication(pid)
    let focused = attribute(app, kAXFocusedUIElementAttribute as String)
    let focusedElement = focused.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    return Snapshot(bundleId: bundleId, pid: pid, windowNumber: windowNumber,
        title: String(title.prefix(300)), url: url,
        focusedRole: focusedElement.flatMap { string($0, kAXRoleAttribute as String) } ?? "",
        focusedTitle: focusedElement.flatMap { string($0, kAXTitleAttribute as String) } ?? "",
        text: String(staticTexts.joined(separator: "\n").prefix(4000)), candidates: candidates)
}
func resolvePath(_ window: AXUIElement, path: [Int]) -> AXUIElement? {
    var node = window
    for index in path {
        let items = children(node)
        guard index >= 0 && index < items.count else { return nil }
        node = items[index]
    }
    return node
}
guard let line = readLine(), let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data) else {
    emit(["event": "error", "code": "invalid_request"]); exit(2)
}
guard AXIsProcessTrusted() else { emit(["event": "error", "code": "accessibility_permission_required"]); exit(4) }
guard let testURL = URL(string: "https://example.com"), let appURL = NSWorkspace.shared.urlForApplication(toOpen: testURL),
      let defaultBundleId = Bundle(url: appURL)?.bundleIdentifier else { emit(["event": "error", "code": "no_default_browser"]); exit(3) }
guard let front = NSWorkspace.shared.frontmostApplication, front.bundleIdentifier == defaultBundleId,
      let window = focusedWindow(front.processIdentifier),
      let before = snapshot(bundleId: defaultBundleId, pid: front.processIdentifier, window: window) else {
    emit(["event": "error", "code": "default_browser_not_observable"]); exit(5)
}
if request.action == "observe" { emit(before.json()); exit(0) }
guard request.action == "click", let bundleId = request.bundleId, let pid = request.pid,
      let expectedURL = request.expectedURL, let path = request.path, path.count <= 24,
      let role = request.role, let title = request.title, let targetURL = request.targetURL,
      bundleId == defaultBundleId, pid == before.pid,
      (request.windowNumber == nil || request.windowNumber == before.windowNumber),
      before.url == expectedURL, role == "AXLink", safeNavigation(targetURL) == targetURL else {
    emit(["event": "error", "code": "stale_or_unsupported_target"]); exit(6)
}
let matches = before.candidates.filter { $0.path == path && $0.role == role && $0.title == title && $0.targetURL == targetURL }
guard matches.count == 1, let node = resolvePath(window, path: path),
      string(node, kAXRoleAttribute as String) == role,
      safeNavigation(string(node, "AXURL")) == targetURL else {
    emit(["event": "error", "code": "stale_or_unsupported_target"]); exit(6)
}
// The main process sends go only after its current-generation check and any required confirmation.
emit(["event": "ready"])
guard readLine() == "go" else { emit(["event": "error", "code": "dispatch_cancelled"]); exit(8) }
guard let stillFront = NSWorkspace.shared.frontmostApplication,
      stillFront.processIdentifier == pid, let currentWindow = focusedWindow(pid),
      let current = snapshot(bundleId: bundleId, pid: pid, window: currentWindow),
      current.url == expectedURL,
      (request.windowNumber == nil || current.windowNumber == request.windowNumber),
      current.candidates.contains(where: { $0.path == path && $0.role == role && $0.title == title && $0.targetURL == targetURL }),
      let currentNode = resolvePath(currentWindow, path: path) else {
    emit(["event": "error", "code": "stale_or_unsupported_target"]); exit(6)
}
emit(["event": "dispatching"])
guard AXUIElementPerformAction(currentNode, kAXPressAction as CFString) == .success else {
    emit(["event": "error", "code": "ax_press_failed"]); exit(7)
}
emit(["event": "dispatched"])
let deadline = Date().addingTimeInterval(6)
while Date() < deadline {
    if let active = NSWorkspace.shared.frontmostApplication, active.bundleIdentifier == bundleId,
       let nextWindow = focusedWindow(active.processIdentifier),
       let after = snapshot(bundleId: bundleId, pid: active.processIdentifier, window: nextWindow),
       after.url == targetURL { emit(after.json()); exit(0) }
    Thread.sleep(forTimeInterval: 0.15)
}
emit(["event": "error", "code": "postcondition_unobserved"]); exit(9)
