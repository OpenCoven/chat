#if DEBUG
import UIKit
import ObjectiveC

/// Temporary #640 diagnostics, enabled only by the native UI test process.
@MainActor enum ConnectionMenuProbe {
  static var enabled: Bool { ProcessInfo.processInfo.environment["CHAT_MENU_PROBE"] == "1" }
  static func record(_ stage: String) {
    guard enabled else { return }
    print("CHAT_MENU_PROBE \(Date().timeIntervalSince1970) \(stage)")
  }
  static func install() {
    guard enabled,
      let original = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.sendEvent(_:))),
      let probe = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.chat_probe_sendEvent(_:)))
    else { return }
    method_exchangeImplementations(original, probe)
    record("installed pid=\(ProcessInfo.processInfo.processIdentifier)")
  }
}

extension UIApplication {
  @objc fileprivate func chat_probe_sendEvent(_ event: UIEvent) {
    if let touches = event.allTouches {
      for touch in touches where touch.phase == .began || touch.phase == .ended {
        let point = touch.location(in: touch.window)
        var ancestors: [String] = []
        var view = touch.view
        while let current = view, ancestors.count < 12 {
          ancestors.append(String(describing: type(of: current)))
          view = current.superview
        }
        ConnectionMenuProbe.record("touch phase=\(touch.phase.rawValue) point=\(point) window=\(String(describing: touch.window.map { String(describing: type(of: $0)) })) views=\(ancestors.joined(separator: ">"))")
      }
    }
    chat_probe_sendEvent(event)
  }
}
#endif
