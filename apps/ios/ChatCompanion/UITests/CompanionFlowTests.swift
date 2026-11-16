import XCTest

final class CompanionFlowTests: XCTestCase {
  func testPairSendStreamStopAndForget() throws {
    continueAfterFailure = false
    guard let url = Bundle(for: Self.self).url(forResource: "LocalPairing", withExtension: "json")
    else { throw XCTSkip("Run Scripts/test-e2e.sh") }
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: String]
    let app = XCUIApplication()
    app.launch()
    if app.buttons["Connection options"].waitForExistence(timeout: 3) {
      forgetMac(in: app)
    }
    // The link field starts folded on a device with a camera, where scanning is
    // the main path; the simulator has no camera, so it starts open.
    XCTAssertTrue(app.buttons["Pair with your Mac"].waitForExistence(timeout: 10))
    if app.buttons["Enter pairing link"].exists { app.buttons["Enter pairing link"].tap() }
    let pairing =
      app.textFields["pairing-link"].exists
      ? app.textFields["pairing-link"] : app.textViews["pairing-link"]
    XCTAssertTrue(pairing.waitForExistence(timeout: 10))
    focus(pairing, in: app)
    pairing.typeText(fixture["pairingLink"]!)
    app.buttons["connect"].tap()
    XCTAssertTrue(
      app.buttons["familiar-picker"].waitForExistence(timeout: 20), app.debugDescription)
    XCTAssertTrue(
      app.staticTexts.containing(
        NSPredicate(format: "label CONTAINS %@", "Secure companion connected.")
      ).firstMatch.waitForExistence(timeout: 15))
    let composer =
      app.textFields["composer"].exists ? app.textFields["composer"] : app.textViews["composer"]
    focus(composer, in: app)
    composer.typeText("Hello from the iPhone")
    let send = app.buttons["send"]
    // A transient polling failure disables Send until the next authenticated
    // refresh. XCTest may tap a disabled button without reporting an error.
    let readyToSend = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true AND hittable == true"), object: send)
    XCTAssertEqual(XCTWaiter.wait(for: [readyToSend], timeout: 20), .completed)
    send.tap()
    XCTAssertTrue(app.buttons["stop"].waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Fixture reply arrived."))
        .firstMatch.waitForExistence(timeout: 10))
    app.buttons["stop"].tap()
    XCTAssertTrue(app.buttons["send"].waitForExistence(timeout: 15))

    // A familiar asks for permission, and the person allows it from the phone.
    focus(composer, in: app)
    composer.typeText("This needs permission")
    // An expectation can be waited on only once.
    let readyAgain = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true AND hittable == true"), object: send)
    XCTAssertEqual(XCTWaiter.wait(for: [readyAgain], timeout: 20), .completed)
    send.tap()
    let allow = app.buttons["approval-allow"]
    XCTAssertTrue(allow.waitForExistence(timeout: 20), app.debugDescription)
    XCTAssertTrue(app.staticTexts["approval-summary"].label.contains("Create fixture.txt"))
    let canAllow = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true AND hittable == true"), object: allow)
    XCTAssertEqual(XCTWaiter.wait(for: [canAllow], timeout: 20), .completed)
    allow.tap()
    // The confirmation's own button, not the card's behind it.
    let confirm = app.buttons.matching(
      NSPredicate(format: "label == %@ AND identifier != %@", "Allow once", "approval-allow")
    ).firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 10), app.debugDescription)
    confirm.tap()
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Created fixture.txt."))
        .firstMatch.waitForExistence(timeout: 20), app.debugDescription)
    XCTAssertFalse(app.buttons["approval-allow"].exists)
    chooseConnectionAction(app.buttons["Permission Log"], in: app)
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Allowed on iPhone"))
        .firstMatch.waitForExistence(timeout: 15), app.debugDescription)
    app.buttons["Done"].tap()

    app.terminate()
    app.launch()
    XCTAssertTrue(
      app.buttons["familiar-picker"].waitForExistence(timeout: 20),
      "Pairing did not survive relaunch")
    forgetMac(in: app)
    XCTAssertTrue(app.buttons["Pair with your Mac"].waitForExistence(timeout: 10))
    app.terminate()
    app.launch()
    XCTAssertTrue(
      app.buttons["Pair with your Mac"].waitForExistence(timeout: 10),
      "Forgotten pairing reappeared")
  }

  @MainActor func testDraftRelaunchPrivacyAndUncertainSendRecovery() async throws {
    continueAfterFailure = false
    guard let url = Bundle(for: Self.self).url(forResource: "LocalPairing", withExtension: "json")
    else { throw XCTSkip("Run Scripts/test-e2e.sh") }
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: String]
    let app = XCUIApplication()
    app.launch()
    if app.buttons["Connection options"].waitForExistence(timeout: 3) {
      forgetMac(in: app)
    }
    XCTAssertTrue(app.buttons["Pair with your Mac"].waitForExistence(timeout: 10))
    if app.buttons["Enter pairing link"].exists { app.buttons["Enter pairing link"].tap() }
    let link = app.textFields["pairing-link"].exists ? app.textFields["pairing-link"] : app.textViews["pairing-link"]
    focus(link, in: app)
    link.typeText(fixture["pairingLink"]!)
    app.buttons["connect"].tap()
    XCTAssertTrue(app.buttons["familiar-picker"].waitForExistence(timeout: 20))
    let composer = app.textFields["composer"].exists ? app.textFields["composer"] : app.textViews["composer"]
    focus(composer, in: app)
    composer.typeText("Draft survives relaunch")
    chooseConnectionAction(app.buttons["mobile-privacy"], in: app)
    XCTAssertTrue(app.switches["cache-conversation-text"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["clear-downloaded-history"].exists)
    app.buttons["Done"].tap()

    let control = try FixtureControl(fixture)
    addTeardownBlock {
      _ = try? await control.change(["offline": false, "dropNextSend": false, "headChanged": false, "stopActive": true])
      control.invalidate()
    }
    _ = try await control.change(["reset": true, "offline": true])
    app.terminate()
    app.launch()
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    XCTAssertEqual(composer.value as? String, "Draft survives relaunch")
    XCTAssertTrue(app.staticTexts["cached-history-status"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["send"].isEnabled)
    _ = try await control.change(["offline": false])
    let sendReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["send"])
    await fulfillment(of: [sendReady], timeout: 20)
    _ = try await control.change(["dropNextSend": true, "offlineAfterDrop": true])
    app.buttons["send"].tap()
    XCTAssertTrue(app.buttons["Review uncertain send"].waitForExistence(timeout: 15))
    app.terminate()
    app.launch()
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["send"].isEnabled)
    let admitted = try await control.change()
    XCTAssertEqual(admitted.sendCount, 1)
    let requestID = try XCTUnwrap(admitted.lastRequestID)
    _ = try await control.change(["offline": false])
    XCTAssertTrue(app.buttons["stop"].waitForExistence(timeout: 20))
    let checked = try await control.change()
    XCTAssertEqual(checked.sendCount, 1, "Relaunch must reconcile, never resubmit")
    XCTAssertTrue(checked.receiptIDs.contains(requestID))
    app.buttons["stop"].tap()
    XCTAssertTrue(app.buttons["send"].waitForExistence(timeout: 15))
    focus(composer, in: app)
    composer.typeText("Draft from the previous chat")
    _ = try await control.change(["headChanged": true])
    XCTAssertTrue(app.buttons["recovered-drafts"].waitForExistence(timeout: 15))
    app.buttons["recovered-drafts"].tap()
    XCTAssertTrue(app.textViews["recovered-draft-editor"].waitForExistence(timeout: 5))
    let recoveredEditor = app.textViews["recovered-draft-editor"]
    focus(recoveredEditor, in: app)
    recoveredEditor.typeText(" Edited recovery")
    let editedRecovery = try XCTUnwrap(recoveredEditor.value as? String)
    XCTAssertTrue(editedRecovery.contains("Edited recovery"))
    app.buttons["Done"].tap()
    app.terminate()
    app.launch()
    XCTAssertTrue(app.buttons["recovered-drafts"].waitForExistence(timeout: 15))
    app.buttons["recovered-drafts"].tap()
    XCTAssertTrue(recoveredEditor.waitForExistence(timeout: 5))
    XCTAssertEqual(recoveredEditor.value as? String, editedRecovery)
    app.buttons["Add to Current Draft"].tap()
    XCTAssertTrue((composer.value as? String ?? "").contains("Draft from the previous chat"))
    let afterRecovery = try await control.change()
    XCTAssertEqual(afterRecovery.sendCount, 1)
    focus(composer, in: app)
    composer.typeText("Text only while open")
    chooseConnectionAction(app.buttons["mobile-privacy"], in: app)
    let privacyToggle = app.switches["cache-conversation-text"]
    XCTAssertTrue(privacyToggle.waitForExistence(timeout: 10), app.debugDescription)
    let privacyImage = XCTAttachment(screenshot: app.screenshot())
    privacyImage.name = "Phone privacy before toggle"
    privacyImage.lifetime = .keepAlways
    add(privacyImage)
    // SwiftUI exposes the whole labelled row as a Switch as well as the native control.
    // Tap the contained control, rather than the row centre (which lands on its text).
    let nativeSwitch = app.switches.allElementsBoundByIndex.first {
      $0.frame.width < privacyToggle.frame.width && privacyToggle.frame.contains($0.frame)
    } ?? privacyToggle
    nativeSwitch.tap()
    let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: privacyToggle)
    await fulfillment(of: [enabled], timeout: 5)
    app.buttons["Done"].tap()
    app.terminate()
    app.launch()
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    XCTAssertFalse((composer.value as? String ?? "").contains("Text only while open"))
    forgetMac(in: app)
    app.terminate()
    app.launch()
    XCTAssertTrue(app.buttons["Pair with your Mac"].waitForExistence(timeout: 10))
  }

  private func forgetMac(in app: XCUIApplication) {
    chooseConnectionAction(app.buttons["Forget Mac"], in: app)
    let confirmation = app.sheets.buttons["Forget Mac"].firstMatch
    XCTAssertTrue(confirmation.waitForExistence(timeout: 10), app.debugDescription)
    confirmation.tap()
    XCTAssertTrue(app.buttons["Pair with your Mac"].waitForExistence(timeout: 10))
  }

  /// iOS 26.5 can expose a visible SwiftUI menu row with an invalid AX tap point
  /// (-1, -1). Use its observed on-screen centre; the following assertions must
  /// still prove that the actual privacy sheet, log or confirmation opened.
  private func chooseConnectionAction(_ action: XCUIElement, in app: XCUIApplication) {
    app.buttons["Connection options"].tap()
    let visible = XCTNSPredicateExpectation(predicate: NSPredicate { element, _ in
      guard let row = element as? XCUIElement, row.exists, row.isEnabled else { return false }
      let frame = row.frame
      return !frame.isEmpty && app.frame.contains(frame)
    }, object: action)
    XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 10), .completed, app.debugDescription)
    action.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
  }

  /// Taps `field` until it holds keyboard focus, so `typeText` has somewhere to
  /// go. Right after pairing the screen is still settling, and XCTest can drop
  /// a tap there without an error. `typeText` then fails with "Neither element
  /// nor any descendant has keyboard focus", as it did on CI three times on
  /// 2026-10-18.
  private func focus(_ field: XCUIElement, in app: XCUIApplication) {
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true AND hittable == true"), object: field)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed, app.debugDescription)
    let focused = NSPredicate(format: "hasKeyboardFocus == true")
    for _ in 0..<5 {
      field.tap()
      let tookFocus = XCTNSPredicateExpectation(predicate: focused, object: field)
      if XCTWaiter.wait(for: [tookFocus], timeout: 2) == .completed { return }
    }
    XCTFail("\(field.identifier) never took keyboard focus\n\(app.debugDescription)")
  }
}
