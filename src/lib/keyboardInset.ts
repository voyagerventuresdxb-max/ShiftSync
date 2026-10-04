/**
 * Keeps the focused field visible above the on-screen keyboard.
 *
 * iOS Safari does not shrink the layout viewport when the keyboard opens —
 * only the *visual* viewport shrinks — so a field low on the screen (the
 * onboarding stage, a bottom sheet) can end up focused but hidden behind
 * the keyboard, and CSS alone (`scroll-padding`, `interactive-widget`) has
 * no effect there. This listens for the visual viewport shrinking by
 * roughly a keyboard's height while a text control is focused and scrolls
 * that control into the middle of what is still visible. On Android Chrome
 * `interactive-widget=resizes-content` (index.html) already handles it and
 * this is a harmless no-op.
 *
 * Installed once from main.tsx; returns the uninstall function.
 */
const KEYBOARD_MIN_SHRINK_PX = 120;
const TEXT_CONTROLS = /^(INPUT|TEXTAREA|SELECT)$/;

export function installKeyboardInsetScroll(win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => {};

  let lastHeight = vv.height;
  const onResize = () => {
    const shrunkBy = lastHeight - vv.height;
    lastHeight = vv.height;
    if (shrunkBy < KEYBOARD_MIN_SHRINK_PX) return;

    const el = win.document.activeElement;
    if (!(el instanceof HTMLElement) || !TEXT_CONTROLS.test(el.tagName)) return;
    // A beat later than the resize itself, so the browser's own focus
    // scroll (when it does one) has finished and this settles on top of it.
    win.setTimeout(() => {
      if (win.document.activeElement === el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
  };

  vv.addEventListener('resize', onResize);
  return () => vv.removeEventListener('resize', onResize);
}
