import SwiftUI
import UIKit

/// A familiar's reply, rendered from its Markdown. Equatable so a poll that
/// returns the same text does not lay the reply out again.
struct ReplyView: View, Equatable {
  let text: String
  @State private var selecting = false

  static func == (lhs: ReplyView, rhs: ReplyView) -> Bool { lhs.text == rhs.text }

  var body: some View {
    let blocks = Markdown.parse(text)
    BlocksView(blocks: blocks, spacing: 14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
      .contextMenu {
        Button("Copy", systemImage: "doc.on.doc") {
          UIPasteboard.general.string = Markdown.plainText(blocks)
        }
        Button("Copy as Markdown", systemImage: "chevron.left.forwardslash.chevron.right") {
          UIPasteboard.general.string = text
        }
        Button("Select Text", systemImage: "selection.pin.in.out") { selecting = true }
        ShareLink(item: Markdown.plainText(blocks))
      }
      .sheet(isPresented: $selecting) { SelectableText(text: Markdown.plainText(blocks)) }
  }
}

/// The whole reply as one selectable text, for copying part of it.
private struct SelectableText: View {
  let text: String
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        Text(text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
          .padding()
      }
      .navigationTitle("Select Text").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .presentationDetents([.medium, .large])
  }
}

struct BlocksView: View {
  let blocks: [MarkdownBlock]
  var spacing: CGFloat = 10
  var body: some View {
    VStack(alignment: .leading, spacing: spacing) {
      ForEach(blocks.indices, id: \.self) { index in BlockView(block: blocks[index]) }
    }
  }
}

private struct BlockView: View {
  let block: MarkdownBlock
  var body: some View {
    switch block {
    case .heading(let level, let text):
      Text(InlineStyle.apply(text))
        .font(Self.headingFont(level)).foregroundStyle(Palette.textPrimary)
        .padding(.top, level <= 2 ? 6 : 2)
        .accessibilityAddTraits(.isHeader)
    case .paragraph(let text):
      Text(InlineStyle.apply(text)).font(.body).lineSpacing(3)
        .foregroundStyle(Palette.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    case .list(let ordered, let start, let items):
      ListBlock(ordered: ordered, start: start, items: items)
    case .quote(let inner):
      HStack(alignment: .top, spacing: 12) {
        Capsule().fill(Palette.accent.opacity(0.55)).frame(width: 3)
        AnyView(BlocksView(blocks: inner)).foregroundStyle(Palette.textSecondary)
      }
      .fixedSize(horizontal: false, vertical: true)
    case .code(let language, let text):
      CodeBlock(language: language, text: text)
    case .table(let header, let alignments, let rows):
      TableBlock(header: header, alignments: alignments, rows: rows)
    case .rule:
      Rectangle().fill(Palette.border).frame(height: 1).padding(.vertical, 4)
    }
  }

  private static func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: .title2.weight(.bold)
    case 2: .title3.weight(.semibold)
    case 3: .headline
    default: .subheadline.weight(.semibold)
    }
  }
}

enum InlineStyle {
  /// Inline code takes the accent on a faint wash; links take the accent.
  static func apply(_ text: String) -> AttributedString {
    var styled = Markdown.inline(text)
    let runs = styled.runs.map { ($0.range, $0.inlinePresentationIntent, $0.link) }
    for (range, intent, link) in runs {
      if intent?.contains(.code) == true {
        styled[range].foregroundColor = Palette.accent
        styled[range].backgroundColor = Palette.accent.opacity(0.12)
      }
      if link != nil { styled[range].foregroundColor = Palette.accent }
    }
    return styled
  }
}

private struct ListBlock: View {
  let ordered: Bool
  let start: Int
  let items: [MarkdownListItem]
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(items.indices, id: \.self) { index in
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          marker(index)
          AnyView(BlocksView(blocks: items[index].blocks, spacing: 8))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }

  @ViewBuilder private func marker(_ index: Int) -> some View {
    if let checked = items[index].checked {
      Image(systemName: checked ? "checkmark.circle.fill" : "circle")
        .foregroundStyle(checked ? Palette.accent : Palette.textMuted)
        .accessibilityLabel(checked ? "Done" : "Not done")
    } else if ordered {
      Text("\(start + index).").font(.body.weight(.semibold)).monospacedDigit()
        .foregroundStyle(Palette.accent).frame(minWidth: 20, alignment: .trailing)
    } else {
      Text("•").font(.body.weight(.bold)).foregroundStyle(Palette.accent)
        .accessibilityHidden(true)
    }
  }
}

private struct CodeBlock: View {
  let language: String
  let text: String
  @State private var expanded = false
  private static let foldedLines = 24

  var body: some View {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    let folded = !expanded && lines.count > Self.foldedLines
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(language.isEmpty ? "Code" : language)
          .font(.caption.weight(.medium)).foregroundStyle(Palette.textMuted)
        Spacer()
        CopyButton(text: text)
      }
      .padding(.leading, 14).padding(.trailing, 8).padding(.vertical, 6)
      Rectangle().fill(Palette.border).frame(height: 1)
      ScrollView(.horizontal, showsIndicators: false) {
        Text(folded ? lines.prefix(Self.foldedLines).joined(separator: "\n") : text)
          .font(.system(.footnote, design: .monospaced))
          .foregroundStyle(Palette.textPrimary)
          .textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: false)
          .padding(14)
      }
      if lines.count > Self.foldedLines {
        Button(folded ? "Show all \(lines.count) lines" : "Show less") {
          withAnimation(.snappy) { expanded.toggle() }
        }
        .font(.caption.weight(.semibold)).padding(.horizontal, 14).padding(.bottom, 10)
      }
    }
    .background(Palette.bgRaised.opacity(0.9), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.border))
  }
}

struct CopyButton: View {
  let text: String
  @State private var copied = false
  var body: some View {
    Button {
      UIPasteboard.general.string = text
      copied = true
      Task {
        try? await Task.sleep(for: .seconds(1.5))
        copied = false
      }
    } label: {
      Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
        .font(.caption.weight(.medium)).contentTransition(.symbolEffect(.replace))
        .padding(.horizontal, 8).padding(.vertical, 4)
    }
    .buttonStyle(.plain).foregroundStyle(copied ? Palette.accent : Palette.textSecondary)
    .sensoryFeedback(.success, trigger: copied) { _, now in now }
  }
}

private struct TableBlock: View {
  let header: [String]
  let alignments: [MarkdownAlignment]
  let rows: [[String]]
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 10) {
        GridRow {
          ForEach(header.indices, id: \.self) { column in
            Text(InlineStyle.apply(header[column])).font(.subheadline.weight(.semibold))
              .gridColumnAlignment(alignment(column))
          }
        }
        Rectangle().fill(Palette.borderStrong).frame(height: 1).gridCellUnsizedAxes(.horizontal)
        ForEach(rows.indices, id: \.self) { row in
          GridRow {
            ForEach(rows[row].indices, id: \.self) { column in
              Text(InlineStyle.apply(rows[row][column])).font(.subheadline)
            }
          }
        }
      }
      .foregroundStyle(Palette.textPrimary)
      .padding(14)
    }
    .background(Palette.bgRaised.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.border))
  }

  private func alignment(_ column: Int) -> HorizontalAlignment {
    switch alignments.indices.contains(column) ? alignments[column] : .leading {
    case .leading: .leading
    case .center: .center
    case .trailing: .trailing
    }
  }
}

/// A run of tool calls as one line, "Ran 3 commands and read 1 file", that
/// opens to list each call.
struct ToolGroupView: View {
  let calls: [ToolCall]
  @State private var expanded = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var shown: [ToolCall] { calls.filter { $0.name != nil } }
  private var kind: ToolKind {
    var counts: [ToolKind: Int] = [:]
    for call in shown { counts[ToolKind(name: call.name), default: 0] += 1 }
    return counts.max { $0.value < $1.value }?.key ?? .other
  }
  private var named: Bool { !shown.isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(reduceMotion ? nil : .snappy) { expanded.toggle() }
      } label: {
        HStack(spacing: 10) {
          Image(systemName: kind.symbol)
            .font(.caption.weight(.semibold)).foregroundStyle(Palette.accent)
            .frame(width: 26, height: 26)
            .background(Palette.accent.opacity(0.14), in: Circle())
          Text(ToolKind.summary(calls))
            .font(.subheadline.weight(.medium)).foregroundStyle(Palette.textSecondary)
            .lineLimit(1)
          Spacer(minLength: 8)
          if named {
            Image(systemName: "chevron.right")
              .font(.caption.weight(.semibold)).foregroundStyle(Palette.textMuted)
              .rotationEffect(.degrees(expanded ? 90 : 0))
          }
        }
        .padding(.vertical, 7).padding(.horizontal, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!named)
      .accessibilityHint(named ? (expanded ? "Hides each call" : "Shows each call") : "")
      if expanded {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(shown.indices, id: \.self) { index in
            let call = shown[index]
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              Image(systemName: ToolKind(name: call.name).symbol)
                .font(.caption2).foregroundStyle(Palette.textMuted).frame(width: 16)
              Text("\(Text(call.name ?? "Tool").fontWeight(.semibold)) \(call.args)")
                .font(.caption.monospaced()).foregroundStyle(Palette.textSecondary)
                .lineLimit(4).textSelection(.enabled)
            }
          }
        }
        .padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 12)
        .transition(.opacity)
      }
    }
    .background(Palette.bgRaised.opacity(0.5), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.border))
  }
}

struct UserBubble: View {
  let text: String
  var onReuse: (() -> Void)?
  var body: some View {
    HStack {
      Spacer(minLength: 52)
      Text(text).font(.body).foregroundStyle(Palette.textPrimary)
        .padding(.horizontal, 15).padding(.vertical, 10)
        .background {
          let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
          shape.fill(
            LinearGradient(
              colors: [Palette.accent.opacity(0.30), Palette.accent.opacity(0.16)],
              startPoint: .topLeading, endPoint: .bottomTrailing))
          shape.strokeBorder(Palette.accent.opacity(0.28))
        }
        .contextMenu {
          Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
          if let onReuse {
            Button("Edit as New Message", systemImage: "square.and.pencil") { onReuse() }
          }
          ShareLink(item: text)
        }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("You: \(text)")
  }
}

struct NoticeView: View {
  let text: String
  var symbol = "info.circle"
  var body: some View {
    Label(text, systemImage: symbol)
      .font(.caption).foregroundStyle(Palette.textMuted)
      .multilineTextAlignment(.center)
      .padding(.horizontal, 12).padding(.vertical, 6)
      .background(Palette.bgRaised.opacity(0.6), in: Capsule())
      .frame(maxWidth: .infinity)
  }
}

/// What a running reply is doing now, from the last thing it wrote.
struct WorkingIndicator: View {
  let familiar: Familiar?
  let phase: String
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    HStack(spacing: 10) {
      FamiliarAvatar(familiar: familiar, size: 24, glowing: true)
      Text("\(phase)…").font(.footnote.weight(.medium)).foregroundStyle(Palette.textSecondary)
      Image(systemName: "ellipsis")
        .font(.footnote.weight(.bold)).foregroundStyle(Palette.accent)
        .symbolEffect(.variableColor.iterative, options: .repeating, isActive: !reduceMotion)
        .accessibilityHidden(true)
    }
    .accessibilityElement(children: .combine)
  }
}
