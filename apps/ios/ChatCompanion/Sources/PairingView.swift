import AVFoundation
import SwiftUI
import UIKit

/// The pairing front door, modelled on Coven Cave's iOS connection screen: a
/// centred hero with the glowing app mark, one prominent scan action, and the
/// pasted-link path folded behind a link until it is needed. A scanned code
/// connects straight away; a link that arrives any other way waits for Connect.
struct PairingView: View {
  @Bindable var model: CompanionModel
  @Binding var link: String
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var scanner = false
  /// Starts open when there is no camera to scan with, as on the simulator.
  @State private var manualEntry = !PairingView.cameraAvailable
  @FocusState private var focused: Bool

  static var cameraAvailable: Bool { AVCaptureDevice.default(for: .video) != nil }

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        VStack(spacing: 0) {
          Spacer(minLength: 36)
          hero
          Spacer(minLength: 28)
          VStack(spacing: 14) {
            scanButton
            if manualEntry {
              manualSection
                .transition(
                  reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            } else {
              manualEntryLink
            }
            if !model.error.isEmpty { errorCallout }
          }
          Spacer(minLength: 40)
          trustFooter
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 24)
        .frame(maxWidth: 520, minHeight: geometry.size.height)
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .spring(duration: 0.32), value: manualEntry)
        .animation(reduceMotion ? nil : .spring(duration: 0.32), value: model.error)
      }
      .scrollBounceBehavior(.basedOnSize)
    }
    .background(background.ignoresSafeArea())
    .toolbarVisibility(.hidden, for: .navigationBar)
    .onAppear { if !link.isEmpty { manualEntry = true } }
    .onChange(of: link) { _, value in if !value.isEmpty { manualEntry = true } }
    .onChange(of: model.error) { _, message in
      if !message.isEmpty { UIAccessibility.post(notification: .announcement, argument: message) }
    }
    .sheet(isPresented: $scanner) {
      NavigationStack {
        PairingScanner { value in
          scanner = false
          link = value
          connect(value)
        }
        .ignoresSafeArea(edges: .bottom)
        .navigationTitle("Scan Mac's pairing code")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanner = false } }
        }
      }
    }
  }

  /// A quiet accent wash behind the hero so the mark's glow belongs to the page.
  private var background: some View {
    ZStack {
      Palette.bgBase
      RadialGradient(
        colors: [Palette.accent.opacity(0.14), .clear], center: .init(x: 0.5, y: 0.22),
        startRadius: 10, endRadius: 340)
    }
  }

  // MARK: - Hero

  private var hero: some View {
    VStack(spacing: 20) {
      glyph
      VStack(spacing: 8) {
        Text("Connect to Chat")
          .font(.system(size: 30, weight: .bold))
          .kerning(-0.6)
          .foregroundStyle(Palette.textPrimary)
        Text("Pair this iPhone with Chat on your Mac to talk with your familiars.")
          .font(.callout)
          .foregroundStyle(Palette.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }

  private var glyph: some View {
    ZStack {
      Circle()
        .fill(Palette.accent.opacity(0.22))
        .frame(width: 96, height: 96)
        .blur(radius: 26)
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(Palette.bgElevated)
        .frame(width: 84, height: 84)
        .overlay {
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .strokeBorder(Palette.accent.opacity(0.45), lineWidth: 1)
        }
        .shadow(color: Palette.accent.opacity(0.35), radius: 22, y: 6)
      appMark
    }
    .accessibilityHidden(true)
  }

  @ViewBuilder private var appMark: some View {
    if let icon = Bundle.main.primaryAppIcon {
      Image(uiImage: icon)
        .resizable()
        .scaledToFill()
        .frame(width: 84, height: 84)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    } else {
      Image("ChatLogo")
        .resizable()
        .scaledToFit()
        .frame(width: 52, height: 52)
        .foregroundStyle(Palette.accent)
    }
  }

  // MARK: - Actions

  private var scanButton: some View {
    VStack(spacing: 10) {
      Button {
        scanner = true
      } label: {
        Label("Pair with your Mac", systemImage: "qrcode.viewfinder")
          .font(.body.weight(.semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      // Cave's white-on-dark scan button, inverted in light mode so it keeps
      // its contrast against the page.
      .tint(Palette.textPrimary)
      .foregroundStyle(Palette.bgBase)
      .disabled(model.busy)
      .accessibilityHint("Opens the camera to scan the pairing code in Chat on your Mac")
      Text("In Chat on your Mac, open Settings, then Devices, choose iPhone companion, then Turn on companion.")
        .font(.footnote)
        .foregroundStyle(Palette.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var manualEntryLink: some View {
    Button {
      manualEntry = true
      focused = true
    } label: {
      Text("Enter pairing link")
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Palette.accent)
    }
    .buttonStyle(.plain)
    .padding(.top, 2)
    .accessibilityHint("Shows a field for the pairing link copied from your Mac")
  }

  private var manualSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Pairing link")
          .font(.caption.weight(.semibold))
          .textCase(.uppercase)
          .kerning(0.6)
          .foregroundStyle(Palette.textMuted)
        Spacer()
        PasteButton(payloadType: String.self) { values in
          if let value = values.first { link = value.trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        .labelStyle(.titleAndIcon)
        .buttonBorderShape(.capsule)
        .controlSize(.mini)
      }
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "link")
          .foregroundStyle(Palette.textMuted)
          .padding(.top, 2)
        TextField("Paste the link from your Mac", text: $link, axis: .vertical)
          .lineLimit(1...4)
          // The link reads best monospaced; the placeholder would truncate.
          .font(link.isEmpty ? .callout : .callout.monospaced())
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
          .focused($focused)
          .accessibilityIdentifier("pairing-link")
        if !link.isEmpty {
          Button {
            link = ""
            focused = true
          } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.textMuted)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Clear pairing link")
        }
      }
      .padding(14)
      .glass(.control, cornerRadius: 16)
      .accentGlow(active: focused)
      Text("Only use a link from your own Mac. It grants access to your conversations.")
        .font(.footnote)
        .foregroundStyle(Palette.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      Button {
        connect(link)
      } label: {
        Label(
          model.busy ? "Connecting…" : "Connect",
          systemImage: model.busy ? "arrow.triangle.2.circlepath" : "bolt.horizontal.circle.fill"
        )
        .font(.body.weight(.semibold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .tint(Palette.accent)
      .foregroundStyle(Palette.accentForeground)
      .disabled(link.isEmpty || model.busy)
      .shadow(color: Palette.accent.opacity(link.isEmpty || model.busy ? 0 : 0.4), radius: 14, y: 5)
      .accessibilityIdentifier("connect")
    }
    .padding(16)
    .glass(.raised, cornerRadius: 20)
  }

  private var errorCallout: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.title3.weight(.semibold))
          .foregroundStyle(Palette.warning)
          .frame(width: 28)
        VStack(alignment: .leading, spacing: 4) {
          Text(model.needsPairingCleanup ? "Couldn't finish forgetting your Mac" : "Couldn't pair")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Palette.textPrimary)
          Text(model.error)
            .font(.footnote)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("connection-error")
        }
        Spacer(minLength: 0)
      }
      if model.needsPairingCleanup {
        Button("Retry forgetting Mac") { model.forget() }
          .font(.subheadline.weight(.semibold))
          .tint(Palette.accent)
      }
    }
    .padding(14)
    .glass(.raised, cornerRadius: 16)
  }

  private var trustFooter: some View {
    Label("Private & encrypted", systemImage: "lock.fill")
      .font(.footnote.weight(.medium))
      .foregroundStyle(Palette.textMuted)
      .padding(.bottom, 6)
      .accessibilityLabel(
        "Private and encrypted. This iPhone talks only to your Mac on your local network, after checking your Mac's certificate."
      )
  }

  private func connect(_ value: String) {
    focused = false
    Task {
      await model.pair(link: value)
      if model.pairing != nil { link = "" } else { manualEntry = true }
    }
  }
}

private extension Bundle {
  /// The largest primary app icon the bundle carries; app icons are not
  /// available as named image assets.
  var primaryAppIcon: UIImage? {
    guard
      let icons = infoDictionary?["CFBundleIcons"] as? [String: Any],
      let primary = icons["CFBundlePrimaryIcon"] as? [String: Any],
      let files = primary["CFBundleIconFiles"] as? [String],
      let name = files.last
    else { return nil }
    return UIImage(named: name)
  }
}
