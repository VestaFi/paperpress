/* PaperPress Reader — continuous-scroll PDF viewer built on pdf.js. */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const state = {
    doc: null,          // pdf.js document
    file: null,         // original File
    pageCount: 0,
    zoomMode: "fit-width", // "fit-width" | "fit-page" | number (percent)
    rotation: 0,        // extra viewer rotation
    currentPage: 1,
    baseDims: null,     // {w,h} of page 1 at scale 1
    pageDims: [],       // per-page dims at scale 1 (filled lazily)
    textCache: null,    // per-page plain text for search
    matches: [],
    matchIdx: -1,
    observer: null,
    thumbObserver: null,
    rendering: new Set(),
  };

  const viewEl = () => $("#view-viewer");
  const pagesEl = () => $("#pv-pages");
  const scrollEl = () => $("#pv-scroll");

  // ---------- open / close ----------

  async function open(file) {
    closeDoc();
    state.file = file;
    const buf = await file.arrayBuffer();
    state.doc = await pdfjsLib.getDocument({ data: buf }).promise;
    state.pageCount = state.doc.numPages;
    state.currentPage = 1;
    state.rotation = 0;
    state.zoomMode = "fit-width";
    state.textCache = null;
    state.matches = [];
    state.matchIdx = -1;

    const p1 = await state.doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    state.baseDims = { w: vp.width, h: vp.height };
    state.pageDims = new Array(state.pageCount).fill(null);
    state.pageDims[0] = { w: vp.width, h: vp.height };

    $("#view-home").hidden = true;
    $("#view-tool").hidden = true;
    viewEl().hidden = false;
    $("#pv-title").textContent = file.name;
    $("#pv-count").textContent = String(state.pageCount);
    $("#pv-pageno").value = "1";
    $("#pv-search").value = "";
    $("#pv-search-results").innerHTML = "";
    $("#pv-match-count").textContent = "";
    setSidebarTab("thumbs");
    setSidebar(false); // §3.1: left sidebar closed whenever a document opens

    buildShells();
    buildThumbs();
    buildOutline();
    updateZoomLabel();
    scrollEl().scrollTop = 0;
  }

  function closeDoc() {
    state.observer?.disconnect();
    state.thumbObserver?.disconnect();
    state.doc?.destroy();
    state.doc = null;
    pagesEl().innerHTML = "";
    $("#pv-thumbs").innerHTML = "";
    $("#pv-outline").innerHTML = "";
  }

  function exit() {
    closeDoc();
    viewEl().hidden = true;
    $("#view-home").hidden = false;
  }

  // ---------- geometry ----------

  function dimsFor(i) { return state.pageDims[i] || state.baseDims; }

  function currentScale(i) {
    const d = dimsFor(i);
    const rot = state.rotation % 180 !== 0;
    const w = rot ? d.h : d.w;
    const h = rot ? d.w : d.h;
    const avail = scrollEl().clientWidth - ($("#pv-sidebar").classList.contains("open") ? 0 : 0) - 48;
    if (state.zoomMode === "fit-width") return Math.max(0.1, avail / w);
    if (state.zoomMode === "fit-page") {
      const availH = scrollEl().clientHeight - 32;
      return Math.max(0.1, Math.min(avail / w, availH / h));
    }
    return state.zoomMode / 100;
  }

  // ---------- page shells + lazy render ----------

  function buildShells() {
    const c = pagesEl();
    c.innerHTML = "";
    state.observer?.disconnect();
    state.observer = new IntersectionObserver(onIntersect, {
      root: scrollEl(),
      rootMargin: "900px 0px",
    });
    for (let i = 1; i <= state.pageCount; i++) {
      const shell = document.createElement("div");
      shell.className = "pv-page";
      shell.dataset.page = String(i);
      sizeShell(shell, i);
      c.append(shell);
      state.observer.observe(shell);
    }
    scrollEl().addEventListener("scroll", trackCurrentPage, { passive: true });
  }

  function sizeShell(shell, i) {
    const d = dimsFor(i - 1);
    const s = currentScale(i - 1);
    const rot = state.rotation % 180 !== 0;
    shell.style.width = Math.floor((rot ? d.h : d.w) * s) + "px";
    shell.style.height = Math.floor((rot ? d.w : d.h) * s) + "px";
  }

  function onIntersect(entries) {
    for (const e of entries) {
      const shell = e.target;
      const i = parseInt(shell.dataset.page, 10);
      if (e.isIntersecting) renderInto(shell, i);
      else unrender(shell);
    }
  }

  async function renderInto(shell, i) {
    if (shell.dataset.rendered === "1" || state.rendering.has(i) || !state.doc) return;
    state.rendering.add(i);
    try {
      const page = await state.doc.getPage(i);
      if (!state.pageDims[i - 1]) {
        const vp1 = page.getViewport({ scale: 1 });
        state.pageDims[i - 1] = { w: vp1.width, h: vp1.height };
        sizeShell(shell, i);
      }
      const scale = currentScale(i - 1);
      const rotation = (page.rotate + state.rotation) % 360;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: scale * dpr, rotation });
      const cssVp = page.getViewport({ scale, rotation });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      canvas.style.width = Math.floor(cssVp.width) + "px";
      canvas.style.height = Math.floor(cssVp.height) + "px";
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;

      // text layer for selection
      const tl = document.createElement("div");
      tl.className = "textLayer";
      tl.style.setProperty("--scale-factor", String(cssVp.scale));
      try {
        await pdfjsLib.renderTextLayer({
          textContentSource: await page.getTextContent(),
          container: tl,
          viewport: cssVp,
          textDivs: [],
        }).promise;
      } catch { /* selection unavailable — canvas still shows */ }

      if (shell.dataset.rendered === "1") return;
      shell.innerHTML = "";
      shell.append(canvas, tl);
      shell.dataset.rendered = "1";
    } catch (e) {
      console.warn(`Page ${i} render failed:`, e.message);
    } finally {
      state.rendering.delete(i);
    }
  }

  function unrender(shell) {
    if (shell.dataset.rendered !== "1") return;
    shell.innerHTML = "";
    shell.dataset.rendered = "0";
  }

  function rerenderAll() {
    document.querySelectorAll("#pv-pages .pv-page").forEach((shell) => {
      unrender(shell);
      sizeShell(shell, parseInt(shell.dataset.page, 10));
    });
    // observer re-fires for visible shells on size change; nudge it
    requestAnimationFrame(() => {
      document.querySelectorAll("#pv-pages .pv-page").forEach((shell) => {
        const r = shell.getBoundingClientRect();
        const sr = scrollEl().getBoundingClientRect();
        if (r.bottom > sr.top - 900 && r.top < sr.bottom + 900) {
          renderInto(shell, parseInt(shell.dataset.page, 10));
        }
      });
    });
  }

  function trackCurrentPage() {
    const sr = scrollEl().getBoundingClientRect();
    const mid = sr.top + sr.height * 0.4;
    let best = 1, bestDist = Infinity;
    document.querySelectorAll("#pv-pages .pv-page").forEach((shell) => {
      const r = shell.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestDist) { bestDist = d; best = parseInt(shell.dataset.page, 10); }
    });
    if (best !== state.currentPage) {
      state.currentPage = best;
      $("#pv-pageno").value = String(best);
      const t = document.querySelector(`#pv-thumbs .pv-thumb.current`);
      t?.classList.remove("current");
      document.querySelector(`#pv-thumbs .pv-thumb[data-page="${best}"]`)?.classList.add("current");
    }
  }

  function scrollToPage(n) {
    n = Math.min(state.pageCount, Math.max(1, n));
    const shell = document.querySelector(`#pv-pages .pv-page[data-page="${n}"]`);
    if (shell) {
      scrollEl().scrollTo({ top: shell.offsetTop - 12, behavior: "auto" });
      state.currentPage = n;
      $("#pv-pageno").value = String(n);
    }
  }

  // ---------- zoom / rotate ----------

  const ZOOM_STEPS = [50, 67, 80, 100, 125, 150, 200, 300, 400];

  function currentPercent() {
    if (typeof state.zoomMode === "number") return state.zoomMode;
    return Math.round(currentScale(state.currentPage - 1) * 100);
  }

  function zoomStep(dir) {
    const cur = currentPercent();
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((z) => z > cur + 1) || 400;
    else next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 1) || 25;
    state.zoomMode = next;
    $("#pv-zoom-sel").value = "custom";
    updateZoomLabel();
    rerenderAll();
  }

  function updateZoomLabel() {
    const sel = $("#pv-zoom-sel");
    if (state.zoomMode === "fit-width" || state.zoomMode === "fit-page") sel.value = state.zoomMode;
    const custom = sel.querySelector('option[value="custom"]');
    custom.textContent = currentPercent() + "%";
    if (typeof state.zoomMode === "number") sel.value = "custom";
  }

  // ---------- thumbnails ----------

  function buildThumbs() {
    const c = $("#pv-thumbs");
    c.innerHTML = "";
    state.thumbObserver?.disconnect();
    state.thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) renderThumb(e.target);
      }
    }, { root: c, rootMargin: "400px 0px" });

    for (let i = 1; i <= state.pageCount; i++) {
      const t = document.createElement("button");
      t.className = "pv-thumb" + (i === 1 ? " current" : "");
      t.dataset.page = String(i);
      t.innerHTML = `<span class="pv-thumb-box"></span><span class="pv-thumb-no">${i}</span>`;
      t.addEventListener("click", () => scrollToPage(i));
      c.append(t);
      state.thumbObserver.observe(t);
    }
  }

  async function renderThumb(t) {
    if (t.dataset.done === "1" || !state.doc) return;
    t.dataset.done = "1";
    try {
      const i = parseInt(t.dataset.page, 10);
      const page = await state.doc.getPage(i);
      const vp = page.getViewport({ scale: 0.22 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
      t.querySelector(".pv-thumb-box").innerHTML = "";
      t.querySelector(".pv-thumb-box").append(canvas);
    } catch { t.dataset.done = "0"; }
  }

  // ---------- outline ----------

  async function buildOutline() {
    const c = $("#pv-outline");
    c.innerHTML = "";
    let outline = null;
    try { outline = await state.doc.getOutline(); } catch {}
    if (!outline || !outline.length) {
      c.innerHTML = `<p class="pv-empty">No bookmarks in this document.</p>`;
      return;
    }
    const addItems = (items, depth) => {
      for (const item of items) {
        const b = document.createElement("button");
        b.className = "pv-outline-item";
        b.style.paddingLeft = 10 + depth * 16 + "px";
        b.textContent = item.title || "(untitled)";
        b.addEventListener("click", async () => {
          try {
            let dest = item.dest;
            if (typeof dest === "string") dest = await state.doc.getDestination(dest);
            if (Array.isArray(dest) && dest[0]) {
              const idx = await state.doc.getPageIndex(dest[0]);
              scrollToPage(idx + 1);
            }
          } catch (e) { console.warn("Outline jump failed:", e.message); }
        });
        c.append(b);
        if (item.items?.length) addItems(item.items, depth + 1);
      }
    };
    addItems(outline, 0);
  }

  // ---------- search ----------

  async function ensureTextCache(progress) {
    if (state.textCache) return;
    state.textCache = [];
    for (let i = 1; i <= state.pageCount; i++) {
      progress?.(`Indexing ${i}/${state.pageCount}…`);
      const page = await state.doc.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) text += item.str + (item.hasEOL ? "\n" : " ");
      state.textCache.push(text);
    }
  }

  async function doSearch(q) {
    const results = $("#pv-search-results");
    const countEl = $("#pv-match-count");
    results.innerHTML = "";
    state.matches = [];
    state.matchIdx = -1;
    if (!q.trim()) { countEl.textContent = ""; return; }
    setSidebarTab("search");
    countEl.textContent = "…";
    await ensureTextCache((msg) => { countEl.textContent = msg; });
    const needle = q.toLowerCase();
    state.textCache.forEach((text, pi) => {
      const hay = text.toLowerCase();
      let at = 0;
      while ((at = hay.indexOf(needle, at)) !== -1) {
        state.matches.push({ page: pi + 1, at, snippet: snippet(text, at, q.length) });
        at += needle.length;
        if (state.matches.length > 500) return;
      }
    });
    countEl.textContent = state.matches.length
      ? `${state.matches.length} match${state.matches.length === 1 ? "" : "es"}`
      : "No matches";
    state.matches.forEach((m, idx) => {
      const b = document.createElement("button");
      b.className = "pv-result";
      b.innerHTML = `<span class="pv-result-pg">p.${m.page}</span> ${m.snippet}`;
      b.addEventListener("click", () => { state.matchIdx = idx; gotoMatch(); });
      results.append(b);
    });
    if (state.matches.length) { state.matchIdx = 0; gotoMatch(); }
  }

  function snippet(text, at, len) {
    const start = Math.max(0, at - 30);
    const end = Math.min(text.length, at + len + 30);
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return (start > 0 ? "…" : "") + esc(text.slice(start, at)) +
      "<mark>" + esc(text.slice(at, at + len)) + "</mark>" +
      esc(text.slice(at + len, end)) + (end < text.length ? "…" : "");
  }

  function gotoMatch() {
    if (state.matchIdx < 0 || !state.matches.length) return;
    const m = state.matches[state.matchIdx];
    scrollToPage(m.page);
    document.querySelectorAll("#pv-search-results .pv-result").forEach((el, i) =>
      el.classList.toggle("on", i === state.matchIdx));
    $("#pv-match-count").textContent = `${state.matchIdx + 1} / ${state.matches.length}`;
  }

  function nextMatch(dir) {
    if (!state.matches.length) return;
    state.matchIdx = (state.matchIdx + dir + state.matches.length) % state.matches.length;
    gotoMatch();
  }

  // ---------- print ----------

  async function printDoc() {
    if (!state.doc) return;
    if (state.pageCount > 300 && !confirm(`This document has ${state.pageCount} pages — printing may take a while. Continue?`)) return;
    const area = $("#pv-print-area");
    area.innerHTML = "";
    const status = $("#pv-status");
    try {
      for (let i = 1; i <= state.pageCount; i++) {
        status.textContent = `Preparing print ${i}/${state.pageCount}…`;
        const page = await state.doc.getPage(i);
        const vp = page.getViewport({ scale: 150 / 72 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
        const img = document.createElement("img");
        img.src = canvas.toDataURL("image/jpeg", 0.92);
        area.append(img);
        canvas.width = 0; canvas.height = 0;
      }
      status.textContent = "";
      window.print();
    } catch (e) {
      status.textContent = "Print failed: " + e.message;
    } finally {
      setTimeout(() => { area.innerHTML = ""; }, 1000);
    }
  }

  // ---------- sidebar ----------

  // Single writer for sidebar open state: CSS class, aria-expanded and focus
  // protection stay in sync. `inert` (not CSS visibility alone) carries the
  // focus/accessibility guarantee — it applies instantly and doesn't depend
  // on the width transition running.
  function setSidebar(openState) {
    const sb = $("#pv-sidebar");
    sb.classList.toggle("open", openState);
    sb.inert = !openState;
    $("#pv-sidebar-toggle").setAttribute("aria-expanded", String(openState));
  }

  function sidebarIsOpen() {
    return $("#pv-sidebar").classList.contains("open");
  }

  function setSidebarTab(tab) {
    document.querySelectorAll(".pv-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $("#pv-thumbs").hidden = tab !== "thumbs";
    $("#pv-outline").hidden = tab !== "outline";
    $("#pv-search-panel").hidden = tab !== "search";
  }

  // ---------- wiring ----------

  function wire() {
    $("#pv-exit").addEventListener("click", exit);

    $("#pv-open").addEventListener("click", () => $("#pv-file").click());
    $("#pv-file").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) open(f).catch((err) => alert("Couldn't open PDF: " + err.message));
      e.target.value = "";
    });

    $("#pv-pageno").addEventListener("change", (e) => {
      const n = parseInt(e.target.value, 10);
      if (!isNaN(n)) scrollToPage(n);
    });
    $("#pv-prev").addEventListener("click", () => scrollToPage(state.currentPage - 1));
    $("#pv-next").addEventListener("click", () => scrollToPage(state.currentPage + 1));

    $("#pv-zoom-out").addEventListener("click", () => zoomStep(-1));
    $("#pv-zoom-in").addEventListener("click", () => zoomStep(1));
    $("#pv-zoom-sel").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v === "fit-width" || v === "fit-page") state.zoomMode = v;
      else if (v !== "custom") state.zoomMode = parseInt(v, 10);
      updateZoomLabel();
      rerenderAll();
    });

    $("#pv-rotate").addEventListener("click", () => {
      state.rotation = (state.rotation + 90) % 360;
      rerenderAll();
    });

    $("#pv-sidebar-toggle").addEventListener("click", () => {
      setSidebar(!sidebarIsOpen());
      rerenderAll();
    });
    document.querySelectorAll(".pv-tab").forEach((b) =>
      b.addEventListener("click", () => setSidebarTab(b.dataset.tab)));

    let searchTimer;
    $("#pv-search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => doSearch(e.target.value), 350);
    });
    $("#pv-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); nextMatch(e.shiftKey ? -1 : 1); }
    });
    $("#pv-match-prev").addEventListener("click", () => nextMatch(-1));
    $("#pv-match-next").addEventListener("click", () => nextMatch(1));

    $("#pv-print").addEventListener("click", printDoc);

    $("#pv-download").addEventListener("click", () => {
      if (!state.file) return;
      const url = URL.createObjectURL(state.file);
      const a = document.createElement("a");
      a.href = url;
      a.download = state.file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });

    $("#pv-edit").addEventListener("click", () => {
      if (!state.file) return;
      const f = state.file;
      exit();
      window.__pp?.stashLaunchFiles([f]);
    });

    window.addEventListener("resize", () => {
      if (!viewEl().hidden && (state.zoomMode === "fit-width" || state.zoomMode === "fit-page")) rerenderAll();
    });

    document.addEventListener("keydown", (e) => {
      if (viewEl().hidden) return;
      const tag = document.activeElement?.tagName;
      const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSidebarTab("search");
        setSidebar(true);
        $("#pv-search").focus();
        return;
      }
      if (typing) return;
      switch (e.key) {
        case "ArrowLeft": case "PageUp": e.preventDefault(); scrollToPage(state.currentPage - 1); break;
        case "ArrowRight": case "PageDown": e.preventDefault(); scrollToPage(state.currentPage + 1); break;
        case "Home": e.preventDefault(); scrollToPage(1); break;
        case "End": e.preventDefault(); scrollToPage(state.pageCount); break;
        case "+": case "=": zoomStep(1); break;
        case "-": zoomStep(-1); break;
      }
    });

    // Reader card on home
    $("#reader-open").addEventListener("click", () => $("#pv-file").click());

    // OS file handler: PDFs open in the reader by default, images go to the images tool
    if ("launchQueue" in window) {
      window.launchQueue.setConsumer(async (params) => {
        if (!params.files?.length) return;
        let files;
        try { files = await Promise.all(params.files.map((h) => h.getFile())); }
        catch (e) { console.warn("Launch files unavailable:", e.message); return; }
        const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
        const imgs = files.filter((f) => /\.(jpe?g|png)$/i.test(f.name));
        if (pdfs.length) {
          open(pdfs[0]).catch((err) => alert("Couldn't open PDF: " + err.message));
          if (pdfs.length > 1) stashExtraPdfs(pdfs[0].name, pdfs.slice(1));
        } else if (imgs.length) {
          window.__pp?.stashLaunchFiles(imgs, "images");
        }
      });
    }
  }

  // Multi-PDF launch (no tabs): first file opens in the reader, the rest wait
  // in the tools stash. The home banner says so honestly.
  function stashExtraPdfs(openedName, extras) {
    window.__pp?.stashLaunchFiles(extras);
    const note = document.querySelector("#launch-note");
    if (note) {
      const n = extras.length;
      note.textContent = `→ Opened "${openedName}" in the reader. ${n} more PDF${n === 1 ? "" : "s"} waiting below — pick a tool and ${n === 1 ? "it'll" : "they'll"} be loaded in.`;
      note.hidden = false;
    }
  }

  wire();
  window.__viewer = { open, exit, stashExtraPdfs };
})();
