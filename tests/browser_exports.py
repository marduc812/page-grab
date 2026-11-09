"""Check notification layout, export settings, and actual image/PDF files in Chrome.
Requires websocket-client, Pillow, and Poppler. Set PAGEGRAB_CHROME if needed.
"""
import base64
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import websocket
from PIL import Image

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='pagegrab-exports-') as folder:
    folder = Path(folder)
    source = (root / 'content.js').read_text()
    source = source[:source.rindex('  (async () => {')] + 'window.testUI = {showPanel, canvasToBlob};})();'
    (folder / 'ui.js').write_text(source)
    (folder / 'check.html').write_text('''<!doctype html><html><head><meta charset="utf-8"><title>A quieter place to work</title>
<style>body{margin:0;min-height:100vh;background:linear-gradient(125deg,#dceaff,#dcbde9 60%,#f1c4cd);font:16px system-ui}main{padding:100px 60px}h1{font-size:48px;font-weight:500;letter-spacing:-2px}p{max-width:400px;line-height:1.7}</style></head>
<body><main><h1>A quieter place to work.</h1><p>Keep what matters. The entire page is ready to save, with a small preview that stays out of your way.</p></main>
<script>let saved={};window.chrome={storage:{local:{get:async()=>saved,set:async value=>{saved=value}}}};
window.downloads=[];const nativeURL=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{downloads.push(b);return nativeURL(b)};HTMLAnchorElement.prototype.click=function(){window.downloadName=this.download};
</script><script src="ui.js"></script><script>
window.ready=(async()=>{const c=document.createElement('canvas');c.width=1000;c.height=4200;const x=c.getContext('2d');x.fillStyle='#f7f7fa';x.fillRect(0,0,1000,4200);x.fillStyle='#17191e';x.font='48px sans-serif';for(let i=0;i<7;i++)x.fillText('Page content '+(i+1),70,120+i*570);x.fillStyle='#16c784';x.fillRect(0,4000,1000,200);window.original=await testUI.canvasToBlob(c);testUI.showPanel(c,original);})();
</script></body></html>''')
    chrome = os.environ.get('PAGEGRAB_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    proc = subprocess.Popen([chrome, '--headless', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files', '--remote-allow-origins=http://localhost', '--remote-debugging-port=0', '--user-data-dir='+str(folder/'profile'), '--window-size=1280,900', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            port_file = folder/'profile/DevToolsActivePort'
            if port_file.exists(): break
            time.sleep(.1)
        port = port_file.read_text().splitlines()[0]
        tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
        ws = websocket.create_connection(next(t['webSocketDebuggerUrl'] for t in tabs if t['type']=='page'), origin='http://localhost', timeout=45)
        serial = 0
        def call(method, params=None):
            global serial
            serial += 1
            ws.send(json.dumps({'id':serial, 'method':method, 'params':params or {}}))
            while True:
                reply = json.loads(ws.recv())
                if reply.get('id') == serial:
                    if 'error' in reply: raise AssertionError(reply['error'])
                    return reply.get('result', {})
        def evaluate(code):
            r=call('Runtime.evaluate', {'expression':code, 'returnByValue':True, 'awaitPromise':True})
            if 'exceptionDetails' in r: raise AssertionError(r['exceptionDetails'])
            return r.get('result', {}).get('value')
        call('Page.navigate', {'url':(folder/'check.html').as_uri()})
        for _ in range(100):
            if evaluate('!!window.ready'): break
            time.sleep(.05)
        evaluate('ready')
        time.sleep(.3)
        evaluate("window.root=document.getElementById('__fpc-panel-host').shadowRoot")
        rect = evaluate("(()=>{const r=root.querySelector('.panel').getBoundingClientRect();return [r.width,r.height,r.top]})()")
        assert rect[0] == 356 and rect[1] < 140 and rect[2] == 16, rect
        assert evaluate("root.querySelector('.preview canvas').width") == 96
        assert not evaluate("root.textContent.includes('Page captured')")
        artifacts = Path('/private/tmp/pagegrab-design')
        artifacts.mkdir(exist_ok=True)
        def screenshot(name):
            (artifacts/name).write_bytes(base64.b64decode(call('Page.captureScreenshot', {'format':'png'})['data']))
        screenshot('colorful.png')
        evaluate("root.querySelector('.preview').click()")
        evaluate("root.querySelector('.large-preview img').decode()")
        assert evaluate("root.querySelector('.panel').getBoundingClientRect().width") == 1000
        assert evaluate("root.querySelector('.large-preview img').naturalHeight") == 4200
        assert evaluate("root.querySelector('.large-preview').scrollHeight > root.querySelector('.large-preview').clientHeight")
        screenshot('expanded.png')
        evaluate("root.querySelector('.collapse').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
        assert evaluate("root.querySelector('.large-preview').hidden && !root.querySelector('.large-preview img')")
        assert evaluate("root.activeElement === root.querySelector('.preview')")
        for color, name in [('#ffffff','light.png'),('#16171b','dark.png')]:
            evaluate(f'document.body.style.background={json.dumps(color)}')
            time.sleep(.2)
            screenshot(name)
        evaluate("root.querySelector('.settings-toggle').click()")
        assert evaluate("!root.querySelector('.settings').hidden")
        screenshot('settings.png')
        def reopen():
            evaluate("(async()=>{const b=await createImageBitmap(original);const c=document.createElement('canvas');c.width=b.width;c.height=b.height;c.getContext('2d').drawImage(b,0,0);b.close();testUI.showPanel(c,original);await new Promise(r=>setTimeout(r,0));window.root=document.getElementById('__fpc-panel-host').shadowRoot})()")
        # Copy failure keeps the result available; success dismisses it.
        evaluate("window.ClipboardItem=class {};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write:async()=>{throw new Error('Denied')}}});root.querySelector('.copy').click()")
        assert evaluate("!!document.getElementById('__fpc-panel-host')")
        assert evaluate("root.querySelector('.status').textContent.includes('Clipboard unavailable')")
        evaluate("navigator.clipboard.write=async()=>{};root.querySelector('.copy').click()")
        assert evaluate("!document.getElementById('__fpc-panel-host')")
        reopen()
        for fmt, actual in [('png','PNG'),('jpg','JPEG'),('webp','WEBP')]:
            evaluate(f"root.querySelector('[data-format={fmt}]').click();root.querySelector('.dl').click()")
            for _ in range(300):
                if evaluate("!root.querySelector('.dl').disabled"): break
                time.sleep(.05)
            data = evaluate("(async()=>{const b=downloads.at(-1);return await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(b)})})()")
            image = Image.open(io.BytesIO(base64.b64decode(data)))
            assert image.format == actual and image.size == (1000,4200), (fmt,image.format,image.size)
            assert max(abs(a-b) for a,b in zip(image.convert('RGB').getpixel((500,4198)), (22,199,132))) < 5
            assert evaluate('downloadName').endswith('.'+fmt)
            assert evaluate('saved.exportFormat') == fmt
            assert evaluate("!document.getElementById('__fpc-panel-host')")
            reopen()
        evaluate("root.querySelector('.pdf').click()")
        for _ in range(300):
            if evaluate("!root.querySelector('.pdf').disabled"): break
            time.sleep(.05)
        data = evaluate("(async()=>await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(downloads.at(-1))}))()")
        assert evaluate("!document.getElementById('__fpc-panel-host')")
        pdf = artifacts/'capture.pdf'; pdf.write_bytes(base64.b64decode(data))
        info = subprocess.check_output(['pdfinfo',str(pdf)], text=True)
        assert 'Pages:           3' in info, info
        subprocess.run(['pdftoppm','-f','3','-singlefile','-scale-to','900','-png',str(pdf),str(artifacts/'pdf-last-page')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        image = Image.open(artifacts/'pdf-last-page.png').convert('RGB')
        assert any(max(abs(a-b) for a,b in zip(image.getpixel((image.width//2,y)),(22,199,132))) < 6 for y in range(image.height)), 'PDF lost bottom content'
        # A fresh result restores the selected format.
        evaluate("(async()=>{const b=await createImageBitmap(original);const c=document.createElement('canvas');c.width=b.width;c.height=b.height;c.getContext('2d').drawImage(b,0,0);b.close();testUI.showPanel(c,original);await new Promise(r=>setTimeout(r,0));window.root=document.getElementById('__fpc-panel-host').shadowRoot})()")
        assert evaluate("root.querySelector('.dl').textContent.trim()") == 'Save WebP'
        evaluate("(async()=>{const c=document.createElement('canvas');c.width=1000;c.height=400;const x=c.getContext('2d');x.fillStyle='#16c784';x.fillRect(0,0,1000,400);testUI.showPanel(c,await testUI.canvasToBlob(c));window.root=document.getElementById('__fpc-panel-host').shadowRoot})()")
        assert evaluate("(()=>{const c=root.querySelector('.preview canvas');return c.getContext('2d').getImageData(c.width-1,c.height-1,1,1).data[3]})()") == 255
        assert evaluate("root.querySelector('.preview').getBoundingClientRect().height") < 24
        evaluate("root.querySelector('.preview').click()")
        evaluate("root.querySelector('.large-preview img').decode()")
        assert evaluate("(()=>{const i=root.querySelector('.large-preview img');const r=i.getBoundingClientRect();return Math.abs(r.width/r.height-2.5)<.01})()")
        assert evaluate("root.querySelector('.large-preview').scrollHeight <= root.querySelector('.large-preview').clientHeight + 1")
        screenshot('short-expanded.png')
        evaluate("root.querySelector('.collapse').click()")
        call('Emulation.setDeviceMetricsOverride' , {'width':360,'height':740,'deviceScaleFactor':1,'mobile':False})
        assert evaluate("root.querySelector('.panel').scrollWidth<=root.querySelector('.panel').clientWidth")
        time.sleep(.3)
        screenshot('narrow.png')
        print('PASS: compact layout, narrow viewport, remembered formats, PNG/JPG/WebP dimensions and bottom pixels, three-page PDF with bottom content. Previews: '+str(artifacts))
    finally:
        proc.terminate(); proc.wait(timeout=10)
