import Foundation

/// The block structure of a reply, as GitHub-flavoured Markdown reads it on the
/// Mac (`remark-gfm`). Inline syntax inside each block is left to
/// `AttributedString(markdown:)`; this only finds the blocks a phone lays out
/// differently: headings, lists, quotes, code, tables and rules.
indirect enum MarkdownBlock: Equatable {
  case heading(level: Int, text: String)
  case paragraph(String)
  case list(ordered: Bool, start: Int, items: [MarkdownListItem])
  case quote([MarkdownBlock])
  case code(language: String, text: String)
  case table(header: [String], alignments: [MarkdownAlignment], rows: [[String]])
  case rule
}

struct MarkdownListItem: Equatable {
  /// nil for a plain item, true or false for a task.
  var checked: Bool?
  var blocks: [MarkdownBlock]
}

enum MarkdownAlignment: Equatable { case leading, center, trailing }

enum Markdown {
  static func parse(_ text: String) -> [MarkdownBlock] {
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").split(
      separator: "\n", omittingEmptySubsequences: false
    ).map { $0.replacingOccurrences(of: "\t", with: "    ") }
    return parse(lines: lines[...])
  }

  private static func parse(lines: ArraySlice<String>) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var paragraph: [String] = []
    func flush() {
      guard !paragraph.isEmpty else { return }
      blocks.append(.paragraph(joinParagraph(paragraph)))
      paragraph = []
    }
    var index = lines.startIndex
    while index < lines.endIndex {
      let line = lines[index]
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      let indent = leadingSpaces(line)
      if trimmed.isEmpty {
        flush()
        index += 1
        continue
      }
      if indent < 4, let fence = fenceOpening(trimmed) {
        flush()
        var body: [String] = []
        index += 1
        while index < lines.endIndex {
          let candidate = lines[index].trimmingCharacters(in: .whitespaces)
          if candidate.hasPrefix(fence.marker), candidate.allSatisfy({ $0 == fence.marker.first }) {
            index += 1
            break
          }
          body.append(String(lines[index].dropFirst(min(indent, leadingSpaces(lines[index])))))
          index += 1
        }
        blocks.append(.code(language: fence.language, text: body.joined(separator: "\n")))
        continue
      }
      if indent < 4, let heading = atxHeading(trimmed) {
        flush()
        blocks.append(heading)
        index += 1
        continue
      }
      if indent < 4, !paragraph.isEmpty, let level = setextLevel(trimmed) {
        blocks.append(.heading(level: level, text: joinParagraph(paragraph)))
        paragraph = []
        index += 1
        continue
      }
      if indent < 4, isRule(trimmed) {
        flush()
        blocks.append(.rule)
        index += 1
        continue
      }
      if indent < 4, trimmed.hasPrefix(">") {
        flush()
        var quoted: [String] = []
        while index < lines.endIndex {
          let candidate = lines[index].trimmingCharacters(in: .whitespaces)
          guard candidate.hasPrefix(">") else { break }
          var rest = candidate.dropFirst()
          if rest.first == " " { rest = rest.dropFirst() }
          quoted.append(String(rest))
          index += 1
        }
        blocks.append(.quote(parse(lines: quoted[...])))
        continue
      }
      if indent < 4, listMarker(line) != nil {
        flush()
        let (list, next) = parseList(lines, from: index)
        blocks.append(list)
        index = next
        continue
      }
      if indent < 4, paragraph.isEmpty, index + 1 < lines.endIndex, line.contains("|"),
        let alignments = delimiterRow(lines[index + 1])
      {
        let header = cells(line)
        if header.count == alignments.count {
          var rows: [[String]] = []
          index += 2
          while index < lines.endIndex, lines[index].contains("|"),
            !lines[index].trimmingCharacters(in: .whitespaces).isEmpty
          {
            var row = cells(lines[index])
            if row.count < header.count {
              row += Array(repeating: "", count: header.count - row.count)
            }
            rows.append(Array(row.prefix(header.count)))
            index += 1
          }
          blocks.append(.table(header: header, alignments: alignments, rows: rows))
          continue
        }
      }
      paragraph.append(trimmed.isEmpty ? line : String(line.dropFirst(min(indent, 3))))
      index += 1
    }
    flush()
    return blocks
  }

  /// Soft breaks read as spaces, as on the Mac; two trailing spaces or a
  /// trailing backslash keep a hard break.
  private static func joinParagraph(_ lines: [String]) -> String {
    var text = ""
    for (index, raw) in lines.enumerated() {
      var line = raw
      let last = index == lines.count - 1
      var hard = false
      if !last {
        if raw.hasSuffix("  ") {
          hard = true
        } else if raw.hasSuffix("\\") {
          hard = true
          line = String(line.dropLast())
        }
      }
      text += line.trimmingCharacters(in: .whitespaces)
      if !last { text += hard ? "\n" : " " }
    }
    return text
  }

  private static func leadingSpaces(_ line: String) -> Int {
    line.prefix(while: { $0 == " " }).count
  }

  private static func fenceOpening(_ trimmed: String) -> (marker: String, language: String)? {
    for mark in ["`", "~"] {
      let run = trimmed.prefix(while: { String($0) == mark }).count
      if run >= 3 {
        let info = trimmed.dropFirst(run).trimmingCharacters(in: .whitespaces)
        if mark == "`" && info.contains("`") { return nil }
        let language = info.split(separator: " ").first.map(String.init) ?? ""
        return (String(repeating: mark, count: run), language)
      }
    }
    return nil
  }

  private static func atxHeading(_ trimmed: String) -> MarkdownBlock? {
    let level = trimmed.prefix(while: { $0 == "#" }).count
    guard (1...6).contains(level) else { return nil }
    let rest = trimmed.dropFirst(level)
    guard rest.isEmpty || rest.first == " " else { return nil }
    var text = rest.trimmingCharacters(in: .whitespaces)
    // A closing run of #s is decoration when a space precedes it.
    if let range = text.range(of: #"\s+#+$"#, options: .regularExpression) {
      text.removeSubrange(range)
    } else if text.allSatisfy({ $0 == "#" }) {
      text = ""
    }
    return .heading(level: level, text: text)
  }

  private static func setextLevel(_ trimmed: String) -> Int? {
    if trimmed.allSatisfy({ $0 == "=" }) { return 1 }
    if trimmed.count >= 2, trimmed.allSatisfy({ $0 == "-" }) { return 2 }
    return nil
  }

  private static func isRule(_ trimmed: String) -> Bool {
    let compact = trimmed.filter { $0 != " " }
    guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else {
      return false
    }
    return compact.allSatisfy { $0 == first }
  }

  private struct Marker {
    let ordered: Bool
    let number: Int
    let delimiter: Character
    /// Columns before the item's content: indent, marker and its space.
    let contentIndent: Int
    let indent: Int
    let content: String
  }

  private static func listMarker(_ line: String) -> Marker? {
    let indent = leadingSpaces(line)
    let rest = line.dropFirst(indent)
    guard let first = rest.first else { return nil }
    if "-*+".contains(first) {
      let after = rest.dropFirst()
      guard after.isEmpty || after.first == " " else { return nil }
      let spaces = min(max(after.prefix(while: { $0 == " " }).count, 1), 4)
      return Marker(
        ordered: false, number: 1, delimiter: first, contentIndent: indent + 1 + spaces,
        indent: indent, content: after.trimmingCharacters(in: .whitespaces))
    }
    let digits = rest.prefix(while: { $0.isASCII && $0.isNumber })
    guard (1...9).contains(digits.count), let number = Int(digits) else { return nil }
    let after = rest.dropFirst(digits.count)
    guard let delimiter = after.first, delimiter == "." || delimiter == ")" else { return nil }
    let tail = after.dropFirst()
    guard tail.isEmpty || tail.first == " " else { return nil }
    let spaces = min(max(tail.prefix(while: { $0 == " " }).count, 1), 4)
    return Marker(
      ordered: true, number: number, delimiter: delimiter,
      contentIndent: indent + digits.count + 1 + spaces, indent: indent,
      content: tail.trimmingCharacters(in: .whitespaces))
  }

  private static func parseList(_ lines: ArraySlice<String>, from start: Int) -> (
    MarkdownBlock, Int
  ) {
    guard let first = listMarker(lines[start]) else { return (.paragraph(lines[start]), start + 1) }
    var items: [MarkdownListItem] = []
    var index = start
    while index < lines.endIndex, let marker = listMarker(lines[index]),
      marker.ordered == first.ordered, marker.delimiter == first.delimiter,
      marker.indent < first.contentIndent
    {
      var body = [marker.content]
      index += 1
      var blank = false
      while index < lines.endIndex {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
          blank = true
          body.append("")
          index += 1
          continue
        }
        let indent = leadingSpaces(line)
        if indent >= marker.contentIndent {
          body.append(String(line.dropFirst(marker.contentIndent)))
        } else if listMarker(line) != nil && indent >= marker.indent + 2 {
          // A nested list indented less than the content column still nests.
          body.append(String(line.dropFirst(indent)))
        } else if !blank && listMarker(line) == nil && !startsBlock(trimmed) {
          body.append(trimmed)  // A lazy continuation of the item's paragraph.
        } else {
          break
        }
        blank = false
        index += 1
      }
      while body.last?.isEmpty == true { body.removeLast() }
      var checked: Bool?
      if let task = body.first, task.count >= 3, task.hasPrefix("["),
        ["[ ]", "[x]", "[X]"].contains(String(task.prefix(3))),
        task.count == 3 || task.dropFirst(3).first == " "
      {
        checked = task.prefix(3) != "[ ]"
        body[0] = String(task.dropFirst(3)).trimmingCharacters(in: .whitespaces)
      }
      items.append(MarkdownListItem(checked: checked, blocks: parse(lines: body[...])))
    }
    return (.list(ordered: first.ordered, start: first.number, items: items), index)
  }

  private static func startsBlock(_ trimmed: String) -> Bool {
    trimmed.hasPrefix(">") || trimmed.hasPrefix("#") || fenceOpening(trimmed) != nil
      || isRule(trimmed)
  }

  private static func cells(_ line: String) -> [String] {
    var text = line.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("|") { text.removeFirst() }
    if text.hasSuffix("|") && !text.hasSuffix("\\|") { text.removeLast() }
    var cells: [String] = []
    var current = ""
    var escaped = false
    var code = false
    for char in text {
      if escaped {
        current.append(char == "|" ? "|" : "\\\(char)")
        escaped = false
      } else if char == "\\" {
        escaped = true
      } else if char == "`" {
        code.toggle()
        current.append(char)
      } else if char == "|" && !code {
        cells.append(current.trimmingCharacters(in: .whitespaces))
        current = ""
      } else {
        current.append(char)
      }
    }
    cells.append(current.trimmingCharacters(in: .whitespaces))
    return cells
  }

  private static func delimiterRow(_ line: String) -> [MarkdownAlignment]? {
    guard line.contains("-") else { return nil }
    let parts = cells(line)
    var alignments: [MarkdownAlignment] = []
    for part in parts {
      let leading = part.hasPrefix(":")
      let trailing = part.hasSuffix(":")
      let dashes = part.dropFirst(leading ? 1 : 0).dropLast(trailing && part.count > 1 ? 1 : 0)
      guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
      alignments.append(leading && trailing ? .center : trailing ? .trailing : .leading)
    }
    return alignments
  }
}

extension Markdown {
  /// A block's inline syntax (emphasis, code, links, strikethrough) with the
  /// source's line breaks kept. Text that is not valid Markdown stays literal.
  static func inline(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
  }

  /// The words of a reply for VoiceOver and for Copy, without Markdown marks.
  static func plainText(_ blocks: [MarkdownBlock]) -> String {
    blocks.map { block -> String in
      switch block {
      case .heading(_, let text), .paragraph(let text):
        return String(inline(text).characters)
      case .list(let ordered, let start, let items):
        return items.enumerated().map { offset, item in
          let mark = ordered ? "\(start + offset)." : "•"
          return "\(mark) \(plainText(item.blocks))"
        }.joined(separator: "\n")
      case .quote(let inner):
        return plainText(inner)
      case .code(_, let text):
        return text
      case .table(let header, _, let rows):
        return ([header] + rows).map { $0.joined(separator: "  ") }.joined(separator: "\n")
      case .rule:
        return ""
      }
    }.filter { !$0.isEmpty }.joined(separator: "\n\n")
  }
}
