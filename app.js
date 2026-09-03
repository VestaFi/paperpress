/* PaperPress — all PDF work happens locally via pdf-lib + pdf.js. */
(() => {
  "use strict";

  const { PDFDocument, degrees, rgb, StandardFonts,
          PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup } = PDFLib;

  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

  // ---------- helpers ----------

  const $ = (sel) => document.querySelector(sel);
  const MM_TO_PT = 72 / 25.4;

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(2) + " MB";
  }

  function baseName(name) {
    return name.replace(/\.pdf$/i, "");
  }

  // "1-3, 5, 8-10" -> [0,1,2,4,7,8,9] (0-based, deduped, in listed order)
  function parseRanges(str, max) {
    const out = [];
    const seen = new Set();
    const parts = String(str).split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error("No pages given.");
    for (const part of parts) {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/) || part.match(/^(\d+)$/);
      if (!m) throw new Error(`Can't read "${part}" — use forms like 3 or 2-5.`);
      const a = parseInt(m[1], 10);
      const b = m[2] !== undefined ? parseInt(m[2], 10) : a;
      if (a < 1 || b < 1) throw new Error("Pages start at 1.");
      if (a > b) throw new Error(`Range "${part}" is backwards.`);
      if (b > max) throw new Error(`Page ${b} doesn't exist — document has ${max} page${max === 1 ? "" : "s"}.`);
      for (let p = a; p <= b; p++) {
        if (!seen.has(p)) { seen.add(p); out.push(p - 1); }
      }
    }
    return out;
  }

  // Same syntax, but keeps groups: "1-2,5" -> [[0,1],[4]]
  function parseRangeGroups(str, max) {
    const groups = [];
    const parts = String(str).split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error("No ranges given.");
    for (const part of parts) {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/) || part.match(/^(\d+)$/);
      if (!m) throw new Error(`Can't read "${part}" — use forms like 3 or 2-5.`);
      const a = parseInt(m[1], 10);
      const b = m[2] !== undefined ? parseInt(m[2], 10) : a;
      if (a < 1) throw new Error("Pages start at 1.");
      if (a > b) throw new Error(`Range "${part}" is backwards.`);
      if (b > max) throw new Error(`Page ${b} doesn't exist — document has ${max} page${max === 1 ? "" : "s"}.`);
      const g = [];
      for (let p = a; p <= b; p++) g.push(p - 1);
      groups.push({ label: part.replace(/\s+/g, ""), indices: g });
    }
    return groups;
  }

  async function loadPdf(file) {
    const buf = await file.arrayBuffer();
    return PDFDocument.load(buf, { ignoreEncryption: true });
  }

  async function loadPdfJs(file) {
    const buf = await file.arrayBuffer();
    return pdfjsLib.getDocument({ data: buf }).promise;
  }

  async function renderPageToCanvas(pdfjsDoc, pageNo, scale) {
    const page = await pdfjsDoc.getPage(pageNo);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // intent "print" avoids requestAnimationFrame scheduling, which stalls in hidden tabs
    await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;
    return { canvas, page };
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error("Couldn't encode image.")),
        "image/jpeg",
        quality
      );
    });
  }

  // ---------- core operations ----------

  const ops = {
    async merge(files) {
      const out = await PDFDocument.create();
      for (const f of files) {
        const src = await loadPdf(f.file);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      }
      return [{ name: "merged.pdf", bytes: await out.save() }];
    },

    async split(files, opts) {
      const f = files[0];
      const src = await loadPdf(f.file);
      const n = src.getPageCount();
      const stem = baseName(f.file.name);
      let groups;
      if (opts.mode === "every") {
        groups = Array.from({ length: n }, (_, i) => ({ label: String(i + 1), indices: [i] }));
      } else {
        groups = parseRangeGroups(opts.ranges, n);
      }
      const results = [];
      for (const g of groups) {
        const doc = await PDFDocument.create();
        const pages = await doc.copyPages(src, g.indices);
        pages.forEach((p) => doc.addPage(p));
        results.push({ name: `${stem}-p${g.label}.pdf`, bytes: await doc.save() });
      }
      return results;
    },

    async extract(files, opts) {
      const f = files[0];
      const src = await loadPdf(f.file);
      const indices = parseRanges(opts.ranges, src.getPageCount());
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(src, indices);
      pages.forEach((p) => doc.addPage(p));
      return [{ name: `${baseName(f.file.name)}-extract.pdf`, bytes: await doc.save() }];
    },

    async delete(files, opts) {
      const f = files[0];
      const src = await loadPdf(f.file);
      const n = src.getPageCount();
      const drop = new Set(parseRanges(opts.ranges, n));
      const keep = src.getPageIndices().filter((i) => !drop.has(i));
      if (!keep.length) throw new Error("That would delete every page.");
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(src, keep);
      pages.forEach((p) => doc.addPage(p));
      return [{ name: `${baseName(f.file.name)}-trimmed.pdf`, bytes: await doc.save() }];
    },

    async rotate(files, opts) {
      const f = files[0];
      const src = await loadPdf(f.file);
      const n = src.getPageCount();
      const targets = opts.ranges.trim() ? new Set(parseRanges(opts.ranges, n)) : null;
      src.getPages().forEach((page, i) => {
        if (targets && !targets.has(i)) return;
        const current = page.getRotation().angle || 0;
        page.setRotation(degrees((current + opts.angle) % 360));
      });
      return [{ name: `${baseName(f.file.name)}-rotated.pdf`, bytes: await src.save() }];
    },

    async organize(files, opts) {
      const f = files[0];
      const src = await loadPdf(f.file);
      const keep = opts.pages.filter((p) => !p.deleted);
      if (!keep.length) throw new Error("Every page is marked for deletion.");
      const doc = await PDFDocument.create();
      const copied = await doc.copyPages(src, keep.map((p) => p.srcIndex));
      copied.forEach((page, i) => {
        const extra = keep[i].rotation % 360;
        if (extra) {
          const current = page.getRotation().angle || 0;
          page.setRotation(degrees((current + extra) % 360));
        }
        doc.addPage(page);
      });
      return [{ name: `${baseName(f.file.name)}-organized.pdf`, bytes: await doc.save() }];
    },

    async crop(files, opts) {
      const f = files[0];
      const src = await loadPdf(f.file);
      const n = src.getPageCount();
      const targets = opts.ranges.trim() ? new Set(parseRanges(opts.ranges, n)) : null;
      const t = opts.top * MM_TO_PT, r = opts.right * MM_TO_PT,
            b = opts.bottom * MM_TO_PT, l = opts.left * MM_TO_PT;
      src.getPages().forEach((page, i) => {
        if (targets && !targets.has(i)) return;
        const { x, y, width, height } = page.getMediaBox();
        const w = width - l - r, h = height - t - b;
        if (w <= 10 || h <= 10) throw new Error("Margins are bigger than the page.");
        page.setCropBox(x + l, y + b, w, h);
      });
      return [{ name: `${baseName(f.file.name)}-cropped.pdf`, bytes: await src.save() }];
    },

    async compress(files, opts, progress) {
      const f = files[0];
      const jsDoc = await loadPdfJs(f.file);
      const doc = await PDFDocument.create();
      const scale = opts.dpi / 72;
      for (let i = 1; i <= jsDoc.numPages; i++) {
        progress?.(`Pressing page ${i} / ${jsDoc.numPages}…`);
        const { canvas, page } = await renderPageToCanvas(jsDoc, i, scale);
        const jpg = await doc.embedJpg(await canvasToJpeg(canvas, opts.quality));
        const vp1 = page.getViewport({ scale: 1 });
        const newPage = doc.addPage([vp1.width, vp1.height]);
        newPage.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        canvas.width = 0; canvas.height = 0;
      }
      const bytes = await doc.save();
      return [{
        name: `${baseName(f.file.name)}-compressed.pdf`,
        bytes,
        note: `${fmtSize(f.file.size)} → ${fmtSize(bytes.length)}. Pages become images — text is no longer selectable.`,
      }];
    },

    async repair(files) {
      const f = files[0];
      const buf = await f.file.arrayBuffer();
      const src = await PDFDocument.load(buf, { ignoreEncryption: true, throwOnInvalidObject: false });
      return [{ name: `${baseName(f.file.name)}-repaired.pdf`, bytes: await src.save() }];
    },

    async unlock(files) {
      const f = files[0];
      const buf = await f.file.arrayBuffer();
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const bytes = await src.save();
      return [{
        name: `${baseName(f.file.name)}-unlocked.pdf`,
        bytes,
        note: "Removes permission (owner) restrictions. Files encrypted with an open password can't be decrypted.",
      }];
    },

    async images(files) {
      const doc = await PDFDocument.create();
      const A4 = { w: 595.28, h: 841.89 };
      const margin = 36;
      for (const f of files) {
        const buf = await f.file.arrayBuffer();
        let img;
        if (/\.png$/i.test(f.file.name)) img = await doc.embedPng(buf);
        else img = await doc.embedJpg(buf);
        const page = doc.addPage([A4.w, A4.h]);
        const maxW = A4.w - margin * 2;
        const maxH = A4.h - margin * 2;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h });
      }
      return [{ name: "images.pdf", bytes: await doc.save() }];
    },

    async tojpg(files, opts, progress) {
      const f = files[0];
      const jsDoc = await loadPdfJs(f.file);
      const stem = baseName(f.file.name);
      const scale = opts.dpi / 72;
      const results = [];
      for (let i = 1; i <= jsDoc.numPages; i++) {
        progress?.(`Printing page ${i} / ${jsDoc.numPages}…`);
        const { canvas } = await renderPageToCanvas(jsDoc, i, scale);
        const bytes = new Uint8Array(await canvasToJpeg(canvas, 0.9));
        results.push({ name: `${stem}-p${i}.jpg`, bytes, mime: "image/jpeg" });
        canvas.width = 0; canvas.height = 0;
      }
      return results;
    },

    async tomd(files, opts, progress) {
      const f = files[0];
      const jsDoc = await loadPdfJs(f.file);
      const parts = [];
      for (let i = 1; i <= jsDoc.numPages; i++) {
        progress?.(`Reading page ${i} / ${jsDoc.numPages}…`);
        const page = await jsDoc.getPage(i);
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) {
          text += item.str;
          text += item.hasEOL ? "\n" : " ";
        }
        parts.push(`## Page ${i}\n\n${text.trim()}\n`);
      }
      const md = `# ${baseName(f.file.name)}\n\n` + parts.join("\n");
      return [{
        name: `${baseName(f.file.name)}.md`,
        bytes: new TextEncoder().encode(md),
        mime: "text/markdown",
        note: "Plain text extraction — scanned/image-only PDFs contain no text to extract.",
      }];
    },

    async watermark(files, opts) {
      const f = files[0];
      if (!opts.text.trim()) throw new Error("Watermark text is empty.");
      const src = await loadPdf(f.file);
      const font = await src.embedFont(StandardFonts.HelveticaBold);
      const size = opts.size;
      const color = rgb(0.88, 0.28, 0.17);
      src.getPages().forEach((page) => {
        const { width, height } = page.getSize();
        const textW = font.widthOfTextAtSize(opts.text, size);
        const angle = opts.diagonal ? Math.atan2(height, width) * (180 / Math.PI) : 0;
        const rad = (angle * Math.PI) / 180;
        const x = width / 2 - (textW / 2) * Math.cos(rad) + (size / 2) * Math.sin(rad) * 0.5;
        const y = height / 2 - (textW / 2) * Math.sin(rad) - (size / 2) * Math.cos(rad) * 0.5;
        page.drawText(opts.text, {
          x, y, size, font, color,
          opacity: opts.opacity,
          rotate: degrees(angle),
        });
      });
      return [{ name: `${baseName(f.file.name)}-watermarked.pdf`, bytes: await src.save() }];
    },

    async pagenum(files, opts) {
      const f = files[0];
      const src = await loadPdf(f.file);
      const font = await src.embedFont(StandardFonts.Helvetica);
      const total = src.getPageCount();
      const size = 10;
      src.getPages().forEach((page, i) => {
        const { width } = page.getSize();
        const num = opts.start + i;
        const label = opts.format === "n-of-total" ? `${num} / ${opts.start + total - 1}` : String(num);
        const textW = font.widthOfTextAtSize(label, size);
        let x;
        if (opts.pos === "left") x = 40;
        else if (opts.pos === "right") x = width - 40 - textW;
        else x = (width - textW) / 2;
        page.drawText(label, { x, y: 24, size, font, color: rgb(0.11, 0.09, 0.07) });
      });
      return [{ name: `${baseName(f.file.name)}-numbered.pdf`, bytes: await src.save() }];
    },

    async sign(files, opts) {
      const f = files[0];
      if (!opts.pngDataUrl) throw new Error("Draw a signature first.");
      const src = await loadPdf(f.file);
      const n = src.getPageCount();
      const pageNo = opts.page;
      if (pageNo < 1 || pageNo > n) throw new Error(`Page ${pageNo} doesn't exist — document has ${n} page${n === 1 ? "" : "s"}.`);
      const png = await src.embedPng(opts.pngDataUrl);
      const page = src.getPage(pageNo - 1);
      const { width, height } = page.getSize();
      const w = opts.widthPt;
      const h = w * (png.height / png.width);
      const m = 30;
      let x, y;
      if (opts.anchor.includes("left")) x = m;
      else if (opts.anchor.includes("right")) x = width - m - w;
      else x = (width - w) / 2;
      y = opts.anchor.includes("top") ? height - m - h : m;
      page.drawImage(png, { x, y, width: w, height: h });
      return [{ name: `${baseName(f.file.name)}-signed.pdf`, bytes: await src.save() }];
    },

    async forms(files, opts) {
      const f = files[0];
      const src = await loadPdf(f.file);
      const form = src.getForm();
      const fields = form.getFields();
      if (!fields.length) throw new Error("This PDF has no form fields.");
      for (const field of fields) {
        const name = field.getName();
        if (!(name in opts.values)) continue;
        const v = opts.values[name];
        try {
          if (field instanceof PDFTextField) field.setText(String(v));
          else if (field instanceof PDFCheckBox) { v ? field.check() : field.uncheck(); }
          else if (field instanceof PDFDropdown && v) field.select(String(v));
          else if (field instanceof PDFOptionList && v) field.select(String(v));
          else if (field instanceof PDFRadioGroup && v) field.select(String(v));
        } catch (e) {
          console.warn(`Field "${name}":`, e.message);
        }
      }
      if (opts.flatten) {
        try { form.flatten(); }
        catch (e) { console.warn("Flatten failed:", e.message); }
      }
      return [{ name: `${baseName(f.file.name)}-filled.pdf`, bytes: await src.save() }];
    },
  };

  // exposed for smoke-testing from the console
  window.__pdfops = { ops, parseRanges, parseRangeGroups };

  // ---------- tool-specific UI state ----------

  let orgState = null;   // organize: [{srcIndex, rotation, deleted, thumbUrl}]
  let sigPad = null;     // sign: {canvas, ctx, dirty}

  // ---------- tool definitions ----------

  const PDF_ACCEPT = "application/pdf,.pdf";
  const ONE_PDF = { accept: PDF_ACCEPT, multiple: false, minFiles: 1, hint: "One PDF file" };

  const TOOLS = {
    merge: {
      title: "Merge",
      sub: "Add two or more PDFs. Reorder with the arrows, then run.",
      accept: PDF_ACCEPT, multiple: true, minFiles: 2, hint: "PDF files · at least two",
      options: () => "", readOpts: () => ({}),
    },

    split: {
      title: "Split", sub: "One PDF in, several out.", ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <span class="opt-label">Mode</span>
          <div class="seg" id="split-mode">
            <button type="button" class="on" data-v="every">Every page</button>
            <button type="button" data-v="ranges">By ranges</button>
          </div>
        </div>
        <div class="opt-row" id="split-ranges-row" hidden>
          <label class="opt-label" for="opt-ranges">Ranges — one file per range</label>
          <input class="opt-input" id="opt-ranges" placeholder="e.g. 1-3, 4-6, 7">
          <span class="opt-note">Commas separate output files. "1-3, 4-6" makes two PDFs.</span>
        </div>`,
      wire: () => {
        segWire("#split-mode", (v) => { $("#split-ranges-row").hidden = v !== "ranges"; });
      },
      readOpts: () => ({
        mode: $("#split-mode button.on").dataset.v,
        ranges: $("#opt-ranges").value,
      }),
    },

    organize: {
      title: "Organize",
      sub: "Every page laid on the bench. Move, rotate, or mark pages for the bin, then run.",
      ...ONE_PDF,
      options: () => `<div id="org-grid" class="org-grid"></div>
        <span class="opt-note" id="org-note" hidden>Large document — showing the first 200 pages only.</span>`,
      onFiles: buildOrganizeGrid,
      readOpts: () => {
        if (!orgState) throw new Error("Add a PDF first.");
        return { pages: orgState };
      },
    },

    extract: {
      title: "Extract pages",
      sub: "Pull chosen pages into a fresh PDF, in the order you list them.",
      ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <label class="opt-label" for="opt-ranges">Pages to extract</label>
          <input class="opt-input" id="opt-ranges" placeholder="e.g. 1, 3-5, 12">
        </div>`,
      readOpts: () => ({ ranges: $("#opt-ranges").value }),
    },

    delete: {
      title: "Delete pages",
      sub: "List the pages to remove — everything else is kept.",
      ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <label class="opt-label" for="opt-ranges">Pages to delete</label>
          <input class="opt-input" id="opt-ranges" placeholder="e.g. 2, 7-9">
        </div>`,
      readOpts: () => ({ ranges: $("#opt-ranges").value }),
    },

    rotate: {
      title: "Rotate",
      sub: "Turn pages clockwise. Leave the page box empty to rotate all.",
      ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <span class="opt-label">Angle</span>
          <div class="seg" id="rot-angle">
            <button type="button" class="on" data-v="90">90°</button>
            <button type="button" data-v="180">180°</button>
            <button type="button" data-v="270">270°</button>
          </div>
        </div>
        <div class="opt-row">
          <label class="opt-label" for="opt-ranges">Pages (optional)</label>
          <input class="opt-input" id="opt-ranges" placeholder="empty = all pages">
        </div>`,
      wire: () => segWire("#rot-angle"),
      readOpts: () => ({
        angle: parseInt($("#rot-angle button.on").dataset.v, 10),
        ranges: $("#opt-ranges").value,
      }),
    },

    crop: {
      title: "Crop",
      sub: "Trim margins in millimetres. Applies to the visible page box.",
      ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <span class="opt-label">Margins to trim (mm)</span>
          <div class="crop-grid">
            <label>Top <input class="opt-input sm" id="crop-t" type="number" min="0" value="10"></label>
            <label>Right <input class="opt-input sm" id="crop-r" type="number" min="0" value="10"></label>
            <label>Bottom <input class="opt-input sm" id="crop-b" type="number" min="0" value="10"></label>
            <label>Left <input class="opt-input sm" id="crop-l" type="number" min="0" value="10"></label>
          </div>
        </div>
        <div class="opt-row">
          <label class="opt-label" for="opt-ranges">Pages (optional)</label>
          <input class="opt-input" id="opt-ranges" placeholder="empty = all pages">
        </div>`,
      readOpts: () => ({
        top: +$("#crop-t").value || 0, right: +$("#crop-r").value || 0,
        bottom: +$("#crop-b").value || 0, left: +$("#crop-l").value || 0,
        ranges: $("#opt-ranges").value,
      }),
    },

    compress: {
      title: "Compress",
      sub: "Re-presses each page as a JPEG image. Strong shrink, but text stops being selectable.",
      ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <span class="opt-label">Preset</span>
          <div class="seg" id="cmp-preset">
            <button type="button" data-v="extreme">Extreme</button>
            <button type="button" class="on" data-v="recommended">Recommended</button>
            <button type="button" data-v="light">Light</button>
          </div>
          <span class="opt-note">Extreme 72 dpi · Recommended 96 dpi · Light 144 dpi</span>
        </div>`,
      wire: () => segWire("#cmp-preset"),
      readOpts: () => {
        const v = $("#cmp-preset button.on").dataset.v;
        return v === "extreme" ? { dpi: 72, quality: 0.5 }
             : v === "light" ? { dpi: 144, quality: 0.8 }
             : { dpi: 96, quality: 0.65 };
      },
    },

    repair: {
      title: "Repair",
      sub: "Re-writes the PDF's internal structure. Fixes many corrupt files — not all.",
      ...ONE_PDF,
      options: () => "", readOpts: () => ({}),
    },

    unlock: {
      title: "Unlock",
      sub: "Strips permission restrictions (printing, copying). Can't decrypt files that need a password to open.",
      ...ONE_PDF,
      options: () => "", readOpts: () => ({}),
    },

    images: {
      title: "Images → PDF",
      sub: "Each image is centred on its own A4 page. Reorder with the arrows.",
      accept: "image/jpeg,image/png,.jpg,.jpeg,.png",
      multiple: true, minFiles: 1, hint: "JPG or PNG images",
      options: () => "", readOpts: () => ({}),
    },

    tojpg: {
      title: "PDF → JPG",
      sub: "Prints every page as a JPG image.",
      ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <span class="opt-label">Resolution</span>
          <div class="seg" id="jpg-dpi">
            <button type="button" data-v="72">72 dpi</button>
            <button type="button" class="on" data-v="150">150 dpi</button>
            <button type="button" data-v="300">300 dpi</button>
          </div>
        </div>`,
      wire: () => segWire("#jpg-dpi"),
      readOpts: () => ({ dpi: parseInt($("#jpg-dpi button.on").dataset.v, 10) }),
    },

    tomd: {
      title: "PDF → Markdown",
      sub: "Extracts the text layer into a Markdown file, one section per page.",
      ...ONE_PDF,
      options: () => "", readOpts: () => ({}),
    },

    watermark: {
      title: "Watermark",
      sub: "Stamps text across every page.",
      ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <label class="opt-label" for="wm-text">Text</label>
          <input class="opt-input" id="wm-text" placeholder="CONFIDENTIAL" value="CONFIDENTIAL">
        </div>
        <div class="opt-row">
          <span class="opt-label">Angle</span>
          <div class="seg" id="wm-diag">
            <button type="button" class="on" data-v="diag">Diagonal</button>
            <button type="button" data-v="flat">Horizontal</button>
          </div>
        </div>
        <div class="opt-row">
          <label class="opt-label" for="wm-size">Size (pt)</label>
          <input class="opt-input sm" id="wm-size" type="number" min="8" max="200" value="48">
        </div>
        <div class="opt-row">
          <label class="opt-label" for="wm-op">Opacity — ${"0.05 to 1"}</label>
          <input class="opt-input sm" id="wm-op" type="number" min="0.05" max="1" step="0.05" value="0.25">
        </div>`,
      wire: () => segWire("#wm-diag"),
      readOpts: () => ({
        text: $("#wm-text").value,
        diagonal: $("#wm-diag button.on").dataset.v === "diag",
        size: Math.min(200, Math.max(8, +$("#wm-size").value || 48)),
        opacity: Math.min(1, Math.max(0.05, +$("#wm-op").value || 0.25)),
      }),
    },

    pagenum: {
      title: "Page numbers",
      sub: "Numbers go along the bottom edge of every page.",
      ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <span class="opt-label">Position</span>
          <div class="seg" id="pn-pos">
            <button type="button" data-v="left">Left</button>
            <button type="button" class="on" data-v="center">Centre</button>
            <button type="button" data-v="right">Right</button>
          </div>
        </div>
        <div class="opt-row">
          <span class="opt-label">Style</span>
          <div class="seg" id="pn-fmt">
            <button type="button" class="on" data-v="n">1, 2, 3</button>
            <button type="button" data-v="n-of-total">1 / 12</button>
          </div>
        </div>
        <div class="opt-row">
          <label class="opt-label" for="pn-start">Start at</label>
          <input class="opt-input sm" id="pn-start" type="number" min="1" value="1">
        </div>`,
      wire: () => { segWire("#pn-pos"); segWire("#pn-fmt"); },
      readOpts: () => ({
        pos: $("#pn-pos button.on").dataset.v,
        format: $("#pn-fmt button.on").dataset.v,
        start: Math.max(1, parseInt($("#pn-start").value, 10) || 1),
      }),
    },

    sign: {
      title: "Sign",
      sub: "Draw your signature below, pick where it lands, then run.",
      ...ONE_PDF,
      options: () => `
        <div class="opt-row">
          <span class="opt-label">Signature</span>
          <canvas id="sig-pad" class="sig-pad" width="440" height="160"></canvas>
          <div><button type="button" class="file-btn" id="sig-clear" style="width:auto;padding:0 12px">Clear</button></div>
        </div>
        <div class="opt-row">
          <label class="opt-label" for="sig-page">Page</label>
          <input class="opt-input sm" id="sig-page" type="number" min="1" value="1">
        </div>
        <div class="opt-row">
          <span class="opt-label">Position</span>
          <div class="seg" id="sig-anchor">
            <button type="button" data-v="bottom-left">↙</button>
            <button type="button" class="on" data-v="bottom-center">↓</button>
            <button type="button" data-v="bottom-right">↘</button>
            <button type="button" data-v="top-left">↖</button>
            <button type="button" data-v="top-right">↗</button>
          </div>
        </div>
        <div class="opt-row">
          <label class="opt-label" for="sig-w">Width (pt)</label>
          <input class="opt-input sm" id="sig-w" type="number" min="40" max="400" value="150">
        </div>`,
      wire: initSigPad,
      readOpts: () => ({
        pngDataUrl: sigPad && sigPad.dirty ? sigPad.canvas.toDataURL("image/png") : null,
        page: Math.max(1, parseInt($("#sig-page").value, 10) || 1),
        anchor: $("#sig-anchor button.on").dataset.v,
        widthPt: Math.min(400, Math.max(40, +$("#sig-w").value || 150)),
      }),
    },

    forms: {
      title: "Fill forms",
      sub: "Add a PDF with form fields — they'll appear here to fill in.",
      ...ONE_PDF,
      options: () => `
        <div id="form-fields" class="form-fields"></div>
        <div class="opt-row">
          <label class="check-row"><input type="checkbox" id="form-flatten"> Flatten after filling (fields become plain text)</label>
        </div>`,
      onFiles: buildFormFields,
      readOpts: () => {
        const values = {};
        document.querySelectorAll("#form-fields [data-field]").forEach((el) => {
          const name = el.dataset.field;
          if (el.type === "checkbox") values[name] = el.checked;
          else if (el.value !== "") values[name] = el.value;
        });
        return { values, flatten: $("#form-flatten").checked };
      },
    },
  };

  // ---------- organize grid ----------

  async function buildOrganizeGrid() {
    const grid = $("#org-grid");
    if (!grid || !fileEntries.length) return;
    grid.innerHTML = `<span class="opt-note">Setting pages on the bench…</span>`;
    orgState = null;
    try {
      const jsDoc = await loadPdfJs(fileEntries[0].file);
      const cap = Math.min(jsDoc.numPages, 200);
      $("#org-note").hidden = jsDoc.numPages <= 200;
      orgState = [];
      grid.innerHTML = "";
      for (let i = 0; i < cap; i++) {
        const { canvas } = await renderPageToCanvas(jsDoc, i + 1, 0.35);
        const entry = { srcIndex: i, rotation: 0, deleted: false, thumbUrl: canvas.toDataURL("image/jpeg", 0.7) };
        canvas.width = 0; canvas.height = 0;
        orgState.push(entry);
      }
      renderOrganize();
    } catch (e) {
      grid.innerHTML = `<span class="opt-note">Couldn't render pages: ${e.message}</span>`;
    }
  }

  function renderOrganize() {
    const grid = $("#org-grid");
    if (!grid || !orgState) return;
    grid.innerHTML = "";
    orgState.forEach((p, i) => {
      const cell = document.createElement("div");
      cell.className = "org-cell" + (p.deleted ? " dead" : "");
      cell.innerHTML = `
        <div class="org-thumb-wrap"><img class="org-thumb" src="${p.thumbUrl}" alt="Page ${p.srcIndex + 1}" style="transform:rotate(${p.rotation}deg)"></div>
        <div class="org-num">p.${p.srcIndex + 1}</div>`;
      const bar = document.createElement("div");
      bar.className = "org-bar";
      const mk = (txt, label, fn) => {
        const b = mkBtn(txt, label, fn);
        bar.append(b);
        return b;
      };
      mk("←", "Move earlier", () => { if (i > 0) { [orgState[i - 1], orgState[i]] = [orgState[i], orgState[i - 1]]; renderOrganize(); } }).disabled = i === 0;
      mk("⟳", "Rotate 90°", () => { p.rotation = (p.rotation + 90) % 360; renderOrganize(); });
      const del = mk(p.deleted ? "↺" : "×", p.deleted ? "Keep page" : "Delete page", () => { p.deleted = !p.deleted; renderOrganize(); });
      if (!p.deleted) del.classList.add("remove");
      mk("→", "Move later", () => { if (i < orgState.length - 1) { [orgState[i + 1], orgState[i]] = [orgState[i], orgState[i + 1]]; renderOrganize(); } }).disabled = i === orgState.length - 1;
      cell.append(bar);
      grid.append(cell);
    });
  }

  // ---------- signature pad ----------

  function initSigPad() {
    const canvas = $("#sig-pad");
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1c2f6b";
    sigPad = { canvas, ctx, dirty: false };
    let drawing = false;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
    };
    canvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const [x, y] = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      sigPad.dirty = true;
    });
    ["pointerup", "pointercancel"].forEach((ev) =>
      canvas.addEventListener(ev, () => { drawing = false; })
    );
    $("#sig-clear").addEventListener("click", () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      sigPad.dirty = false;
    });
  }

  // ---------- forms field list ----------

  async function buildFormFields() {
    const box = $("#form-fields");
    if (!box || !fileEntries.length) return;
    box.innerHTML = `<span class="opt-note">Reading form fields…</span>`;
    try {
      const src = await loadPdf(fileEntries[0].file);
      const fields = src.getForm().getFields();
      if (!fields.length) {
        box.innerHTML = `<span class="opt-note">No form fields found in this PDF.</span>`;
        return;
      }
      box.innerHTML = "";
      for (const field of fields) {
        const name = field.getName();
        const row = document.createElement("div");
        row.className = "opt-row";
        const esc = name.replace(/"/g, "&quot;");
        if (field instanceof PDFCheckBox) {
          row.innerHTML = `<label class="check-row"><input type="checkbox" data-field="${esc}" ${field.isChecked() ? "checked" : ""}> ${name}</label>`;
        } else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
          const opts = field.getOptions().map((o) => `<option value="${o.replace(/"/g, "&quot;")}">${o}</option>`).join("");
          row.innerHTML = `<label class="opt-label">${name}</label>
            <select class="opt-input" data-field="${esc}"><option value="">— leave as is —</option>${opts}</select>`;
        } else if (field instanceof PDFTextField) {
          let cur = "";
          try { cur = field.getText() || ""; } catch {}
          row.innerHTML = `<label class="opt-label">${name}</label>
            <input class="opt-input" data-field="${esc}" value="${cur.replace(/"/g, "&quot;")}">`;
        } else {
          row.innerHTML = `<span class="opt-note">${name} — unsupported field type, left untouched.</span>`;
        }
        box.append(row);
      }
    } catch (e) {
      box.innerHTML = `<span class="opt-note">Couldn't read form: ${e.message}</span>`;
    }
  }

  // ---------- shared UI ----------

  function segWire(sel, onChange) {
    const seg = $(sel);
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      onChange?.(b.dataset.v);
    });
  }

  let currentTool = null;
  let fileEntries = []; // { file, pageCount|null }
  let resultUrls = [];
  let pendingLaunchFiles = []; // files handed over by the OS (PWA file handler)

  const viewHome = $("#view-home");
  const viewTool = $("#view-tool");
  const dropzone = $("#dropzone");
  const fileInput = $("#file-input");
  const fileListEl = $("#file-list");
  const runBtn = $("#run-btn");
  const statusEl = $("#status");
  const resultsEl = $("#results");
  const resultsList = $("#results-list");
  const dlAllRow = $("#dl-all-row");

  function openTool(key) {
    currentTool = key;
    const t = TOOLS[key];
    fileEntries = [];
    orgState = null;
    sigPad = null;
    $("#tool-title").textContent = t.title;
    $("#tool-sub").textContent = t.sub;
    $("#drop-hint").textContent = t.hint;
    fileInput.accept = t.accept;
    fileInput.multiple = t.multiple;
    $("#tool-options").innerHTML = t.options();
    if (t.wire) t.wire();
    clearResults();
    statusEl.textContent = "";
    statusEl.classList.remove("err");
    renderFiles();
    viewHome.hidden = true;
    viewTool.hidden = false;
    window.scrollTo({ top: 0 });
    if (pendingLaunchFiles.length) {
      const handoff = pendingLaunchFiles;
      pendingLaunchFiles = [];
      const note = $("#launch-note");
      if (note) note.hidden = true;
      addFiles(handoff);
    }
  }

  function goHome() {
    viewTool.hidden = true;
    viewHome.hidden = false;
    currentTool = null;
    fileEntries = [];
    orgState = null;
    sigPad = null;
    clearResults();
  }

  function clearResults() {
    resultUrls.forEach((u) => URL.revokeObjectURL(u));
    resultUrls = [];
    resultsEl.hidden = true;
    resultsList.innerHTML = "";
    dlAllRow.hidden = true;
  }

  function acceptsFile(file) {
    const t = TOOLS[currentTool];
    if (t.accept.includes("pdf")) return /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    return /\.(jpe?g|png)$/i.test(file.name) || /^image\/(jpeg|png)$/.test(file.type);
  }

  async function addFiles(list) {
    const t = TOOLS[currentTool];
    let files = Array.from(list).filter(acceptsFile);
    if (!files.length) {
      setStatus("Those files aren't the right type for this tool.", true);
      return;
    }
    if (!t.multiple) {
      fileEntries = [];
      files = files.slice(0, 1);
    }
    for (const f of files) {
      const entry = { file: f, pageCount: null };
      fileEntries.push(entry);
      if (/\.pdf$/i.test(f.name)) {
        loadPdf(f)
          .then((doc) => { entry.pageCount = doc.getPageCount(); renderFiles(); })
          .catch(() => { entry.pageCount = -1; renderFiles(); });
      }
    }
    setStatus("");
    renderFiles();
    if (t.onFiles) t.onFiles();
  }

  function renderFiles() {
    const t = TOOLS[currentTool || "merge"];
    fileListEl.innerHTML = "";
    fileEntries.forEach((entry, i) => {
      const li = document.createElement("li");
      li.className = "file-item";
      const pages =
        entry.pageCount === null ? "…" :
        entry.pageCount === -1 ? "unreadable" :
        entry.pageCount + " pg";
      li.innerHTML = `
        <span class="file-ord">${String(i + 1).padStart(2, "0")}</span>
        <span class="file-name" title="${entry.file.name}">${entry.file.name}</span>
        <span class="file-pages">${pages} · ${fmtSize(entry.file.size)}</span>`;
      const up = mkBtn("↑", "Move up", () => { swap(i, i - 1); });
      const down = mkBtn("↓", "Move down", () => { swap(i, i + 1); });
      up.disabled = i === 0;
      down.disabled = i === fileEntries.length - 1;
      const rm = mkBtn("×", "Remove", () => {
        fileEntries.splice(i, 1);
        renderFiles();
        if (TOOLS[currentTool]?.onFiles) TOOLS[currentTool].onFiles();
      });
      rm.classList.add("remove");
      if (t.multiple) { li.append(up, down); }
      li.append(rm);
      fileListEl.append(li);
    });
    runBtn.disabled = !currentTool || fileEntries.length < TOOLS[currentTool].minFiles;
  }

  function mkBtn(txt, label, fn) {
    const b = document.createElement("button");
    b.className = "file-btn";
    b.textContent = txt;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", fn);
    return b;
  }

  function swap(a, b) {
    if (b < 0 || b >= fileEntries.length) return;
    [fileEntries[a], fileEntries[b]] = [fileEntries[b], fileEntries[a]];
    renderFiles();
  }

  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.classList.toggle("err", !!isErr);
  }

  async function run() {
    const t = TOOLS[currentTool];
    runBtn.disabled = true;
    setStatus("Pressing…");
    clearResults();
    try {
      const opts = t.readOpts();
      const outputs = await ops[currentTool](fileEntries, opts, setStatus);
      const links = [];
      for (const out of outputs) {
        const blob = new Blob([out.bytes], { type: out.mime || "application/pdf" });
        const url = URL.createObjectURL(blob);
        resultUrls.push(url);
        const li = document.createElement("li");
        li.className = "result-item";
        li.innerHTML = `
          <span class="result-name">${out.name}${out.note ? `<span class="result-note">${out.note}</span>` : ""}</span>
          <span class="result-size">${fmtSize(blob.size)}</span>`;
        const a = document.createElement("a");
        a.className = "dl-btn";
        a.textContent = "Download";
        a.href = url;
        a.download = out.name;
        li.append(a);
        resultsList.append(li);
        links.push(a);
      }
      dlAllRow.hidden = links.length < 2;
      $("#dl-all").onclick = () => {
        let delay = 0;
        for (const a of links) { setTimeout(() => a.click(), delay); delay += 300; }
      };
      resultsEl.hidden = false;
      setStatus(`Done — ${outputs.length} file${outputs.length === 1 ? "" : "s"} ready.`);
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Something went wrong with that file.", true);
    } finally {
      runBtn.disabled = fileEntries.length < t.minFiles;
    }
  }

  // ---------- events ----------

  document.querySelectorAll(".tool-card").forEach((card) => {
    card.addEventListener("click", () => openTool(card.dataset.tool));
  });
  $("#back-btn").addEventListener("click", goHome);

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
  );
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  runBtn.addEventListener("click", run);

  // ---------- bridge for the reader (viewer.js) ----------

  window.__pp = {
    openTool,
    stashLaunchFiles(files, tool) {
      pendingLaunchFiles = files;
      const note = $("#launch-note");
      if (note && files.length) {
        const names = files.map((f) => f.name).join(", ");
        note.textContent = `→ ${names} ready — pick a tool and it'll be loaded in.`;
        note.hidden = false;
      }
      if (tool) openTool(tool);
    },
  };

  // ---------- service worker ----------

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("SW registration failed:", err);
    });
  }
})();
