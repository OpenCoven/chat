import SwiftUI

/// A familiar's request for write access, above the composer. The words are the
/// familiar's. What Allow does is Chat's own sentence, because no summary can
/// narrow it, and a phone in a pocket gets one more question than a Mac.
struct ApprovalCard: View {
  let approval: Approval
  let name: String
  let canAllow: Bool
  let answering: Bool
  let onAllow: () -> Void
  let onDecline: () -> Void
  @State private var confirming = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("\(name) asks for permission", systemImage: "hand.raised.fill")
        .font(.subheadline.weight(.semibold)).foregroundStyle(Palette.textPrimary)
      Text(approval.summary).font(.subheadline).foregroundStyle(Palette.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("approval-summary")
      if let reason = approval.reason {
        Text(reason).font(.footnote).foregroundStyle(Palette.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      HStack(spacing: 10) {
        Button("Allow once") { confirming = true }
          .buttonStyle(.borderedProminent)
          .disabled(!canAllow || answering)
          .accessibilityIdentifier("approval-allow")
        Button("Decline", action: onDecline)
          .buttonStyle(.bordered)
          .disabled(answering)
          .accessibilityIdentifier("approval-decline")
      }
      .font(.subheadline.weight(.semibold))
      if !canAllow {
        Text("Allow once is available when the current run ends.")
          .font(.caption).foregroundStyle(Palette.textSecondary)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .glass(.raised, cornerRadius: 16)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("approval-card")
    .confirmationDialog(
      "Allow \(name) to make changes?", isPresented: $confirming, titleVisibility: .visible
    ) {
      Button("Allow once", action: onAllow).accessibilityIdentifier("approval-confirm")
      Button("Not now", role: .cancel) {}
    } message: {
      Text(
        "\(approval.summary)\n\n\(name) can change files and run commands on your Mac as you, for one turn. That access isn't limited to what's described here. Chat logs your answer and each tool call Coven reports."
      )
    }
  }
}

/// What familiars asked for, how each was answered, and what the allowed turns did.
struct PermissionLogView: View {
  let model: CompanionModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      content
        .background(Palette.bgBase.ignoresSafeArea())
        .navigationTitle("Permission Log").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .task { await model.loadPermissionLog() }
    .presentationDragIndicator(.visible)
  }

  @ViewBuilder private var content: some View {
    if let failure = model.permissionLogError {
      ContentUnavailableView(
        "Can't read the log", systemImage: "exclamationmark.triangle", description: Text(failure))
    } else if let entries = model.permissionLog {
      if entries.isEmpty {
        ContentUnavailableView(
          "Nothing yet", systemImage: "hand.raised",
          description: Text(
            "When a familiar asks for permission, the request, your answer and each tool call Coven reports from the allowed turn appear here."
          ))
      } else {
        List(Array(entries.enumerated()), id: \.offset) { _, entry in
          VStack(alignment: .leading, spacing: 2) {
            Text(entry.line(name: model.name(ofFamiliar: entry.familiarId)))
              .font(.footnote).foregroundStyle(Palette.textPrimary)
            Text(Date(timeIntervalSince1970: entry.at / 1000), format: .dateTime)
              .font(.caption2).foregroundStyle(Palette.textMuted)
          }
          .accessibilityElement(children: .combine)
          .listRowBackground(Color.clear)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .accessibilityIdentifier("permission-log")
      }
    } else {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
}
