import SwiftUI

struct CompanionRoot: View {
  @Bindable var model: CompanionModel
  @Environment(\.scenePhase) private var phase
  @State private var link = ""
  @State private var scanner = false
  @State private var forget = false
  @State private var dismissSend = false
  @State private var discovery = Discovery()
  @State private var candidates: [URL] = []
  @State private var candidateIndex = 0
  var body: some View {
    NavigationStack {
      Group {
        if model.pairing == nil { welcome } else { workspace }
      }
      .navigationTitle(model.pairing == nil ? "Coven Chat" : "Familiars")
      .toolbar {
        if model.pairing != nil {
          ToolbarItem(placement: .topBarTrailing) {
            Menu {
              Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
              Button("Forget Mac", systemImage: "link.badge.plus", role: .destructive) {
                forget = true
              }
            } label: {
              Image(systemName: "ellipsis.circle").accessibilityLabel("Connection options")
            }
          }
        }
      }
      .confirmationDialog("Forget this Mac?", isPresented: $forget, titleVisibility: .visible) {
        Button("Forget Mac", role: .destructive) {
          discovery.stop()
          model.forget()
        }
      } message: {
        Text("You will need a new pairing link to connect again. Your chats remain on the Mac.")
      }
      .confirmationDialog(
        "Have you checked the conversation on your Mac?", isPresented: $dismissSend,
        titleVisibility: .visible
      ) {
        Button("I checked — dismiss uncertain send") { model.dismissUncertainSend() }
      } message: {
        Text(
          "The previous send might have reached the Mac. Check before sending the same message again."
        )
      }
      .sheet(isPresented: $scanner) {
        NavigationStack {
          PairingScanner { value in
            link = value
            scanner = false
          }
          .ignoresSafeArea(edges: .bottom)
          .navigationTitle("Scan Mac's pairing code")
          .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanner = false } }
          }
        }
      }
    }
    .tint(.purple)
    .overlay {
      if phase != .active {
        Color(.systemBackground).ignoresSafeArea().overlay {
          Label("Coven Chat", systemImage: "sparkle").font(.title2)
        }
      }
    }
    .onOpenURL { url in if model.pairing == nil { link = url.absoluteString } }
    .task(id: "\(phase == .active)-\(model.pairing?.fingerprint ?? "")") {
      discovery.stop()
      guard phase == .active, let pairing = model.pairing else { return }
      candidates = []
      candidateIndex = 0
      discovery.start(fingerprint: pairing.fingerprint) { endpoint in
        if !candidates.contains(endpoint) {
          candidates.append(endpoint)
          if candidates.count > 4 { candidates.removeFirst() }
        }
      }
      while !Task.isCancelled {
        await model.refresh()
        if !model.connected, !candidates.isEmpty {
          let candidate = candidates[candidateIndex % candidates.count]
          candidateIndex += 1
          await model.tryEndpoint(candidate)
        }
        try? await Task.sleep(
          for: .seconds(model.activeRun?.running == true || model.pendingRunId != nil ? 1 : 4))
      }
      discovery.stop()
    }
  }
  private var welcome: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        Image(systemName: "sparkles.rectangle.stack").font(.system(size: 52)).foregroundStyle(
          .purple
        ).accessibilityHidden(true)
        Text("Your familiars,\nwhere you are.").font(.largeTitle.bold())
        Text(
          "Connect to Chat on your Mac to read conversations and send a message. Your Mac runs Coven and keeps your chat history."
        ).foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 12) {
          Text("1. On your Mac, open Sidebar options (⋯), then iPhone companion.")
          Text("2. Turn on companion. Keep both devices on the same local network.")
          Button {
            scanner = true
          } label: {
            Label("Pair with your Mac", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
              .padding(.vertical, 6)
          }
          .buttonStyle(.borderedProminent)
          TextField("Paste pairing link", text: $link, axis: .vertical)
            .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .lineLimit(2...4).accessibilityIdentifier("pairing-link")
          Button(model.busy ? "Connecting…" : "Connect") {
            let value = link
            Task {
              await model.pair(link: value)
              if model.pairing != nil { link = "" }
            }
          }.buttonStyle(.bordered).disabled(link.isEmpty || model.busy).accessibilityIdentifier(
            "connect")
        }
        if !model.error.isEmpty {
          Text(model.error).foregroundStyle(.red).accessibilityIdentifier("connection-error")
        }
        if model.needsPairingCleanup { Button("Retry forgetting Mac") { model.forget() } }
        Text(
          "Pairing links grant access to your conversations. Only use the code from your own Mac."
        ).font(.footnote).foregroundStyle(.secondary)
      }.padding(24).frame(maxWidth: 560)
    }
  }
  private var workspace: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        Label(model.status, systemImage: model.connected ? "checkmark.circle" : "wifi.slash")
          .font(.caption).foregroundStyle(model.connected ? Color.secondary : Color.orange)
          .accessibilityIdentifier("connection-status")
        if !model.familiars.isEmpty {
          Picker(
            "Familiar",
            selection: Binding(
              get: { model.selectedId ?? "" }, set: { value in Task { await model.select(value) } })
          ) {
            ForEach(model.familiars) { familiar in Text(familiar.displayName).tag(familiar.id) }
          }.pickerStyle(.menu).accessibilityIdentifier("familiar-picker")
        }
        if !model.error.isEmpty {
          Text(model.error).font(.callout).foregroundStyle(.red).accessibilityIdentifier(
            "connection-error")
          if model.pendingRunId != nil && model.activeRun?.running != true {
            Button("Review uncertain send") { dismissSend = true }.font(.callout)
          }
        }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal).padding(.vertical, 10)
      Divider()
      if model.familiars.isEmpty {
        ContentUnavailableView(
          "No familiars", systemImage: "sparkles",
          description: Text(
            model.connected
              ? "Configure a familiar in Coven on your Mac, then refresh."
              : "Waiting for your Mac to reconnect."))
      } else {
        transcript
      }
      Divider()
      composer
    }
  }
  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 20) {
          if model.hasMore {
            Text("Showing recent history. Open Chat on your Mac for earlier turns.").font(.footnote)
              .foregroundStyle(.secondary)
          }
          if model.messages.isEmpty && model.shownRun == nil {
            Text("Start a conversation with your familiar.").foregroundStyle(.secondary).padding(
              .top, 32)
          }
          ForEach(model.messages) { message in MessageRow(message: message) }
          if let run = model.shownRun {
            ForEach(run.messages) { message in MessageRow(message: message) }
            if model.activeRun?.running == true {
              Label("Responding…", systemImage: "ellipsis").font(.callout).foregroundStyle(
                .secondary
              ).accessibilityIdentifier("run-status")
            }
          }
          Color.clear.frame(height: 1).id("latest")
        }.padding().frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(.bottom)
      .onChange(of: model.selectedId) { _, _ in proxy.scrollTo("latest", anchor: .bottom) }
      .accessibilityIdentifier("transcript")
    }
  }
  private var composer: some View {
    VStack(alignment: .leading, spacing: 10) {
      if model.archived {
        Text("This chat is archived. Restore it on your Mac to send a message.").font(.callout)
          .foregroundStyle(.secondary)
      }
      if let run = model.activeRun, run.running, run.familiarId != model.selectedId {
        Text("Another familiar is responding.").font(.caption).foregroundStyle(.secondary)
      }
      HStack(alignment: .bottom, spacing: 12) {
        TextField("Message your familiar", text: $model.draft, axis: .vertical)
          .lineLimit(1...6).textFieldStyle(.roundedBorder).disabled(
            model.selectedId == nil || model.archived
          )
          .accessibilityIdentifier("composer")
        if model.activeRun?.running == true {
          Button("Stop", systemImage: "stop.fill") { Task { await model.stop() } }
            .labelStyle(.iconOnly).buttonStyle(.bordered).disabled(model.busy)
            .accessibilityIdentifier("stop")
        } else {
          Button("Send", systemImage: "arrow.up") { Task { await model.send() } }
            .labelStyle(.iconOnly).buttonStyle(.borderedProminent).disabled(!model.canSend)
            .accessibilityIdentifier("send")
        }
      }
      if model.draft.utf8.count > 32768 {
        Text("Message is too long (maximum 32,768 bytes).").font(.caption).foregroundStyle(.red)
      }
    }.padding().background(.bar)
  }
}

private struct MessageRow: View {
  let message: Message
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(message.role == "user" ? "You" : message.role == "assistant" ? "Familiar" : "Activity")
        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      Text(message.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }.padding(message.role == "user" ? 14 : 0)
      .background(
        message.role == "user" ? Color.purple.opacity(0.08) : Color.clear,
        in: RoundedRectangle(cornerRadius: 16)
      )
      .accessibilityElement(children: .combine)
  }
}
