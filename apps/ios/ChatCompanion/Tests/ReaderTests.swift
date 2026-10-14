import XCTest

@testable import ChatCompanion

final class ToolSegmentTests: XCTestCase {
  func testLiftsToolCallsOutOfProse() {
    XCTAssertEqual(
      ToolSegments.split("Looking first.⚒ Bash(set +e)Now I'll author the file."),
      [
        .text("Looking first."), .tool(name: "Bash", args: "set +e"),
        .text("Now I'll author the file."),
      ])
  }

  func testQuotedParenthesesStayInsideTheArguments() {
    XCTAssertEqual(
      ToolSegments.split(#"⚒ Bash(echo "a)b" | wc)done"#),
      [.tool(name: "Bash", args: #"echo "a)b" | wc"#), .text("done")])
  }

  func testAnApostropheDoesNotSwallowTheLine() {
    XCTAssertEqual(
      ToolSegments.split("⚒ Grep(don't) next"),
      [.tool(name: "Grep", args: "don't"), .text(" next")])
  }

  func testTruncatedSummaryEndsAtTheLine() {
    XCTAssertEqual(
      ToolSegments.split("⚒ Read(src/a.ts\nThen prose."),
      [.tool(name: "Read", args: "src/a.ts"), .text("\nThen prose.")])
  }

  func testMarkersInCodeAreLeftAlone() {
    let fenced = "Run:\n```\n⚒ Bash(ls)\n```\nDone."
    XCTAssertEqual(ToolSegments.split(fenced), [.text(fenced)])
    XCTAssertEqual(ToolSegments.split("Use `⚒ Bash(x)` here."), [.text("Use `⚒ Bash(x)` here.")])
  }

  func testVariationSelectorAndLegacyMarkers() {
    XCTAssertEqual(
      ToolSegments.split("⚒\u{FE0F} WebFetch(https://a.b)✳ functions.exec_command(ls)"),
      [
        .tool(name: "WebFetch", args: "https://a.b"),
        .tool(name: "functions.exec_command", args: "ls"),
      ])
  }
}

final class RunOnSentenceTests: XCTestCase {
  func testSplitsSentencesTheStreamRanTogether() {
    XCTAssertEqual(
      RunOnSentences.separate("the verified research.Everything's grounded. All set!Next step"),
      "the verified research.\n\nEverything's grounded. All set!\n\nNext step")
  }

  func testLeavesAbbreviationsCodeAndAddressesAlone() {
    for text in [
      "e.g.The rest", "Open `Theme.Swift` now", "See example.com/Docs.Html", "U.S.Army",
      "```\nfoo.Bar\n```",
    ] {
      XCTAssertEqual(RunOnSentences.separate(text), text, text)
    }
  }
}

final class TranscriptTests: XCTestCase {
  func testGroupsToolCallsAcrossMessagesAndWorkingLines() {
    let items = TranscriptItem.build([
      Message(id: "0", role: "user", text: "Fix it"),
      Message(id: "1", role: "assistant", text: "On it.⚒ Bash(ls)⚒ Read(a.swift)"),
      Message(id: "2", role: "status", text: "Working…"),
      Message(id: "3", role: "assistant", text: "Done."),
      Message(id: "4", role: "status", text: "Chat carried 4 earlier turns into this run."),
    ])
    XCTAssertEqual(
      items,
      [
        .user(id: "0", text: "Fix it"),
        .reply(id: "1.0", text: "On it."),
        .tools(
          id: "1.1",
          calls: [
            ToolCall(name: "Bash", args: "ls"), ToolCall(name: "Read", args: "a.swift"),
            ToolCall(name: nil, args: ""),
          ]),
        .reply(id: "3.0", text: "Done."),
        .notice(id: "4", text: "Chat carried 4 earlier turns into this run."),
      ])
  }

  func testSummariesMatchTheMac() {
    let calls = ["Bash", "Bash", "Read", "functions.exec_command", "Edit"].map {
      ToolCall(name: $0, args: "")
    }
    XCTAssertEqual(ToolKind.summary(calls), "Ran 3 commands, read 1 file and edited 1 file")
    XCTAssertEqual(
      ToolKind.summary(["Alpha", "Beta", "Alpha", "Gamma", "Delta"].map { ToolCall(name: $0, args: "") }),
      "Called Alpha, Beta, Gamma and 1 more")
    XCTAssertEqual(ToolKind.summary([ToolCall(name: nil, args: "")]), "Used 1 tool")
    XCTAssertEqual(
      ToolKind.summary([ToolCall(name: "Bash", args: "ls"), ToolCall(name: nil, args: "")]),
      "Ran 1 command")
    XCTAssertEqual(ToolKind(name: "mcp.WebSearch"), .web)
  }
}

final class MarkdownTests: XCTestCase {
  func testHeadingsParagraphsAndRules() {
    XCTAssertEqual(
      Markdown.parse("# Title #\nSoft\nbreak  \nhard\n\n---\nSetext\n==="),
      [
        .heading(level: 1, text: "Title"), .paragraph("Soft break\nhard"), .rule,
        .heading(level: 1, text: "Setext"),
      ])
  }

  func testFencedCodeKeepsItsText() {
    XCTAssertEqual(
      Markdown.parse("Before\n```swift\nlet a = 1\n\n  // b\n```\nAfter"),
      [
        .paragraph("Before"), .code(language: "swift", text: "let a = 1\n\n  // b"),
        .paragraph("After"),
      ])
    XCTAssertEqual(
      Markdown.parse("```\nnever closed"), [.code(language: "", text: "never closed")])
  }

  func testListsNestAndCarryTasks() {
    XCTAssertEqual(
      Markdown.parse("- [x] done\n- [ ] todo\n  - nested\n\n3. three\n4. four"),
      [
        .list(
          ordered: false, start: 1,
          items: [
            MarkdownListItem(checked: true, blocks: [.paragraph("done")]),
            MarkdownListItem(
              checked: false,
              blocks: [
                .paragraph("todo"),
                .list(
                  ordered: false, start: 1,
                  items: [MarkdownListItem(checked: nil, blocks: [.paragraph("nested")])]),
              ]),
          ]),
        .list(
          ordered: true, start: 3,
          items: [
            MarkdownListItem(checked: nil, blocks: [.paragraph("three")]),
            MarkdownListItem(checked: nil, blocks: [.paragraph("four")]),
          ]),
      ])
  }

  func testQuotesAndTables() {
    XCTAssertEqual(
      Markdown.parse("> quoted\n> **line**\n\n| A | B |\n|:--|--:|\n| `a|b` | 2 |\n| 3"),
      [
        .quote([.paragraph("quoted **line**")]),
        .table(
          header: ["A", "B"], alignments: [.leading, .trailing],
          rows: [["`a|b`", "2"], ["3", ""]]),
      ])
  }

  func testPlainTextDropsMarks() {
    XCTAssertEqual(
      Markdown.plainText(Markdown.parse("**Bold** and `code`\n\n- one\n- two")),
      "Bold and code\n\n• one\n• two")
  }
}
