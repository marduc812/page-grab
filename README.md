<div align="center">
  <img src="icons/pagegrab128.png" alt="PageGrab logo" width="96" height="96">
  <h1>PageGrab</h1>
  <p>Capture the full page. Copy it, save an image, or export a PDF.</p>
  <p>A Chrome extension with an on-page preview and a glass panel that follows the page's background.</p>
</div>

![PageGrab's capture panel on Wikipedia's white-background Cherry blossom article, with image export settings open](docs/images/pagegrab-wikipedia.png)

<p align="center"><sub>The actual capture panel on <a href="https://en.wikipedia.org/wiki/Cherry_blossom">Wikipedia's Cherry blossom article</a>. Export settings are open.</sub></p>

## What you can do

- Capture a whole page, including content below the fold.
- Click the thumbnail to inspect a larger, scrollable preview.
- Copy the capture to your clipboard as PNG.
- Save PNG, JPG, or WebP. PageGrab remembers your image format.
- Export the capture as a PDF split across A4 pages.
- Start a capture from the toolbar, the page's context menu, or `Alt+Shift+P`.

PageGrab scrolls the page to load lazy content before capturing it. It also supports a main scrolling container when the document itself does not scroll. The capture restores your original scroll position afterward.

## Install locally

1. Download this project and extract it, or clone it to a local folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin **Full Page Capture** in Chrome's extensions menu. This is PageGrab's name in the manifest.

There is no build step or package installation. The extension loads directly from this folder.

## Take a capture

1. Open a web page and click the extension icon, or press `Alt+Shift+P`.
2. Keep the tab active while PageGrab scrolls and captures the page.
3. Use **Copy**, **Save PNG**, or **Save PDF** in the panel. Open **Export settings** to choose JPG or WebP.

Click the thumbnail to expand the preview. Press `Escape` to close settings, collapse the preview, or dismiss the panel.

You can change the shortcut at `chrome://extensions/shortcuts` if another application uses it.

## Privacy and permissions

PageGrab processes screenshots in your browser. The extension code has no analytics, external API calls, or screenshot uploads. It stores your selected image format in `chrome.storage.local`.

| Permission | Why PageGrab needs it |
| --- | --- |
| `activeTab` | Access the tab you invoke the extension on and capture its visible area. |
| `scripting` | Run the capture code and display the panel on that page. |
| `contextMenus` | Add the page context-menu command. |
| `storage` | Remember your preferred image format. |

The manifest requests no persistent host permissions.

## Capture limits

Chrome blocks script injection on protected pages such as `chrome://` pages and the Chrome Web Store. Local `file://` pages require **Allow access to file URLs** in the extension's details.

Pages that block scrolling or keep adding content can stop a capture. Very large captures scale down to fit a maximum canvas dimension of 16,000 pixels and a maximum area of 200 million pixels. The PDF contains page images, so its text is not selectable.

## Development

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 configuration, permissions, and shortcut. |
| `background.js` | Capture entry points and the shared screenshot rate-limit queue. |
| `content.js` | Scrolling, image stitching, preview, clipboard, and exports. |
| `icons/` | Extension icons and logo assets. |
| `tests/` | Node tests and Chrome integration checks. |

Run the capture tests with Node.js:

```sh
node --test tests/capture.test.cjs
```

The browser checks require Python 3 and Google Chrome. The capture and export checks also need `websocket-client`. The export check needs Pillow and the Poppler commands `pdfinfo` and `pdftoppm`.

```sh
python3 tests/browser_theme.py
python3 tests/browser_capture.py
python3 tests/browser_exports.py
```

The scripts use Chrome's standard macOS installation path. Set `PAGEGRAB_CHROME` to use a different executable.

After changing extension files, click **Reload** at `chrome://extensions`, then reload the page you want to capture.
