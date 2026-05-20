// Client-side avatar processor. Reads the user's chosen File, draws it to
// an offscreen canvas downscaled to AVATAR_MAX_DIMENSION × AVATAR_MAX_DIMENSION
// (preserving aspect ratio), and returns a JPEG data URL. JPEG gives the
// best size/quality tradeoff for photographic avatars; we don't preserve
// transparency since the chip rendering uses circular crops anyway.
//
// The server caps the final payload at 100KB — at 256px × 256px JPEG q=0.85
// that's comfortably under (~30KB for typical photos). If a user's image is
// somehow still over, we drop quality progressively until it fits or we
// give up.

const AVATAR_MAX_DIMENSION = 256;
const AVATAR_MAX_BYTES     = 100 * 1024;
const QUALITY_STEPS        = [0.85, 0.7, 0.55, 0.4];

export async function fileToDownscaledAvatarDataUrl(file: File): Promise<string> {
  // Quick precheck: reject obviously-wrong file types up front so the user
  // gets a fast error instead of a confusing decode failure later. The
  // server validates magic bytes too — this is just for UX.
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file (PNG, JPEG, GIF, or WebP)');
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { canvas } = drawScaled(img, AVATAR_MAX_DIMENSION);

    // Try progressively lower JPEG quality until the encoded result fits
    // the server cap. In practice the first try succeeds for any sane
    // input — this loop is the safety net.
    for (const quality of QUALITY_STEPS) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      // Approximate decoded size from the base64 payload length: 3/4 of
      // the chars-after-the-comma. Cheaper than actually decoding.
      const commaIdx = dataUrl.indexOf(',');
      const b64len   = dataUrl.length - commaIdx - 1;
      const approxBytes = Math.floor(b64len * 0.75);
      if (approxBytes <= AVATAR_MAX_BYTES) return dataUrl;
    }
    throw new Error('Image is too complex to compress under 100KB — try a smaller picture');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

function drawScaled(img: HTMLImageElement, maxDim: number): { canvas: HTMLCanvasElement } {
  const { naturalWidth: w, naturalHeight: h } = img;
  // Scale so the longer edge equals maxDim. Square avatars get cropped at
  // render time (CSS rounded-full); we don't crop here because the user may
  // want to keep the full frame.
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const targetW = Math.round(w * scale);
  const targetH = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width  = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  // White fill so JPEGs of transparent PNGs don't end up with a black
  // background where the alpha used to be.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(img, 0, 0, targetW, targetH);
  return { canvas };
}
