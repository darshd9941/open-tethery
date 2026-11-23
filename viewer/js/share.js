// Save frame and share link. Browser-only helpers.

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the frame.'))), 'image/png');
  });
}

// Returns 'shared' | 'downloaded' | 'cancelled'
export async function saveFrame(canvas, fileName) {
  const blob = await canvasToBlob(canvas);
  const file = new File([blob], fileName, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // fall through to a plain download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

// Returns 'shared' | 'copied' | 'cancelled' | 'failed'
export async function shareLink(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok ? 'copied' : 'failed';
  } catch {
    return 'failed';
  }
}
