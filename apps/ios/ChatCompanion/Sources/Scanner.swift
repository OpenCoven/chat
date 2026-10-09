import AVFoundation
import SwiftUI
import UIKit

struct PairingScanner: UIViewControllerRepresentable {
  let scanned: (String) -> Void
  func makeUIViewController(context: Context) -> ScannerController {
    let view = ScannerController()
    view.scanned = scanned
    return view
  }
  func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
  static func dismantleUIViewController(_ uiViewController: ScannerController, coordinator: ()) {
    uiViewController.stop()
  }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var scanned: ((String) -> Void)?
  private let capture = AVCaptureSession()
  private let queue = DispatchQueue(label: "ai.opencoven.chat.scanner")
  private var preview: AVCaptureVideoPreviewLayer?
  private var finished = false
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
      DispatchQueue.main.async {
        guard let self, !self.finished else { return }
        if allowed {
          self.configure()
        } else {
          self.explain(
            "Camera access is off. Enable it in Settings, or close this screen and paste your pairing link."
          )
        }
      }
    }
  }
  private func configure() {
    guard let camera = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: camera), capture.canAddInput(input)
    else {
      explain(
        "The camera is unavailable. Close this screen and paste the pairing link from your Mac.")
      return
    }
    capture.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard capture.canAddOutput(output) else {
      explain("Scanning is unavailable. Paste the pairing link instead.")
      return
    }
    capture.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    let layer = AVCaptureVideoPreviewLayer(session: capture)
    layer.videoGravity = .resizeAspectFill
    view.layer.addSublayer(layer)
    preview = layer
    layer.frame = view.bounds
    queue.async { [capture] in capture.startRunning() }
  }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }
  func metadataOutput(
    _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !finished,
      let text = metadataObjects.compactMap({
        ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue
      }).first
    else { return }
    stop()
    scanned?(text)
  }
  func stop() {
    finished = true
    queue.async { [capture] in capture.stopRunning() }
  }
  private func explain(_ text: String) {
    let label = UILabel()
    label.text = text
    label.textColor = .white
    label.numberOfLines = 0
    label.font = .preferredFont(forTextStyle: .body)
    label.adjustsFontForContentSizeCategory = true
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }
}
