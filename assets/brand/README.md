# Coven Chat logo

The Coven Chat mark is the OpenCoven crown inside an outlined speech bubble,
white on ink black (`#050409`).

| File | What it is | Used for |
| --- | --- | --- |
| `chat-app-icon.svg` | Opaque square, full-bleed ink black | iOS App Store icon, `public/apple-touch-icon.png` |
| `chat-app-icon-rounded.svg` | Rounded cutout with transparent corners | Desktop bundle icons, `public/favicon.svg`, Settings › About, README |
| `chat-logo.svg` | The mark alone, black, no background | iOS `ChatLogo` template image (tinted in code) |

## Platform usage

- **iOS** masks app icon corners itself, so `AppIcon-1024.png` must stay the
  opaque 1024 × 1024 square with no alpha channel. Never use the rounded
  cutout there. In-app surfaces use `Image("ChatLogo")`, a template image that
  takes the view's foreground style.
- **macOS, Windows, and Linux** don't mask icons, so the desktop bundle uses the
  rounded cutout.
- **Web:** `favicon.svg` is the rounded cutout. `apple-touch-icon.png` is the
  opaque square, because iOS masks it.
- Don't recolor, stretch, or outline the crown, and keep the bubble outlined.
  The OpenCoven master mark's own rules apply to the crown.

## Regenerating the exports

```bash
node scripts/render-brand-icons.mjs
```

This rewrites `src-tauri/icons/` (`32x32.png`, `128x128.png`,
`128x128@2x.png`, `icon.png`, `icon.icns`, `icon.ico`), the iOS
`AppIcon-1024.png`, `public/apple-touch-icon.png`, `public/favicon.svg`,
and the iOS `ChatLogo.svg`. Rendering uses the pinned Tauri CLI's `tauri icon`.
The script then re-encodes the iOS icons without an alpha channel, after
checking that every pixel is opaque. It also sorts the ICNS entries, because
`tauri icon` writes them in a different order on each run. With that, a rerun
on the same machine reproduces every export byte for byte.
`src/brand-assets.test.ts` checks that the vector copies match these sources,
that the iOS icon has no alpha channel, and that the ICNS order is canonical.

## Provenance

- **Crown:** the `d` path of `OpenCoven_Master_Mark.svg` from the OpenCoven
  identity asset pack ("preferred production master"), unchanged. It is
  uniformly scaled by 0.67 and centered at (627, 568) in the 1254 px canvas.
- **Bubble and placement** are fitted to the approved artwork from 2026-10-11/12:
  - *OpenCoven crown chat bubble icon.png*: the opaque square.
  - *Crown and chat bubble on black.png*: the rounded cutout.
  - Both are 1254 px, so the SVGs keep that coordinate space.
- **Bubble geometry:**
  - The center line is a rounded rectangle from (215, 227) to (1039, 896), with
    corner radius 206 and a 37.5 px stroke, round joins and caps.
  - The tail leaves the bottom edge at x = 480, reaches its tip at (262, 1011),
    and returns to the lower-left corner arc.
  - It covers the approved bubble with 96% pixel overlap.
- **The crown's width:** the approved raster's crown is about 7% wider than the
  master mark. The master mark wins, because the pack forbids stretching.
- **Rounded tile:** each corner curve starts 356 px from the corner, drawn as a
  cubic with handles at 0.371 of that length. Both values were measured from the
  approved cutout.
- **Ink black** `#050409` is the background of the pack's
  `OpenCoven_App_Icon_Dark_1024.png`.
