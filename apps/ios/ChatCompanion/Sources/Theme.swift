import SwiftUI
import UIKit

/// Chat's desktop design tokens (`src/design/familiars-shell.css`) as colours that
/// follow the phone's appearance, the way the desktop follows the Mac's. The
/// `oklch` status tokens are converted to sRGB.
enum Palette {
  static let bgBase = dynamic(dark: 0x0C0C0E, light: 0xF7F7F9)
  static let bgRaised = dynamic(dark: 0x1C1C1F, light: 0xFFFFFF)
  static let bgElevated = dynamic(dark: 0x232327, light: 0xFBFBFC)
  static let textPrimary = dynamic(dark: 0xF0EFF4, light: 0x17171B)
  static let textSecondary = dynamic(dark: 0xA2A1AB, light: 0x4A4955)
  static let textMuted = dynamic(dark: 0x8E8D97, light: 0x62616C)
  static let border = dynamic(dark: (0xFFFFFF, 0.08), light: (0x000000, 0.09))
  static let borderStrong = dynamic(dark: (0xFFFFFF, 0.16), light: (0x000000, 0.18))
  static let accent = dynamic(dark: 0xA79BF5, light: 0x5B45D6)
  static let accentForeground = dynamic(dark: 0x0C0C0E, light: 0xFFFFFF)
  static let warning = dynamic(dark: 0xCDAB76, light: 0x945A00)
  static let danger = dynamic(dark: 0xCD7671, light: 0xB63132)
  /// A live connection or a reply in progress. The desktop greys its success
  /// token; a phone glanced at across a room needs the dot to read as "on".
  static let online = dynamic(dark: 0x8FCB9B, light: 0x2F8F57)

  private static func dynamic(dark: Int, light: Int) -> Color {
    dynamic(dark: (dark, 1), light: (light, 1))
  }

  private static func dynamic(dark: (Int, Double), light: (Int, Double)) -> Color {
    Color(
      uiColor: UIColor { traits in
        let (hex, alpha) = traits.userInterfaceStyle == .dark ? dark : light
        return UIColor(
          red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
          blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
      })
  }
}

/// How far a glass surface sits above the page, after Coven Cave's iOS glass
/// system: a control (a field) frosts lighter than a raised card.
enum GlassLevel {
  case control
  case raised

  fileprivate var tintOpacity: Double { self == .control ? 0.5 : 0.45 }
  fileprivate var accentOpacity: Double { self == .control ? 0.10 : 0.08 }
  fileprivate var shadow: (radius: CGFloat, y: CGFloat, opacity: Double) {
    self == .control ? (8, 3, 0.12) : (6, 2, 0.08)
  }
}

extension View {
  /// Frosts a surface with an accent-tinted material, a hairline border and a soft
  /// shadow. Reduce Transparency swaps the material for a solid surface; Increase
  /// Contrast drops the accent wash and strengthens the border.
  func glass(_ level: GlassLevel, cornerRadius: CGFloat = 16) -> some View {
    modifier(GlassSurface(level: level, cornerRadius: cornerRadius))
  }

  /// An accent halo on the focused element, suppressed where a glow would hurt
  /// legibility or count as unwanted motion.
  func accentGlow(active: Bool) -> some View {
    modifier(AccentGlow(active: active))
  }
}

private struct GlassSurface: ViewModifier {
  let level: GlassLevel
  let cornerRadius: CGFloat
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.colorSchemeContrast) private var contrast

  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    let increased = contrast == .increased
    content.background {
      ZStack {
        if reduceTransparency {
          shape.fill(Palette.bgRaised)
        } else {
          shape.fill(.thinMaterial)
          shape.fill(Palette.bgRaised.opacity(level.tintOpacity))
          if !increased { shape.fill(Palette.accent.opacity(level.accentOpacity)) }
        }
        shape.strokeBorder(
          increased ? Palette.borderStrong : Palette.border, lineWidth: increased ? 1.5 : 1)
      }
      .shadow(
        color: .black.opacity(reduceTransparency || increased ? 0 : level.shadow.opacity),
        radius: level.shadow.radius, y: level.shadow.y)
    }
  }
}

private struct AccentGlow: ViewModifier {
  let active: Bool
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.colorSchemeContrast) private var contrast
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    let shown = active && !reduceTransparency && contrast != .increased && !reduceMotion
    content.shadow(color: Palette.accent.opacity(shown ? 0.35 : 0), radius: 12)
  }
}
