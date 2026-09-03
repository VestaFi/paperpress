# PaperPress — Local PDF Workshop

A Progressive Web App with iLovePDF-style tools that run **entirely in your browser**.
No uploads, no accounts, no server — files never leave your device. Works offline once installed.

## Tools (17)

**Organize** — Merge · Split · Organize (visual reorder/rotate/delete with thumbnails) · Extract pages · Delete pages · Rotate · Crop (trim margins in mm)

**Optimize** — Compress (rasterizes pages to JPEG at 72/96/144 dpi) · Repair (structure re-write) · Unlock (strips permission restrictions; can't decrypt open-password files)

**Convert** — Images → PDF · PDF → JPG (72/150/300 dpi) · PDF → Markdown (text extraction)

**Edit & sign** — Watermark · Page numbers · Sign (draw a signature, place on any page) · Fill forms (detects fields, optional flatten)

Processing: [pdf-lib](https://pdf-lib.js.org/) for document assembly, [pdf.js](https://mozilla.github.io/pdf.js/) for rendering/text — both vendored locally in `vendor/`.

### Not included (impossible without a server or heavyweight WASM)

- PDF ↔ Word / PowerPoint / Excel — real conversion needs Office-format engines; browser-only results are unusably poor
- PDF/A conversion, Protect (encrypt) — need Ghostscript/qpdf (WASM builds are 10–20 MB; could be added later)
- OCR / Scan to PDF — feasible with Tesseract.js (~15 MB models); left out to keep the app small
- HTML to PDF — cross-origin pages can't be fetched from a browser; use the browser's own Print → Save as PDF
- AI Summarizer / Translate — require an AI API (not local)

## Run locally

Any static file server works. For example:

```
npx http-server . -p 8123
```

Then open http://localhost:8123.

## Install as an app (PWA)

PWA install requires HTTPS (or localhost). Host the folder anywhere static —
GitHub Pages, Netlify, Cloudflare Pages — then in Edge/Chrome:

**Edge:** ⋯ menu → **Apps** → **Install PaperPress**
**Chrome:** install icon in the address bar

Once installed it opens in its own window, has a taskbar icon, and works fully offline
(the service worker precaches the app shell and pdf-lib; Google Fonts are cached on first load).

## Files

- `index.html` / `app.css` / `app.js` — the app
- `manifest.webmanifest` — PWA manifest
- `sw.js` — service worker (cache-first)
- `vendor/pdf-lib.min.js` — PDF engine (pdf-lib 1.17.1, MIT)
- `icons/` — app icons

## Notes

- Password-protected PDFs load with `ignoreEncryption`; heavily protected files may still fail.
- "Compress PDF" is intentionally absent — pdf-lib can't meaningfully recompress content streams.
- To bust the offline cache after editing files, bump `CACHE` in `sw.js` (e.g. `paperpress-v2`).
