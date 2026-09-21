//! The screen relay: how the chat window shows a remote desktop over VNC
//! without opening a network connection of its own.
//!
//! The webview hands the desktop host one WebSocket URL. The host performs
//! the WebSocket upgrade (RFC 6455) itself, then forwards opaque frames in
//! both directions and reports the close. That is the whole surface:
//!
//! - only `ws:` and `wss:` targets, never plain HTTP requests;
//! - the reply to the upgrade is checked and discarded, so no response body
//!   or header ever reaches the webview;
//! - the host adds no credentials, no cookies and no headers the webview
//!   chose;
//! - every message is bounded, and a session is torn down the moment either
//!   side closes.
//!
//! The VNC protocol itself (noVNC) runs in the webview; the host never
//! interprets the frames it carries.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use reqwest::{
    header::{CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE},
    StatusCode,
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};

/// Screens a window may hold open at once.
pub(crate) const MAX_SESSIONS: usize = 2;
/// The largest message accepted from the screen server, buffered or whole.
pub(crate) const MAX_DOWNSTREAM: usize = 16 * 1024 * 1024;
/// The largest message the webview may send; VNC client messages are tiny.
pub(crate) const MAX_UPSTREAM: usize = 64 * 1024;
/// URLs longer than this are refused before parsing.
pub(crate) const MAX_URL_LEN: usize = 2048;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_CHUNK: usize = 64 * 1024;

/// First byte of every message the host sends down the channel.
pub(crate) const TAG_DATA: u8 = 0;
pub(crate) const TAG_OPEN: u8 = 1;
/// Followed by a big-endian close code and a UTF-8 reason.
pub(crate) const TAG_CLOSE: u8 = 2;
/// Followed by a UTF-8 message the reader can act on.
pub(crate) const TAG_ERROR: u8 = 3;

const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

enum Upstream {
    Data(Vec<u8>),
    Close,
}

#[derive(Default)]
pub(crate) struct ScreenRelayState {
    sessions: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Upstream>>>>,
}

type Sessions = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Upstream>>>>;

/// Accepts a `ws:`/`wss:` URL and returns the `http:`/`https:` form the
/// upgrade request is sent to. Refuses anything that would add authority the
/// host does not mean to lend: other schemes, userinfo, or a missing host.
pub(crate) fn upgrade_target(input: &str) -> Result<url::Url, String> {
    if input.len() > MAX_URL_LEN {
        return Err("The screen address is too long.".into());
    }
    let mut target = url::Url::parse(input.trim())
        .map_err(|_| "Enter a WebSocket address such as wss://host/websockify.".to_string())?;
    let scheme = match target.scheme() {
        "ws" => "http",
        "wss" => "https",
        _ => return Err("The screen address must start with ws:// or wss://.".into()),
    };
    if target.host_str().is_none_or(str::is_empty) {
        return Err("The screen address needs a host.".into());
    }
    if !target.username().is_empty() || target.password().is_some() {
        return Err("Remove the username and password from the screen address.".into());
    }
    target
        .set_scheme(scheme)
        .map_err(|()| "The screen address could not be prepared.".to_string())?;
    Ok(target)
}

/// SHA-1, needed only for the RFC 6455 `Sec-WebSocket-Accept` check. The
/// digest is not used for anything security-sensitive here; the handshake
/// simply proves the peer speaks WebSocket rather than an HTTP server that
/// happened to answer 101.
pub(crate) fn sha1(message: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut padded = message.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&((message.len() as u64) * 8).to_be_bytes());
    for block in padded.as_chunks::<64>().0 {
        let mut w = [0u32; 80];
        for (i, word) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*word);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut digest = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        digest[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

pub(crate) fn accept_key(key: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .encode(sha1(format!("{key}{WEBSOCKET_GUID}").as_bytes()))
}

fn handshake_key() -> Result<String, String> {
    use base64::Engine as _;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| "Randomness is unavailable.".to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(nonce))
}

fn mask_key() -> Result<[u8; 4], String> {
    let mut key = [0u8; 4];
    getrandom::fill(&mut key).map_err(|_| "Randomness is unavailable.".to_string())?;
    Ok(key)
}

/// A client frame: always masked, as RFC 6455 requires of clients.
pub(crate) fn encode_frame(opcode: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 14);
    frame.push(0x80 | (opcode & 0x0F));
    match payload.len() {
        len if len < 126 => frame.push(0x80 | len as u8),
        len if len <= u16::MAX as usize => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        }
        len => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    frame
}

fn close_payload(code: u16, reason: &str) -> Vec<u8> {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason.as_bytes());
    payload
}

/// Opcode, FIN flag, payload and the bytes the frame occupied.
type ParsedFrame = (u8, bool, Vec<u8>, usize);

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Message {
    Data(Vec<u8>),
    Ping(Vec<u8>),
    Close(u16, String),
}

/// Parses server frames from a byte stream. Server frames must be unmasked;
/// fragmented data messages are reassembled; control frames interleave.
#[derive(Default)]
pub(crate) struct Decoder {
    buffer: Vec<u8>,
    fragments: Option<Vec<u8>>,
}

impl Decoder {
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.buffer.len() + bytes.len() > MAX_DOWNSTREAM + 14 {
            return Err("The screen server sent a message larger than 16 MiB.".into());
        }
        self.buffer.extend_from_slice(bytes);
        Ok(())
    }

    pub(crate) fn next(&mut self) -> Result<Option<Message>, String> {
        loop {
            let Some((opcode, fin, payload, consumed)) = self.frame()? else {
                return Ok(None);
            };
            self.buffer.drain(..consumed);
            match opcode {
                OP_TEXT | OP_BINARY => {
                    if self.fragments.is_some() {
                        return Err("The screen server interleaved two messages.".into());
                    }
                    if fin {
                        return Ok(Some(Message::Data(payload)));
                    }
                    self.fragments = Some(payload);
                }
                OP_CONTINUATION => {
                    let Some(mut fragments) = self.fragments.take() else {
                        return Err(
                            "The screen server continued a message it never started.".into()
                        );
                    };
                    if fragments.len() + payload.len() > MAX_DOWNSTREAM {
                        return Err("The screen server sent a message larger than 16 MiB.".into());
                    }
                    fragments.extend_from_slice(&payload);
                    if fin {
                        return Ok(Some(Message::Data(fragments)));
                    }
                    self.fragments = Some(fragments);
                }
                OP_PING => return Ok(Some(Message::Ping(payload))),
                OP_PONG => {}
                OP_CLOSE => {
                    let code = if payload.len() >= 2 {
                        u16::from_be_bytes([payload[0], payload[1]])
                    } else {
                        1005
                    };
                    let reason =
                        String::from_utf8_lossy(payload.get(2..).unwrap_or(&[])).into_owned();
                    return Ok(Some(Message::Close(code, reason)));
                }
                _ => return Err("The screen server sent an unknown frame.".into()),
            }
        }
    }

    /// One complete frame at the head of the buffer, or `None` until it is.
    fn frame(&self) -> Result<Option<ParsedFrame>, String> {
        let buffer = &self.buffer;
        if buffer.len() < 2 {
            return Ok(None);
        }
        let first = buffer[0];
        let second = buffer[1];
        if first & 0x70 != 0 {
            return Err("The screen server used a WebSocket extension this app does not.".into());
        }
        if second & 0x80 != 0 {
            return Err("The screen server sent a masked frame.".into());
        }
        let opcode = first & 0x0F;
        let fin = first & 0x80 != 0;
        let (length, header) = match second & 0x7F {
            126 => {
                if buffer.len() < 4 {
                    return Ok(None);
                }
                (u16::from_be_bytes([buffer[2], buffer[3]]) as usize, 4)
            }
            127 => {
                if buffer.len() < 10 {
                    return Ok(None);
                }
                let mut bytes = [0u8; 8];
                bytes.copy_from_slice(&buffer[2..10]);
                (
                    usize::try_from(u64::from_be_bytes(bytes)).unwrap_or(usize::MAX),
                    10,
                )
            }
            small => (small as usize, 2),
        };
        if length > MAX_DOWNSTREAM {
            return Err("The screen server sent a message larger than 16 MiB.".into());
        }
        if opcode >= OP_CLOSE && (!fin || length > 125) {
            return Err("The screen server sent an invalid control frame.".into());
        }
        if buffer.len() < header + length {
            return Ok(None);
        }
        Ok(Some((
            opcode,
            fin,
            buffer[header..header + length].to_vec(),
            header + length,
        )))
    }
}

/// A user-facing description that never echoes the URL: a screen address
/// may carry an access token in its query string.
fn describe(error: reqwest::Error) -> String {
    let error = error.without_url();
    if error.is_timeout() {
        "The screen server did not answer in time.".into()
    } else if error.is_connect() {
        "Could not reach the screen server. Check the address and that the desktop is running."
            .into()
    } else {
        format!("Could not connect to the screen server: {error}")
    }
}

async fn open_socket(target: url::Url) -> Result<reqwest::Upgraded, String> {
    let key = handshake_key()?;
    let client = reqwest::Client::builder()
        .http1_only()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(describe)?;
    let request = client
        .get(target)
        .header(CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header(SEC_WEBSOCKET_VERSION, "13")
        .header(SEC_WEBSOCKET_KEY, key.as_str());
    let response = tokio::time::timeout(CONNECT_TIMEOUT, request.send())
        .await
        .map_err(|_| "The screen server did not answer in time.".to_string())?
        .map_err(describe)?;
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        return Err(format!(
            "The screen server answered {} instead of opening a WebSocket. Check the address and any token it needs.",
            response.status().as_u16()
        ));
    }
    let upgraded_to_websocket = response
        .headers()
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let accepted = response
        .headers()
        .get(SEC_WEBSOCKET_ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim() == accept_key(&key));
    if !upgraded_to_websocket || !accepted {
        return Err("The screen server did not complete the WebSocket handshake.".into());
    }
    response.upgrade().await.map_err(describe)
}

fn deliver(channel: &Channel<InvokeResponseBody>, tag: u8, payload: &[u8]) -> bool {
    let mut message = Vec::with_capacity(payload.len() + 1);
    message.push(tag);
    message.extend_from_slice(payload);
    channel.send(InvokeResponseBody::Raw(message)).is_ok()
}

async fn pump(
    id: String,
    upgraded: reqwest::Upgraded,
    mut upstream: mpsc::UnboundedReceiver<Upstream>,
    channel: Channel<InvokeResponseBody>,
    sessions: Sessions,
) {
    let (mut reader, mut writer) = tokio::io::split(upgraded);
    let mut decoder = Decoder::default();
    let mut chunk = vec![0u8; READ_CHUNK];
    let mut announced_close: Option<(u16, String)> = None;
    'session: loop {
        tokio::select! {
            read = reader.read(&mut chunk) => {
                let count = match read {
                    Ok(0) | Err(_) => {
                        announced_close = Some((1006, "The screen connection ended.".into()));
                        break 'session;
                    }
                    Ok(count) => count,
                };
                if let Err(problem) = decoder.feed(&chunk[..count]) {
                    deliver(&channel, TAG_ERROR, problem.as_bytes());
                    announced_close = Some((1009, problem));
                    break 'session;
                }
                loop {
                    match decoder.next() {
                        Ok(None) => break,
                        Ok(Some(Message::Data(payload))) => {
                            if !deliver(&channel, TAG_DATA, &payload) {
                                break 'session;
                            }
                        }
                        Ok(Some(Message::Ping(payload))) => {
                            let Ok(mask) = mask_key() else { break 'session };
                            if writer.write_all(&encode_frame(OP_PONG, &payload, mask)).await.is_err() {
                                announced_close = Some((1006, "The screen connection ended.".into()));
                                break 'session;
                            }
                        }
                        Ok(Some(Message::Close(code, reason))) => {
                            if let Ok(mask) = mask_key() {
                                let _ = writer
                                    .write_all(&encode_frame(OP_CLOSE, &close_payload(code, ""), mask))
                                    .await;
                            }
                            announced_close = Some((code, reason));
                            break 'session;
                        }
                        Err(problem) => {
                            deliver(&channel, TAG_ERROR, problem.as_bytes());
                            if let Ok(mask) = mask_key() {
                                let _ = writer
                                    .write_all(&encode_frame(OP_CLOSE, &close_payload(1002, ""), mask))
                                    .await;
                            }
                            announced_close = Some((1002, problem));
                            break 'session;
                        }
                    }
                }
            }
            request = upstream.recv() => {
                match request {
                    Some(Upstream::Data(payload)) => {
                        let Ok(mask) = mask_key() else { break 'session };
                        if writer.write_all(&encode_frame(OP_BINARY, &payload, mask)).await.is_err() {
                            announced_close = Some((1006, "The screen connection ended.".into()));
                            break 'session;
                        }
                    }
                    Some(Upstream::Close) | None => {
                        if let Ok(mask) = mask_key() {
                            let _ = writer
                                .write_all(&encode_frame(OP_CLOSE, &close_payload(1000, ""), mask))
                                .await;
                        }
                        announced_close = Some((1000, "Disconnected.".into()));
                        break 'session;
                    }
                }
            }
        }
    }
    let _ = writer.shutdown().await;
    if let Ok(mut sessions) = sessions.lock() {
        sessions.remove(&id);
    }
    let (code, reason) = announced_close.unwrap_or((1006, "The screen connection ended.".into()));
    deliver(&channel, TAG_CLOSE, &close_payload(code, &reason));
}

#[tauri::command]
pub(crate) async fn coven_screen_connect(
    state: State<'_, ScreenRelayState>,
    url: String,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let target = upgrade_target(&url)?;
    let sessions = Arc::clone(&state.sessions);
    {
        let held = sessions
            .lock()
            .map_err(|_| "The screen relay is unavailable.".to_string())?;
        if held.len() >= MAX_SESSIONS {
            return Err(format!(
                "At most {MAX_SESSIONS} screens can be open at once. Disconnect one first."
            ));
        }
    }
    let upgraded = open_socket(target).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::unbounded_channel();
    {
        let mut held = sessions
            .lock()
            .map_err(|_| "The screen relay is unavailable.".to_string())?;
        if held.len() >= MAX_SESSIONS {
            return Err(format!(
                "At most {MAX_SESSIONS} screens can be open at once. Disconnect one first."
            ));
        }
        held.insert(id.clone(), sender);
    }
    if !deliver(&on_frame, TAG_OPEN, &[]) {
        if let Ok(mut held) = sessions.lock() {
            held.remove(&id);
        }
        return Err("The screen viewer went away before the connection opened.".into());
    }
    tauri::async_runtime::spawn(pump(id.clone(), upgraded, receiver, on_frame, sessions));
    Ok(id)
}

#[tauri::command]
pub(crate) fn coven_screen_send(
    state: State<'_, ScreenRelayState>,
    id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if bytes.len() > MAX_UPSTREAM {
        return Err("The screen message is too large.".into());
    }
    let held = state
        .sessions
        .lock()
        .map_err(|_| "The screen relay is unavailable.".to_string())?;
    let sender = held
        .get(&id)
        .ok_or_else(|| "This screen is no longer connected.".to_string())?;
    sender
        .send(Upstream::Data(bytes))
        .map_err(|_| "This screen is no longer connected.".to_string())
}

#[tauri::command]
pub(crate) fn coven_screen_disconnect(
    state: State<'_, ScreenRelayState>,
    id: String,
) -> Result<(), String> {
    let mut held = state
        .sessions
        .lock()
        .map_err(|_| "The screen relay is unavailable.".to_string())?;
    if let Some(sender) = held.remove(&id) {
        let _ = sender.send(Upstream::Close);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn sha1_matches_known_vectors() {
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(&sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex(&sha1(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        // Crosses the single-block boundary with a two-block padding.
        assert_eq!(
            hex(&sha1(&[b'a'; 64])),
            "0098ba824b5c16427bd7a1122a5a442a25ec644d"
        );
    }

    #[test]
    fn accept_key_matches_rfc_6455_example() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn only_websocket_addresses_with_a_host_and_no_userinfo_are_accepted() {
        assert_eq!(
            upgrade_target("wss://sandbox.example/websockify?token=abc")
                .unwrap()
                .as_str(),
            "https://sandbox.example/websockify?token=abc"
        );
        assert_eq!(
            upgrade_target(" ws://127.0.0.1:6080/ ").unwrap().as_str(),
            "http://127.0.0.1:6080/"
        );
        for rejected in [
            "https://sandbox.example/",
            "ftp://sandbox.example/",
            "wss://user:pw@sandbox.example/",
            "wss://user@sandbox.example/",
            "wss:",
            "not a url",
            "",
        ] {
            assert!(upgrade_target(rejected).is_err(), "{rejected} was accepted");
        }
        assert!(upgrade_target(&format!("wss://h/{}", "a".repeat(MAX_URL_LEN))).is_err());
    }

    #[test]
    fn rejection_messages_never_echo_the_address() {
        let error = upgrade_target("https://sandbox.example/websockify?token=secret").unwrap_err();
        assert!(!error.contains("secret"));
        assert!(!error.contains("sandbox.example"));
    }

    #[test]
    fn client_frames_are_masked_with_every_length_encoding() {
        let mask = [1, 2, 3, 4];
        let small = encode_frame(OP_BINARY, b"hi", mask);
        assert_eq!(small, vec![0x82, 0x82, 1, 2, 3, 4, b'h' ^ 1, b'i' ^ 2]);
        let medium = encode_frame(OP_BINARY, &[0u8; 300], mask);
        assert_eq!(&medium[..4], &[0x82, 0x80 | 126, 0x01, 0x2C]);
        assert_eq!(medium.len(), 4 + 4 + 300);
        let large = encode_frame(OP_BINARY, &[0u8; 70_000], mask);
        assert_eq!(&large[..2], &[0x82, 0x80 | 127]);
        assert_eq!(u64::from_be_bytes(large[2..10].try_into().unwrap()), 70_000);
        assert_eq!(large.len(), 10 + 4 + 70_000);
    }

    fn server_frame(fin: bool, opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mut frame = vec![if fin { 0x80 } else { 0 } | opcode];
        match payload.len() {
            len if len < 126 => frame.push(len as u8),
            len if len <= u16::MAX as usize => {
                frame.push(126);
                frame.extend_from_slice(&(len as u16).to_be_bytes());
            }
            len => {
                frame.push(127);
                frame.extend_from_slice(&(len as u64).to_be_bytes());
            }
        }
        frame.extend_from_slice(payload);
        frame
    }

    #[test]
    fn decoder_reassembles_fragments_and_interleaves_control_frames_byte_by_byte() {
        let mut stream = server_frame(false, OP_BINARY, b"hel");
        stream.extend(server_frame(true, OP_PING, b"p"));
        stream.extend(server_frame(true, OP_CONTINUATION, b"lo"));
        stream.extend(server_frame(true, OP_TEXT, &[0u8; 200]));
        stream.extend(server_frame(true, OP_PONG, b""));
        stream.extend(server_frame(true, OP_CLOSE, &close_payload(1001, "bye")));
        let mut decoder = Decoder::default();
        let mut messages = Vec::new();
        for byte in stream {
            decoder.feed(&[byte]).unwrap();
            while let Some(message) = decoder.next().unwrap() {
                messages.push(message);
            }
        }
        assert_eq!(
            messages,
            vec![
                Message::Ping(b"p".to_vec()),
                Message::Data(b"hello".to_vec()),
                Message::Data(vec![0u8; 200]),
                Message::Close(1001, "bye".into()),
            ]
        );
    }

    #[test]
    fn decoder_reads_large_frames_and_a_close_without_a_code() {
        let payload = vec![7u8; 70_000];
        let mut decoder = Decoder::default();
        decoder
            .feed(&server_frame(true, OP_BINARY, &payload))
            .unwrap();
        assert_eq!(decoder.next().unwrap(), Some(Message::Data(payload)));
        decoder.feed(&server_frame(true, OP_CLOSE, b"")).unwrap();
        assert_eq!(
            decoder.next().unwrap(),
            Some(Message::Close(1005, String::new()))
        );
        assert_eq!(decoder.next().unwrap(), None);
    }

    /// A minimal WebSocket server: one upgrade, then frames both ways. It is
    /// the peer the relay is written against, so the handshake, masking and
    /// close exchange are exercised over a real socket rather than in pieces.
    /// The request the relay sent, the payloads it wrote, and its close code.
    type ServerObservation = (String, Vec<Vec<u8>>, Option<u16>);

    async fn serve_once(listener: tokio::net::TcpListener, script: Vec<u8>) -> ServerObservation {
        use tokio::io::AsyncBufReadExt;
        let (stream, _) = listener.accept().await.unwrap();
        let mut stream = tokio::io::BufReader::new(stream);
        let mut request = String::new();
        loop {
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            request.push_str(&line);
        }
        let key = request
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("sec-websocket-key")
                    .then(|| value.trim().to_string())
            })
            .expect("the relay must send Sec-WebSocket-Key");
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
            accept_key(&key)
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(&script).await.unwrap();
        // Read the client's masked frames until it closes.
        let mut received = Vec::new();
        let mut close_code = None;
        let mut raw = Vec::new();
        let mut chunk = [0u8; 4096];
        'read: loop {
            let count = stream.read(&mut chunk).await.unwrap_or(0);
            if count == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..count]);
            loop {
                if raw.len() < 6 {
                    break;
                }
                let opcode = raw[0] & 0x0F;
                assert_eq!(raw[1] & 0x80, 0x80, "client frames must be masked");
                let (length, header) = match raw[1] & 0x7F {
                    126 => (u16::from_be_bytes([raw[2], raw[3]]) as usize, 4),
                    127 => (
                        u64::from_be_bytes(raw[2..10].try_into().unwrap()) as usize,
                        10,
                    ),
                    small => (small as usize, 2),
                };
                if raw.len() < header + 4 + length {
                    break;
                }
                let mask: [u8; 4] = raw[header..header + 4].try_into().unwrap();
                let payload: Vec<u8> = raw[header + 4..header + 4 + length]
                    .iter()
                    .enumerate()
                    .map(|(index, byte)| byte ^ mask[index % 4])
                    .collect();
                raw.drain(..header + 4 + length);
                match opcode {
                    OP_CLOSE => {
                        close_code = payload
                            .get(..2)
                            .map(|code| u16::from_be_bytes([code[0], code[1]]));
                        break 'read;
                    }
                    OP_PONG => received.push(b"pong:".iter().chain(&payload).copied().collect()),
                    _ => received.push(payload),
                }
            }
        }
        (request, received, close_code)
    }

    /// A channel that records every raw message it is sent.
    type CollectingChannel = (Channel<InvokeResponseBody>, Arc<Mutex<Vec<Vec<u8>>>>);

    fn collecting_channel() -> CollectingChannel {
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&collected);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().push(bytes);
            }
            Ok(())
        });
        (channel, collected)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relays_frames_both_ways_over_a_real_socket_and_closes_cleanly() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut script = server_frame(true, OP_BINARY, b"RFB 003.008\n");
        script.extend(server_frame(true, OP_PING, b"keep"));
        script.extend(server_frame(false, OP_BINARY, b"frag"));
        script.extend(server_frame(true, OP_CONTINUATION, b"ment"));
        let server = tokio::spawn(serve_once(listener, script));

        let target = upgrade_target(&format!("ws://127.0.0.1:{port}/websockify?token=t")).unwrap();
        let upgraded = open_socket(target).await.unwrap();
        let (channel, collected) = collecting_channel();
        let (sender, receiver) = mpsc::unbounded_channel();
        let sessions: Sessions = Arc::default();
        sessions.lock().unwrap().insert("s".into(), sender.clone());
        let relay = tokio::spawn(pump(
            "s".into(),
            upgraded,
            receiver,
            channel,
            Arc::clone(&sessions),
        ));

        sender
            .send(Upstream::Data(b"RFB 003.008\n".to_vec()))
            .unwrap();
        sender.send(Upstream::Data(vec![0u8; 300])).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        sender.send(Upstream::Close).unwrap();
        relay.await.unwrap();
        let (request, received, close_code) = server.await.unwrap();

        let request = request.to_ascii_lowercase();
        assert!(request.starts_with("get /websockify?token=t http/1.1\r\n"));
        assert!(request.contains("upgrade: websocket"));
        assert!(request.contains("sec-websocket-version: 13"));
        assert!(!request.contains("authorization"));
        assert!(!request.contains("cookie"));
        // The pong answers the server's ping from the read branch while the
        // data frames come from the write branch; `select!` decides which
        // branch is served first, so only the set is stable.
        let mut received = received;
        received.sort();
        let mut expected = vec![
            b"RFB 003.008\n".to_vec(),
            vec![0u8; 300],
            b"pong:keep".to_vec(),
        ];
        expected.sort();
        assert_eq!(received, expected);
        assert_eq!(close_code, Some(1000));
        let messages = collected.lock().unwrap().clone();
        assert_eq!(
            messages[0],
            vec![TAG_DATA]
                .into_iter()
                .chain(b"RFB 003.008\n".iter().copied())
                .collect::<Vec<u8>>()
        );
        assert_eq!(
            messages[1],
            vec![TAG_DATA]
                .into_iter()
                .chain(b"fragment".iter().copied())
                .collect::<Vec<u8>>()
        );
        let last = messages.last().unwrap();
        assert_eq!(last[0], TAG_CLOSE);
        assert_eq!(u16::from_be_bytes([last[1], last[2]]), 1000);
        assert!(sessions.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_server_that_does_not_upgrade_is_refused_without_echoing_the_address() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut sink = [0u8; 2048];
            let _ = stream.read(&mut sink).await;
            stream
                .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let target = upgrade_target(&format!("ws://127.0.0.1:{port}/?token=secret")).unwrap();
        let error = open_socket(target).await.unwrap_err();
        assert!(error.contains("403"), "{error}");
        assert!(!error.contains("secret"));
        assert!(!error.contains("127.0.0.1"));

        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let target = upgrade_target(&format!("ws://127.0.0.1:{port}/?token=secret")).unwrap();
        let error = open_socket(target).await.unwrap_err();
        assert!(!error.contains("secret"));
        assert!(!error.contains("127.0.0.1"), "{error}");
    }

    #[test]
    fn decoder_rejects_protocol_violations_without_panicking() {
        let masked = {
            let mut frame = server_frame(true, OP_BINARY, b"x");
            frame[1] |= 0x80;
            frame
        };
        let reserved = {
            let mut frame = server_frame(true, OP_BINARY, b"x");
            frame[0] |= 0x40;
            frame
        };
        let fragmented_control = server_frame(false, OP_PING, b"x");
        let orphan_continuation = server_frame(true, OP_CONTINUATION, b"x");
        let unknown = server_frame(true, 0x3, b"x");
        let oversized_header = {
            let mut frame = vec![0x82, 127];
            frame.extend_from_slice(&((MAX_DOWNSTREAM as u64) + 1).to_be_bytes());
            frame
        };
        for bytes in [
            masked,
            reserved,
            fragmented_control,
            orphan_continuation,
            unknown,
            oversized_header,
        ] {
            let mut decoder = Decoder::default();
            decoder.feed(&bytes).unwrap();
            assert!(decoder.next().is_err(), "{bytes:?} was accepted");
        }
        let mut interleaved = Decoder::default();
        interleaved
            .feed(&server_frame(false, OP_BINARY, b"a"))
            .unwrap();
        interleaved
            .feed(&server_frame(true, OP_BINARY, b"b"))
            .unwrap();
        assert!(interleaved.next().is_err());
        let mut flooded = Decoder::default();
        assert!(flooded.feed(&vec![0u8; MAX_DOWNSTREAM + 15]).is_err());
    }
}
