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
      app.buttons["Connection options"].tap()
      app.buttons["Forget Mac"].tap()
      app.buttons["Forget Mac"].tap()
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
    app.terminate()
    app.launch()
    XCTAssertTrue(
      app.buttons["familiar-picker"].waitForExistence(timeout: 20),
      "Pairing did not survive relaunch")
    app.buttons["Connection options"].tap()
    app.buttons["Forget Mac"].tap()
    app.buttons["Forget Mac"].tap()
    XCTAssertTrue(app.buttons["Pair with your Mac"].waitForExistence(timeout: 10))
    app.terminate()
    app.launch()
    XCTAssertTrue(
      app.buttons["Pair with your Mac"].waitForExistence(timeout: 10),
      "Forgotten pairing reappeared")
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
