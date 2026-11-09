const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function worker({ inactive = false, errors = [], firefox = false, clipboardError = null } = {}) {
  let listener, now = 10000;
  const calls = [];
  const event = { addListener() {} };
  const context = {
    Date: { now: () => now },
    setTimeout(callback, delay) { now += delay; callback(); },
    chrome: {
      runtime: { onInstalled: event, onMessage: { addListener(fn) { listener = fn; } } },
      contextMenus: { onClicked: event }, action: { onClicked: event }, commands: { onCommand: event },
      tabs: {
        async query() { return [{ id: inactive ? 2 : 1 }]; },
        async captureVisibleTab() {
          calls.push(now);
          const error = errors.shift();
          if (error) throw new Error(error);
          return 'data:image/png;base64,test';
        }
      }
    }
  };
  const copied = [];
  if (firefox) {
    context.browser = context.chrome;
    delete context.chrome;
    context.browser.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
    context.browser.clipboard = { async setImageData(data, type) {
      if (clipboardError) throw new Error(clipboardError);
      copied.push({ data, type });
    } };
  }
  vm.runInNewContext(read('background.js'), context);
  return {
    calls, copied,
    copy: (imageData) => new Promise((resolve) => listener({ type: 'copy-image', imageData }, { tab: { id: 1 } }, resolve)),
    capture: () => new Promise((resolve) => listener({ type: 'capture-visible' }, { tab: { id: 1, windowId: 3 } }, resolve))
  };
}

test('concurrent capture requests share the rate limit', async () => {
  const w = worker();
  const results = await Promise.all([w.capture(), w.capture(), w.capture()]);
  assert.ok(results.every((result) => result.dataUrl));
  assert.equal(w.calls.length, 3);
  for (let i = 1; i < w.calls.length; i++) assert.equal(w.calls[i] - w.calls[i - 1], 510);
});

test('Firefox captures without the Chrome delay, but backs off after quota errors', async () => {
  const w = worker({ firefox: true });
  await Promise.all([w.capture(), w.capture(), w.capture()]);
  assert.deepEqual(w.calls, [10000, 10000, 10000]);
  const limited = worker({ firefox: true, errors: ['rate limit'] });
  assert.ok((await limited.capture()).dataUrl);
  assert.equal(limited.calls[1] - limited.calls[0], 550);
});

test('retry rate limits and keep the queue usable after other failures', async () => {
  const w = worker({ errors: ['MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND', 'Access denied'] });
  assert.match((await w.capture()).error, /Access denied/);
  assert.equal(w.calls.length, 2);
  assert.ok((await w.capture()).dataUrl);
});

test('do not capture a different active tab', async () => {
  const w = worker({ inactive: true });
  assert.match((await w.capture()).error, /tab active/);
  assert.equal(w.calls.length, 0);
});

function captureContext({ fail = false, grows = false, nested = false, blocked = false } = {}) {
  const values = new Map([['scroll-behavior', ['smooth', 'important']]]);
  const style = () => ({
    getPropertyValue: (name) => values.get(name)?.[0] || '',
    getPropertyPriority: (name) => values.get(name)?.[1] || '',
    setProperty: (name, value, priority) => values.set(name, [value, priority]),
    removeProperty: (name) => values.delete(name)
  });
  const draws = [];
  const scrolls = [];
  const doc = { scrollHeight: 2200, style: style() };
  const header = { style: style(), getBoundingClientRect: () => ({left:0,top:0,width:800,height:80,bottom:80}), contains: () => false };
  let grew = false;
  const container = {style:style(), clientHeight:800,clientWidth:700,clientLeft:0,clientTop:0,scrollHeight:2400,scrollTop:120,scrollLeft:0,
    getBoundingClientRect: () => ({left:50,top:100,width:700,height:800,bottom:900}),
    scrollTo({left,top}) {this.scrollLeft=left;this.scrollTop=Math.min(top,this.scrollHeight-this.clientHeight);}};
  if (nested) doc.scrollHeight=1000;
  const canvas = { getContext: () => ({ drawImage: (...args) => draws.push(args.slice(1)) }) };
  const context = {
    window: { scrollX: 0, scrollY: 180, innerHeight: 1000, innerWidth: 800,
      scrollTo({left, top}) {
        if(blocked)return;
        scrolls.push(top);
        this.scrollX=left; this.scrollY=Math.min(top,doc.scrollHeight-1000);
        if(grows && !grew && this.scrollY >= 1200) {doc.scrollHeight=4200;grew=true;}
      } },
    document: { documentElement: doc, scrollingElement:doc, images:[], body: null, querySelectorAll: () => nested ? [container,header] : [header], createElement: () => canvas },
    getComputedStyle: (el) => ({ position: el === header ? 'fixed' : 'static', overflowY: el === container ? 'auto' : 'visible' }),
    setTimeout: (fn) => fn(), requestAnimationFrame: (fn) => fn(),
    Image: class { width = 800; height = 1000; set src(value) { if (value) this.onload(); } },
    chrome: { runtime: { sendMessage: (_, fn) => fn(fail ? { error: 'Capture failed' } : { dataUrl: 'image' }) } }
  };
  const source = read('content.js');
  vm.runInNewContext(source.slice(0, source.lastIndexOf('  (async () => {')) + 'globalThis.capture = captureFullPage; globalThis.settle = settle;})();', context);
  return { context, draws, values, canvas, container, scrolls };
}
const toast = { set() {}, hide() {}, show() {} };

test('loaded capture frames wait for paint without a fixed timer', async () => {
  const { context } = captureContext();
  let paints = 0;
  context.requestAnimationFrame = (fn) => { paints++; fn(); };
  context.setTimeout = () => { throw new Error('Unexpected fixed delay'); };
  await context.settle({ rect: () => ({ top: 0, height: 1000 }) }, 0);
  assert.equal(paints, 2);
});

test('capture frames still wait for visible lazy images and paint after decoding', async () => {
  const { context } = captureContext();
  const events = [];
  context.requestAnimationFrame = (fn) => { events.push('paint'); fn(); };
  // Leave the timeout pending so the image decode must finish the wait.
  context.setTimeout = () => {};
  context.document.images = [{
    complete: false,
    getBoundingClientRect: () => ({ top: 100, bottom: 200 }),
    decode: async () => { events.push('decode'); }
  }, {
    complete: false,
    getBoundingClientRect: () => ({ top: 1200, bottom: 1300 }),
    decode: () => { throw new Error('Offscreen image should not delay capture'); }
  }];
  await context.settle({ rect: () => ({ top: 0, height: 1000 }) }, 0);
  assert.deepEqual(events, ['paint', 'paint', 'decode', 'paint', 'paint']);
});

test('stitch overlapping frames without repainting earlier pixels', async () => {
  const { context, draws, values, canvas } = captureContext();
  assert.equal(await context.capture(toast), canvas);
  assert.equal(canvas.height, 2200);
  assert.deepEqual(draws.map((d) => [d[1], d[3], d[5], d[7]]), [[0,1000,0,1000], [0,1000,1000,1000], [800,200,2000,200]]);
  assert.equal(context.window.scrollY, 180);
  assert.deepEqual(values.get('scroll-behavior'), ['smooth', 'important']);
  assert.equal(values.has('visibility'), false);
});

test('stable pages capture in one downward pass', async () => {
  const { context, scrolls } = captureContext();
  await context.capture(toast);
  assert.deepEqual(scrolls, [0, 0, 1000, 1200, 180]);
});

test('height changes during screenshot delivery discard earlier pixels and recapture', async () => {
  const { context, draws, canvas, scrolls } = captureContext();
  let shots = 0;
  context.chrome.runtime.sendMessage = (_, fn) => {
    if (++shots === 2) context.document.documentElement.scrollHeight = 3200;
    fn({ dataUrl: 'image' });
  };
  await context.capture(toast);
  assert.equal(canvas.height, 3200);
  // The first frame is drawn again after the changed layout is loaded.
  assert.equal(draws.filter((d) => d[5] === 0).length, 2);
  assert.equal(draws.at(-1)[5] + draws.at(-1)[7], 3200);
  assert.equal(scrolls.at(-1), 180);
});

test('growth during the final bottom wait triggers a complete recapture', async () => {
  const { context, canvas, draws } = captureContext();
  let grew = false;
  context.setTimeout = (fn, delay) => {
    if (delay === 700 && !grew) {
      grew = true;
      context.document.documentElement.scrollHeight = 3200;
    }
    fn();
  };
  await context.capture(toast);
  assert.equal(canvas.height, 3200);
  assert.equal(draws.filter((d) => d[5] === 0).length, 2);
});

test('a shrinking page is recaptured at its new height', async () => {
  const { context, canvas, draws } = captureContext();
  let shots = 0;
  context.chrome.runtime.sendMessage = (_, fn) => {
    if (++shots === 2) context.document.documentElement.scrollHeight = 1400;
    fn({ dataUrl: 'image' });
  };
  await context.capture(toast);
  assert.equal(canvas.height, 1400);
  assert.equal(draws.at(-1)[5] + draws.at(-1)[7], 1400);
});

test('repeated layout changes stop capture and restore page settings', async () => {
  const { context, values } = captureContext();
  context.chrome.runtime.sendMessage = (_, fn) => {
    context.document.documentElement.scrollHeight += 10;
    fn({ dataUrl: 'image' });
  };
  await assert.rejects(context.capture(toast), /keeps changing size/);
  assert.equal(context.window.scrollY, 180);
  assert.deepEqual(values.get('scroll-behavior'), ['smooth', 'important']);
  assert.equal(values.has('visibility'), false);
});

test('restore scroll settings when capture fails', async () => {
  const { context, values } = captureContext({ fail: true });
  await assert.rejects(context.capture(toast), /Capture failed/);
  assert.equal(context.window.scrollY, 180);
  assert.deepEqual(values.get('scroll-behavior'), ['smooth', 'important']);
  assert.equal(values.has('scroll-snap-type'), false);
});


test('include content appended when scrolling reaches the original bottom', async () => {
  const {context,canvas,draws}=captureContext({grows:true});
  await context.capture(toast);
  assert.equal(canvas.height,4200);
  const last=draws.at(-1);
  assert.equal(last[5]+last[7],4200);
  assert.equal(context.window.scrollY,180);
});

test('scroll and capture the main container when the document does not scroll', async () => {
  const {context,canvas,draws,container}=captureContext({nested:true});
  await context.capture(toast);
  assert.equal(canvas.height,2400);
  assert.equal(canvas.width,700);
  assert.equal(draws[0][0],50);
  assert.equal(draws[0][1],100);
  assert.equal(draws.at(-1)[5]+draws.at(-1)[7],2400);
  assert.equal(container.scrollTop,120);
});

test('fail visibly when a page blocks scrolling instead of returning a partial capture', async () => {
  const {context}=captureContext({blocked:true});
  await assert.rejects(context.capture(toast), /prevented scrolling/);
});


test('Firefox background captures with browser APIs and copies PNG bytes', async () => {
  const w = worker({ firefox: true });
  assert.ok((await w.capture()).dataUrl);
  const data = new Uint8Array([137, 80, 78, 71]).buffer;
  assert.equal((await w.copy(data)).ok, true);
  assert.equal(w.copied[0].data, data);
  assert.equal(w.copied[0].type, 'png');
});

test('Firefox clipboard failures reach the export panel', async () => {
  const w = worker({ firefox: true, clipboardError: 'Clipboard denied' });
  assert.equal((await w.copy(new ArrayBuffer(0))).error, 'Clipboard denied');
});

test('Firefox content uses promise messaging for capture and PNG copy', async () => {
  const { context } = captureContext();
  const messages = [];
  context.browser = { runtime: { getBrowserInfo() {}, async sendMessage(message) {
    messages.push(message);
    return message.type === 'capture-visible' ? { dataUrl: 'firefox-image' } : { ok: true };
  } } };
  delete context.chrome;
  context.window.__fpcBusy = false;
  const source = read('content.js');
  vm.runInNewContext(source.slice(0, source.lastIndexOf('  (async () => {')) + 'globalThis.helpers = {requestCapture, copyImage};})();', context);
  assert.equal(await context.helpers.requestCapture(), 'firefox-image');
  const data = new Uint8Array([137, 80, 78, 71]).buffer;
  await context.helpers.copyImage({ arrayBuffer: async () => data });
  assert.equal(messages[1].type, 'copy-image');
  assert.equal(messages[1].imageData, data);
  context.browser.runtime.sendMessage = async () => ({ error: 'Denied' });
  await assert.rejects(context.helpers.copyImage({ arrayBuffer: async () => data }), /Denied/);
});

test('Chrome with a browser namespace still copies through the web clipboard', async () => {
  const { context } = captureContext();
  context.window.__fpcBusy = false;
  context.browser = { runtime: {} };
  let copied;
  context.ClipboardItem = class { constructor(items) { this.items = items; } };
  context.navigator = { clipboard: { async write(items) { copied = items; } } };
  const source = read('content.js');
  vm.runInNewContext(source.slice(0, source.lastIndexOf('  (async () => {')) + 'globalThis.copyImage = copyImage;})();', context);
  const blob = {};
  await context.copyImage(blob);
  assert.equal(copied[0].items['image/png'], blob);
});
