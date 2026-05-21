# PWA icons — what's needed

These files are referenced by `manifest.json` + `index.html`. Until they
exist, the install experience falls back to ugly defaults (Vite's
default icon, generic name). Generation is a one-shot — set them up
once, replace if the brand mark changes.

| File | Size | Used by | Required? |
|---|---|---|---|
| `/icon-192.png` | 192×192 | Android manifest (small) | yes |
| `/icon-512.png` | 512×512 | Android manifest (large) | yes |
| `/icon-512-maskable.png` | 512×512 | Android adaptive icon | recommended |
| `/icon-180.png` | 180×180 | iOS apple-touch-icon | yes for iOS install |
| `/favicon.ico` | 32×32 | browser tab (legacy) | optional — SVG fallback works in modern browsers |

## Easiest path: one-shot generator

1. Get a 1024×1024 PNG of the pickYum mark (orange/red gradient
   background, plate/utensil glyph). Hire a designer or use a tool
   like Looka / Canva for a quick brand mark.
2. Drop it into <https://realfavicongenerator.net/> — it spits out a
   zip with every size + a snippet to verify.
3. Copy `icon-192.png`, `icon-512.png`, `icon-180.png` into this
   `public/` folder.
4. For the maskable variant, use <https://maskable.app/editor> to
   pad the icon with a safe zone, export as `icon-512-maskable.png`.

## Quick & dirty (placeholder until real brand mark exists)

Generate solid-color squares with the 🍽️ emoji centered:

```bash
# macOS (requires ImageMagick): brew install imagemagick
for size in 192 512 180; do
  convert -size ${size}x${size} xc:'#f97316' \
    -fill white -gravity center \
    -font 'Apple-Color-Emoji' -pointsize $((size/2)) \
    -annotate +0+$((size/8)) '🍽️' \
    icon-${size}.png
done
```

ImageMagick may not render emoji on all systems — if not, use a free
tool like <https://favicon.io/emoji-favicons/> ("Fork and knife")
which generates everything from an emoji or text.

## Verification

Once the files are in place, install the PWA on a real iOS device and
check the home-screen icon. Test on Android via Chrome's "Install
app" menu.
