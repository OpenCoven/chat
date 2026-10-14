import Foundation

/// One tool call lifted out of a reply. A structured call the Mac reports only as
/// "Working…" has no name.
struct ToolCall: Equatable {
  let name: String?
  let args: String
}

/// What the transcript draws, in order. Built from the Mac's messages without
/// changing their text: replies stay Markdown, and tool calls written into a
/// reply as `⚒ Name(arguments)` become their own grouped rows.
enum TranscriptItem: Identifiable, Equatable {
  case user(id: String, text: String)
  case reply(id: String, text: String)
  case tools(id: String, calls: [ToolCall])
  case notice(id: String, text: String)

  var id: String {
    switch self {
    case .user(let id, _), .reply(let id, _), .tools(let id, _), .notice(let id, _): id
    }
  }

  /// The Mac sends a structured tool start as a status line with this text.
  static let anonymousToolText = "Working…"

  static func build(_ messages: [Message]) -> [TranscriptItem] {
    var items: [TranscriptItem] = []
    func appendTools(_ calls: [ToolCall], id: String) {
      if case .tools(let first, let earlier) = items.last {
        items[items.count - 1] = .tools(id: first, calls: earlier + calls)
      } else {
        items.append(.tools(id: id, calls: calls))
      }
    }
    for message in messages {
      switch message.role {
      case "user":
        items.append(.user(id: message.id, text: message.text))
      case "assistant":
        for (index, segment) in ToolSegments.split(message.text).enumerated() {
          let id = "\(message.id).\(index)"
          switch segment {
          case .text(let text): items.append(.reply(id: id, text: text))
          case .tool(let name, let args): appendTools([ToolCall(name: name, args: args)], id: id)
          }
        }
      default:
        if message.role == "status" && message.text == anonymousToolText {
          appendTools([ToolCall(name: nil, args: "")], id: message.id)
        } else {
          items.append(.notice(id: message.id, text: message.text))
        }
      }
    }
    return items
  }
}

/// A port of the desktop's `src/coven/tool-activity.ts`, so the phone splits a
/// reply exactly where Chat on the Mac does.
enum ToolSegments {
  enum Segment: Equatable {
    case text(String)
    case tool(name: String, args: String)
  }

  private static let markers: Set<Unicode.Scalar> = ["\u{2692}", "\u{2736}", "\u{2733}"]

  static func split(_ text: String) -> [Segment] {
    let scalars = Array(text.unicodeScalars)
    var segments: [Segment] = []
    var cursor = 0
    var index = 0
    while index < scalars.count {
      if let end = fenceEnd(scalars, at: index) {
        segmentProse(scalars, cursor..<index, into: &segments)
        segments.append(.text(string(scalars, index..<end)))
        cursor = end
        index = end
      } else {
        index += 1
      }
    }
    segmentProse(scalars, cursor..<scalars.count, into: &segments)

    // Adjacent prose pieces (around a fence) belong to one Markdown document.
    var merged: [Segment] = []
    for segment in segments {
      if case .text(let next) = segment, case .text(let last) = merged.last {
        merged[merged.count - 1] = .text(last + next)
      } else {
        merged.append(segment)
      }
    }
    return merged.compactMap { segment in
      guard case .text(let text) = segment else { return segment }
      let prose = RunOnSentences.separate(text)
      return prose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : .text(prose)
    }
  }

  /// The end of a ``` or ~~~ fence that opens at `index`: the closing marker, or
  /// the end of the text when the fence never closes.
  private static func fenceEnd(_ s: [Unicode.Scalar], at index: Int) -> Int? {
    guard index + 2 < s.count, s[index] == "`" || s[index] == "~",
      s[index + 1] == s[index], s[index + 2] == s[index]
    else { return nil }
    let mark = s[index]
    var probe = index + 3
    while probe + 2 < s.count {
      if s[probe] == mark && s[probe + 1] == mark && s[probe + 2] == mark { return probe + 3 }
      probe += 1
    }
    return s.count
  }

  /// Inline code spans: a run of N backticks up to the next run of exactly N.
  static func codeSpans(_ s: [Unicode.Scalar], _ range: Range<Int>) -> [Range<Int>] {
    var spans: [Range<Int>] = []
    var index = range.lowerBound
    func run(at start: Int) -> Int {
      var end = start
      while end < range.upperBound && s[end] == "`" { end += 1 }
      return end - start
    }
    while index < range.upperBound {
      guard s[index] == "`" else {
        index += 1
        continue
      }
      let length = run(at: index)
      var probe = index + length
      var closed = false
      while probe < range.upperBound {
        if s[probe] == "`" {
          let other = run(at: probe)
          if other == length {
            spans.append(index..<(probe + other))
            index = probe + other
            closed = true
            break
          }
          probe += other
        } else {
          probe += 1
        }
      }
      if !closed { index += length }
    }
    return spans
  }

  private static func segmentProse(
    _ s: [Unicode.Scalar], _ range: Range<Int>, into segments: inout [Segment]
  ) {
    let spans = codeSpans(s, range)
    var cursor = range.lowerBound
    var index = range.lowerBound
    while index < range.upperBound {
      guard markers.contains(s[index]), !spans.contains(where: { $0.contains(index) }),
        let (name, open) = toolName(s, after: index, limit: range.upperBound)
      else {
        index += 1
        continue
      }
      let close = closingParen(s, open, limit: range.upperBound)
      let argsEnd: Int
      let resume: Int
      if let close {
        argsEnd = close
        resume = close + 1
      } else {
        // A truncated summary never closes; end it at the next marker or line
        // and leave that terminator in place for the next pass.
        var stop = open + 1
        while stop < range.upperBound && !markers.contains(s[stop]) && s[stop] != "\n" {
          stop += 1
        }
        argsEnd = stop
        resume = stop
      }
      if index > cursor { segments.append(.text(string(s, cursor..<index))) }
      segments.append(.tool(name: name, args: string(s, (open + 1)..<argsEnd)))
      cursor = resume
      index = resume
    }
    if cursor < range.upperBound { segments.append(.text(string(s, cursor..<range.upperBound))) }
  }

  /// `[⚒✶✳][︎️]?\s*([A-Za-z][\w.-]*)\(` — the name and the index of `(`.
  private static func toolName(_ s: [Unicode.Scalar], after marker: Int, limit: Int) -> (
    String, Int
  )? {
    var index = marker + 1
    if index < limit && (s[index] == "\u{FE0E}" || s[index] == "\u{FE0F}") { index += 1 }
    while index < limit && s[index].properties.isWhitespace { index += 1 }
    func letter(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("A"..."Z").contains(c) }
    guard index < limit, letter(s[index]) else { return nil }
    let start = index
    index += 1
    while index < limit,
      letter(s[index]) || ("0"..."9").contains(s[index]) || "_.-".unicodeScalars.contains(s[index])
    {
      index += 1
    }
    guard index < limit, s[index] == "(" else { return nil }
    return (string(s, start..<index), index)
  }

  private enum Scan { case found(Int), missing, unterminatedQuote }

  /// The `)` matching `open`, or nil when the summary was truncated. Parentheses
  /// inside quotes are argument text; a quote that never closes on its line is
  /// an apostrophe, so the scan retries without quoting.
  private static func closingParen(_ s: [Unicode.Scalar], _ open: Int, limit: Int) -> Int? {
    switch scan(s, open, limit: limit, quoting: true) {
    case .found(let index): return index
    case .missing: return nil
    case .unterminatedQuote:
      if case .found(let index) = scan(s, open, limit: limit, quoting: false) { return index }
      return nil
    }
  }

  private static func scan(_ s: [Unicode.Scalar], _ open: Int, limit: Int, quoting: Bool) -> Scan {
    var depth = 0
    var quote: Unicode.Scalar?
    var index = open
    while index < limit {
      let char = s[index]
      if char == "\n" && (quote != nil || (index + 1 < limit && s[index + 1] == "\n")) {
        // A summary never spans a paragraph break, so any later `)` is prose.
        return quote != nil ? .unterminatedQuote : .missing
      }
      if let open = quote {
        if char == "\\" && open == "\"" {
          index += 1
        } else if char == open {
          quote = nil
        }
      } else if quoting && (char == "\"" || char == "'") {
        quote = char
      } else if char == "(" {
        depth += 1
      } else if char == ")" {
        depth -= 1
        if depth == 0 { return .found(index) }
      }
      index += 1
    }
    return quote != nil ? .unterminatedQuote : .missing
  }

  fileprivate static func string(_ s: [Unicode.Scalar], _ range: Range<Int>) -> String {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: s[range])
    return String(view)
  }
}

/// A reply streamed as several messages can arrive with no break between them,
/// as in "the research.Everything's grounded". A sentence end followed at once
/// by a capitalised word starts a new paragraph. Code is left alone, and so is
/// "e.g.Foo", where the letter before the stop follows another stop.
enum RunOnSentences {
  static func separate(_ text: String) -> String {
    let s = Array(text.unicodeScalars)
    var fences: [Range<Int>] = []
    var index = 0
    while index + 2 < s.count {
      if (s[index] == "`" || s[index] == "~") && s[index + 1] == s[index] && s[index + 2] == s[index]
      {
        var end = index + 3
        while end + 2 < s.count
          && !(s[end] == s[index] && s[end + 1] == s[index] && s[end + 2] == s[index])
        {
          end += 1
        }
        end = min(s.count, end + 3)
        fences.append(index..<end)
        index = end
      } else {
        index += 1
      }
    }
    let code = fences + ToolSegments.codeSpans(s, 0..<s.count)
    var out = String.UnicodeScalarView()
    for (index, scalar) in s.enumerated() {
      out.append(scalar)
      guard index >= 2, index + 2 < s.count, ".!?".unicodeScalars.contains(scalar),
        isLower(s[index - 1]), isLetter(s[index - 2]), isUpper(s[index + 1]),
        isLower(s[index + 2]) || s[index + 2] == "'" || s[index + 2] == "\u{2019}",
        !code.contains(where: { $0.contains(index) }), !inLink(s, before: index)
      else { continue }
      out.append(contentsOf: "\n\n".unicodeScalars)
    }
    return String(out)
  }

  private static func isLower(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) }
  private static func isUpper(_ c: Unicode.Scalar) -> Bool { ("A"..."Z").contains(c) }
  private static func isLetter(_ c: Unicode.Scalar) -> Bool { isLower(c) || isUpper(c) }

  /// A stop inside an address ("example.com/Path" or "https://a.b/C.Doc").
  private static func inLink(_ s: [Unicode.Scalar], before index: Int) -> Bool {
    var start = index
    while start > 0 && !s[start - 1].properties.isWhitespace { start -= 1 }
    let word = ToolSegments.string(s, start..<index)
    return word.contains("://") || word.contains("/") || word.contains("@")
  }
}

/// What a tool call did, for the one-line summary of a group of calls.
enum ToolKind: CaseIterable {
  case command, read, edit, search, web, other

  private static let names: [ToolKind: Set<String>] = [
    .command: [
      "bash", "shell", "exec", "execcommand", "localshell", "shellcommand", "powershell",
      "terminal", "run",
    ],
    .read: ["read", "readfile", "view", "cat", "notebookread", "open"],
    .edit: [
      "edit", "multiedit", "write", "writefile", "applypatch", "patch", "strreplace", "create",
      "notebookedit",
    ],
    .search: [
      "grep", "glob", "search", "find", "ls", "list", "listdir", "listfiles", "rg",
      "codebasesearch",
    ],
    .web: ["webfetch", "websearch", "fetch", "browse", "browser"],
  ]

  /// Names compare without case, separators or a namespace (`functions.exec_command`).
  init(name: String?) {
    guard let name else {
      self = .other
      return
    }
    let last = name.split(separator: ".").last.map(String.init) ?? name
    let key = String(last.lowercased().unicodeScalars.filter { ("a"..."z").contains($0) })
    self = Self.allCases.first { Self.names[$0]?.contains(key) == true } ?? .other
  }

  var symbol: String {
    switch self {
    case .command: "terminal"
    case .read: "doc.text"
    case .edit: "pencil"
    case .search: "magnifyingglass"
    case .web: "globe"
    case .other: "wrench.and.screwdriver"
    }
  }

  /// The present-tense phrase for a call still running.
  var progress: String {
    switch self {
    case .command: "Running a command"
    case .read: "Reading a file"
    case .edit: "Editing a file"
    case .search: "Searching"
    case .web: "Reading the web"
    case .other: "Using a tool"
    }
  }

  fileprivate func phrase(_ n: Int) -> String {
    switch self {
    case .command: "ran \(n) \(n == 1 ? "command" : "commands")"
    case .read: "read \(n) \(n == 1 ? "file" : "files")"
    case .edit: "edited \(n) \(n == 1 ? "file" : "files")"
    case .search: "searched \(n) \(n == 1 ? "time" : "times")"
    case .web: "fetched \(n) \(n == 1 ? "page" : "pages")"
    case .other: "used \(n) other \(n == 1 ? "tool" : "tools")"
    }
  }

  /// A group of calls in one line, most frequent kind first, as on the Mac:
  /// "Ran 4 commands, read 2 files and edited 1 file". When every call is an
  /// unrecognised tool, the names say more; unnamed calls are just "tools".
  /// A step the Mac reports only as "Working…" adds nothing beside named calls,
  /// and may be the same call, so it counts only when nothing is named.
  static func summary(_ calls: [ToolCall]) -> String {
    let named = calls.compactMap(\.name)
    if named.isEmpty { return "Used \(calls.count) \(calls.count == 1 ? "tool" : "tools")" }
    var counts: [ToolKind: Int] = [:]
    for name in named { counts[ToolKind(name: name), default: 0] += 1 }
    if counts.count == 1, counts[.other] != nil {
      var unique: [String] = []
      for name in named where !unique.contains(name) { unique.append(name) }
      let listed = unique.prefix(3).joined(separator: ", ")
      let more = unique.count > 3 ? " and \(unique.count - 3) more" : ""
      return "Called \(listed)\(more)"
    }
    var phrases = counts.sorted {
      $0.value != $1.value
        ? $0.value > $1.value
        : allCases.firstIndex(of: $0.key)! < allCases.firstIndex(of: $1.key)!
    }.map { $0.key.phrase($0.value) }
    let last = phrases.removeLast()
    let text = phrases.isEmpty ? last : "\(phrases.joined(separator: ", ")) and \(last)"
    return text.prefix(1).uppercased() + text.dropFirst()
  }
}
