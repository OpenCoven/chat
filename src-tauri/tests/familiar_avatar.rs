#[path = "../src/familiar_avatar.rs"]
mod familiar_avatar;

#[test]
#[ignore = "Reads an explicitly selected installed familiar portrait"]
fn installed_portrait_becomes_a_small_png_without_modifying_it() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::{fs, path::PathBuf};

    let workspace = PathBuf::from(
        std::env::var_os("COVEN_CHAT_AVATAR_SMOKE_WORKSPACE").expect("Select an avatar workspace"),
    );
    let name = std::env::var("COVEN_CHAT_AVATAR_SMOKE_NAME").expect("Select a familiar name");
    let file = workspace.join("avatars").join(format!("{name}.png"));
    let before = fs::metadata(&file).unwrap();
    let result = familiar_avatar::read_avatar(&workspace, &name)
        .unwrap()
        .expect("The selected portrait must exist");
    let bytes = STANDARD
        .decode(result.strip_prefix("data:image/png;base64,").unwrap())
        .unwrap();
    let thumbnail = image::load_from_memory(&bytes).unwrap();
    assert!(thumbnail.width() <= 128 && thumbnail.height() <= 128);
    assert!(bytes.len() < 128 * 1024);
    let after = fs::metadata(&file).unwrap();
    assert_eq!(before.len(), after.len());
    assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    println!(
        "Verified {}x{} PNG thumbnail: {} bytes from {} byte original",
        thumbnail.width(),
        thumbnail.height(),
        bytes.len(),
        before.len()
    );
}
