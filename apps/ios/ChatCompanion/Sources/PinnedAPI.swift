import CryptoKit
import Foundation
import Security

final class PinnedAPI: NSObject, CompanionClient, URLSessionDelegate, URLSessionTaskDelegate {
  nonisolated let pairing: Pairing
  private var session: URLSession!
  init(pairing: Pairing) {
    self.pairing = pairing
    super.init()
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 12
    config.timeoutIntervalForResource = 65
    config.urlCache = nil
    config.httpCookieStorage = nil
    config.urlCredentialStorage = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }
  func invalidate() { session.invalidateAndCancel() }
  nonisolated static func matches(certificate: Data, fingerprint: String) -> Bool {
    SHA256.hash(data: certificate).map { String(format: "%02x", $0) }.joined() == fingerprint
  }
  nonisolated func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      challenge.protectionSpace.host == pairing.endpoint.host,
      let trust = challenge.protectionSpace.serverTrust,
      let cert = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
      Self.matches(
        certificate: SecCertificateCopyData(cert) as Data, fingerprint: pairing.fingerprint)
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
  nonisolated func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    urlSession(session, didReceive: challenge, completionHandler: completionHandler)
  }
  nonisolated func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
  func snapshot() async throws -> Snapshot {
    let result: Snapshot = try await request("snapshot")
    guard result.version == 1 else {
      throw CompanionError.message("Update Chat on your Mac and iPhone to compatible versions.")
    }
    return result
  }
  func history(familiarId: String) async throws -> History {
    try await request("history", query: [URLQueryItem(name: "familiarId", value: familiarId)])
  }
  func send(_ value: SendRequest) async throws -> Run {
    try await request("send", body: JSONEncoder().encode(value))
  }
  func run(id: String) async throws -> Run {
    try await request("run", query: [URLQueryItem(name: "id", value: id)])
  }
  func stop(id: String) async throws {
    struct Stopped: Decodable { let ok: Bool }
    let result: Stopped = try await request(
      "stop", body: JSONSerialization.data(withJSONObject: ["runId": id]))
    guard result.ok else { throw CompanionError.message("The Mac could not stop this run.") }
  }
  private func request<T: Decodable>(_ path: String, query: [URLQueryItem] = [], body: Data? = nil)
    async throws -> T
  {
    guard Pairing.validEndpoint(pairing.endpoint) else {
      throw CompanionError.message("Pair with your Mac again.")
    }
    var c = URLComponents(
      url: pairing.endpoint.appending(path: "v1/\(path)"), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { c.queryItems = query }
    var request = URLRequest(url: c.url!)
    request.httpMethod = body == nil ? "GET" : "POST"
    request.httpBody = body
    request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    // Async byte transfers use a task delegate for authentication and redirects.
    let (bytes, response) = try await session.bytes(for: request, delegate: self)
    guard let http = response as? HTTPURLResponse else {
      throw CompanionError.message("The Mac returned an invalid response.")
    }
    if http.statusCode == 401 { throw CompanionError.revoked }
    if http.statusCode == 404 && path == "run" { throw CompanionError.missingRun }
    guard (200...299).contains(http.statusCode) else {
      // Never echo addresses, credentials or arbitrary server bodies into diagnostics.
      throw CompanionError.message(
        http.statusCode == 409
          ? "The chat changed or another run is active. Refresh before sending."
          : "The Mac could not complete this request (\(http.statusCode)).")
    }
    var data = Data()
    for try await byte in bytes {
      guard data.count < 4 * 1024 * 1024 else {
        throw CompanionError.message(
          "This conversation is too large to display. Open it on your Mac.")
      }
      data.append(byte)
    }
    do { return try JSONDecoder().decode(T.self, from: data) } catch {
      throw CompanionError.message(
        "The Mac returned an unreadable response. Update both Chat apps.")
    }
  }
}
