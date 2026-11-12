// DSHNotify - tiny macOS notification helper for DeepSeek Harness.
// Runs as a persistent accessory app: the host plugin writes one JSON object
// per line on stdin, this process posts a native user notification for each.
// stdout answers one JSON object per request: {"ok":true} or {"ok":false,"error":"..."}.
import Foundation
import UserNotifications
import AppKit

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

var authorizationStatus: UNAuthorizationStatus = .notDetermined
var pending: [UNNotificationRequest] = []

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                               willPresent notification: UNNotification,
                               withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                               didReceive response: UNNotificationResponse,
                               withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let bundleId = info["activateBundleId"] as? String, !bundleId.isEmpty {
            for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleId) {
                app.activate(options: [.activateIgnoringOtherApps])
            }
            if let target = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
                _ = target
            } else if let path = info["appPath"] as? String, !path.isEmpty {
                let c = Process()
                c.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                c.arguments = ["-a", path]
                try? c.run()
            }
        } else if let raw = info["url"] as? String, let url = URL(string: raw), !raw.isEmpty {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
    }
}

let center = UNUserNotificationCenter.current()
let delegate = Delegate()
center.delegate = delegate

func flushPending() {
    let queued = pending
    pending = []
    for request in queued {
        center.add(request) { error in
            if let error {
                emit(["ok": false, "error": "\(error.localizedDescription)"])
            } else {
                emit(["ok": true])
            }
        }
    }
}

func authorize() {
    center.getNotificationSettings { settings in
        authorizationStatus = settings.authorizationStatus
        if settings.authorizationStatus == .notDetermined {
            center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                center.getNotificationSettings { updated in
                    authorizationStatus = updated.authorizationStatus
                    emit(["ok": true, "authorized": granted, "status": updated.authorizationStatus.rawValue,
                          "note": error.map { "\($0.localizedDescription)" } ?? ""])
                    flushPending()
                }
            }
        } else {
            emit(["ok": true, "authorized": settings.authorizationStatus == .authorized,
                  "status": settings.authorizationStatus.rawValue])
            flushPending()
        }
    }
}

func deliver(_ json: [String: Any]) {
    if let frontmost = json["skipIfFrontmost"] as? [String], !frontmost.isEmpty,
       let current = NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
       frontmost.contains(current) {
        emit(["ok": true, "skipped": true])
        return
    }

    let content = UNMutableNotificationContent()
    content.title = json["title"] as? String ?? "DeepSeek Harness"
    if let subtitle = json["subtitle"] as? String, !subtitle.isEmpty { content.subtitle = subtitle }
    content.body = json["body"] as? String ?? ""
    if let sound = json["sound"] as? String, !sound.isEmpty {
        content.sound = UNNotificationSound(named: UNNotificationSoundName(sound))
    }
    var info: [String: Any] = [:]
    if let bundleId = json["activateBundleId"] as? String { info["activateBundleId"] = bundleId }
    if let path = json["appPath"] as? String { info["appPath"] = path }
    if let url = json["url"] as? String { info["url"] = url }
    content.userInfo = info
    if let thread = json["thread"] as? String, !thread.isEmpty { content.threadIdentifier = thread }

    let request = UNNotificationRequest(identifier: json["id"] as? String ?? UUID().uuidString,
                                        content: content, trigger: nil)

    guard authorizationStatus == .authorized || authorizationStatus == .provisional else {
        pending.append(request)
        authorize()
        return
    }

    center.add(request) { error in
        if let error {
            emit(["ok": false, "error": "\(error.localizedDescription)"])
        } else {
            emit(["ok": true])
        }
    }
}

func handle(line: Data) {
    guard let json = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
        emit(["ok": false, "error": "invalid json"])
        return
    }
    if json["probe"] != nil {
        center.getNotificationSettings { settings in
            center.getDeliveredNotifications { delivered in
                emit(["ok": true, "status": settings.authorizationStatus.rawValue,
                      "delivered": delivered.count])
            }
        }
        return
    }
    if json["quit"] != nil { exit(0) }
    deliver(json)
}

// stdin: one JSON object per line, EOF means the host is gone.
var buffer = Data()
var stdinClosedAt: Date?
FileHandle.standardInput.readabilityHandler = { fh in
    let chunk = fh.availableData
    if chunk.isEmpty {
        // The host is gone (or we were launched by LaunchServices without a pipe).
        // Stay alive for a while so a first-run permission alert can be answered,
        // then leave so no orphan process is left behind.
        if stdinClosedAt == nil { stdinClosedAt = Date() }
        return
    }
    buffer.append(chunk)
    while let newline = buffer.firstIndex(of: 0x0A) {
        let line = buffer[buffer.startIndex..<newline]
        buffer.removeSubrange(buffer.startIndex...newline)
        if !line.isEmpty { handle(line: Data(line)) }
    }
}

// One-shot mode: `--title/--body` posted once, then exit. Used to test delivery
// when the helper is started by LaunchServices (`open`) instead of the host pipe.
if let bodyIndex = CommandLine.arguments.firstIndex(of: "--body") {
    func value(_ flag: String) -> String {
        if let i = CommandLine.arguments.firstIndex(of: flag), i + 1 < CommandLine.arguments.count {
            return CommandLine.arguments[i + 1]
        }
        return ""
    }
    _ = bodyIndex
    var json: [String: Any] = ["title": value("--title"), "body": value("--body")]
    let subtitleValue = value("--subtitle")
    if !subtitleValue.isEmpty { json["subtitle"] = subtitleValue }
    let threadValue = value("--thread")
    if !threadValue.isEmpty { json["thread"] = threadValue }
    json["activateBundleId"] = "com.deepseek.dsh"
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        deliver(json)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(0) }
    }
}

// Probe mode: report current permission and exit (used for diagnostics).
if CommandLine.arguments.contains("--probe") {
    center.getNotificationSettings { settings in
        center.getDeliveredNotifications { delivered in
            emit(["ok": true, "status": settings.authorizationStatus.rawValue, "delivered": delivered.count])
            exit(0)
        }
    }
    RunLoop.current.run(until: Date().addingTimeInterval(5))
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = nil

// Ask for permission up front so the user can approve the helper right away.
authorize()

// Leave after two idle minutes once the host pipe closed (see stdinClosedAt).
Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    if let closedAt = stdinClosedAt, Date().timeIntervalSince(closedAt) > 120 { exit(0) }
}

app.run()
