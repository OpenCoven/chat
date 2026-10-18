import Foundation
import Network
import dnssd

@MainActor final class Discovery {
  private var browser: NWBrowser?
  /// `access` reports whether iOS allows Local Network access, when the browser can tell.
  func start(
    fingerprint: String, found: @escaping (URL) -> Void, access: @escaping (Bool) -> Void = { _ in }
  ) {
    stop()
    let browser = NWBrowser(
      for: .bonjourWithTXTRecord(type: "_coven-chat._tcp", domain: "local."), using: .tcp)
    self.browser = browser
    browser.stateUpdateHandler = { [weak self, weak browser] state in
      guard let denied = LocalNetwork.denies(state) else { return }
      Task { @MainActor in
        guard let self, let browser, self.browser === browser else { return }
        access(!denied)
      }
    }
    browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
      Task { @MainActor in
        guard let self, let browser, self.browser === browser else { return }
        for result in results {
          guard case .bonjour(let record) = result.metadata,
            record.dictionary["fingerprint"] == fingerprint,
            let raw = record.dictionary["url"], let url = URL(string: raw),
            Pairing.validEndpoint(url)
          else { continue }
          found(url)
        }
      }
    }
    browser.start(queue: .main)
  }
  func stop() {
    browser?.cancel()
    browser = nil
  }
}

/// Local Network privacy has no API that reports its state; these are the two checks
/// Apple's TN3179 describes, one for Bonjour and one for a TCP connection.
enum LocalNetwork {
  /// True when the browser waits because Local Network access is denied, false once it
  /// browses, nil when its state says nothing about access.
  static func denies(_ state: NWBrowser.State) -> Bool? {
    switch state {
    case .ready: return false
    case .waiting(.dns(let code)) where Int(code) == kDNSServiceErr_PolicyDenied: return true
    default: return nil
    }
  }

  /// After a failed pairing attempt, asks whether Local Network access blocked the Mac's
  /// address. Answers false when it did not, or when the answer does not come in time.
  @MainActor static func blocks(_ endpoint: URL, within seconds: Double = 2) async -> Bool {
    guard let host = endpoint.host,
      let port = NWEndpoint.Port(rawValue: UInt16(clamping: endpoint.port ?? 443))
    else { return false }
    let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: .tcp)
    return await withCheckedContinuation { continuation in
      let answer = Answer(connection: connection, continuation: continuation)
      connection.stateUpdateHandler = { state in
        switch state {
        case .waiting:
          answer.give(connection.currentPath?.unsatisfiedReason == .localNetworkDenied)
        case .ready, .failed, .cancelled: answer.give(false)
        default: break
        }
      }
      connection.start(queue: .main)
      DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { answer.give(false) }
    }
  }

  /// Answers once and closes the probe. Every caller runs on the main queue.
  private final class Answer: @unchecked Sendable {
    private let connection: NWConnection
    private var continuation: CheckedContinuation<Bool, Never>?
    init(connection: NWConnection, continuation: CheckedContinuation<Bool, Never>) {
      self.connection = connection
      self.continuation = continuation
    }
    func give(_ blocked: Bool) {
      guard let continuation else { return }
      self.continuation = nil
      connection.cancel()
      continuation.resume(returning: blocked)
    }
  }
}
