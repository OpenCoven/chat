import CryptoKit
import Foundation
import Security

/// Only talks to the opt-in test proxy; none of these routes exist in the app host.
final class FixtureControl: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
  struct Stats: Decodable {
    let sendCount: Int
    let lastRequestID: String?
    let receiptIDs: [String]
  }
  private let endpoint: URL
  private let token: String
  private let fingerprint: String
  private var session: URLSession!
  init(_ fixture: [String: String]) throws {
    let parts = URLComponents(string: fixture["pairingLink"]!)!
    token = parts.queryItems!.first { $0.name == "token" }!.value!
    fingerprint = parts.queryItems!.first { $0.name == "fingerprint" }!.value!
    endpoint = URL(string: fixture["endpoint"]!)!
    super.init()
    session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
  }
  func invalidate() { session.invalidateAndCancel() }
  func change(_ values: [String: Bool]? = nil) async throws -> Stats {
    var request = URLRequest(url: endpoint.appendingPathComponent("__fixture/control"))
    request.httpMethod = values == nil ? "GET" : "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let values {
      request.httpBody = try JSONSerialization.data(withJSONObject: values)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await session.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw NSError(domain: "FixtureControl", code: 1)
    }
    return try JSONDecoder().decode(Stats.self, from: data)
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let cert = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
      SHA256.hash(data: SecCertificateCopyData(cert) as Data).map({ String(format: "%02x", $0) }).joined() == fingerprint
    else { completionHandler(.cancelAuthenticationChallenge, nil); return }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
