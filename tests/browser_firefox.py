"""Run the packaged Firefox extension in a temporary profile on an HTTP fixture.
Requires selenium and Pillow. Set PAGEGRAB_FIREFOX to override Firefox's path.
"""
import functools
import http.server
import io
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from PIL import Image
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

root = Path(__file__).resolve().parent.parent
subprocess.run(['node', str(root / 'scripts/build.cjs'), 'firefox'], check=True)
with tempfile.TemporaryDirectory(prefix='pagegrab-firefox-') as folder:
    folder = Path(folder)
    fixture = (root / 'tests/fixtures/full-page.html').read_text().split('let serial=0;')[0] + '</script></body></html>'
    (folder / 'index.html').write_text(fixture)
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(folder)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    options = Options()
    options.add_argument('-headless')
    options.binary_location = os.environ.get('PAGEGRAB_FIREFOX', '/Applications/Firefox.app/Contents/MacOS/firefox')
    options.set_preference('browser.download.folderList', 2)
    options.set_preference('browser.download.dir', str(folder))
    options.set_preference('browser.helperApps.neverAsk.saveToDisk', 'image/png,image/jpeg,image/webp,application/pdf')
    options.set_preference('pdfjs.disabled', True)
    options.set_preference('browser.download.alwaysOpenPanel', False)
    driver = None
    try:
        driver = webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))
        driver.set_window_size(1280, 1000)
        driver.install_addon(str(root / 'dist/firefox'), temporary=True)
        driver.set_context('chrome')
        driver.execute_script('CustomizableUI.addWidgetToArea("pagegrab_pagegrab_extension-browser-action", CustomizableUI.AREA_NAVBAR)')
        driver.set_context('content')
        wait = WebDriverWait(driver, 45)
        def js(code):
            return driver.execute_script("const area=document.body.classList.contains('nested') ? document.querySelector('main') : document.scrollingElement;const grew=document.querySelectorAll('.section').length === 5;" + code)
        def panel(code):
            return js("const root=document.getElementById('__fpc-panel-host')?.shadowRoot;" + code)
        def capture():
            driver.switch_to.window(driver.current_window_handle)
            driver.set_context('chrome')
            try:
                driver.find_element(By.CSS_SELECTOR, '#pagegrab_pagegrab_extension-browser-action .unified-extensions-item-action-button').click()
            finally:
                driver.set_context('content')
            def complete(_):
                text = panel("return root?.textContent || ''")
                if 'Capture failed:' in text:
                    raise AssertionError(text)
                return panel("return !!root?.querySelector('.copy')")
            try:
                wait.until(complete)
            except Exception:
                print('Capture UI:', driver.current_url, driver.window_handles, panel("return root?.textContent"), flush=True)
                raise
        for kind in os.environ.get('PAGEGRAB_FIREFOX_CASES', 'document,nested,modal,modal-unmarked,modal-fit,modal-fit-zoom,modal-fit-zoom-out,unstable,shell').split(','):
            query = {'document': '', 'nested': '?nested', 'modal': '?modal&static',
                     'modal-unmarked': '?modal&unmarked&static', 'modal-fit': '?modal&fit&static',
                     'modal-fit-zoom': '?modal&fit&static', 'modal-fit-zoom-out': '?modal&fit&static', 'unstable': '?modal&static&unstable', 'shell': '?shell&static'}[kind]
            driver.get(f'http://127.0.0.1:{server.server_port}/' + query)
            fits = 'fit' in kind or kind == 'unstable'
            if 'zoom' in kind:
                driver.set_context('chrome')
                driver.execute_script('ZoomManager.setZoomForBrowser(gBrowser.selectedBrowser, arguments[0])', 0.8 if kind.endswith('-out') else 1.25)
                driver.set_context('content')
            reference = Image.open(io.BytesIO(driver.get_screenshot_as_png())).convert('RGB') if fits or kind == 'shell' else None
            before = js('return [scrollX, scrollY, area.scrollTop]')
            capture()
            print("Captured", kind, flush=True)
            if kind == 'unstable':
                assert 'Captured the visible area' in panel("return root.querySelector('.status').textContent")
            assert js('return [scrollX, scrollY, area.scrollTop]') == before
            assert js('return grew') == (kind in ['document', 'nested'])
            panel("root.querySelector('.preview').click()")
            wait.until(lambda _: panel("return root.querySelector('.large-preview img').naturalHeight > 0"))
            preview_size = panel("const img=root.querySelector('.large-preview img');return [img.naturalWidth,img.naturalHeight]")
            if fits:
                expected_size = js('return [Math.round(innerWidth*devicePixelRatio),Math.round(innerHeight*devicePixelRatio)]')
                assert preview_size == expected_size, (kind, preview_size, expected_size)
            else:
                assert preview_size[1] == js('return area.scrollHeight + innerHeight - area.clientHeight' if kind in ['nested', 'modal', 'modal-unmarked', 'shell'] else 'return area.scrollHeight')
            panel("root.querySelector('.settings-toggle').click();root.querySelector('[data-format=png]').click();root.querySelector('.dl').click()")
            wait.until(lambda _: not js("return !!document.getElementById('__fpc-panel-host')"))
            wait.until(lambda _: bool(list(folder.glob('*.png'))) and not list(folder.glob('*.part')))
            image_path = next(folder.glob('*.png'))
            with Image.open(image_path) as image:
                if fits:
                    assert list(image.size) == expected_size, (kind, image.size, expected_size)
                    # Compare the popup's left and top border locations with the
                    # actual viewport so an offset or clipped edge cannot pass.
                    for color in [(231, 70, 120), (30, 100, 210)]:
                        def bounds(rgb):
                            mask = Image.new('1', rgb.size)
                            mask.putdata([pixel == color for pixel in rgb.getdata()])
                            return mask.getbbox()
                        expected = bounds(reference)
                        assert expected is not None
                        actual = bounds(image.convert('RGB'))
                        scaled = tuple(round(value * image.size[i % 2] / reference.size[i % 2]) for i, value in enumerate(expected))
                        assert actual is not None and all(abs(a-b) <= 2 for a, b in zip(actual, scaled)), (kind, color, actual, scaled)
                else:
                    nested = kind in ['nested', 'modal', 'modal-unmarked', 'shell']
                    assert image.height == js('return area.scrollHeight + innerHeight - area.clientHeight' if nested else 'return area.scrollHeight')
                    bottom = js('const r=area.getBoundingClientRect();return Math.round(r.top+area.scrollHeight-4)') if nested else image.height-4
                    assert image.convert('RGB').getpixel((image.width // 2, bottom)) == (22, 199, 132)
                    if kind == 'shell':
                        rgb = image.convert('RGB')
                        assert rgb.getpixel((100, 20)) == (30, 100, 210)
                        assert rgb.getpixel((10, 200)) == (231, 70, 120)
                        assert rgb.getpixel((10, image.height-30)) == (231, 70, 120)
                        orange = (255, 160, 30)
                        assert sum(pixel == orange for pixel in rgb.getdata()) == sum(pixel == orange for pixel in reference.getdata())
                        assert js("return getComputedStyle(document.getElementById('dynamic-heading')).visibility") == 'visible'
            image_path.unlink()
            print('Verified PNG viewport edges' if fits else 'Verified PNG bottom pixels', flush=True)
        driver.set_context('chrome')
        driver.execute_script('ZoomManager.setZoomForBrowser(gBrowser.selectedBrowser, 1)')
        driver.set_context('content')
        driver.get(f'http://127.0.0.1:{server.server_port}/?nested&static')
        for fmt in ['jpg', 'webp', 'pdf']:
            capture()
            print('Exporting', fmt, flush=True)
            if fmt == 'pdf':
                panel("root.querySelector('.pdf').click()")
            else:
                panel(f"root.querySelector('.settings-toggle').click();root.querySelector('[data-format={fmt}]').click();root.querySelector('.dl').click()")
            wait.until(lambda _: not js("return !!document.getElementById('__fpc-panel-host')"))
            wait.until(lambda _: bool(list(folder.glob('*.' + fmt))) and not list(folder.glob('*.part')))
            file = next(folder.glob('*.' + fmt))
            if fmt == 'pdf':
                assert file.read_bytes().startswith(b'%PDF-')
            else:
                with Image.open(file) as image:
                    assert image.format == {'jpg': 'JPEG', 'webp': 'WEBP'}[fmt]
                    assert image.height == js('return area.scrollHeight + innerHeight - area.clientHeight')
        capture()
        wait.until(lambda _: panel("return root.querySelector('.dl span').textContent === 'Save WebP'"))
        if os.environ.get('PAGEGRAB_TEST_CLIPBOARD') == '1':
            # Opt in because this replaces the system clipboard with the capture.
            panel("root.querySelector('.copy').click()")
            wait.until(lambda _: not js("return !!document.getElementById('__fpc-panel-host')"))
            print('PASS: Firefox copied PNG through extension messaging.')
        print('PASS: Firefox extension captures pages and popups at 80%/100%/125% zoom, exports PNG/JPG/WebP/PDF, and remembers format.')
    finally:
        if driver:
            driver.quit()
        server.shutdown()
        server.server_close()
