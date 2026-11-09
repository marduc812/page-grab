const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function worker({ inactive = false, errors = [] } = {}) {
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
  vm.runInNewContext(read('background.js'), context);
  return {
    calls,
    capture: () => new Promise((resolve) => listener({ type: 'capture-visible' }, { tab: { id: 1, windowId: 3 } }, resolve))
  };
}

test('concurrent capture requests share the rate limit', async () => {
  const w = worker();
  const results = await Promise.all([w.capture(), w.capture(), w.capture()]);
  assert.ok(results.every((result) => result.dataUrl));
  assert.equal(w.calls.length, 3);
  for (let i = 1; i < w.calls.length; i++) assert.ok(w.calls[i] - w.calls[i - 1] >= 550);
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
  vm.runInNewContext(source.slice(0, source.lastIndexOf('  (async () => {')) + 'globalThis.capture = captureFullPage;})();', context);
  return { context, draws, values, canvas, container };
}
const toast = { set() {}, hide() {}, show() {} };

test('stitch overlapping frames without repainting earlier pixels', async () => {
  const { context, draws, values, canvas } = captureContext();
  assert.equal(await context.capture(toast), canvas);
  assert.equal(canvas.height, 2200);
  assert.deepEqual(draws.map((d) => [d[1], d[3], d[5], d[7]]), [[0,1000,0,1000], [0,1000,1000,1000], [800,200,2000,200]]);
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
