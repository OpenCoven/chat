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
/// A familiar's open request for write access. Older Macs don't send these.
struct Approval: Codable, Identifiable, Equatable {
  let id: String
  let familiarId: String
  let summary: String
  var reason: String?
  let requestedAt: Double
  let expiresAt: Double
}
struct Snapshot: Codable {
  let version: Int
  let familiars: [Familiar]
  let sessions: [ChatSession]
  let activeRun: Run?
  var pendingApprovals: [Approval]? = nil
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
/// The phone names the request and the answer. The chat, the permission and the
/// words of the allowed turn are the Mac's.
struct ApprovalAnswer: Codable, Equatable {
  let requestId: String
  let approvalId: String
  let decision: String
}
struct ApprovalResult: Codable {
  let status: String
  var run: Run?
}
struct PermissionLogEntry: Codable, Equatable {
  let at: Double
  let event: String
  let approvalId: String
  let familiarId: String
  var summary: String?
  var device: String?
  var tool: String?
  var detail: String?
  var outcome: String?

  func line(name: String) -> String {
    let device = device == "iphone" ? "iPhone" : "your computer"
    let summary = summary ?? ""
    switch event {
    case "requested": return "\(name) asked: \(summary)"
    case "allowed": return "Allowed on \(device) for \(name): \(summary)"
    case "declined": return "Declined on \(device) for \(name): \(summary)"
    case "superseded": return "A new message replaced \(name)'s request: \(summary)"
    case "action":
      let tool = tool ?? "a tool"
      return "\(name) used \(tool)\(detail.map { ": \($0)" } ?? "")"
    case "finished":
      return "\(name)'s allowed turn \(outcome == "completed" ? "finished" : outcome ?? "ended")."
    default: return "\(name): \(event)"
    }
  }
}
struct PermissionLog: Codable {
  let entries: [PermissionLogEntry]
}
@MainActor protocol CompanionClient: AnyObject {
  func snapshot() async throws -> Snapshot
  func history(familiarId: String) async throws -> History
  func send(_ request: SendRequest) async throws -> Run
  func run(id: String) async throws -> Run
  func stop(id: String) async throws
  func answer(_ answer: ApprovalAnswer) async throws -> ApprovalResult
  func permissionLog() async throws -> PermissionLog
  func invalidate()
}
