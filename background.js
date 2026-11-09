const MENU_ID = "capture-full-page";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Capture full page as image",
    contexts: ["all"]
  });
});

async function startCapture(tab) {
  if (!tab || tab.id == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (err) {
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: "" }), 3000);
    console.warn("Cannot capture this page:", err);
  }
}

chrome.action.onClicked.addListener(startCapture);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) startCapture(tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "capture-full-page") return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  startCapture(tab);
});

// Chrome limits visible-tab captures to two calls per second per extension.
// Keep one queue so simultaneous captures in different windows share that limit.
const CAPTURE_INTERVAL = 550;
let captureQueue = Promise.resolve();
let lastCaptureAt = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureVisible(sender) {
  if (sender.tab?.id == null) throw new Error("Capture must come from a browser tab");
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(Math.max(0, CAPTURE_INTERVAL - (Date.now() - lastCaptureAt)));
    const [active] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
    if (active?.id !== sender.tab.id) throw new Error("Keep the page's tab active until capture finishes");
    lastCaptureAt = Date.now();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
      return { dataUrl };
    } catch (error) {
      if (attempt === 3 || !/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|rate limit/i.test(error.message)) throw error;
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "capture-visible") return;
  const result = captureQueue.then(() => captureVisible(sender));
  captureQueue = result.catch(() => {});
  result.then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});
