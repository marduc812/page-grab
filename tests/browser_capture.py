"""Chrome integration check. Requires Python's websocket-client package.

Run with: python3 tests/browser_capture.py
Set PAGEGRAB_CHROME to override the Chrome executable.
Screenshots come from Chrome itself, through a bridge in place of extension messaging.
"""
import subprocess,time,json,urllib.request,websocket,base64,os,tempfile,shutil
from pathlib import Path
workspace = Path(__file__).resolve().parent.parent
temporary = tempfile.TemporaryDirectory(prefix='pagegrab-browser-')
out = Path(temporary.name)
shutil.copyfile(os.environ.get('PAGEGRAB_CAPTURE_SOURCE', workspace / 'content.js'), out / 'content.js')
shutil.copyfile(workspace / 'tests/fixtures/full-page.html', out / 'full-page.html')
p=subprocess.Popen([os.environ.get('PAGEGRAB_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),'--headless','--disable-gpu','--no-first-run','--allow-file-access-from-files','--remote-allow-origins=http://localhost','--remote-debugging-port=9224','--user-data-dir='+str(out / 'profile'),'--window-size=1280,1000','about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
 for _ in range(60):
  try:tabs=json.load(urllib.request.urlopen('http://127.0.0.1:9224/json'));break
  except Exception:time.sleep(.1)
 ws=websocket.create_connection(next(t['webSocketDebuggerUrl'] for t in tabs if t['type']=='page'),origin='http://localhost',timeout=45)
 serial=0;pending={};captured=0;last_capture=0
 def handle(r):
  global captured,last_capture
  if r.get('method')=='Runtime.bindingCalled':
   ident=r['params']['payload']
   time.sleep(max(0,.55-(time.time()-last_capture)))
   png=call('Page.captureScreenshot',{'format':'png','captureBeyondViewport':False})['data'];last_capture=time.time();captured+=1
   evaluate('captureReply('+ident+','+json.dumps('data:image/png;base64,'+png)+')')
 def call(method,params={}):
  global serial
  serial+=1;ident=serial;ws.send(json.dumps({'id':ident,'method':method,'params':params}))
  while ident not in pending:
   r=json.loads(ws.recv())
   if 'id' in r:pending[r['id']]=r
   else:handle(r)
  r=pending.pop(ident)
  if 'error' in r:raise RuntimeError(r['error'])
  return r.get('result',{})
 def evaluate(expr,awaitPromise=False):
  r=call('Runtime.evaluate',{'expression':expr,'returnByValue':True,'awaitPromise':awaitPromise})
  if 'exceptionDetails' in r:raise RuntimeError(r['exceptionDetails'])
  return r.get('result',{}).get('value')
 call('Page.enable');call('Runtime.enable');call('Runtime.addBinding',{'name':'captureBridge'})
 for kind in os.environ.get('PAGEGRAB_CAPTURE_CASES', 'document,nested,static,short').split(','):
  captured=0
  started=time.monotonic()
  call('Page.navigate',{'url':(out / 'full-page.html').as_uri()+({'nested':'?nested', 'static':'?static', 'short':'?static&short'}.get(kind, ''))})
  deadline=time.time()+60
  while time.time()<deadline:
   if evaluate("!!document.getElementById('__fpc-panel-host')?.shadowRoot.querySelector('.panel')"):break
   time.sleep(.1)
  else:raise RuntimeError(evaluate("document.getElementById('__fpc-panel-host')?.shadowRoot.textContent"))
  elapsed=time.monotonic()-started
  result=evaluate("""(async()=>{
   const image=await createImageBitmap(outputBlob);const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const x=c.getContext('2d');x.drawImage(image,0,0);
   const bottom=[...x.getImageData(Math.floor(c.width/2),c.height-4,1,1).data];
   const root=document.getElementById('__fpc-panel-host').shadowRoot;
   const panel=root.querySelector('.panel').getBoundingClientRect();
   return {size:outputSize,bottom,grew,restored:area.scrollTop,maxScroll:Math.max(0,...scrolls),fullHeight:area.scrollHeight,viewport:area.clientHeight,panelTop:panel.top,glass:getComputedStyle(root.querySelector('.panel')).backgroundColor,blur:getComputedStyle(root.querySelector('.panel')).backdropFilter,reducedTransparency:matchMedia('(prefers-reduced-transparency: reduce)').matches};
  })()""",True)
  print(kind,result,'screenshots',captured,'seconds',round(elapsed,2),flush=True)
  assert result['grew'] == (kind in ['document', 'nested']) and result['restored']==0
  assert result['size'][1]==result['fullHeight']
  assert result['bottom'][:3]==[22,199,132],result
  assert result['maxScroll']+result['viewport']>=result['fullHeight']-2
  assert 10<=result['panelTop']<=20
  data=call('Page.captureScreenshot',{'format':'png'})['data'];(out/('new-'+kind+'.png')).write_bytes(base64.b64decode(data))
  assert evaluate("getComputedStyle(document.getElementById('composer')).visibility") == 'visible'
 print('PASS: complete Chrome captures, correct bottom pixels, restored scrolling and overlays.',flush=True)
finally:
 p.terminate();p.wait(timeout=10)
 temporary.cleanup()
