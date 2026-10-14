import SwiftUI

/// A familiar's mark: its emoji, or its initial, on a gradient that stays the
/// same for that familiar on every launch.
struct FamiliarAvatar: View {
  let familiar: Familiar?
  var size: CGFloat = 36
  var glowing = false

  var body: some View {
    let tones = Self.tones[Int(Self.hash(familiar?.id ?? "") % UInt64(Self.tones.count))]
    ZStack {
      Circle().fill(
        LinearGradient(
          colors: [Self.color(tones.0), Self.color(tones.1)], startPoint: .topLeading,
          endPoint: .bottomTrailing))
      Circle().strokeBorder(.white.opacity(0.22), lineWidth: max(1, size / 40))
      if let emoji = familiar?.emoji, !emoji.isEmpty {
        Text(emoji).font(.system(size: size * 0.5))
      } else {
        Text(String((familiar?.displayName ?? "?").prefix(1)).uppercased())
          .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
          .foregroundStyle(.white)
      }
    }
    .frame(width: size, height: size)
    .accentGlow(active: glowing)
    .accessibilityHidden(true)
  }

  /// Jewel tones that sit well on the dark and light page alike.
  private static let tones: [(Int, Int)] = [
    (0x9A8CF8, 0x4B3CB4), (0x7393FF, 0x2F45AE), (0x55C4BB, 0x1C6A73), (0x6CC492, 0x2A6A4C),
    (0xE8BC6A, 0x95601F), (0xEA8FAA, 0x973A60), (0x70C6F2, 0x276C9A), (0xBC84DE, 0x66308C),
  ]

  private static func color(_ hex: Int) -> Color {
    Color(
      red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255)
  }

  /// FNV-1a, because Swift's own hashes change between launches.
  static func hash(_ id: String) -> UInt64 {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in id.utf8 {
      hash ^= UInt64(byte)
      hash = hash &* 0x100_0000_01b3
    }
    return hash
  }
}

/// Every familiar on the Mac as a card: what it is, its chat, and whether it is
/// replying now.
struct FamiliarPicker: View {
  let familiars: [Familiar]
  let sessions: [ChatSession]
  let selectedId: String?
  let respondingId: String?
  let onSelect: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  private var shown: [Familiar] {
    let needle = query.trimmingCharacters(in: .whitespaces)
    guard !needle.isEmpty else { return familiars }
    return familiars.filter {
      $0.displayName.localizedCaseInsensitiveContains(needle)
        || ($0.description ?? "").localizedCaseInsensitiveContains(needle)
    }
  }

  var body: some View {
    NavigationStack {
      searchable(
        ScrollView {
          LazyVStack(spacing: 10) {
            ForEach(shown) { familiar in card(familiar) }
            if shown.isEmpty {
              ContentUnavailableView.search(text: query).padding(.top, 24)
            }
          }
          .padding(.horizontal, 16).padding(.vertical, 8)
        }
      )
      .background(Palette.bgBase.ignoresSafeArea())
      .navigationTitle("Familiars").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .presentationDetents(familiars.count > 4 ? [.medium, .large] : [.medium])
    .presentationDragIndicator(.visible)
    .presentationCornerRadius(28)
  }

  @ViewBuilder private func searchable(_ content: some View) -> some View {
    if familiars.count > 5 {
      content.searchable(text: $query, prompt: "Search familiars")
    } else {
      content
    }
  }

  private func card(_ familiar: Familiar) -> some View {
    let selected = familiar.id == selectedId
    let session = sessions.first { $0.familiarId == familiar.id }
    let responding = familiar.id == respondingId
    return Button {
      onSelect(familiar.id)
      dismiss()
    } label: {
      HStack(alignment: .center, spacing: 14) {
        FamiliarAvatar(familiar: familiar, size: 46, glowing: selected)
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Text(familiar.displayName).font(.headline).foregroundStyle(Palette.textPrimary)
            if responding { Badge(text: "Replying", color: Palette.online, pulsing: true) }
            if session?.archived == true { Badge(text: "Archived", color: Palette.textMuted) }
          }
          if let description = familiar.description, !description.isEmpty {
            Text(description).font(.subheadline).foregroundStyle(Palette.textSecondary)
              .lineLimit(2).multilineTextAlignment(.leading)
          }
          if let title = session?.title, !title.isEmpty {
            Label(title, systemImage: "bubble.left")
              .font(.caption).foregroundStyle(Palette.textMuted).lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
          .font(.title3)
          .foregroundStyle(selected ? Palette.accent : Palette.borderStrong)
      }
      .padding(14)
      .glass(.raised, cornerRadius: 20)
      .overlay {
        if selected {
          RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(Palette.accent.opacity(0.55), lineWidth: 1.5)
        }
      }
      .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("familiar-\(familiar.id)")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

struct Badge: View {
  let text: String
  let color: Color
  var pulsing = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "circle.fill").font(.system(size: 6))
        .symbolEffect(.pulse, options: .repeating, isActive: pulsing && !reduceMotion)
      Text(text)
    }
    .font(.caption2.weight(.semibold)).foregroundStyle(color)
    .padding(.horizontal, 7).padding(.vertical, 3)
    .background(color.opacity(0.14), in: Capsule())
  }
}

/// Which Mac this phone trusts and how it reaches it.
struct ConnectionDetails: View {
  let pairing: Pairing
  let status: String
  let connected: Bool
  let familiarCount: Int
  let onForget: () -> Void
  @Environment(\.dismiss) private var dismiss

  private var address: String {
    "\(pairing.endpoint.host ?? "")\(pairing.endpoint.port.map { ":\($0)" } ?? "")"
  }
  /// The certificate fingerprint in groups of four, as people read it aloud.
  private var fingerprint: String {
    stride(from: 0, to: pairing.fingerprint.count, by: 4).map { offset in
      let start = pairing.fingerprint.index(pairing.fingerprint.startIndex, offsetBy: offset)
      let end = pairing.fingerprint.index(start, offsetBy: 4, limitedBy: pairing.fingerprint.endIndex)
      return String(pairing.fingerprint[start..<(end ?? pairing.fingerprint.endIndex)])
    }.joined(separator: " ")
  }
  private var appVersion: String {
    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "?"
    let build = info?["CFBundleVersion"] as? String ?? "?"
    return "\(version) (\(build))"
  }

  var body: some View {
    NavigationStack {
      List {
        Section {
          LabeledContent("Status") {
            HStack(spacing: 6) {
              Circle().fill(connected ? Palette.online : Palette.warning).frame(width: 7, height: 7)
              Text(status)
            }
          }
          LabeledContent("Address") { Text(address).monospaced() }
          LabeledContent("Familiars", value: "\(familiarCount)")
        }
        Section {
          Text(fingerprint).font(.footnote.monospaced()).foregroundStyle(Palette.textSecondary)
            .textSelection(.enabled)
        } header: {
          Text("Mac certificate")
        } footer: {
          Text(
            "Your iPhone talks only to this Mac, over your local network, and checks this certificate on every connection. Your chats stay on the Mac."
          )
        }
        Section {
          LabeledContent("Coven Chat for iPhone", value: appVersion)
        }
        Section {
          Button("Forget Mac", systemImage: "link.badge.plus", role: .destructive) {
            dismiss()
            onForget()
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(Palette.bgBase.ignoresSafeArea())
      .navigationTitle("Connection").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}
