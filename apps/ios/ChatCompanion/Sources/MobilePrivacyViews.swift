import SwiftUI

struct MobilePrivacyView: View {
  let model: CompanionModel
  @Environment(\.dismiss) private var dismiss
  @State private var clearing = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Toggle("Keep conversation text only while open", isOn: Binding(
            get: { !model.cacheConversationText },
            set: { model.setCacheConversationText(!$0) }))
            .accessibilityIdentifier("cache-conversation-text")
        } footer: {
          Text("Pairing credentials and minimal send-recovery metadata stay on this iPhone. In this mode, unsent text cannot be recovered after the app closes.")
        }
        Section {
          Button("Clear Downloaded History", role: .destructive) { clearing = true }
            .accessibilityIdentifier("clear-downloaded-history")
        } footer: {
          Text("Recent history is kept for up to seven days, within a 20 MiB limit. Phone storage is protected and excluded from backups. Your Mac keeps the authoritative history.")
        }
        if let failure = model.persistenceError {
          Section {
            Text(failure).foregroundStyle(Palette.danger)
              .accessibilityIdentifier("mobile-storage-error")
            Button("Retry Saving") { model.flushPersistence() }
          }
        }
      }
      .navigationTitle("Phone Privacy")
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .confirmationDialog("Clear downloaded history?", isPresented: $clearing, titleVisibility: .visible) {
        Button("Clear History", role: .destructive) { model.clearDownloadedHistory() }
      } message: {
        Text("Chats stay on your Mac. Unsent drafts and pending send recovery stay on this iPhone.")
      }
    }
    .modifier(CompanionInactiveCover())
  }
}

struct RecoveredDraftsView: View {
  let model: CompanionModel
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      List {
        ForEach(model.recoveredDrafts, id: \.binding) { record in
          RecoveredDraftEditor(record: record, model: model)
        }
      }
      .navigationTitle("Recovered Drafts")
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .modifier(CompanionInactiveCover())
  }
}

private struct RecoveredDraftEditor: View {
  let record: SavedDraft
  let model: CompanionModel
  @Environment(\.dismiss) private var dismiss
  @State private var namespace: CacheNamespace?
  @State private var destination: DraftBinding?
  init(record: SavedDraft, model: CompanionModel) {
    self.record = record
    self.model = model
    _namespace = State(initialValue: model.cacheNamespace)
    _destination = State(initialValue: model.draftDestination)
  }
  var body: some View {
    Section {
      Text(model.name(ofFamiliar: record.binding.familiarID)).font(.headline)
      Text(record.updatedAt, format: .dateTime.month().day().hour().minute()).font(.caption)
      Text("Saved for: \(record.conversationTitle ?? model.conversationLabel(for: record.binding))")
        .font(.footnote)
      Text("Destination: \(model.conversationLabel(for: destination))").font(.footnote)
      TextEditor(text: Binding(get: {
        guard model.cacheNamespace == namespace else { return "" }
        return model.recoveredDrafts.first { $0.binding == record.binding }?.text ?? ""
      }, set: { value in
        if let namespace {
          model.editRecoveredDraft(binding: record.binding, namespace: namespace, text: value)
        }
      })).frame(minHeight: 120)
        .accessibilityLabel("Recovered draft text")
        .accessibilityIdentifier("recovered-draft-editor")
      Button("Add to Current Draft") {
        guard let namespace, let destination else { return }
        model.restoreDraft(revision: record.revision, expectedDestination: destination, namespace: namespace)
        if !model.recoveredDrafts.contains(where: { $0.revision == record.revision }) { dismiss() }
      }
      .disabled(!model.connected || !model.historyReady || model.selectedId != record.binding.familiarID
        || model.cacheNamespace != namespace || model.draftDestination != destination)
      if model.cacheNamespace != namespace {
        Text("The connection changed. Close this sheet and review the draft again.").font(.footnote)
      } else if model.draftDestination != destination {
        Text("The conversation changed. Review the new destination before adding this draft.").font(.footnote)
        Button("Review Current Conversation") { destination = model.draftDestination }
          .disabled(!model.connected || !model.historyReady)
      }
    }
  }
}

/// Covers each presentation independently, including sheets containing recovered text.
struct CompanionInactiveCover: ViewModifier {
  @Environment(\.scenePhase) private var phase
  func body(content: Content) -> some View {
    content.overlay {
      if phase != .active {
        Palette.bgBase.ignoresSafeArea().overlay {
          Label {
            Text("Coven Chat")
          } icon: {
            Image("ChatLogo").resizable().scaledToFit().frame(width: 30, height: 30)
          }
          .font(.title2).foregroundStyle(Palette.textPrimary)
        }
      }
    }
  }
}
