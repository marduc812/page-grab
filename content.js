(() => {
  if (window.__fpcBusy) return;
  window.__fpcBusy = true;

  const extensionAPI = globalThis.browser ?? globalThis.chrome;
  const PANEL_ID = "__fpc-panel-host";
  const MAX_CANVAS_DIM = 16000;
  const MAX_CANVAS_AREA = 200_000_000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function removeExistingPanel() {
    const old = document.getElementById(PANEL_ID);
    if (old) { old.dispatchEvent(new Event("pagegrab-dispose")); old.remove(); }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to decode screenshot"));
      img.src = src;
    });
  }

  function sendMessage(message) {
    if (globalThis.browser) return browser.runtime.sendMessage(message);
    return new Promise((resolve, reject) => {
      extensionAPI.runtime.sendMessage(message, (response) => {
        if (extensionAPI.runtime.lastError) return reject(new Error(extensionAPI.runtime.lastError.message));
        resolve(response);
      });
    });
  }

  async function requestCapture() {
    const response = await sendMessage({ type: "capture-visible" });
    if (!response || response.error) throw new Error(response?.error || "Capture failed");
    return response.dataUrl;
  }

  async function copyImage(blob) {
    if (typeof extensionAPI?.runtime?.getBrowserInfo === "function") {
      const response = await sendMessage({ type: "copy-image", imageData: await blob.arrayBuffer() });
      if (!response?.ok) throw new Error(response?.error || "Copy failed");
    } else {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    }
  }

  function hideFixedElements(scrollElement, bottomOnly = false) {
    const hidden = [];
    for (const el of document.querySelectorAll("*")) {
      if (el.id === PANEL_ID || el === scrollElement || el.contains?.(scrollElement)) continue;
      const pos = getComputedStyle(el).position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      const rect = el.getBoundingClientRect();
      if (bottomOnly && (rect.top < window.innerHeight * .5 || rect.bottom < window.innerHeight - 100)) continue;
      if ((pos === "fixed" || pos === "sticky") && rect.height < window.innerHeight * .7) {
        hidden.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);

      }
    }
    for (const [el] of hidden) el.style.setProperty("visibility", "hidden", "important");
    return () => {
      for (const [el, value, priority] of hidden) {
        if (value) el.style.setProperty("visibility", value, priority);
        else el.style.removeProperty("visibility");
      }
    };
  }

  const glassStyles = `
    :host{color-scheme:light dark}
    *{box-sizing:border-box}
    .glass{color-scheme:light;--ink:#17191e;--muted:#454b56;--glass:rgba(245,247,252,.24);--line:rgba(255,255,255,.72);--tile:rgba(255,255,255,.3);--edge:rgba(32,45,66,.09);--accent:#0064d7;--text-shadow:0 1px 2px #ffffff60;
      font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);text-shadow:var(--text-shadow);background:linear-gradient(135deg,#ffffff20,transparent 48%),var(--glass);
      border:1px solid var(--line);border-radius:22px;box-shadow:0 12px 40px #14203826,0 2px 8px #14203812,inset 0 1px 0 #ffffffb3,inset 1px 0 0 #ffffff30,inset 0 -1px 0 #ffffff18;
      backdrop-filter:blur(24px) saturate(165%);-webkit-backdrop-filter:blur(24px) saturate(165%)}
    .glass[data-theme="dark"]{color-scheme:dark;--ink:#f4f6fb;--muted:#c0c8d6;--glass:rgba(18,22,30,.34);--line:rgba(255,255,255,.32);--tile:rgba(255,255,255,.08);--edge:rgba(255,255,255,.14);--accent:#b5d8ff;--text-shadow:0 1px 3px #0009}
    button{font:inherit;cursor:pointer;color:inherit;border:1px solid var(--edge);background:var(--tile);transition:background .15s,transform .15s}
    button:hover{background:var(--edge)} button:active{transform:scale(.97)}
    button:focus-visible,.preview:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
    button:disabled{opacity:.6;cursor:wait}
    svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
    @media(prefers-contrast:more){.glass{--glass:Canvas;--ink:CanvasText;--muted:CanvasText;--line:CanvasText;--edge:CanvasText;backdrop-filter:none;-webkit-backdrop-filter:none}}
    @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  `;

  const icons = {
    copy: '<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    pdf: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 15h8M8 18h5"/>',
    check: '<path d="m5 12 4 4L19 6"/>'
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;

  function followPageBackground(host, surface) {
    // Read the layers underneath the glass, rather than the system's color scheme.
    const sampler = document.createElement("canvas");
    sampler.width = sampler.height = 1;
    const ctx = sampler.getContext("2d", { willReadFrequently: true });
    const color = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "transparent";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].map((n, i) => i === 3 ? n / 255 : n);
    };
    const background = (element) => {
      const layers = [];
      for (let el = element; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        const stops = style.backgroundImage.includes("gradient(")
          ? style.backgroundImage.match(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)|#[0-9a-f]{3,8}\b/gi) : null;
        if (stops?.length) {
          const colors = stops.map(color);
          layers.push(colors[0].map((_, i) => colors.reduce((sum, c) => sum + c[i], 0) / colors.length));
        }
        layers.push(color(style.backgroundColor));
        if (layers.at(-1)[3] >= .99) break;
      }
      // Browsers paint an otherwise transparent document onto a white canvas.
      let rgb = [255, 255, 255];
      for (const layer of layers.reverse()) rgb = rgb.map((n, i) => layer[i] * layer[3] + n * (1 - layer[3]));
      return rgb;
    };
    let timer;
    let stopped = false;
    const update = () => {
      if (!host.isConnected) { stop(); return; }
      if (host.style.getPropertyValue("visibility") === "hidden") return;
      const rect = surface.getBoundingClientRect();
      const old = host.style.getPropertyValue("pointer-events");
      const priority = host.style.getPropertyPriority("pointer-events");
      host.style.setProperty("pointer-events", "none", "important");
      try {
        const samples = [[.2,.12],[.5,.12],[.8,.12],[.2,.9],[.8,.9]].map(([x,y]) => {
          const element = document.elementFromPoint(
            Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width * x)),
            Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height * y))
          );
          const rgb = background(element || document.documentElement);
          return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        }).sort((a,b) => a-b);
        const brightness = samples[Math.floor(samples.length / 2)];
        // A small dead band prevents flicker near the light/dark boundary.
        const threshold = surface.dataset.theme === "dark" ? 145 : surface.dataset.theme === "light" ? 125 : 135;
        surface.dataset.theme = brightness < threshold ? "dark" : "light";
      } finally {
        if (old) host.style.setProperty("pointer-events", old, priority);
        else host.style.removeProperty("pointer-events");
      }
    };
    const schedule = () => {
      if (stopped || timer) return;
      timer = setTimeout(() => { timer = null; update(); }, 120);
    };
    const observer = new MutationObserver((records) => {
      if (records.some(({ target }) => target !== host && !host.contains(target))) schedule();
    });
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      host.removeEventListener("click", schedule);
    };
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-mode", "data-dark-mode"]
    });
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    host.addEventListener("click", schedule);
    update();
    return stop;
  }

  function createHost() {
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.style.cssText = "all:initial!important;position:fixed!important;top:16px!important;right:16px!important;z-index:2147483647!important;max-width:calc(100vw - 48px)!important;";
    return host;
  }

  function createToast(text) {
    const host = createHost();
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${glassStyles}.toast{display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:18px;font-weight:500;letter-spacing:-.15px}.spinner{width:16px;height:16px;border:2px solid var(--edge);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><div class="glass toast" role="status"><span class="spinner" aria-hidden="true"></span><span class="message"></span></div>`;
    const message = root.querySelector(".message");
    message.textContent = text;
    document.documentElement.appendChild(host);
    const stopTheme = followPageBackground(host, root.querySelector(".glass"));
    return {
      set: (t) => (message.textContent = t),
      hide: () => host.style.setProperty("visibility", "hidden", "important"),
      show: () => host.style.removeProperty("visibility"),
      remove: () => { stopTheme(); host.remove(); }
    };
  }

  function findScrollArea() {
    const doc = document.documentElement;
    const page = document.scrollingElement || doc;
    const pageHeight = () => Math.max(page.scrollHeight, doc.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight);
    let element = page;
    let bestArea = 0;
    // Many apps scroll a main element while the document itself never moves.
    if (pageHeight() <= window.innerHeight * 1.5) {
      for (const candidate of document.querySelectorAll("*")) {
        if (candidate.id === PANEL_ID || candidate.clientHeight < window.innerHeight * .4 || candidate.scrollHeight <= candidate.clientHeight + 2) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.width < window.innerWidth * .4 || rect.top < 0 || rect.bottom > window.innerHeight + 2) continue;
        if (!/auto|scroll|overlay/.test(getComputedStyle(candidate).overflowY)) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) { element = candidate; bestArea = area; }
      }
    }
    const nested = element !== page;
    return {
      element,
      height: () => nested ? element.scrollHeight : pageHeight(),
      viewport: () => nested ? element.clientHeight : window.innerHeight,
      y: () => nested ? element.scrollTop : window.scrollY,
      x: () => nested ? element.scrollLeft : window.scrollX,
      scroll: (x, y) => nested ? element.scrollTo({ left: x, top: y, behavior: "instant" }) : window.scrollTo({ left: x, top: y, behavior: "instant" }),
      rect: () => {
        if (!nested) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        const r = element.getBoundingClientRect();
        return { left: r.left + element.clientLeft, top: r.top + element.clientTop, width: element.clientWidth, height: element.clientHeight };
      }
    };
  }

  const afterPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  async function settle(area, delay = 160) {
    // The loading pass needs time for scroll-triggered work. On the capture
    // pass, wait for the scroll and hidden notification to paint instead.
    if (delay) await sleep(delay);
    else await afterPaint();
    // Give lazy images in this screen time to decode, with a bounded wait.
    const rect = area.rect();
    const pending = [...document.images].filter((image) => {
      if (image.complete) return false;
      const r = image.getBoundingClientRect();
      return r.bottom > rect.top && r.top < rect.top + rect.height;
    });
    if (pending.length) {
      await Promise.race([
        Promise.all(pending.map((image) => image.decode().catch(() => {}))), sleep(1400)
      ]);
    }
    if (delay || pending.length) await afterPaint();
  }

  async function captureFullPage(toast) {
    const area = findScrollArea();
    const original = { x: area.x(), y: area.y() };
    const overrides = [];
    for (const el of new Set([document.documentElement, document.body, area.element].filter(Boolean))) {
      for (const [name, value] of [["scroll-behavior", "auto"], ["scroll-snap-type", "none"], ["overflow-anchor", "none"]]) {
        overrides.push([el, name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
        el.style.setProperty(name, value, "important");
      }
    }
    let restoreFixed;
    let restoreBottom;
    let canvas;
    try {
      // Capture stable pages in one pass. If loading changes the height,
      // warm the entire page and restart so shifted content cannot leave gaps.
      const preparePage = async () => {
        area.scroll(original.x, 0);
        await settle(area);
        let steps = 0;
        while (true) {
          if (++steps > 300) throw new Error("This page keeps adding content. Capture stopped without saving an incomplete image.");
          const height = area.height();
          const viewport = area.viewport();
          const current = area.y();
          const next = Math.min(current + viewport * .85, Math.max(0, height - viewport));
          toast.set("Loading full page…");
          area.scroll(original.x, next);
          await settle(area, next >= height - viewport - 2 ? 450 : 160);
          if (area.y() < next - 2) throw new Error("The page prevented scrolling to the bottom. Capture stopped.");
          if (area.y() + area.viewport() >= area.height() - 2) {
            // A second bottom check catches delayed infinite-scroll responses.
            await sleep(700);
            if (area.height() <= height + 2) break;
          }
        }
      };
      area.scroll(original.x, 0);
      await settle(area);
      restoreBottom = hideFixedElements(area.element, true);
      let totalH = area.height();
      let drawnUntil = 0;
      let frame = 0;
      let prepared = false;
      let restarts = 0;
      let pxScale, outScale, ctx, width;
      const createOutput = () => {
        const fullW = width * pxScale;
        const fullH = totalH * pxScale;
        const scale = Math.min(1, MAX_CANVAS_DIM / fullW, MAX_CANVAS_DIM / fullH, Math.sqrt(MAX_CANVAS_AREA / (fullW * fullH)));
        const next = document.createElement("canvas");
        next.width = Math.max(1, Math.round(fullW * scale));
        next.height = Math.max(1, Math.round(fullH * scale));
        const nextCtx = next.getContext("2d");
        if (!nextCtx) throw new Error("This page is too large to capture");
        canvas = next; ctx = nextCtx; outScale = scale;
      };
      const restartAfterLoading = async () => {
        if (++restarts > 3) throw new Error("The page keeps changing size. Capture stopped without saving an incomplete image.");
        if (restoreFixed) { restoreFixed(); restoreFixed = null; }
        if (restoreBottom) { restoreBottom(); restoreBottom = null; }
        toast.show();
        if (canvas) { canvas.width = canvas.height = 1; canvas = null; }
        await preparePage();
        prepared = true;
        totalH = area.height();
        drawnUntil = 0;
        area.scroll(original.x, 0);
        restoreBottom = hideFixedElements(area.element, true);
      };
      while (true) {
        if (++frame > 300) throw new Error("This page keeps adding content. Capture stopped without saving an incomplete image.");
        if (area.height() !== totalH) {
          await restartAfterLoading();
          continue;
        }
        const target = Math.min(drawnUntil, Math.max(0, area.height() - area.viewport()));
        area.scroll(original.x, target);
        toast.set(`Capturing full page · ${Math.min(99, Math.round(drawnUntil / area.height() * 100))}%`);
        toast.hide();
        await settle(area, prepared ? 0 : target + area.viewport() >= totalH - 2 ? 450 : 160);
        if (area.height() !== totalH) {
          await restartAfterLoading();
          continue;
        }
        if (Math.abs(area.y() - target) > 2) throw new Error("The page prevented scrolling. Capture stopped.");
        const actualY = area.y();
        const img = await loadImage(await requestCapture());
        try {
          if (area.height() !== totalH) {
            await restartAfterLoading();
            continue;
          }
          const rect = area.rect();
          if (!canvas) {
            width = rect.width;
            pxScale = img.width / window.innerWidth;
            createOutput();
          }
          const top = Math.max(actualY, drawnUntil);
          const bottom = Math.min(totalH, actualY + rect.height);
          if (top > drawnUntil + 2) throw new Error("The page jumped during capture. Please try again.");
          if (bottom > top) {
            const destTop = Math.round(top * pxScale * outScale);
            ctx.drawImage(img, rect.left * pxScale, (rect.top + top - actualY) * pxScale,
              rect.width * pxScale, (bottom - top) * pxScale,
              0, destTop, canvas.width, Math.round(bottom * pxScale * outScale) - destTop);
            drawnUntil = bottom;
          }
        } finally { img.src = ""; toast.show(); }
        if (!restoreFixed && drawnUntil < totalH) restoreFixed = hideFixedElements(area.element);
        if (drawnUntil >= area.height() - 2) {
          await sleep(700);
          if (area.height() === totalH && drawnUntil >= totalH - 2) break;
        }
      }
      toast.set("Preparing image…");
      return canvas;
    } finally {
      if (restoreFixed) restoreFixed();
      if (restoreBottom) restoreBottom();
      area.scroll(original.x, original.y);
      for (const [el, name, value, priority] of overrides) {
        if (value) el.style.setProperty(name, value, priority);
        else el.style.removeProperty(name);
      }
      toast.show();
    }
  }

  function canvasToBlob(canvas, type = "image/png", quality = .92) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode image"))), type, quality)
    );
  }

  function buildFileName(extension = "png") {
    const host = location.hostname.replace(/[^a-z0-9.-]/gi, "_") || "page";
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${host}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${extension}`;
  }

  // PDF stores JPEG strips directly. Only one page-sized canvas is encoded at a time.
  async function createPDF(blob) {
    const bitmap = await createImageBitmap(blob);
    const pageWidth = 595.28, pageHeight = 841.89, margin = 24;
    const contentWidth = pageWidth - margin * 2;
    const pixelsPerPage = Math.max(1, Math.floor((pageHeight - margin * 2) * bitmap.width / contentWidth));
    const count = Math.ceil(bitmap.height / pixelsPerPage);
    const encoder = new TextEncoder();
    const parts = [], offsets = [0];
    let length = 0;
    const append = (value) => {
      const bytes = typeof value === "string" ? encoder.encode(value) : value;
      parts.push(bytes); length += bytes.byteLength;
    };
    const object = (id, value, stream) => {
      offsets[id] = length;
      append(`${id} 0 obj\n${value}`);
      if (stream) { append("\nstream\n"); append(stream); append("\nendstream"); }
      append("\nendobj\n");
    };
    const page = document.createElement("canvas");
    try {
      append("%PDF-1.4\n%PageGrab\n");
      object(1, "<< /Type /Catalog /Pages 2 0 R >>");
      object(2, `<< /Type /Pages /Count ${count} /Kids [${Array.from({length: count}, (_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>`);
      for (let i = 0; i < count; i++) {
        const height = Math.min(pixelsPerPage, bitmap.height - i * pixelsPerPage);
        page.width = bitmap.width; page.height = height;
        const ctx = page.getContext("2d", { alpha: false });
        ctx.fillStyle = "white"; ctx.fillRect(0, 0, page.width, height);
        ctx.drawImage(bitmap, 0, i * pixelsPerPage, bitmap.width, height, 0, 0, page.width, height);
        const jpeg = new Uint8Array(await (await canvasToBlob(page, "image/jpeg", .95)).arrayBuffer());
        const id = 3 + i * 3;
        const drawnHeight = height * contentWidth / bitmap.width;
        const commands = encoder.encode(`q\n${contentWidth} 0 0 ${drawnHeight} ${margin} ${pageHeight - margin - drawnHeight} cm\n/Im0 Do\nQ\n`);
        object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
        object(id + 1, `<< /Length ${commands.length} >>`, commands);
        object(id + 2, `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
      }
      const xref = length;
      append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
      for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, "0")} 00000 n \n`);
      append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
      return new Blob(parts, { type: "application/pdf" });
    } finally { bitmap.close(); page.width = page.height = 1; }
  }

  async function convertImage(blob, format) {
    if (format === "png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    try {
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { alpha: format !== "jpg" });
      if (format === "jpg") { ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(bitmap, 0, 0);
      const type = format === "jpg" ? "image/jpeg" : "image/webp";
      const result = await canvasToBlob(canvas, type);
      if (result.type !== type) throw new Error("This browser cannot export that format.");
      return result;
    } finally { bitmap.close(); canvas.width = canvas.height = 1; }
  }

  function showPanel(canvas, blob) {
    removeExistingPanel();
    const host = createHost();
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        ${glassStyles}
        .panel{width:356px;max-width:calc(100vw - 48px);max-height:calc(100dvh - 32px);overflow:auto;padding:14px;border-radius:20px;animation:appear .2s ease-out}
        @keyframes appear{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
        .head{display:flex;align-items:center;gap:12px}
        .preview{padding:0;cursor:zoom-in;width:48px;height:58px;flex-shrink:0;border-radius:8px;overflow:hidden;background:var(--tile);border:1px solid var(--edge);box-shadow:0 2px 5px #0000000c}
        .preview canvas{display:block;width:100%;height:100%}
        .panel.expanded{width:min(1000px,calc(100vw - 48px))}
        .large-preview{margin-top:12px;max-height:calc(100dvh - 190px);overflow:auto;overscroll-behavior:contain;border-radius:10px;border:1px solid var(--edge);scrollbar-width:thin}
        .large-preview img{display:block;width:100%;height:auto}
        .expanded .actions{max-width:400px;margin-left:auto;margin-right:auto}
        .heading{flex:1;min-width:0}.heading h2{font-size:13px;line-height:1.35;letter-spacing:-.2px;margin:0 0 3px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .source,.meta{color:var(--muted);font-size:11px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{font-size:10px;font-variant-numeric:tabular-nums;opacity:.85}
        .tools{display:flex;align-self:flex-start;gap:2px;margin:-4px -5px 0 0}
        .icon{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;padding:0;border:0;background:transparent;color:var(--muted);flex-shrink:0}.icon svg{width:14px;height:14px}.icon[aria-expanded="true"]{background:var(--tile);color:var(--ink)}
        .actions{display:flex;gap:6px;margin-top:12px}.actions button{display:flex;align-items:center;justify-content:center;gap:5px;flex:1;white-space:nowrap;padding:7px 4px;border-radius:9px;font-size:11px;font-weight:500;box-shadow:inset 0 1px 0 #ffffff20}.actions svg{width:14px;height:14px}
        .settings{margin-top:12px;padding-top:11px;border-top:1px solid var(--edge)}[hidden]{display:none!important}
        .settings label{display:block;font-size:11px;font-weight:500;margin-bottom:7px}
        .formats{display:flex;padding:3px;gap:3px;background:var(--edge);border-radius:9px}.formats button{flex:1;border:0;border-radius:6px;padding:5px;font-size:11px;background:transparent}.formats button[aria-pressed="true"]{background:var(--tile);box-shadow:0 1px 4px #0002,inset 0 0 0 1px var(--line)}
        .hint{font-size:10px;color:var(--muted);line-height:1.5;margin:7px 0 0}
        .status{font-size:11px;color:var(--muted);margin:0;overflow-wrap:anywhere}.status:not(:empty){margin-top:9px}
      </style>
      <section class="glass panel" role="region" aria-label="Screenshot ready">
        <div class="head">
          <button class="preview" title="Show large preview" aria-label="Show large preview" aria-expanded="false" aria-controls="large-preview"></button>
          <div class="heading"><h2></h2><div class="source"></div><div class="meta"></div></div>
          <div class="tools">
            <button class="icon collapse" title="Close preview" aria-label="Close preview" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
            <button class="icon settings-toggle" title="Export settings" aria-label="Export settings" aria-expanded="false" aria-controls="export-settings">${icon("settings")}</button>
            <button class="icon close" title="Dismiss" aria-label="Dismiss">${icon("close")}</button>
          </div>
        </div>
        <div class="large-preview" id="large-preview" tabindex="0" role="region" aria-label="Full capture preview. Scroll to inspect." hidden></div>
        <div class="actions"><button class="copy">${icon("copy")}Copy</button><button class="dl">${icon("download")}<span>Save PNG</span></button><button class="pdf">${icon("pdf")}Save PDF</button></div>
        <div class="settings" id="export-settings" hidden>
          <label id="format-label">Image format</label>
          <div class="formats" role="group" aria-labelledby="format-label"><button data-format="png" aria-pressed="true">PNG</button><button data-format="jpg" aria-pressed="false">JPG</button><button data-format="webp" aria-pressed="false">WebP</button></div>
          <p class="hint">PNG keeps every detail. JPG and WebP use smaller files.<br>PDF saves the full capture on A4 pages.</p>
        </div>
        <p class="status" role="status" aria-live="polite"></p>
      </section>`;
    const width = canvas.width, height = canvas.height;
    const thumb = document.createElement("canvas");
    // Render only the visible thumbnail, instead of retaining a second long image.
    thumb.width = 96; thumb.height = Math.max(1, Math.min(116, Math.round(96 * height / width)));
    root.querySelector(".preview").style.height = `${thumb.height * 46 / 96 + 2}px`;
    const previewHeight = Math.min(height, width * thumb.height / thumb.width);
    const ctx = thumb.getContext("2d");
    ctx.drawImage(canvas, 0, 0, width, previewHeight, 0, 0, thumb.width, thumb.width * previewHeight / width);
    root.querySelector(".preview").appendChild(thumb);
    root.querySelector("h2").textContent = document.title || location.hostname || "Screenshot";
    root.querySelector("h2").title = document.title;
    root.querySelector(".source").textContent = location.hostname || "Current page";
    root.querySelector(".meta").textContent = `${width.toLocaleString()} × ${height.toLocaleString()} px`;
    canvas.width = canvas.height = 1;

    const panel = root.querySelector(".panel");
    const status = root.querySelector(".status");
    const setStatus = (message) => { status.textContent = message; };
    const settings = root.querySelector(".settings");
    const toggle = root.querySelector(".settings-toggle");
    const setSettings = (open) => { settings.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); };
    toggle.addEventListener("click", () => setSettings(settings.hidden));
    const previewButton = root.querySelector(".preview");
    const largePreview = root.querySelector(".large-preview");
    const collapseButton = root.querySelector(".collapse");
    let previewURL;
    const setExpanded = (expanded) => {
      panel.classList.toggle("expanded", expanded);
      previewButton.setAttribute("aria-expanded", String(expanded));
      previewButton.setAttribute("aria-label", expanded ? "Close large preview" : "Show large preview");
      previewButton.title = expanded ? "Close large preview" : "Show large preview";
      largePreview.hidden = !expanded;
      collapseButton.hidden = !expanded;
      if (expanded) {
        setSettings(false);
        previewURL = URL.createObjectURL(blob);
        const image = document.createElement("img");
        image.alt = "Full captured page";
        image.width = width; image.height = height;
        image.src = previewURL;
        largePreview.replaceChildren(image);
        largePreview.scrollTop = 0;
        collapseButton.focus();
      } else {
        largePreview.replaceChildren();
        if (previewURL) URL.revokeObjectURL(previewURL);
        previewURL = null;
        previewButton.focus();
      }
    };
    previewButton.addEventListener("click", () => setExpanded(largePreview.hidden));
    collapseButton.addEventListener("click", () => setExpanded(false));
    const dispose = () => { stopTheme(); if (previewURL) URL.revokeObjectURL(previewURL); };
    host.addEventListener("pagegrab-dispose", dispose, { once: true });
    const close = () => { dispose(); host.remove(); };
    root.querySelector(".close").addEventListener("click", close);
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!settings.hidden) { setSettings(false); toggle.focus(); }
      else if (!largePreview.hidden) setExpanded(false);
      else close();
    });
    let format = "png", changed = false;
    const selectFormat = (value) => {
      format = ["png", "jpg", "webp"].includes(value) ? value : "png";
      for (const button of root.querySelectorAll("[data-format]")) button.setAttribute("aria-pressed", String(button.dataset.format === format));
      root.querySelector(".dl span").textContent = `Save ${format === "webp" ? "WebP" : format.toUpperCase()}`;
    };
    // Extension storage keeps this preference across sites without touching site data.
    if (extensionAPI?.storage?.local) {
      extensionAPI.storage.local.get("exportFormat").then((saved) => { if (!changed) selectFormat(saved.exportFormat); }).catch(() => {});
    }
    for (const button of root.querySelectorAll("[data-format]")) button.addEventListener("click", () => {
      changed = true; selectFormat(button.dataset.format);
      if (extensionAPI?.storage?.local) extensionAPI.storage.local.set({ exportFormat: format }).catch(() => setStatus("Format selected. Could not remember it for next time."));
    });
    const save = (file, extension) => {
      if (!host.isConnected) return;
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url; a.download = buildFileName(extension);
      root.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    const runExport = async (button, operation) => {
      const buttons = root.querySelectorAll(".actions button");
      for (const item of buttons) item.disabled = true;
      button.setAttribute("aria-busy", "true");
      try { await operation(); close(); }
      catch (error) { setStatus(error.message || "Export failed. Please try again."); }
      finally { for (const item of buttons) item.disabled = false; button.removeAttribute("aria-busy"); }
    };
    root.querySelector(".copy").addEventListener("click", (event) => runExport(event.currentTarget, async () => {
      try {
        await copyImage(blob);
      } catch { throw new Error("Clipboard unavailable. Save the image instead."); }
    }));
    root.querySelector(".dl").addEventListener("click", (event) => runExport(event.currentTarget, async () => {
      const selected = format;
      setStatus("Preparing image…");
      save(await convertImage(blob, selected), selected);
    }));
    root.querySelector(".pdf").addEventListener("click", (event) => runExport(event.currentTarget, async () => {
      setStatus("Preparing PDF…");
      save(await createPDF(blob), "pdf");
    }));
    document.documentElement.appendChild(host);
    const stopTheme = followPageBackground(host, panel);
  }

  (async () => {
    removeExistingPanel();
    const toast = createToast("Preparing capture…");
    try {
      const canvas = await captureFullPage(toast);
      const blob = await canvasToBlob(canvas);
      toast.remove();
      showPanel(canvas, blob);
    } catch (err) {
      toast.set("Capture failed: " + err.message);
      setTimeout(() => toast.remove(), 4000);
    } finally {
      window.__fpcBusy = false;
    }
  })();
})();
