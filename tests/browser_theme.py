"""Check automatic page appearance in Chrome. Set PAGEGRAB_CHROME to override its path."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source = (root / 'content.js').read_text()
# Expose the real UI without running the capture workflow.
source = source[:source.rindex('  (async () => {')] + 'window.testUI = {showPanel, createToast};})();'
with tempfile.TemporaryDirectory(prefix='pagegrab-theme-') as folder:
    folder = Path(folder)
    (folder / 'ui.js').write_text(source)
    (folder / 'check.html').write_text('''<!doctype html><html><body style="margin:0;background:white;min-height:100vh">
<script src="ui.js"></script><script>
(async () => {
  const wait = () => new Promise(resolve => setTimeout(resolve, 180));
  const check = (condition, message) => {if (!condition) throw new Error(message)};
  try {
    const c = document.createElement('canvas'); c.width=800; c.height=1600;
    testUI.showPanel(c, new Blob(['png'], {type:'image/png'}));
    const host = document.getElementById('__fpc-panel-host');
    const panel = host.shadowRoot.querySelector('.panel');
    check(!host.shadowRoot.querySelector('.theme'), 'Switch still exists');
    check(panel.dataset.theme === 'light', 'White page must use light glass even in dark system mode');
    document.body.style.background = '#101014'; await wait();
    check(panel.dataset.theme === 'dark', 'Dark page must use dark glass');
    document.body.style.background = 'rgba(255,255,255,.1)'; document.documentElement.style.background = '#101014'; await wait();
    check(panel.dataset.theme === 'dark', 'Transparent background must inherit the dark layer');
    document.body.style.background = 'linear-gradient(#eeeeee,#ffffff)'; await wait();
    check(panel.dataset.theme === 'light', 'Light gradient must use light glass');
    document.body.style.background = 'linear-gradient(#080808,#333333)'; await wait();
    check(panel.dataset.theme === 'dark', 'Dark gradient must use dark glass');
    host.shadowRoot.querySelector('.close').click();
    check(!host.isConnected, 'Close failed');
    document.body.style.background = 'white';
    const toast = testUI.createToast('Test');
    const surface = document.getElementById('__fpc-panel-host').shadowRoot.querySelector('.toast');
    check(surface.dataset.theme === 'light', 'Notification should follow the page');
    toast.remove();
    document.body.textContent = 'PASS: automatic page appearance, dynamic changes, transparent backgrounds, gradients, notification and switch removal';
  } catch (error) {document.body.textContent = 'FAIL: '+error.message;}
})();
</script></body></html>''')
    chrome = os.environ.get('PAGEGRAB_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    result = subprocess.run([
        chrome, '--headless', '--disable-gpu', '--no-first-run', '--force-dark-mode',
        '--allow-file-access-from-files', '--user-data-dir=' + str(folder / 'profile'),
        '--window-size=1280,1000', '--virtual-time-budget=3000', '--dump-dom',
        (folder / 'check.html').as_uri()
    ], capture_output=True, text=True, timeout=45)
    if result.returncode or '<body style="margin:0;background:white;min-height:100vh">PASS:' not in result.stdout:
        # Browser serialization may normalize the style attribute.
        if '>PASS: automatic page appearance' not in result.stdout:
            raise AssertionError(result.stdout + result.stderr)
    print('PASS: page appearance follows light/dark backgrounds, live changes, gradients and transparency. Appearance switch removed.')
