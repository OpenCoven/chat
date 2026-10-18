import SwiftUI

struct CompanionRoot: View {
  @Bindable var model: CompanionModel
  @Environment(\.scenePhase) private var phase
  @State private var link = ""
  @State private var forget = false
  @State private var dismissSend = false
  @State private var discovery = Discovery()
  @State private var candidates: [URL] = []
  @State private var candidateIndex = 0
  var body: some View {
    NavigationStack {
      Group {
        if model.pairing == nil {
          PairingView(model: model, link: $link)
        } else {
          Workspace(model: model, forget: $forget, dismissSend: $dismissSend)
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
    }
    .tint(Palette.accent)
    .overlay {
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
    .onOpenURL { url in if model.pairing == nil { link = url.absoluteString } }
    .task(id: "\(phase == .active)-\(model.pairing?.fingerprint ?? "")") {
      discovery.stop()
      guard phase == .active, let pairing = model.pairing else { return }
      candidates = []
      candidateIndex = 0
      discovery.start(
        fingerprint: pairing.fingerprint,
        found: { endpoint in
          if !candidates.contains(endpoint) {
            candidates.append(endpoint)
            if candidates.count > 4 { candidates.removeFirst() }
          }
        },
        access: { allowed in model.localNetworkAccess(allowed: allowed) })
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
}

/// The paired screen: the chosen familiar in a glass header, its chat as a
/// Markdown reader, and a floating composer.
private struct Workspace: View {
  @Bindable var model: CompanionModel
  @Binding var forget: Bool
  @Binding var dismissSend: Bool
  @State private var picking = false
  @State private var details = false
  /// Set from Connection Details, which asks to forget only once it has closed:
  /// a confirmation cannot present while a sheet is still dismissing.
  @State private var forgetAfterDetails = false
  @State private var scroll = ScrollPosition(edge: .bottom)
  @State private var atBottom = true
  @FocusState private var composing: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var familiar: Familiar? { model.familiars.first { $0.id == model.selectedId } }
  private var replyingId: String? {
    model.activeRun?.running == true ? model.activeRun?.familiarId : nil
  }

  var body: some View {
    let page = content
      .safeAreaInset(edge: .top, spacing: 0) { header }
      .safeAreaInset(edge: .bottom, spacing: 0) { composer }
      .background(backdrop.ignoresSafeArea())
      .toolbarVisibility(.hidden, for: .navigationBar)
    return page
      .sheet(isPresented: $picking) { picker }
      .sheet(isPresented: $details) {
        if forgetAfterDetails {
          forgetAfterDetails = false
          forget = true
        }
      } content: {
        connection
      }
      .modifier(RunHaptics(pendingRunId: model.pendingRunId, running: model.activeRun?.running))
  }

  private var picker: some View {
    FamiliarPicker(
      familiars: model.familiars, sessions: model.sessions, selectedId: model.selectedId,
      respondingId: replyingId
    ) { id in Task { await model.select(id) } }
  }

  @ViewBuilder private var connection: some View {
    if let pairing = model.pairing {
      ConnectionDetails(
        pairing: pairing, status: model.status, connected: model.connected,
        familiarCount: model.familiars.count
      ) { forgetAfterDetails = true }
    }
  }

  private var backdrop: some View {
    ZStack {
      Palette.bgBase
      RadialGradient(
        colors: [Palette.accent.opacity(0.10), .clear], center: .init(x: 0.5, y: 0),
        startRadius: 0, endRadius: 420)
    }
  }

  // MARK: Header

  private var header: some View {
    HStack(spacing: 12) {
      if let familiar {
        FamiliarAvatar(familiar: familiar, size: 40, glowing: replyingId == familiar.id)
          .onTapGesture { picking = true }
        VStack(alignment: .leading, spacing: 2) {
          Button {
            picking = true
          } label: {
            HStack(spacing: 5) {
              Text(familiar.displayName).font(.headline).foregroundStyle(Palette.textPrimary)
                .lineLimit(1)
              Image(systemName: "chevron.down")
                .font(.caption.weight(.bold)).foregroundStyle(Palette.textMuted)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Familiar: \(familiar.displayName)")
          .accessibilityHint("Choose another familiar")
          .accessibilityIdentifier("familiar-picker")
          connectionLine
        }
      } else {
        Image("ChatLogo").resizable().scaledToFit().frame(width: 28, height: 28)
          .foregroundStyle(Palette.textPrimary).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text("Coven Chat").font(.headline).foregroundStyle(Palette.textPrimary)
          connectionLine
        }
      }
      Spacer(minLength: 8)
      Menu {
        Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
        Button("Connection Details", systemImage: "info.circle") { details = true }
        Divider()
        Button("Forget Mac", systemImage: "link.badge.plus", role: .destructive) {
          forget = true
        }
      } label: {
        Image(systemName: "ellipsis")
          .font(.body.weight(.semibold)).foregroundStyle(Palette.textPrimary)
          .frame(width: 40, height: 40)
          .glass(.control, cornerRadius: 20)
          .accessibilityLabel("Connection options")
      }
    }
    .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
    .background {
      Rectangle().fill(.ultraThinMaterial)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
        .ignoresSafeArea(edges: .top)
    }
  }

  private var connectionLine: some View {
    HStack(spacing: 6) {
      Circle().fill(model.connected ? Palette.online : Palette.warning).frame(width: 6, height: 6)
      Text(model.status).font(.caption).foregroundStyle(Palette.textSecondary).lineLimit(1)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("connection-status")
  }

  // MARK: Transcript

  @ViewBuilder private var content: some View {
    if model.familiars.isEmpty {
      ContentUnavailableView {
        Label("No familiars", systemImage: "sparkles")
      } description: {
        Text(
          model.connected
            ? "Configure a familiar in Coven on your Mac, then refresh."
            : "Waiting for your Mac to reconnect.")
      } actions: {
        if model.connected {
          Button("Refresh") { Task { await model.refresh() } }.buttonStyle(.bordered)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      transcript
    }
  }

  private var transcript: some View {
    let history = TranscriptItem.build(model.messages)
    let run = model.shownRun.map { TranscriptItem.build($0.messages) } ?? []
    return ScrollView {
      LazyVStack(alignment: .leading, spacing: 18) {
        if model.hasMore {
          NoticeView(
            text: "Showing recent history. Open Chat on your Mac for earlier turns.",
            symbol: "clock.arrow.circlepath")
        }
        ForEach(history) { item in row(item) }
        if model.shownRun != nil {
          ForEach(run) { item in row(item) }
          if model.activeRun?.running == true {
            WorkingIndicator(familiar: familiar, phase: Self.phase(run))
              .accessibilityIdentifier("run-status")
          }
        }
      }
      .padding(.horizontal, 18).padding(.vertical, 16)
      .frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
    }
    .scrollPosition($scroll)
    .defaultScrollAnchor(.bottom)
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await model.refresh() }
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.visibleRect.maxY >= geometry.contentSize.height - 80
    } action: { _, bottom in
      atBottom = bottom
    }
    .onChange(of: contentMark) { _, _ in
      if atBottom { withAnimation(reduceMotion ? nil : .smooth) { scroll.scrollTo(edge: .bottom) } }
    }
    .onChange(of: model.selectedId) { _, _ in scroll.scrollTo(edge: .bottom) }
    .overlay(alignment: .bottom) {
      if !atBottom {
        Button {
          withAnimation(reduceMotion ? nil : .smooth) { scroll.scrollTo(edge: .bottom) }
        } label: {
          Image(systemName: "arrow.down")
            .font(.subheadline.weight(.bold)).foregroundStyle(Palette.textPrimary)
            .frame(width: 38, height: 38)
            .glass(.control, cornerRadius: 19)
        }
        .accessibilityLabel("Scroll to latest")
        .padding(.bottom, 10)
        .transition(.scale(scale: 0.8).combined(with: .opacity))
      }
    }
    .overlay {
      // Outside the scroll view, which anchors short content to the bottom.
      if model.messages.isEmpty && model.shownRun == nil {
        if model.connected && !model.historyReady { ProgressView() } else { emptyState }
      }
    }
    .animation(reduceMotion ? nil : .snappy, value: atBottom)
    .accessibilityIdentifier("transcript")
  }

  /// Changes whenever the transcript grows, to follow it while at the bottom.
  private var contentMark: String {
    let run = model.shownRun
    return
      "\(model.messages.count)|\(run?.messages.count ?? 0)|\(run?.messages.last?.text.count ?? 0)|\(model.activeRun?.running == true)"
  }

  @ViewBuilder private func row(_ item: TranscriptItem) -> some View {
    switch item {
    case .user(_, let text):
      UserBubble(
        text: text,
        onReuse: model.draft.isEmpty && !model.archived
          ? {
            model.draft = text
            composing = true
          } : nil)
    case .reply(_, let text):
      ReplyView(text: text).equatable()
    case .tools(_, let calls):
      ToolGroupView(calls: calls)
    case .notice(_, let text):
      NoticeView(text: text)
    }
  }

  /// What the running reply is doing, from the last thing it wrote.
  static func phase(_ items: [TranscriptItem]) -> String {
    switch items.last {
    case .tools(_, let calls):
      calls.last(where: { $0.name != nil }).map { ToolKind(name: $0.name).progress } ?? "Working"
    case .reply: "Writing"
    default: "Thinking"
    }
  }

  private var emptyState: some View {
    VStack(spacing: 14) {
      FamiliarAvatar(familiar: familiar, size: 76, glowing: true)
      Text("Chat with \(familiar?.displayName ?? "your familiar")")
        .font(.title2.weight(.semibold)).foregroundStyle(Palette.textPrimary)
      if let description = familiar?.description, !description.isEmpty {
        Text(description).font(.subheadline).foregroundStyle(Palette.textSecondary)
          .multilineTextAlignment(.center).lineLimit(3)
      }
      Text("Messages you send here run on your Mac.")
        .font(.footnote).foregroundStyle(Palette.textMuted)
    }
    .padding(.horizontal, 32)
    .frame(maxWidth: 520)
  }

  // MARK: Composer

  private var composer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !model.error.isEmpty { errorCard }
      if model.archived {
        NoticeView(
          text: "This chat is archived. Restore it on your Mac to send a message.",
          symbol: "archivebox")
      }
      if let run = model.activeRun, run.running, run.familiarId != model.selectedId {
        let name = model.familiars.first { $0.id == run.familiarId }?.displayName
        NoticeView(
          text: "\(name ?? "Another familiar") is replying. You can send once it finishes.",
          symbol: "hourglass")
      }
      HStack(alignment: .bottom, spacing: 6) {
        TextField(
          "Message \(familiar?.displayName ?? "your familiar")", text: $model.draft, axis: .vertical
        )
        .lineLimit(1...6)
        .focused($composing)
        .padding(.leading, 16).padding(.vertical, 11)
        .disabled(model.selectedId == nil || model.archived)
        .accessibilityIdentifier("composer")
        action.padding(4)
      }
      .glass(.control, cornerRadius: 24)
      .accentGlow(active: composing)
      if model.draft.utf8.count > 32768 {
        Text("Message is too long (maximum 32,768 bytes).")
          .font(.caption).foregroundStyle(Palette.danger)
      }
    }
    .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 8)
    .background {
      LinearGradient(
        colors: [Palette.bgBase.opacity(0), Palette.bgBase.opacity(0.92), Palette.bgBase],
        startPoint: .top, endPoint: .bottom
      )
      .ignoresSafeArea()
    }
  }

  @ViewBuilder private var action: some View {
    if model.activeRun?.running == true {
      Button {
        Task { await model.stop() }
      } label: {
        Image(systemName: "stop.fill")
          .font(.footnote.weight(.bold)).foregroundStyle(Palette.bgBase)
          .frame(width: 36, height: 36)
          .background(Palette.textPrimary, in: Circle())
      }
      .disabled(model.busy)
      .accessibilityLabel("Stop")
      .accessibilityIdentifier("stop")
    } else {
      Button {
        Task { await model.send() }
      } label: {
        Image(systemName: "arrow.up")
          .font(.body.weight(.bold))
          .foregroundStyle(model.canSend ? Palette.accentForeground : Palette.textMuted)
          .frame(width: 36, height: 36)
          .background(model.canSend ? Palette.accent : Palette.bgElevated, in: Circle())
      }
      .disabled(!model.canSend)
      .accessibilityLabel("Send")
      .accessibilityIdentifier("send")
    }
  }

  private var errorCard: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
      VStack(alignment: .leading, spacing: 6) {
        Text(model.error).font(.footnote).foregroundStyle(Palette.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("connection-error")
        if model.pendingRunId != nil && model.activeRun?.running != true {
          Button("Review uncertain send") { dismissSend = true }
            .font(.footnote.weight(.semibold))
        }
        if model.localNetworkDenied { OpenSettingsButton().font(.footnote.weight(.semibold)) }
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .glass(.raised, cornerRadius: 16)
  }
}

/// A light tap when a message leaves, and a success tap when its reply ends.
private struct RunHaptics: ViewModifier {
  let pendingRunId: String?
  let running: Bool?
  func body(content: Content) -> some View {
    content
      .sensoryFeedback(.impact(weight: .light), trigger: pendingRunId) {
        (old: String?, new: String?) in old == nil && new != nil
      }
      .sensoryFeedback(.success, trigger: running) { (old: Bool?, new: Bool?) in
        old == true && new == false
      }
  }
}

/// Opens Coven Chat's page in Settings, where iOS shows its Local Network switch.
struct OpenSettingsButton: View {
  @Environment(\.openURL) private var openURL
  var body: some View {
    Button("Open Settings") {
      if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
    }
    .accessibilityIdentifier("open-settings")
  }
}
