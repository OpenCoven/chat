# Windows install identity

The NSIS template is vendored from [Tauri tauri-cli-v2.11.4](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi), under the adjacent MIT license. Its upstream SHA-256 is `20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079`.

Three changes preserve upgrades while displaying Coven Chat: retain the OpenCoven Chat uninstall key, retain the manufacturer/product installation key, and recognize either display name when locating a prior MSI. Keep these changes when updating the pinned Tauri template. MSI separately pins the legacy UpgradeCode in tauri.conf.json. Debian replacement metadata declares that the new package replaces and provides opencoven-chat.

These are package migration declarations. Installing and upgrading published Windows and Linux packages still requires the existing native acceptance lanes.
