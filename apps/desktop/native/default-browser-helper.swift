import AppKit
import ApplicationServices
import Foundation

// One JSON request per process. This helper never types into a browser, imports a
// profile, or sends a page event. The caller terminates it to stop observation.
struct Request: Decodable {
    let action: String
    let url: String?
    let bundleId: String?
    let pid: Int32?
    let windowNumber: Int?
    let expectedURL: String?
    let timeoutMs: Int?
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let string = value as? String { return string }
    if let url = value as? URL { return url.absoluteString }
    return nil
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
    let names = [kAXChildrenAttribute as String, kAXVisibleChildrenAttribute as String]
    for name in names {
        if let children = attribute(element, name) as? [AXUIElement] { return children }
    }
    return []
}

func normalizedWebURL(_ value: String?) -> String? {
    guard var value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
    if !value.contains("://") && value.contains(".") && !value.contains(" ") { value = "https://" + value }
    guard let url = URL(string: value), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
          url.host != nil, url.user == nil, url.password == nil else { return nil }
    return url.absoluteString
}

struct Observation {
    let title: String
    let url: String
    let pid: Int32
    let windowNumber: Int?
    let text: String

    func json(includeText: Bool) -> [String: Any] {
        var value: [String: Any] = ["event": "observed", "title": title, "url": url, "pid": pid]
        if let windowNumber { value["windowNumber"] = windowNumber }
        if includeText { value["text"] = text }
        return value
    }
}

func observeWindow(_ window: AXUIElement, pid: Int32, includeText: Bool) -> Observation? {
    let title = stringAttribute(window, kAXTitleAttribute as String) ?? ""
    let windowNumber = (attribute(window, "AXWindowNumber") as? NSNumber)?.intValue
    var addressURLs: [String] = []
    var documentURLs: [String] = []
    var pageText: [String] = []
    var queue: [(AXUIElement, Bool)] = [(window, false)]
    var index = 0
    let walkDeadline = Date().addingTimeInterval(0.6)
    // Fixed node, depth-independent and text bounds keep inaccessible or huge
    // pages from monopolizing a voice operation.
    while index < queue.count && index < 1400 && Date() < walkDeadline {
        let (element, insideWebArea) = queue[index]
        index += 1
        let role = stringAttribute(element, kAXRoleAttribute as String) ?? ""
        let isWebArea = insideWebArea || role == "AXWebArea"
        // Only a document URL or a browser address field can identify the page.
        // URL-looking text in page content is never a navigation receipt.
        if role == "AXWebArea", let candidate = normalizedWebURL(stringAttribute(element, "AXURL")) {
            if !documentURLs.contains(candidate) { documentURLs.append(candidate) }
        }
        if ["AXTextField", "AXComboBox"].contains(role),
           let candidate = normalizedWebURL(stringAttribute(element, kAXValueAttribute as String)) {
            if !addressURLs.contains(candidate) { addressURLs.append(candidate) }
        }
        if includeText && isWebArea && role == (kAXStaticTextRole as String) {
            if let value = stringAttribute(element, kAXValueAttribute as String), !value.isEmpty {
                pageText.append(value)
            }
        }
        if queue.count < 1400 { queue.append(contentsOf: childElements(element).map { ($0, isWebArea) }) }
    }
    // Prefer the browser address field. Distinct address values or a mismatch
    // with the primary document means navigation is still in progress.
    guard addressURLs.count <= 1 else { return nil }
    let url = addressURLs.first ?? documentURLs.first
    if let address = addressURLs.first, let document = documentURLs.first,
       address != document { return nil }
    guard let url, !title.isEmpty else { return nil }
    return Observation(title: String(title.prefix(300)), url: url, pid: pid,
                       windowNumber: windowNumber, text: String(pageText.joined(separator: "\n").prefix(4000)))
}

func observations(bundleId: String, pid: Int32?, includeText: Bool, focusedOnly: Bool = false) -> [Observation] {
    let applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        .filter { pid == nil || $0.processIdentifier == pid }
    var result: [Observation] = []
    for application in applications {
        let appElement = AXUIElementCreateApplication(application.processIdentifier)
        if focusedOnly && !application.isActive { continue }
        let windows: [AXUIElement]
        if focusedOnly {
            guard let value = attribute(appElement, kAXFocusedWindowAttribute as String),
                  CFGetTypeID(value) == AXUIElementGetTypeID() else { continue }
            let window = value as! AXUIElement
            windows = [window]
        } else {
            guard let all = attribute(appElement, kAXWindowsAttribute as String) as? [AXUIElement] else { continue }
            windows = all
        }
        for window in windows.prefix(30) {
            if let observed = observeWindow(window, pid: application.processIdentifier, includeText: includeText) {
                result.append(observed)
            }
        }
    }
    return result
}

guard let line = readLine(), let data = line.data(using: .utf8),
      let request = try? JSONDecoder().decode(Request.self, from: data) else {
    emit(["event": "error", "code": "invalid_request"])
    exit(2)
}

if request.action == "resolve" {
    guard let url = URL(string: "https://example.com"),
          let appURL = NSWorkspace.shared.urlForApplication(toOpen: url),
          let bundleId = Bundle(url: appURL)?.bundleIdentifier else {
        emit(["event": "error", "code": "no_default_browser"])
        exit(3)
    }
    emit(["event": "resolved", "bundleId": bundleId, "applicationPath": appURL.path])
    exit(0)
}

guard AXIsProcessTrusted() else {
    emit(["event": "error", "code": "accessibility_permission_required"])
    exit(4)
}

if request.action == "read" {
    guard let bundleId = request.bundleId, let pid = request.pid else {
        emit(["event": "error", "code": "invalid_target"])
        exit(2)
    }
    let found = observations(bundleId: bundleId, pid: pid, includeText: true)
    let chosen: Observation?
    if let number = request.windowNumber {
        chosen = found.first { $0.windowNumber == number }
    } else {
        let matching = found.filter { $0.url == request.expectedURL }
        chosen = matching.count == 1 ? matching.first : nil
    }
    guard let chosen else {
        emit(["event": "error", "code": found.isEmpty ? "target_not_observed" : "ambiguous_target"])
        exit(5)
    }
    var receipt = chosen.json(includeText: true)
    receipt["bundleId"] = bundleId
    emit(receipt)
    exit(0)
}

guard request.action == "open", let rawURL = request.url,
      let url = URL(string: rawURL), url.scheme == "https", url.host != nil,
      url.user == nil, url.password == nil,
      let appURL = NSWorkspace.shared.urlForApplication(toOpen: url),
      let bundleId = Bundle(url: appURL)?.bundleIdentifier else {
    emit(["event": "error", "code": "invalid_or_unhandled_url"])
    exit(2)
}

emit(["event": "ready", "bundleId": bundleId])
guard readLine() == "go" else {
    emit(["event": "error", "code": "dispatch_cancelled"])
    exit(8)
}
emit(["event": "dispatching", "bundleId": bundleId])
guard NSWorkspace.shared.open(url) else {
    emit(["event": "error", "code": "launch_failed"])
    exit(6)
}
emit(["event": "dispatched", "bundleId": bundleId])

let deadline = Date().addingTimeInterval(Double(min(max(request.timeoutMs ?? 8000, 500), 20000)) / 1000)
while Date() < deadline {
    let found = observations(bundleId: bundleId, pid: nil, includeText: false, focusedOnly: true)
    if let match = found.first(where: { $0.url == url.absoluteString }) {
        var receipt = match.json(includeText: false)
        receipt["bundleId"] = bundleId
        emit(receipt)
        exit(0)
    }
    Thread.sleep(forTimeInterval: 0.15)
}
emit(["event": "error", "code": "observation_timeout", "bundleId": bundleId])
exit(7)
