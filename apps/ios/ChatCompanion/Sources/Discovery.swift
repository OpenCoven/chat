import Foundation
import Network

@MainActor final class Discovery {
  private var browser: NWBrowser?
  func start(fingerprint: String, found: @escaping (URL) -> Void) {
    stop()
    let browser = NWBrowser(
      for: .bonjourWithTXTRecord(type: "_coven-chat._tcp", domain: "local."), using: .tcp)
    self.browser = browser
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
