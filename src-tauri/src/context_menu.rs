//! The main window's web view setup on Windows and Linux: its right-click
//! menu offers text actions only (#547), and on Windows the autofill an
//! earlier version let WebView2 save is cleared (#578).
//!
//! # The right-click menu
//!
//! Links in a reply carry no address of their own, so a menu has nothing to
//! open. On macOS, WKWebView's menu already holds only text actions (Copy,
//! Look Up, Share and the like) and is left alone. WebView2 on Windows and
//! WebKitGTK on Linux instead offer the web view's page actions: Back, Refresh
//! or Reload, Stop, Save as, Print. Those would navigate or reload Chat's own
//! window, and lose drafts that live only in memory. On those two platforms,
//! every item that is not a text action is removed before the menu opens. A
//! menu left with nothing in it does not open.
//!
//! # Saved autofill
//!
//! v0.0.8 and earlier left WebView2's general autofill on, and it saved the
//! composer's text in the profile's `Web Data` (#546). v0.0.9 turned it off,
//! which stops new entries but leaves the old ones on disk. Each time Chat
//! starts on Windows it clears that one kind of saved data, and nothing else.
//! Clearing on every launch needs no marker file and also clears anything an
//! older version saved after a downgrade; with autofill off there is nothing
//! new to lose. macOS and Linux never stored typed text this way.
// The filter runs on Windows and Linux; macOS builds only its tests.
#![cfg_attr(not(any(windows, target_os = "linux", test)), allow(dead_code))]

/// What a web view's menu item is, as far as the filter cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    /// Works on text: Copy, Cut, Paste, Select all, Undo, spelling.
    Text,
    Separator,
    /// A page action, a link or image action, or anything else.
    Other,
}

/// The positions to keep: every text action, and a separator only where it
/// still falls between two kept groups.
pub(crate) fn kept(entries: &[Entry]) -> Vec<usize> {
    let mut keep = Vec::new();
    let mut separator = None;
    for (index, entry) in entries.iter().enumerate() {
        match entry {
            Entry::Text => {
                if let Some(at) = separator.take() {
                    if !keep.is_empty() {
                        keep.push(at);
                    }
                }
                keep.push(index);
            }
            Entry::Separator => {
                separator.get_or_insert(index);
            }
            Entry::Other => {}
        }
    }
    keep
}

/// WebView2's text actions, by the unlocalized `Name` of a menu item.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub(crate) fn webview2_entry(name: &str, separator: bool) -> Entry {
    if separator {
        return Entry::Separator;
    }
    match name {
        "copy" | "cut" | "paste" | "pasteAndMatchStyle" | "selectAll" | "undo" | "redo"
        | "emoji" => Entry::Text,
        _ => Entry::Other,
    }
}

/// WebView2's `COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL`: what text
/// fields were filled with, kept to suggest it again. Passwords and the web
/// view's storage are other kinds.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub(crate) const GENERAL_AUTOFILL: i32 = 1 << 10;

/// What Chat clears from its web view each time it starts on Windows (#578):
/// saved autofill only. Local storage, which keeps the selected familiar and
/// Settings, is a different kind, so it stays. Transcripts are Chat's own
/// files, outside the web view's profile.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub(crate) const CLEARED_AT_LAUNCH: i32 = GENERAL_AUTOFILL;

/// Installs the filter on the main window's web view, and on Windows clears
/// its saved autofill. Nothing on macOS.
pub(crate) fn install<R: tauri::Runtime>(app: &tauri::App<R>) {
    #[cfg(any(windows, target_os = "linux"))]
    {
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else {
            eprintln!("Coven Chat: no main window to keep page actions out of its menu");
            return;
        };
        if let Err(error) = window.with_webview(|webview| {
            #[cfg(windows)]
            {
                if let Err(error) = webview2::install(&webview) {
                    eprintln!("Coven Chat: could not filter the right-click menu: {error}");
                }
                // A failure is logged by its code only, and Chat still starts.
                if let Err(error) = webview2::clear_saved_autofill(&webview) {
                    eprintln!("Coven Chat: could not clear saved autofill: {error}");
                }
            }
            #[cfg(target_os = "linux")]
            webkitgtk::install(&webview);
        }) {
            eprintln!("Coven Chat: could not reach the web view: {error}");
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = app;
}

#[cfg(windows)]
mod webview2 {
    use super::{kept, webview2_entry, CLEARED_AT_LAUNCH, GENERAL_AUTOFILL};
    use webview2_com::{
        take_pwstr, ClearBrowsingDataCompletedHandler, ContextMenuRequestedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile2, ICoreWebView2_11, ICoreWebView2_13,
            COREWEBVIEW2_BROWSING_DATA_KINDS, COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL,
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        },
    };
    use windows_core::{Interface, PWSTR};

    // The value the tests check is WebView2's own.
    const _: () = assert!(GENERAL_AUTOFILL == COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL.0);

    /// Asks WebView2 to clear the profile's saved autofill. It finishes on its
    /// own; only a failure is reported, and only by its code.
    pub(super) fn clear_saved_autofill(
        webview: &tauri::webview::PlatformWebview,
    ) -> windows_core::Result<()> {
        // SAFETY: as in `install`.
        unsafe {
            webview
                .controller()
                .CoreWebView2()?
                .cast::<ICoreWebView2_13>()?
                .Profile()?
                .cast::<ICoreWebView2Profile2>()?
                .ClearBrowsingData(
                    COREWEBVIEW2_BROWSING_DATA_KINDS(CLEARED_AT_LAUNCH),
                    &ClearBrowsingDataCompletedHandler::create(Box::new(
                        |result: windows_core::Result<()>| {
                            if let Err(error) = result {
                                eprintln!(
                                    "Coven Chat: could not clear saved autofill: {error}"
                                );
                            }
                            Ok(())
                        },
                    )),
                )
        }
    }

    pub(super) fn install(webview: &tauri::webview::PlatformWebview) -> windows_core::Result<()> {
        // SAFETY: COM calls on the web view's own thread, which runs this
        // closure; every interface comes from WebView2 and is checked.
        unsafe {
            let core = webview
                .controller()
                .CoreWebView2()?
                .cast::<ICoreWebView2_11>()?;
            let mut token = 0i64;
            core.add_ContextMenuRequested(
                &ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let items = args.MenuItems()?;
                    let mut count = 0u32;
                    items.Count(&mut count)?;
                    let mut entries = Vec::with_capacity(count as usize);
                    for index in 0..count {
                        let item = items.GetValueAtIndex(index)?;
                        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
                        item.Kind(&mut kind)?;
                        let mut name = PWSTR::null();
                        item.Name(&mut name)?;
                        entries.push(webview2_entry(
                            &take_pwstr(name),
                            kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
                        ));
                    }
                    let keep = kept(&entries);
                    for index in (0..count).rev() {
                        if !keep.contains(&(index as usize)) {
                            items.RemoveValueAtIndex(index)?;
                        }
                    }
                    // Handled with nothing to show: no menu opens.
                    if keep.is_empty() {
                        args.SetHandled(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod webkitgtk {
    use super::{kept, Entry};
    use webkit2gtk::{ContextMenuAction, ContextMenuExt, ContextMenuItemExt, WebViewExt};

    fn entry(item: &webkit2gtk::ContextMenuItem) -> Entry {
        if item.is_separator() {
            return Entry::Separator;
        }
        match item.stock_action() {
            ContextMenuAction::Copy
            | ContextMenuAction::Cut
            | ContextMenuAction::Paste
            | ContextMenuAction::Delete
            | ContextMenuAction::SelectAll
            | ContextMenuAction::InputMethods
            | ContextMenuAction::Unicode
            | ContextMenuAction::SpellingGuess
            | ContextMenuAction::NoGuessesFound
            | ContextMenuAction::IgnoreSpelling
            | ContextMenuAction::LearnSpelling
            | ContextMenuAction::IgnoreGrammar => Entry::Text,
            _ => Entry::Other,
        }
    }

    pub(super) fn install(webview: &tauri::webview::PlatformWebview) {
        webview.inner().connect_context_menu(|_, menu, _, _| {
            let items = menu.items();
            let entries: Vec<Entry> = items.iter().map(entry).collect();
            let keep = kept(&entries);
            for (index, item) in items.iter().enumerate() {
                if !keep.contains(&index) {
                    menu.remove(item);
                }
            }
            // True stops the menu from opening: there is nothing left in it.
            keep.is_empty()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{kept, webview2_entry, Entry, CLEARED_AT_LAUNCH};

    /// `COREWEBVIEW2_BROWSING_DATA_KINDS`, with the values WebView2 documents.
    const FILE_SYSTEMS: i32 = 1 << 0;
    const INDEXED_DB: i32 = 1 << 1;
    const LOCAL_STORAGE: i32 = 1 << 2;
    const WEB_SQL: i32 = 1 << 3;
    const CACHE_STORAGE: i32 = 1 << 4;
    const ALL_DOM_STORAGE: i32 = 1 << 5;
    const COOKIES: i32 = 1 << 6;
    const ALL_SITE: i32 = 1 << 7;
    const GENERAL_AUTOFILL: i32 = 1 << 10;
    const SETTINGS: i32 = 1 << 13;
    const ALL_PROFILE: i32 = 1 << 14;

    #[test]
    fn launch_clears_the_autofill_v0_0_8_saved() {
        // #578: v0.0.8 left what the composer held in Web Data's autofill.
        assert_eq!(CLEARED_AT_LAUNCH & GENERAL_AUTOFILL, GENERAL_AUTOFILL);
    }

    #[test]
    fn launch_keeps_local_storage_and_the_rest_of_the_profile() {
        // Local storage holds opencoven.chat.navigation.v1 and
        // opencoven.chat.preferences.v1: the selected familiar and Settings.
        for kind in [
            FILE_SYSTEMS,
            INDEXED_DB,
            LOCAL_STORAGE,
            WEB_SQL,
            CACHE_STORAGE,
            ALL_DOM_STORAGE,
            COOKIES,
            ALL_SITE,
            SETTINGS,
            ALL_PROFILE,
        ] {
            assert_eq!(CLEARED_AT_LAUNCH & kind, 0, "kind {kind:#x} is cleared");
        }
        assert_eq!(CLEARED_AT_LAUNCH, GENERAL_AUTOFILL);
    }

    fn webview2(items: &[&str]) -> Vec<Entry> {
        items
            .iter()
            .map(|name| webview2_entry(name, *name == "-"))
            .collect()
    }

    #[test]
    fn the_v0_0_8_page_menus_keep_nothing_so_no_menu_opens() {
        // What #504's native lane read on the published v0.0.8 installers
        // after a right-click on a link in a reply (#547).
        let windows = webview2(&["back", "reload", "saveAs", "print", "-", "moreTools"]);
        assert!(kept(&windows).is_empty());
        let linux = [Entry::Other, Entry::Other, Entry::Other, Entry::Other];
        assert!(kept(&linux).is_empty());
    }

    #[test]
    fn text_actions_stay_with_the_separators_between_them() {
        let editing = webview2(&[
            "emoji",
            "-",
            "undo",
            "redo",
            "-",
            "cut",
            "copy",
            "paste",
            "-",
            "selectAll",
        ]);
        assert_eq!(kept(&editing), (0..editing.len()).collect::<Vec<_>>());
        // A selection in a reply: Copy and Select all, without the page actions.
        let selection = webview2(&[
            "copy",
            "copyLinkToHighlight",
            "-",
            "print",
            "-",
            "selectAll",
        ]);
        assert_eq!(kept(&selection), vec![0, 2, 5]);
    }

    #[test]
    fn link_actions_and_dangling_separators_go() {
        let link = webview2(&[
            "-",
            "openLinkInNewWindow",
            "copyLinkLocation",
            "-",
            "copy",
            "-",
            "inspectElement",
            "-",
        ]);
        assert_eq!(kept(&link), vec![4]);
    }
}
