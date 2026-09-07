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
    queue: [],          // reader document queue: [{ id, file, name }] — in-memory only
    opening: false,     // a document switch is in progress (UI interaction lock)
  };

  // Monotonic token: every open() captures its value; only the newest may commit.
  // Guards viewer state even if overlapping open() calls slip past the UI lock.
  let openGeneration = 0;

  async function destroyDoc(doc) {
    try { await doc?.destroy(); } catch { /* already gone */ }
  }

  const viewEl = () => $("#view-viewer");
  const pagesEl = () => $("#pv-pages");
  const scrollEl = () => $("#pv-scroll");

  // The reader is a full-viewport surface, but it lives inside <main>, whose
  // stacking context (z-index 1) sits below the later .colophon sibling — so
  // page chrome would paint over the fixed reader and steal its clicks. While
  // the reader is active the chrome is hidden entirely ([hidden] is
  // display:none !important in app.css), which also stops it adding body
  // height behind the reader.
  function setPageChromeVisible(visible) {
    document.querySelectorAll(".masthead, .colophon").forEach((el) => {
      el.hidden = !visible;
    });
  }

  // ---------- open / close ----------

  // Returns an explicit result: "success" | "superseded".
  // Throws only on a genuine parse failure for the *current* generation. A stale
  // (superseded) call never throws, never touches active state, and destroys its
  // own candidate document. All candidate parsing/measuring happens on a local
  // `doc` — the previous document is torn down only inside the synchronous commit
  // block, so exactly the newest generation ever mutates viewer state.
  async function open(file) {
    const gen = ++openGeneration;
    let doc, vp;
    try {
      const buf = await file.arrayBuffer();
      if (gen !== openGeneration) return "superseded";        // stale before parse
      doc = await pdfjsLib.getDocument({ data: buf }).promise;
      if (gen !== openGeneration) { await destroyDoc(doc); return "superseded"; }
      const p1 = await doc.getPage(1);                        // measure the candidate, not state.doc
      vp = p1.getViewport({ scale: 1 });
    } catch (err) {
      if (gen !== openGeneration) { await destroyDoc(doc); return "superseded"; }
      throw err;                                              // real parse failure, current generation
    }
    if (gen !== openGeneration) { await destroyDoc(doc); return "superseded"; }

    // ---- commit (synchronous: nothing may interleave until state is consistent) ----
    closeDoc();                         // destroy the previous active document exactly once
    state.file = file;
    state.doc = doc;
    state.pageCount = doc.numPages;
    state.currentPage = 1;
    state.rotation = 0;
    state.zoomMode = "fit-width";
    state.textCache = null;
    state.matches = [];
    state.matchIdx = -1;
    state.baseDims = { w: vp.width, h: vp.height };
    state.pageDims = new Array(state.pageCount).fill(null);
    state.pageDims[0] = { w: vp.width, h: vp.height };

    $("#view-home").hidden = true;
    $("#view-tool").hidden = true;
    setPageChromeVisible(false);
    viewEl().hidden = false;
    $("#pv-title").textContent = file.name;
    $("#pv-count").textContent = String(state.pageCount);
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
    synchroniseCurrentPage(1); // page-1 field + highlight + aria via the single owner
    return "success";
  }

  function closeDoc() {
    state.observer?.disconnect();
    state.thumbObserver?.disconnect();
    state.rendering.clear();   // drop in-flight render bookkeeping so a stale page render can't block the new document
    state.doc?.destroy();
    state.doc = null;
    pagesEl().innerHTML = "";
    $("#pv-thumbs").innerHTML = "";
    $("#pv-outline").innerHTML = "";
  }

  function exit() {
    setPageChromeVisible(true); // restore chrome first — later teardown must not leave it hidden
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

  // Single owner of current-page presentation: state.currentPage, the
  // page-number field, and the thumbnail highlight + aria-current. It never
  // scrolls the PDF viewport and never touches document/dirty state. Safe
  // before thumbnails exist and while the sidebar is closed or inert.
  function synchroniseCurrentPage(pageNumber) {
    const n = Math.min(state.pageCount || 1, Math.max(1, pageNumber | 0));
    state.currentPage = n;
    // Don't stomp the value while the user is actively editing the field;
    // the field's own commit/blur handlers reconcile it to state afterwards.
    const input = $("#pv-pageno");
    if (input && document.activeElement !== input) input.value = String(n);

    const thumbs = $("#pv-thumbs");
    if (!thumbs) return; // thumbnails not built yet — nothing more to do
    thumbs.querySelectorAll(".pv-thumb.current").forEach((t) => {
      t.classList.remove("current");
      t.removeAttribute("aria-current");
    });
    const cur = thumbs.querySelector(`.pv-thumb[data-page="${n}"]`);
    if (cur) {
      cur.classList.add("current");
      cur.setAttribute("aria-current", "page");
      // Bring it into view inside the thumbnail rail only, never the PDF
      // viewport, and only when the rail is actually visible.
      if (thumbs.offsetParent !== null) {
        const tr = cur.getBoundingClientRect(), cr = thumbs.getBoundingClientRect();
        if (tr.top < cr.top || tr.bottom > cr.bottom) cur.scrollIntoView({ block: "nearest" });
      }
    }
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
    // Guarded: after an explicit nav, scrollToPage already set currentPage, so
    // a settling scroll event sees best === currentPage and does nothing — no
    // flicker. Ordinary scrolling changes best and updates through the helper.
    if (best !== state.currentPage) synchroniseCurrentPage(best);
  }

  function scrollToPage(n) {
    n = Math.min(state.pageCount, Math.max(1, n));
    const shell = document.querySelector(`#pv-pages .pv-page[data-page="${n}"]`);
    if (shell) {
      scrollEl().scrollTo({ top: shell.offsetTop - 12, behavior: "auto" });
      synchroniseCurrentPage(n);
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
      // No initial .current here — synchroniseCurrentPage owns the highlight.
      t.className = "pv-thumb";
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
      enqueueForReading(e.target.files); // single or multiple -> shared reading intake
      e.target.value = "";               // reset so re-picking the same file fires change again
    });

    // Queue toolbar button + panel
    $("#pv-queue-btn").addEventListener("click", () => (queueOpen ? closeQueuePanel(true) : openQueuePanel()));
    $("#pv-queue-panel").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeQueuePanel(true); }
    });

    // Page-number field: a text input (type=number exposes no selection API in
    // Chromium/Edge). Enter and blur both commit through one shared function;
    // Escape cancels. Per-session flags (local to this interaction) ensure a
    // value commits at most once and a cancelled value never commits.
    const pageInput = $("#pv-pageno");
    let editing = false, committed = false, cancelled = false;

    // The single entry point that turns field text into navigation. It never
    // writes current-page state itself — scrollToPage -> synchroniseCurrentPage
    // remains the only owner — and always leaves the field showing the
    // canonical clamped page.
    function commitPageInput() {
      const n = parseInt(pageInput.value.trim(), 10); // parseInt-style: "3.8"->3, " 4 "->4
      if (isNaN(n)) {
        pageInput.value = String(state.currentPage);  // empty / whitespace / non-numeric
      } else {
        scrollToPage(n);                              // clamps 0/-5/9999 via synchronise
        pageInput.value = String(state.currentPage);  // canonical page after clamp
      }
    }

    pageInput.addEventListener("focus", () => {
      // First focus of a session selects all so typing replaces the value; the
      // flag stops re-selecting on later clicks so the caret can be placed.
      if (!editing) {
        editing = true; committed = false; cancelled = false;
        pageInput.select();
      }
    });
    pageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        commitPageInput();
        committed = true;   // the following blur must not commit again
        pageInput.blur();
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        cancelled = true;   // the following blur must not commit the discarded text
        pageInput.value = String(state.currentPage); // restore, no navigation
        pageInput.blur();
      }
    });
    pageInput.addEventListener("blur", () => {
      if (!cancelled && !committed) commitPageInput(); // commit valid / restore invalid, once
      else if (cancelled) pageInput.value = String(state.currentPage);
      editing = false; committed = false; cancelled = false; // reset for next session
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

    // Reader card on home — same multi-file picker as Open
    $("#reader-open").addEventListener("click", () => $("#pv-file").click());

    // Home drag-and-drop: PDF-only reading intake. Only active on the home view,
    // never over the reader or a specialist-tool view, and never touches the
    // existing per-tool dropzone or image-tool intake.
    const home = $("#view-home");
    if (home) {
      const homeActive = () => !home.hidden;
      const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
      let dragDepth = 0;
      const clearDrag = () => { dragDepth = 0; home.classList.remove("drag-over"); };
      home.addEventListener("dragenter", (e) => {
        if (!homeActive() || !hasFiles(e)) return;
        e.preventDefault(); dragDepth++; home.classList.add("drag-over");
      });
      home.addEventListener("dragover", (e) => {
        if (!homeActive() || !hasFiles(e)) return;
        e.preventDefault(); e.dataTransfer.dropEffect = "copy"; // stop the browser opening the file
      });
      home.addEventListener("dragleave", () => {
        if (!homeActive()) return;
        if (--dragDepth <= 0) clearDrag();
      });
      home.addEventListener("drop", (e) => {
        if (!homeActive()) return;
        e.preventDefault(); clearDrag();
        enqueueForReading(e.dataTransfer?.files);
      });
    }

    // OS/PWA file handler: first PDF opens in the reader, the rest enter the
    // reader queue (never the tools stash). Images still go to the images tool.
    if ("launchQueue" in window) {
      window.launchQueue.setConsumer(async (params) => {
        if (!params.files?.length) return;
        let files;
        try { files = await Promise.all(params.files.map((h) => h.getFile())); }
        catch (e) { console.warn("Launch files unavailable:", e.message); return; }
        const { pdfs } = classifyPdfs(files);
        const imgs = files.filter((f) => /\.(jpe?g|png)$/i.test(f.name));
        if (pdfs.length) enqueueForReading(pdfs);
        else if (imgs.length) window.__pp?.stashLaunchFiles(imgs, "images");
      });
    }
  }

  // ---------- reader document queue (in-memory, no persistence) ----------
  //
  // A queued entry holds only { id, File, name }. Nothing is parsed, rendered
  // or indexed until it is opened. Queue data is interface state: it never
  // touches document/dirty state, never persists (no localStorage/session/IDB),
  // never leaves the device, and is deliberately NOT in any AI scope — a future
  // AI feature must opt a document in explicitly, not read state.queue.

  let queueSeq = 0;              // stable ids, independent of filename
  let queueOpen = false;

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Accept by MIME when present, else a conservative .pdf filename fallback.
  // Filename is only a routing hint — the real open() path reports parse errors.
  const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");

  function classifyPdfs(fileLike) {
    const pdfs = [], unsupported = [];
    for (const f of (fileLike ? Array.from(fileLike) : [])) (isPdf(f) ? pdfs : unsupported).push(f);
    return { pdfs, unsupported };
  }

  // Transient local message: reader status while reading, home banner otherwise.
  function announce(msg) {
    if (!viewEl().hidden) {
      const s = $("#pv-status");
      if (s) { s.textContent = msg; if (msg) setTimeout(() => { if (s.textContent === msg) s.textContent = ""; }, 4000); }
    } else {
      const note = $("#launch-note");
      if (note) { note.textContent = msg; note.hidden = !msg; }
    }
  }

  // The single reading-intake path — home drop, hero/Open picker, OS launchQueue.
  // Opens the first PDF only when nothing is active; otherwise appends every
  // accepted PDF to the queue. Accepted reading PDFs are never sent to the
  // specialist-tools stash. Input order preserved; source collection not mutated.
  function enqueueForReading(fileLike) {
    const { pdfs, unsupported } = classifyPdfs(fileLike);
    if (!pdfs.length) {
      announce(unsupported.length ? "That isn't a PDF — nothing was added." : "");
      return;
    }
    const active = !viewEl().hidden && !!state.file;
    // If a document is active OR a switch/initial-open is already pending, every
    // accepted PDF is simply queued — we never start a second competing open.
    if (active || state.opening) {
      pdfs.forEach((f) => state.queue.push({ id: ++queueSeq, file: f, name: f.name }));
      renderQueue();
    } else {
      const [first, ...rest] = pdfs;
      rest.forEach((f) => state.queue.push({ id: ++queueSeq, file: f, name: f.name }));
      state.opening = true;
      renderQueue();                       // reflect busy state immediately
      open(first)
        .catch((err) => announce("Couldn't open “" + first.name + "”. " + err.message)) // failure: rest stay queued
        .finally(() => { state.opening = false; renderQueue(); });
    }
    if (unsupported.length) {
      announce(`Skipped ${unsupported.length} non-PDF file${unsupported.length === 1 ? "" : "s"}.`);
    }
  }

  function mkQueueBtn(label, title, fn) {
    const b = document.createElement("button");
    b.className = "pv-qbtn";
    b.textContent = label;
    b.title = title; b.setAttribute("aria-label", title);
    b.addEventListener("click", fn);
    return b;
  }

  // focusHint: { id, action } re-focuses that row's control after a re-render.
  function renderQueue(focusHint) {
    const n = state.queue.length;
    const busy = state.opening; // a switch/open is pending: lock all queue mutation controls
    const btn = $("#pv-queue-btn"), count = $("#pv-queue-count"), list = $("#pv-queue-list"), panel = $("#pv-queue-panel");
    if (count) count.textContent = String(n);
    if (btn) btn.disabled = n === 0 && !busy;      // keep the panel reachable while busy shows progress
    if (panel) panel.setAttribute("aria-busy", busy ? "true" : "false");
    if (n === 0 && queueOpen && !busy) { closeQueuePanel(false); }
    if (!list) return;
    list.innerHTML = "";
    state.queue.forEach((item, i) => {
      const row = document.createElement("li");
      row.className = "pv-queue-row" + (busy ? " busy" : "");
      row.dataset.id = String(item.id);
      const name = document.createElement("span");
      name.className = "pv-queue-name";
      name.textContent = item.name; name.title = item.name;
      const openB = mkQueueBtn("Open", "Open in the reader", () => openFromQueue(item.id));
      openB.classList.add("pv-qbtn-open"); openB.dataset.action = "open";
      const up = mkQueueBtn("↑", "Move up", () => moveInQueue(item.id, -1)); up.dataset.action = "up";
      const down = mkQueueBtn("↓", "Move down", () => moveInQueue(item.id, +1)); down.dataset.action = "down";
      const rm = mkQueueBtn("✕", "Remove from queue", () => removeFromQueue(item.id)); rm.dataset.action = "remove";
      // While switching, every mutation control is disabled (lock); otherwise
      // only the boundary move buttons are.
      openB.disabled = busy;
      up.disabled = busy || i === 0;
      down.disabled = busy || i === state.queue.length - 1;
      rm.disabled = busy;
      row.append(name, openB, up, down, rm);
      list.append(row);
    });
    if (focusHint) {
      const row = list.querySelector(`.pv-queue-row[data-id="${focusHint.id}"]`);
      let target = row && row.querySelector(`[data-action="${focusHint.action}"]:not(:disabled)`);
      if (!target) target = list.querySelector('[data-action="open"]') || btn;
      target && target.focus();
    }
  }

  // Atomic rotating swap. The interaction lock rejects a second concurrent
  // switch (double-click / two rows); the generation token inside open() is the
  // deeper guard. Nothing in the queue is removed or replaced until open()
  // reports "success", and the item is re-resolved by stable id AFTER the await
  // (never via an index captured before it).
  async function openFromQueue(id) {
    if (state.opening) return "busy";                 // a switch is already pending
    const exists = state.queue.some((q) => q.id === id);
    if (!exists) return "gone";
    const prev = state.file;
    const prevName = prev ? prev.name : null;
    state.opening = true;
    renderQueue();                                    // lock controls + aria-busy
    let result = "failed";
    try {
      const item = state.queue.find((q) => q.id === id);
      result = await open(item.file);                 // "success" | "superseded" | (throws on real failure)
      if (result === "success") {
        const idx = state.queue.findIndex((q) => q.id === id); // re-resolve post-await
        if (idx !== -1) {
          state.queue.splice(idx, 1);                 // remove the now-active item
          if (prev) state.queue.splice(idx, 0, { id: ++queueSeq, file: prev, name: prevName }); // prev into vacated slot
        }
      }
      // "superseded" -> no queue mutation at all
    } catch (err) {
      announce("Couldn't open “" + (state.queue.find((q) => q.id === id)?.name || "document") + "”. " + err.message);
      result = "failed";
    } finally {
      state.opening = false;                          // clear the lock (this op owns it)
      renderQueue();                                  // re-enable controls, aria-busy false
    }
    if (result === "success") closeQueuePanel(true);  // otherwise keep the panel open for retry
    return result;
  }

  function removeFromQueue(id) {
    if (state.opening) return;                          // locked during a switch
    const idx = state.queue.findIndex((q) => q.id === id);
    if (idx === -1) return;
    state.queue.splice(idx, 1); // drops the in-memory reference only; source file untouched
    // keep focus predictable: the row that shifted into this slot, else the button
    const nextId = state.queue[idx]?.id ?? state.queue[idx - 1]?.id;
    renderQueue(nextId != null ? { id: nextId, action: "open" } : undefined);
    if (state.queue.length === 0) $("#pv-queue-btn").focus();
  }

  function moveInQueue(id, delta) {
    if (state.opening) return;                          // locked during a switch
    const idx = state.queue.findIndex((q) => q.id === id);
    const to = idx + delta;
    if (idx === -1 || to < 0 || to >= state.queue.length) return;
    const [item] = state.queue.splice(idx, 1);
    state.queue.splice(to, 0, item);
    renderQueue({ id, action: delta < 0 ? "up" : "down" });
  }

  // ---------- queue panel open/close ----------

  function openQueuePanel() {
    if ($("#pv-queue-btn").disabled) return;
    queueOpen = true;
    const p = $("#pv-queue-panel");
    p.hidden = false; p.inert = false;
    $("#pv-queue-btn").setAttribute("aria-expanded", "true");
    const first = p.querySelector("button:not(:disabled)") || $("#pv-queue-btn");
    first.focus();
    document.addEventListener("pointerdown", onQueueOutside, true);
  }
  function closeQueuePanel(refocus) {
    if (!queueOpen) { if (refocus) $("#pv-queue-btn").focus(); return; }
    queueOpen = false;
    const p = $("#pv-queue-panel");
    p.hidden = true; p.inert = true;
    $("#pv-queue-btn").setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onQueueOutside, true);
    if (refocus) $("#pv-queue-btn").focus();
  }
  function onQueueOutside(e) {
    const p = $("#pv-queue-panel"), b = $("#pv-queue-btn");
    if (!p.contains(e.target) && e.target !== b) closeQueuePanel(false);
  }

  wire();
  window.__viewer = {
    open, exit, enqueueForReading, openFromQueue, removeFromQueue, moveInQueue,
    _queue: () => state.queue,           // test-only inspection (references, not bytes)
    _reset: () => { state.queue.splice(0); renderQueue(); }, // test-only: clear + re-render
    _activeFile: () => state.file, _activeDoc: () => state.doc, // test-only inspection
    _openPanel: openQueuePanel, _closePanel: closeQueuePanel,
  };
})();
