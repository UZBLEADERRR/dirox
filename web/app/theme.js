/**
 * Theme bootstrap.
 *
 * Loaded synchronously in <head> so the saved theme is applied before first
 * paint. It is a separate file rather than an inline script because the
 * Content-Security-Policy forbids inline execution.
 */
try {
  var saved = JSON.parse(localStorage.getItem('diroxcode.ui') || '{}');
  if (saved.theme === 'light' || saved.theme === 'dark') {
    document.documentElement.dataset.theme = saved.theme;
  }
} catch (error) {
  // Blocked storage (private mode, hardened browser): the default theme applies.
}
