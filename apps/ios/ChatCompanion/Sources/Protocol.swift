import Foundation

struct Familiar: Codable, Identifiable, Equatable {
  let id: String
  let name: String
  let displayName: String
  var description: String?
  var emoji: String?
}
struct ChatSession: Codable, Identifiable, Equatable {
  let id: String
  let familiarId: String
  let title: String
  let archived: Bool
}
struct Message: Codable, Identifiable, Equatable {
  let id: String
  let role: String
  let text: String
}
struct Run: Codable, Identifiable, Equatable {
  let id: String
  let familiarId: String
  let status: String
  let messages: [Message]
  var error: String?
  var running: Bool { status == "running" }
}
struct Snapshot: Codable {
  let version: Int
  let familiars: [Familiar]
  let sessions: [ChatSession]
  let activeRun: Run?
}
struct History: Codable {
  let sessionId: String?
  let messages: [Message]
  let hasMore: Bool
  var activeRunId: String? = nil
}
struct SendRequest: Codable, Equatable {
  let requestId: String
  let familiarId: String
  let sessionId: String?
  let prompt: String
  enum CodingKeys: String, CodingKey { case requestId, familiarId, sessionId, prompt }
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(requestId, forKey: .requestId)
    try c.encode(familiarId, forKey: .familiarId)
    try c.encode(sessionId, forKey: .sessionId)
    try c.encode(prompt, forKey: .prompt)
  }
}
@MainActor protocol CompanionClient: AnyObject {
  func snapshot() async throws -> Snapshot
  func history(familiarId: String) async throws -> History
  func send(_ request: SendRequest) async throws -> Run
  func run(id: String) async throws -> Run
  func stop(id: String) async throws
  func invalidate()
}
