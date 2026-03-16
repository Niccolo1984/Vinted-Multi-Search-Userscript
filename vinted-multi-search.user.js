// ==UserScript==
// @name         Vinted Multi-Search
// @namespace    https://github.com/Niccolo1984/Vinted-Multi-Search-Userscript/raw/refs/heads/main/vinted-multi-search.user.js
// @version      1.2.0
// @description  Find Vinted sellers who have two specific items at once.
// @author       twoj-nick
// @match        *://*.vinted.pl/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/Niccolo1984/Vinted-Multi-Search-Userscript/raw/refs/heads/main/vinted-multi-search.user.js
// @downloadURL  https://github.com/Niccolo1984/Vinted-Multi-Search-Userscript/raw/refs/heads/main/vinted-multi-search.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ─── WYKRYWANIE PLATFORMY ──────────────────────────────────────────────────
  const IS_MOBILE = /Android|iPhone|iPad/i.test(navigator.userAgent)
    || window.innerWidth < 768;

  // ─── KONFIGURACJA ─────────────────────────────────────────────────────────
  const CONFIG = {
    MAX_UNIQUE_SELLERS:      1000,
    MAX_PAGES_PER_ITEM:      25,
    ITEMS_PER_PAGE:          96,
    DELAY_BETWEEN_PAGES_MIN: 400,
    DELAY_BETWEEN_PAGES_MAX: 700,
    DELAY_BETWEEN_ITEMS_MIN: 3000,
    DELAY_BETWEEN_ITEMS_MAX: 4000,
    SAFETY_PAUSE_EVERY:      5,
    SAFETY_PAUSE_MIN:        4000,
    SAFETY_PAUSE_MAX:        6000,
    RATE_LIMIT_WAIT_MS:      30000,
    MAX_RETRIES:             2,
  };

  // ─── BEZPIECZEŃSTWO ───────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const VINTED_ORIGIN = window.location.origin;
  let isPaused    = false;
  let isCancelled = false;

  // ─── CACHE KATEGORII ──────────────────────────────────────────────────────
  let categoriesCache   = null;
  let categoriesPromise = null;

  async function loadCategories() {
    if (categoriesCache) return categoriesCache;
    if (categoriesPromise) return categoriesPromise;

    categoriesPromise = (async () => {
      try {
        const res = await fetch(`${VINTED_ORIGIN}/api/v2/catalog/initializers?page=catalog`, {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
          },
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        categoriesCache = data?.dtos?.catalogs || [];
      } catch (e) {
        console.warn('[VMS] Nie udało się pobrać kategorii:', e);
        categoriesCache = [];
        // Poinformuj użytkownika
        ['1', '2'].forEach(n => {
          const btn = document.getElementById(`vms-catbtn${n}`);
          if (btn) { btn.textContent = 'Kategorie niedostępne'; btn.disabled = true; }
        });
      }
      return categoriesCache;
    })();

    return categoriesPromise;
  }

  function flattenCategories(cats, level = 0, result = []) {
    for (const cat of cats) {
      const hasChildren = cat.catalogs?.length > 0;
      result.push({ id: String(cat.id), title: cat.title, level, hasChildren });
      if (hasChildren) flattenCategories(cat.catalogs, level + 1, result);
    }
    return result;
  }

  // ─── STAN DROPDOWNÓW / DRZEWKA ────────────────────────────────────────────
  let flatCats = [];

  // Desktop: dropdown
  const catState = {
    1: { value: '', open: false, collapsed: new Set() },
    2: { value: '', open: false, collapsed: new Set() },
  };

  // Mobile: drzewko z badge
  const mCatState = {
    1: { value: '', label: '', open: false, collapsed: new Set() },
    2: { value: '', label: '', open: false, collapsed: new Set() },
  };

  // ─── RENDEROWANIE DROPDOWN (DESKTOP) ──────────────────────────────────────
  function renderDropdown(n) {
    const state  = catState[n];
    const drawer = document.getElementById(`vms-catdrawer${n}`);
    const btn    = document.getElementById(`vms-catbtn${n}`);
    if (!drawer || !btn) return;

    const hiddenIds = new Set();
    for (const cat of flatCats) {
      if (cat.hasChildren && state.collapsed.has(cat.id)) {
        let hiding = false;
        for (const c of flatCats) {
          if (c === cat) { hiding = true; continue; }
          if (hiding) {
            if (c.level <= cat.level) break;
            hiddenIds.add(c.id);
          }
        }
      }
    }

    const items = flatCats
      .filter(cat => !hiddenIds.has(cat.id))
      .map(cat => {
        const indent     = cat.level * 16;
        const isSelected = cat.id === state.value;
        const arrow = cat.hasChildren
          ? `<span class="vms-dd-arrow" data-id="${escapeHtml(cat.id)}">${state.collapsed.has(cat.id) ? '▶' : '▼'}</span>`
          : `<span class="vms-dd-arrow vms-dd-arrow--leaf"></span>`;
        return `<div class="vms-dd-item${isSelected ? ' vms-dd-item--selected' : ''}"
                     data-id="${escapeHtml(cat.id)}" data-title="${escapeHtml(cat.title)}" data-level="${cat.level}"
                     style="padding-left:${10 + indent}px">
                  ${arrow}<span class="vms-dd-label">${escapeHtml(cat.title)}</span>
                </div>`;
      }).join('');

    drawer.innerHTML = `<div class="vms-dd-reset" data-action="reset">✕ Wszystkie kategorie</div>${items}`;
    drawer.style.display = state.open ? 'block' : 'none';

    if (state.value) {
      const found = flatCats.find(c => c.id === state.value);
      btn.textContent = found ? `${found.title} ▾` : 'Wszystkie kategorie ▾';
    } else {
      btn.textContent = 'Wszystkie kategorie ▾';
    }
  }

  function initDesktopDropdowns() {
    const panel = document.getElementById('vms-panel');
    if (!panel) return;

    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('.vms-catbtn');
      if (btn) {
        const n = btn.dataset.n;
        const wasOpen = catState[n].open;
        catState[1].open = false;
        catState[2].open = false;
        catState[n].open = !wasOpen;
        renderDropdown(1);
        renderDropdown(2);
        return;
      }

      const arrow = e.target.closest('.vms-dd-arrow:not(.vms-dd-arrow--leaf)');
      if (arrow) {
        const id = arrow.dataset.id;
        const n  = catState[1].open ? '1' : '2';
        if (catState[n].collapsed.has(id)) {
          catState[n].collapsed.delete(id);
          const parent = flatCats.find(c => c.id === id);
          if (parent) {
            let inChildren = false;
            for (const c of flatCats) {
              if (c === parent) { inChildren = true; continue; }
              if (inChildren) {
                if (c.level <= parent.level) break;
                if (c.hasChildren) catState[n].collapsed.add(c.id);
              }
            }
          }
        } else {
          catState[n].collapsed.add(id);
        }
        renderDropdown(n);
        return;
      }

      const reset = e.target.closest('[data-action="reset"]');
      if (reset) {
        const n = catState[1].open ? '1' : '2';
        catState[n].value = '';
        catState[n].open  = false;
        renderDropdown(n);
        return;
      }

      const item = e.target.closest('.vms-dd-item');
      if (item) {
        const n = catState[1].open ? '1' : '2';
        catState[n].value = item.dataset.id;
        catState[n].open  = false;
        renderDropdown(n);
        return;
      }

      catState[1].open = false;
      catState[2].open = false;
      renderDropdown(1);
      renderDropdown(2);
    });
  }

  // ─── RENDEROWANIE DRZEWKA (MOBILE) ────────────────────────────────────────
  function renderMobileTree(n) {
    const state    = mCatState[n];
    const tree     = document.getElementById(`vmsm-cattree${n}`);
    const badge    = document.getElementById(`vmsm-catbadge${n}`);
    const badgeLbl = document.getElementById(`vmsm-catbadgelabel${n}`);
    if (!tree) return;

    const hiddenIds = new Set();
    for (const cat of flatCats) {
      if (cat.hasChildren && state.collapsed.has(cat.id)) {
        let hiding = false;
        for (const c of flatCats) {
          if (c === cat) { hiding = true; continue; }
          if (hiding) {
            if (c.level <= cat.level) break;
            hiddenIds.add(c.id);
          }
        }
      }
    }

    const items = flatCats
      .filter(cat => !hiddenIds.has(cat.id))
      .map(cat => {
        const indent     = cat.level * 20;
        const isSelected = cat.id === state.value;
        const arrow = cat.hasChildren
          ? `<span class="vmsm-tree-arrow" data-id="${escapeHtml(cat.id)}">${state.collapsed.has(cat.id) ? '▶' : '▼'}</span>`
          : `<span class="vmsm-tree-arrow vmsm-tree-arrow--leaf"></span>`;
        return `<div class="vmsm-tree-item${isSelected ? ' vmsm-tree-item--selected' : ''}"
                     data-id="${escapeHtml(cat.id)}" data-title="${escapeHtml(cat.title)}" data-level="${cat.level}"
                     style="padding-left:${12 + indent}px">
                  ${arrow}<span class="vmsm-tree-label">${escapeHtml(cat.title)}</span>
                </div>`;
      }).join('');

    tree.innerHTML = `<div class="vmsm-tree-reset" data-n="${n}">✕ Wszystkie kategorie</div>${items}`;
    tree.style.display = state.open ? 'block' : 'none';

    if (badge && badgeLbl) {
      if (state.value) {
        badgeLbl.textContent = state.label;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  // ─── POPULATE KATEGORII ───────────────────────────────────────────────────
  async function populateCategories() {
    const cats = await loadCategories();
    if (!cats.length) return;

    flatCats = flattenCategories(cats);

    if (IS_MOBILE) {
      [1, 2].forEach(n => {
        flatCats.forEach(c => { if (c.level === 0 && c.hasChildren) mCatState[n].collapsed.add(c.id); });
        renderMobileTree(n);
      });
    } else {
      [1, 2].forEach(n => {
        flatCats.forEach(c => { if (c.level === 0 && c.hasChildren) catState[n].collapsed.add(c.id); });
        renderDropdown(n);
      });
    }
  }

  // ─── UI DESKTOP ───────────────────────────────────────────────────────────
  function injectDesktopUI() {
    if (document.getElementById('vms-panel')) return true;
    const header = document.querySelector('header') || document.body.firstElementChild;
    if (!header || !header.parentNode) return false;

    const panel = document.createElement('div');
    panel.id = 'vms-panel';
    panel.innerHTML = `
      <div class="vms-container">
        <span class="vms-title">
          <span style="font-size:18px;margin-right:4px;color:#676c6f">⌕</span>Szukaj zestawu
        </span>
        <div class="vms-inputs">
          <div class="vms-input-group">
            <input type="text" id="vms-item1" placeholder="Przedmiot A (np. kurtka)" />
            <div class="vms-catpicker">
              <button type="button" id="vms-catbtn1" class="vms-catbtn" data-n="1">Wszystkie kategorie ▾</button>
              <div id="vms-catdrawer1" class="vms-catdrawer" style="display:none"></div>
              <input type="hidden" id="vms-cat1" value="" />
            </div>
          </div>
          <span class="vms-plus">+</span>
          <div class="vms-input-group">
            <input type="text" id="vms-item2" placeholder="Przedmiot B (np. czapka)" />
            <div class="vms-catpicker">
              <button type="button" id="vms-catbtn2" class="vms-catbtn" data-n="2">Wszystkie kategorie ▾</button>
              <div id="vms-catdrawer2" class="vms-catdrawer" style="display:none"></div>
              <input type="hidden" id="vms-cat2" value="" />
            </div>
          </div>
        </div>
        <div class="vms-buttons">
          <button id="vms-search-btn">Znajdź wspólnych sprzedawców</button>
          <button id="vms-pause-btn"  style="display:none">⏸ Pauza</button>
          <button id="vms-cancel-btn" style="display:none">✕ Anuluj</button>
        </div>
        <div id="vms-status"  class="vms-status"  style="display:none"></div>
        <div id="vms-results" class="vms-results" style="display:none"></div>
      </div>
    `;
    header.parentNode.insertBefore(panel, header.nextSibling);

    document.getElementById('vms-search-btn').addEventListener('click', handleSearch);
    document.getElementById('vms-pause-btn').addEventListener('click', handlePause);
    document.getElementById('vms-cancel-btn').addEventListener('click', handleCancel);

    initDesktopDropdowns();
    populateCategories();
    return true;
  }

  // ─── STAN MOBILNY ────────────────────────────────────────────────────────
  // inactive → fab w headerze aktywuje → tab
  // tab      → kliknięcie zakładki otwiera sheet → open
  // open     → ✕ minimalizuje do tab, fab w headerze usuwa zakładkę → inactive
  let mobileState = 'inactive'; // 'inactive' | 'tab' | 'open'

  function setMobileState(state) {
    mobileState = state;
    const fab   = document.getElementById('vmsm-fab');
    const tab   = document.getElementById('vmsm-tab');
    const sheet = document.getElementById('vmsm-sheet');

    if (state === 'inactive') {
      if (tab)   tab.style.display   = 'none';
      if (sheet) sheet.classList.remove('vmsm-sheet--open');
      document.body.style.overflow = '';
    } else if (state === 'tab') {
      if (tab)   tab.style.display   = 'flex';
      if (sheet) sheet.classList.remove('vmsm-sheet--open');
      document.body.style.overflow = '';
    } else if (state === 'open') {
      if (tab)   tab.style.display   = 'none';
      if (sheet) sheet.classList.add('vmsm-sheet--open');
      document.body.style.overflow = 'hidden';
      adjustSheetForKeyboard();
    }
  }

  function adjustSheetForKeyboard() {
    const inner = document.getElementById('vmsm-sheet-inner');
    if (!inner) return;
    const vv = window.visualViewport;
    if (vv) inner.style.height = Math.round(vv.height * 0.85) + 'px';
  }

  function resetMobileSearch() {
    // Wyczyść pola i wyniki, zachowaj kategorie
    const i1 = document.getElementById('vmsm-item1');
    const i2 = document.getElementById('vmsm-item2');
    if (i1) i1.value = '';
    if (i2) i2.value = '';
    const status  = document.getElementById('vmsm-status');
    const results = document.getElementById('vmsm-results');
    if (status)  { status.style.display  = 'none'; status.textContent = ''; }
    if (results) { results.style.display = 'none'; results.innerHTML  = ''; }
    isCancelled = false;
    isPaused    = false;
    setScanningUI(false);
  }

  // ─── ZAKŁADKA (DRAGGABLE TAB) ─────────────────────────────────────────────
  let tabInitialized = false;
  let tabPosY  = null;
  let tabLeft  = false;

  function initTab() {
    const tab = document.getElementById('vmsm-tab');
    if (!tab) return;

    // Ustaw pozycję — tylko przy pierwszym wywołaniu
    if (tabPosY === null) tabPosY = window.innerHeight * 0.45;
    placeTab(tab, tabPosY, tabLeft);

    // Listenery dodajemy tylko raz
    if (tabInitialized) return;
    tabInitialized = true;

    let dragging  = false;
    let startY    = 0;
    let startPosY = 0;
    let moved     = false;

    tab.addEventListener('touchstart', (e) => {
      startY    = e.touches[0].clientY;
      startPosY = tabPosY;
      moved     = false;
      dragging  = true;
      tab.style.transition = 'none';
      tab.style.transform  = 'scale(1.15)';
    }, { passive: true });

    tab.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dy) > 5) moved = true;
      tabPosY = Math.max(40, Math.min(window.innerHeight - 80, startPosY + dy));
      const px = e.touches[0].clientX;
      tabLeft = px < window.innerWidth / 2;
      placeTab(tab, tabPosY, tabLeft);
    }, { passive: true });

    tab.addEventListener('touchend', () => {
      dragging = false;
      tab.style.transition = 'transform 0.25s cubic-bezier(0.34,1.56,0.64,1)';
      tab.style.transform  = 'scale(1)';
      if (!moved) setMobileState('open');
    });
  }

  function placeTab(tab, y, left) {
    tab.style.top  = y + 'px';
    tab.style.left = left  ? '-2px' : 'auto';
    tab.style.right = left ? 'auto' : '-2px';
    tab.style.borderRadius = left
      ? '0 20px 20px 0'
      : '20px 0 0 20px';
  }

  // ─── UI MOBILE ────────────────────────────────────────────────────────────
  function injectMobileUI() {
    if (document.getElementById('vmsm-fab')) return true;
    const header = document.querySelector('header');
    if (!header || !header.parentNode) return false;

    // FAB w headerze
    const fab = document.createElement('button');
    fab.id        = 'vmsm-fab';
    fab.innerHTML = '⌕';
    fab.setAttribute('aria-label', 'Szukaj zestawu');
    const headerInner = header.querySelector('div') || header;
    headerInner.appendChild(fab);

    // Zakładka boczna
    const tab = document.createElement('button');
    tab.id        = 'vmsm-tab';
    tab.innerHTML = '⌕';
    tab.setAttribute('aria-label', 'Otwórz Multi-Search');
    tab.style.display = 'none';
    document.body.appendChild(tab);

    // Bottom sheet
    const sheet = document.createElement('div');
    sheet.id = 'vmsm-sheet';
    sheet.innerHTML = `
      <div id="vmsm-sheet-inner">
        <div id="vmsm-sheet-header">
          <button id="vmsm-reset-btn" aria-label="Resetuj wyszukiwanie">↺</button>
          <button id="vmsm-close-btn" aria-label="Minimalizuj">✕</button>
        </div>
        <div class="vmsm-field-group">
          <div class="vmsm-input-row">
            <input type="text" id="vmsm-item1" placeholder="Przedmiot A" autocomplete="off" />
            <button class="vmsm-catbtn" id="vmsm-catbtn1" data-n="1" aria-label="Kategoria">≡</button>
          </div>
          <div id="vmsm-cattree1" class="vmsm-cattree" style="display:none"></div>
          <div id="vmsm-catbadge1" class="vmsm-catbadge" style="display:none">
            <span id="vmsm-catbadgelabel1"></span>
            <button class="vmsm-catbadge-remove" data-n="1">✕</button>
          </div>
        </div>
        <div class="vmsm-field-group">
          <div class="vmsm-input-row">
            <input type="text" id="vmsm-item2" placeholder="Przedmiot B" autocomplete="off" />
            <button class="vmsm-catbtn" id="vmsm-catbtn2" data-n="2" aria-label="Kategoria">≡</button>
          </div>
          <div id="vmsm-cattree2" class="vmsm-cattree" style="display:none"></div>
          <div id="vmsm-catbadge2" class="vmsm-catbadge" style="display:none">
            <span id="vmsm-catbadgelabel2"></span>
            <button class="vmsm-catbadge-remove" data-n="2">✕</button>
          </div>
        </div>
        <div id="vmsm-action-row">
          <button id="vmsm-search-btn">⌕ Szukaj zestawu</button>
          <button id="vmsm-pause-btn"  style="display:none">❚❚ Pauza</button>
          <button id="vmsm-cancel-btn" style="display:none">✕ Anuluj</button>
        </div>
        <div id="vmsm-status"  class="vmsm-status"  style="display:none"></div>
        <div id="vmsm-results" class="vmsm-results" style="display:none"></div>
      </div>
    `;
    document.body.appendChild(sheet);

    fab.addEventListener('click', () => {
      if (mobileState === 'inactive') {
        setMobileState('tab');
        initTab(); // inicjalizuje listenery tylko przy pierwszym wywołaniu (flaga wewnątrz)
      } else {
        setMobileState('inactive');
      }
    });

    // Przycisk ✕ — minimalizuj do zakładki
    document.getElementById('vmsm-close-btn').addEventListener('click', () => {
      setMobileState('tab');
    });

    // Przycisk ↺ — reset wyszukiwania
    document.getElementById('vmsm-reset-btn').addEventListener('click', resetMobileSearch);

    // Kliknięcie tła — minimalizuj
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) setMobileState('tab');
    });

    document.getElementById('vmsm-search-btn').addEventListener('click', handleSearch);
    document.getElementById('vmsm-pause-btn').addEventListener('click', handlePause);
    document.getElementById('vmsm-cancel-btn').addEventListener('click', handleCancel);

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', adjustSheetForKeyboard);
    }

    // Event delegation dla drzewka
    sheet.addEventListener('click', (e) => {
      const catBtn = e.target.closest('.vmsm-catbtn');
      if (catBtn) {
        const n = catBtn.dataset.n;
        const isOpen = mCatState[n].open;
        [1, 2].forEach(i => { mCatState[i].open = false; renderMobileTree(i); });
        if (!isOpen) { mCatState[n].open = true; renderMobileTree(n); }
        return;
      }

      const arrow = e.target.closest('.vmsm-tree-arrow:not(.vmsm-tree-arrow--leaf)');
      if (arrow) {
        const id = arrow.dataset.id;
        const n  = mCatState[1].open ? '1' : '2';
        if (mCatState[n].collapsed.has(id)) {
          mCatState[n].collapsed.delete(id);
          const parent = flatCats.find(c => c.id === id);
          if (parent) {
            let inChildren = false;
            for (const c of flatCats) {
              if (c === parent) { inChildren = true; continue; }
              if (inChildren) {
                if (c.level <= parent.level) break;
                if (c.hasChildren) mCatState[n].collapsed.add(c.id);
              }
            }
          }
        } else {
          mCatState[n].collapsed.add(id);
        }
        renderMobileTree(n);
        return;
      }

      const treeReset = e.target.closest('.vmsm-tree-reset');
      if (treeReset) {
        const n = treeReset.dataset.n;
        mCatState[n].value = '';
        mCatState[n].label = '';
        mCatState[n].open  = false;
        renderMobileTree(n);
        return;
      }

      const item = e.target.closest('.vmsm-tree-item');
      if (item) {
        const n = mCatState[1].open ? '1' : '2';
        mCatState[n].value = item.dataset.id;
        mCatState[n].label = item.dataset.title;
        mCatState[n].open  = false;
        renderMobileTree(n);
        return;
      }

      const badgeRemove = e.target.closest('.vmsm-catbadge-remove');
      if (badgeRemove) {
        const n = badgeRemove.dataset.n;
        mCatState[n].value = '';
        mCatState[n].label = '';
        renderMobileTree(n);
        return;
      }
    });

    populateCategories();
    return true;
  }

  function closeMobileSheet() {
    setMobileState('tab');
    [1, 2].forEach(n => { mCatState[n].open = false; renderMobileTree(n); });
  }

  // ─── STEROWANIE ───────────────────────────────────────────────────────────
  function prefix(id) {
    return IS_MOBILE ? `vmsm-${id}` : `vms-${id}`;
  }

  function handlePause() {
    const btn = document.getElementById(prefix('pause-btn'));
    isPaused = !isPaused;
    btn.textContent = isPaused ? '▶ Wznów' : '❚❚ Pauza';
    setStatus(isPaused ? '⏸ Wstrzymano.' : 'Wznowiono...');
  }

  function handleCancel() {
    isCancelled = true;
    isPaused    = false;
    setStatus('Anulowano.', true);
    setScanningUI(false);
  }

  function setScanningUI(scanning) {
    const searchBtn = document.getElementById(prefix('search-btn'));
    const pauseBtn  = document.getElementById(prefix('pause-btn'));
    const cancelBtn = document.getElementById(prefix('cancel-btn'));
    if (!searchBtn) return;

    searchBtn.disabled    = scanning;
    searchBtn.textContent = scanning ? 'Szukam...'
      : IS_MOBILE ? '⌕ Szukaj zestawu' : 'Znajdź wspólnych sprzedawców';

    const display = scanning ? (IS_MOBILE ? 'block' : 'inline-block') : 'none';
    if (pauseBtn)  pauseBtn.style.display  = display;
    if (cancelBtn) cancelBtn.style.display = display;

    if (scanning) {
      isPaused    = false;
      isCancelled = false;
      if (pauseBtn) pauseBtn.textContent = IS_MOBILE ? '❚❚ Pauza' : '❚❚ Pauza';
    }
  }

  function setStatus(msg, isError = false, isHtml = false) {
    const el = document.getElementById(prefix('status'));
    if (!el) return;
    el.style.display = 'block';
    el.className     = (IS_MOBILE ? 'vmsm-status' : 'vms-status') + (isError ? (IS_MOBILE ? ' vmsm-error' : ' vms-error') : '');
    if (isHtml) el.innerHTML = msg;
    else        el.textContent = msg;
  }

  function showResults(matches) {
    const el = document.getElementById(prefix('results'));
    if (!el) return;
    el.style.display = 'block';

    if (matches.length === 0) {
      el.innerHTML = `<p class="${IS_MOBILE ? 'vmsm' : 'vms'}-no-results">Brak wspólnych sprzedawców.</p>`;
      return;
    }

    if (IS_MOBILE) {
      el.innerHTML = `
        <ul class="vmsm-list">
          ${matches.map(m => `
            <li class="vmsm-result-item">
              <div class="vmsm-result-header">
                <a class="vmsm-seller" href="${escapeHtml(m.profileUrl)}" target="_blank">@${escapeHtml(m.username)}</a>
                <span class="vmsm-total-price">${m.totalPrice.toFixed(2)} zł</span>
              </div>
              <div class="vmsm-result-items">
                <a class="vmsm-item" href="${escapeHtml(m.itemA.url)}" target="_blank">${escapeHtml(m.itemA.title)}</a>
                <span class="vmsm-plus">+</span>
                <a class="vmsm-item" href="${escapeHtml(m.itemB.url)}" target="_blank">${escapeHtml(m.itemB.title)}</a>
              </div>
            </li>`).join('')}
        </ul>`;
    } else {
      el.innerHTML = `
        <ul class="vms-list">
          ${matches.map(m => `
            <li>
              <a class="vms-seller" href="${escapeHtml(m.profileUrl)}" target="_blank">@${escapeHtml(m.username)}</a>
              <span class="vms-counts">(${m.itemA.count} szt. A, ${m.itemB.count} szt. B)</span>
              <span class="vms-total-price">${m.totalPrice.toFixed(2)} zł</span>:
              <a class="vms-item" href="${escapeHtml(m.itemA.url)}" target="_blank">${escapeHtml(m.itemA.title)}</a>
              <span class="vms-plus">+</span>
              <a class="vms-item" href="${escapeHtml(m.itemB.url)}" target="_blank">${escapeHtml(m.itemB.title)}</a>
            </li>`).join('')}
        </ul>`;
    }
  }

  // ─── CORE API ─────────────────────────────────────────────────────────────
  function randomDelay(minMs, maxMs) {
    return new Promise(r => setTimeout(r, Math.round(minMs + Math.random() * (maxMs - minMs))));
  }

  async function waitIfPaused() {
    while (isPaused && !isCancelled) await new Promise(r => setTimeout(r, 500));
  }

  async function fetchVintedAPI(params, retryCount = 0) {
    const url = new URL(`${VINTED_ORIGIN}/api/v2/catalog/items`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      credentials: 'include',
    });

    if (res.status === 429) {
      if (retryCount >= CONFIG.MAX_RETRIES) return null;
      setStatus(`⚠️ Serwer spowalnia — czekam ${CONFIG.RATE_LIMIT_WAIT_MS / 1000}s...`);
      await new Promise(r => setTimeout(r, CONFIG.RATE_LIMIT_WAIT_MS));
      return fetchVintedAPI(params, retryCount + 1);
    }
    if (res.status === 400) return { _endOfResults: true };
    if (!res.ok) return null;
    return res.json();
  }

  async function collectSellers(searchText, label, categoryId = '') {
    const sellers = new Map();
    let page = 1;

    while (page <= CONFIG.MAX_PAGES_PER_ITEM) {
      if (isCancelled) break;
      await waitIfPaused();
      if (isCancelled) break;

      setStatus(`Zbieram ${label} "${searchText}" (str. ${page}, sprzed.: ${sellers.size})...`);

      const params = {
        search_text: searchText,
        per_page:    CONFIG.ITEMS_PER_PAGE,
        page,
        order:       'newest_first',
      };
      if (categoryId) params['catalog_ids[]'] = categoryId;

      const data = await fetchVintedAPI(params);
      if (!data?.items?.length || data._endOfResults) break;

      for (const item of data.items) {
        if (item.user?.id && item.user?.login) {
          const userId    = item.user.id;
          const itemPrice = parseFloat(item.price?.amount ?? '0');
          if (!item.price?.amount) console.warn(`[VMS] Brak ceny: ${item.url}`);

          const itemData = { title: item.title || searchText, url: item.url, price: itemPrice };

          if (!sellers.has(userId)) {
            sellers.set(userId, {
              username:     item.user.login,
              profileUrl:   item.user.profile_url || `${VINTED_ORIGIN}/member/${userId}`,
              cheapestItem: itemData,
              count:        1,
            });
          } else {
            const existing = sellers.get(userId);
            existing.count++;
            if (itemPrice < existing.cheapestItem.price) existing.cheapestItem = itemData;
          }
        }
      }

      if (sellers.size >= CONFIG.MAX_UNIQUE_SELLERS) break;
      page++;
      if (page > CONFIG.MAX_PAGES_PER_ITEM) break;

      if ((page - 1) % CONFIG.SAFETY_PAUSE_EVERY === 0) {
        const pauseMs = Math.round(CONFIG.SAFETY_PAUSE_MIN + Math.random() * (CONFIG.SAFETY_PAUSE_MAX - CONFIG.SAFETY_PAUSE_MIN));
        setStatus(`Przerwa ${label}... (${sellers.size} sprzedawców)`);
        await new Promise(r => setTimeout(r, pauseMs));
      } else {
        await randomDelay(CONFIG.DELAY_BETWEEN_PAGES_MIN, CONFIG.DELAY_BETWEEN_PAGES_MAX);
      }
    }

    return sellers;
  }

  function findCommonSellers(sellersA, sellersB) {
    const matches = [];
    for (const [userId, infoA] of sellersA) {
      if (sellersB.has(userId)) {
        const infoB      = sellersB.get(userId);
        const sameItem   = infoA.cheapestItem.url === infoB.cheapestItem.url;
        const totalPrice = sameItem
          ? infoA.cheapestItem.price
          : infoA.cheapestItem.price + infoB.cheapestItem.price;
        matches.push({
          userId,
          username:   infoA.username,
          profileUrl: infoA.profileUrl,
          itemA:      { ...infoA.cheapestItem, count: infoA.count },
          itemB:      { ...infoB.cheapestItem, count: infoB.count },
          totalPrice, sameItem,
        });
      }
    }
    matches.sort((a, b) => a.totalPrice - b.totalPrice);
    return matches;
  }

  // ─── GŁÓWNA LOGIKA ────────────────────────────────────────────────────────
  async function handleSearch() {
    isCancelled = false;
    isPaused    = false;

    const item1 = document.getElementById(prefix('item1')).value.trim();
    const item2 = document.getElementById(prefix('item2')).value.trim();
    const cat1  = IS_MOBILE ? mCatState[1].value : (document.getElementById('vms-cat1')?.value || '');
    const cat2  = IS_MOBILE ? mCatState[2].value : (document.getElementById('vms-cat2')?.value || '');
    const resultsEl = document.getElementById(prefix('results'));

    if (!item1 || !item2) { alert('Wpisz oba przedmioty!'); return; }

    setScanningUI(true);
    if (resultsEl) resultsEl.style.display = 'none';

    try {
      const sellersA = await collectSellers(item1, 'A', cat1);
      if (isCancelled) return;
      if (sellersA.size === 0) { setStatus(`Brak wyników dla "${item1}".`, true); return; }

      setStatus(`Przedmiot A: ${sellersA.size} sprzedawców. Czekam...`);
      await randomDelay(CONFIG.DELAY_BETWEEN_ITEMS_MIN, CONFIG.DELAY_BETWEEN_ITEMS_MAX);
      if (isCancelled) return;

      const sellersB = await collectSellers(item2, 'B', cat2);
      if (isCancelled) return;
      if (sellersB.size === 0) { setStatus(`Brak wyników dla "${item2}".`, true); return; }

      setStatus(`Porównuję... (${sellersA.size} × ${sellersB.size})`);
      const matches = findCommonSellers(sellersA, sellersB);

      setStatus(
        matches.length > 0
          ? `✔ Znaleziono <strong style="color:#007680">${matches.length}</strong> sprzedawców. (A: ${sellersA.size}, B: ${sellersB.size})`
          : `Brak wspólnych sprzedawców. (A: ${sellersA.size}, B: ${sellersB.size})`,
        false, true
      );
      showResults(matches);

    } catch (err) {
      console.error('[VMS] Błąd:', err);
      setStatus('Wystąpił błąd. Sprawdź konsolę.', true);
    } finally {
      setScanningUI(false);
    }
  }

  // ─── CSS ──────────────────────────────────────────────────────────────────
  function injectCSS() {
    const style = document.createElement('style');
    style.id = 'vms-styles';
    style.textContent = `
/* ── DESKTOP ── */
#vms-panel{background-color:#edf2f2;padding:10px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;z-index:9999;position:relative;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.vms-container{display:flex;justify-content:center;align-items:center;gap:12px;flex-wrap:wrap}
.vms-title{font-weight:600;font-size:14px;color:#676c6f;display:flex;align-items:center;white-space:nowrap}
.vms-inputs{display:flex;align-items:center;gap:8px}
.vms-input-group{display:flex;flex-direction:column;gap:4px;align-items:stretch}
.vms-container input[type="text"]{padding:0 12px;border:none;border-radius:6px;background-color:#dde6e6;color:#676c6f;font-size:14px;outline:none;width:185px;height:36px;box-sizing:border-box;transition:background-color .2s}
.vms-container input[type="text"]::placeholder{color:#9aa0a3}
.vms-container input[type="text"]:focus{background-color:#cfdada}
.vms-plus{font-weight:700;font-size:16px;color:#676c6f;flex-shrink:0;line-height:1}
.vms-catpicker{position:relative;width:185px}
.vms-catbtn{width:100%;padding:0 10px;border:none;border-radius:6px;background-color:#dde6e6;color:#676c6f;font-size:13px;text-align:left;cursor:pointer;transition:background-color .2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:36px;box-sizing:border-box;display:flex;align-items:center}
.vms-catbtn:hover{background-color:#cfdada}
.vms-catdrawer{position:absolute;top:calc(100% + 4px);left:0;width:240px;max-height:300px;overflow-y:auto;background:#edf2f2;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);z-index:99999;padding:4px 0}
.vms-dd-reset{padding:7px 12px;font-size:12px;color:#9aa0a3;cursor:pointer;border-bottom:1px solid #dde6e6;margin-bottom:2px;background:#edf2f2}
.vms-dd-reset:hover{background:#dde6e6;color:#007680}
.vms-dd-item{display:flex;align-items:center;gap:4px;padding-top:5px;padding-bottom:5px;padding-right:10px;cursor:pointer;font-size:13px;color:#333;user-select:none;transition:background .1s;background:#edf2f2}
.vms-dd-item[data-level="1"]{background:#e0e9e9}
.vms-dd-item[data-level="2"]{background:#d4e2e2}
.vms-dd-item[data-level="3"]{background:#c8dbdb}
.vms-dd-item[data-level="4"]{background:#bcd4d4}
.vms-dd-item[data-level="5"]{background:#b0cdcd}
.vms-dd-item:hover{filter:brightness(.96)}
.vms-dd-item--selected{color:#007680;font-weight:600}
.vms-dd-arrow{font-size:9px;color:#9aa0a3;width:14px;flex-shrink:0;text-align:center;padding:2px;border-radius:3px;transition:background .1s}
.vms-dd-arrow:not(.vms-dd-arrow--leaf):hover{background:#dde6e6;color:#007680}
.vms-dd-arrow--leaf{visibility:hidden}
.vms-dd-label{flex:1}
.vms-buttons{display:flex;gap:8px;align-items:center}
#vms-search-btn{padding:8px 16px;background-color:#edf2f2;color:#007680;border:1.5px solid #007680;border-radius:6px;font-weight:600;font-size:14px;cursor:pointer;transition:background-color .2s,color .2s;white-space:nowrap}
#vms-search-btn:hover{background-color:#007680;color:#fff}
#vms-search-btn:disabled{opacity:.6;cursor:default}
#vms-pause-btn,#vms-cancel-btn{padding:7px 14px;background-color:transparent;color:#676c6f;border:1.5px solid #676c6f;border-radius:6px;font-weight:500;font-size:13px;cursor:pointer;transition:background-color .2s}
#vms-pause-btn:hover,#vms-cancel-btn:hover{background-color:#dde6e6}
.vms-status{width:100%;text-align:center;font-size:13px;color:#676c6f;padding:4px 0}
.vms-error{color:#c0392b}
.vms-results{width:100%;padding-top:6px}
.vms-no-results{font-size:13px;color:#9aa0a3;text-align:center}
.vms-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.vms-list li{font-size:13px;color:#676c6f;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 8px;background:#dde6e6;border-radius:8px}
.vms-seller{font-weight:600;color:#007680;text-decoration:none}
.vms-seller:hover{text-decoration:underline}
.vms-counts{color:#9aa0a3;font-size:12px}
.vms-total-price{font-weight:700;color:#007680;white-space:nowrap}
.vms-item{color:#333;text-decoration:none;border-bottom:1px solid #ccc}
.vms-item:hover{border-bottom-color:#007680;color:#007680}

/* ── MOBILE ── */
#vmsm-fab{background:none;border:none;font-size:22px;color:#007680;cursor:pointer;padding:6px 8px;line-height:1;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;transition:background .15s;-webkit-tap-highlight-color:transparent}
#vmsm-fab:active{background:rgba(0,118,128,.1)}
#vmsm-tab{position:fixed;top:45%;width:36px;height:56px;background:#007680;color:#fff;border:none;font-size:20px;cursor:pointer;display:none;align-items:center;justify-content:center;z-index:999997;box-shadow:0 2px 10px rgba(0,0,0,.25);touch-action:none;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform 0.25s cubic-bezier(0.34,1.56,0.64,1)}
#vmsm-sheet{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999998;align-items:flex-end}
#vmsm-sheet.vmsm-sheet--open{display:flex}
#vmsm-sheet-inner{background:#edf2f2;width:100%;border-radius:16px 16px 0 0;padding:12px 16px 32px;box-sizing:border-box;height:85vh;overflow-y:auto;-webkit-overflow-scrolling:touch;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
#vmsm-sheet-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
#vmsm-reset-btn{background:none;border:none;font-size:20px;color:#676c6f;cursor:pointer;padding:4px 8px;border-radius:6px;-webkit-tap-highlight-color:transparent;line-height:1}
#vmsm-reset-btn:active{background:#dde6e6}
#vmsm-close-btn{background:none;border:none;font-size:18px;color:#676c6f;cursor:pointer;padding:4px 8px;border-radius:6px;-webkit-tap-highlight-color:transparent}
#vmsm-close-btn:active{background:#dde6e6}
.vmsm-field-group{margin-bottom:12px}
.vmsm-input-row{display:flex;gap:8px;align-items:center}
.vmsm-input-row input[type="text"]{flex:1;height:44px;padding:0 14px;border:none;border-radius:6px;background:#dde6e6;color:#333;font-size:16px;outline:none;box-sizing:border-box}
.vmsm-input-row input[type="text"]::placeholder{color:#9aa0a3}
.vmsm-input-row input[type="text"]:focus{background:#cfdada}
.vmsm-catbtn{width:44px;height:44px;flex-shrink:0;background:#dde6e6;border:none;border-radius:6px;font-size:20px;color:#676c6f;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent;transition:background .15s}
.vmsm-catbtn:active{background:#cfdada}
.vmsm-catbadge{display:flex;align-items:center;gap:6px;margin-top:6px;padding:4px 10px;background:#fff;border:1.5px solid #007680;border-radius:6px;font-size:13px;color:#007680;width:fit-content;max-width:100%}
.vmsm-catbadge span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.vmsm-catbadge-remove{background:none;border:none;color:#007680;font-size:14px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;-webkit-tap-highlight-color:transparent}
.vmsm-cattree{margin-top:6px;background:#edf2f2;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.12);max-height:280px;overflow-y:auto;padding:4px 0}
.vmsm-tree-reset{padding:10px 14px;font-size:13px;color:#9aa0a3;cursor:pointer;border-bottom:1px solid #dde6e6;margin-bottom:2px;-webkit-tap-highlight-color:transparent}
.vmsm-tree-reset:active{background:#dde6e6}
.vmsm-tree-item{display:flex;align-items:center;gap:6px;padding-top:10px;padding-bottom:10px;padding-right:12px;cursor:pointer;font-size:14px;color:#333;user-select:none;background:#edf2f2;-webkit-tap-highlight-color:transparent}
.vmsm-tree-item[data-level="1"]{background:#e0e9e9}
.vmsm-tree-item[data-level="2"]{background:#d4e2e2}
.vmsm-tree-item[data-level="3"]{background:#c8dbdb}
.vmsm-tree-item[data-level="4"]{background:#bcd4d4}
.vmsm-tree-item[data-level="5"]{background:#b0cdcd}
.vmsm-tree-item:active{filter:brightness(.94)}
.vmsm-tree-item--selected{color:#007680;font-weight:600}
.vmsm-tree-arrow{font-size:10px;color:#9aa0a3;width:16px;flex-shrink:0;text-align:center;padding:4px;border-radius:4px}
.vmsm-tree-arrow--leaf{visibility:hidden}
.vmsm-tree-label{flex:1}
#vmsm-action-row{display:flex;flex-direction:column;gap:8px;margin-top:4px}
#vmsm-search-btn{width:100%;height:48px;background:#edf2f2;color:#007680;border:1.5px solid #007680;border-radius:6px;font-size:16px;font-weight:600;cursor:pointer;transition:background .15s,color .15s;-webkit-tap-highlight-color:transparent}
#vmsm-search-btn:active:not(:disabled){background:#007680;color:#fff}
#vmsm-search-btn:disabled{opacity:.6;cursor:default}
#vmsm-pause-btn,#vmsm-cancel-btn{width:100%;height:44px;background:transparent;color:#676c6f;border:1.5px solid #676c6f;border-radius:6px;font-size:15px;font-weight:500;cursor:pointer;-webkit-tap-highlight-color:transparent}
#vmsm-pause-btn:active,#vmsm-cancel-btn:active{background:#dde6e6}
.vmsm-status{margin-top:12px;font-size:13px;color:#676c6f;text-align:center;padding:4px 0}
.vmsm-error{color:#c0392b}
.vmsm-results{margin-top:12px}
.vmsm-no-results{font-size:13px;color:#9aa0a3;text-align:center}
.vmsm-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.vmsm-result-item{background:#dde6e6;border-radius:8px;padding:10px 12px}
.vmsm-result-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.vmsm-seller{font-weight:600;color:#007680;text-decoration:none;font-size:14px}
.vmsm-total-price{font-weight:700;color:#007680;font-size:14px}
.vmsm-result-items{display:flex;flex-direction:column;gap:2px}
.vmsm-item{font-size:13px;color:#333;text-decoration:none;border-bottom:1px solid #ccc;word-break:break-word}
.vmsm-item:active{color:#007680}
.vmsm-plus{font-size:12px;color:#9aa0a3;text-align:center}
    `;
    document.head.appendChild(style);
  }

  // ─── INICJALIZACJA ────────────────────────────────────────────────────────
  function injectUI() {
    return IS_MOBILE ? injectMobileUI() : injectDesktopUI();
  }

  function waitForHydration(callback) {
    let lastChange  = Date.now();
    let headerFound = false;

    const observer = new MutationObserver(() => {
      lastChange = Date.now();
      if (document.querySelector('header')) headerFound = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const check = setInterval(() => {
      if (headerFound && (Date.now() - lastChange) > 300) {
        clearInterval(check);
        observer.disconnect();
        callback();
      }
    }, 100);
  }

  injectCSS();

  waitForHydration(() => {
    injectUI();

    window.addEventListener('popstate', () => setTimeout(injectUI, 400));

    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(injectUI, 400);
      }
    }).observe(document.body, { childList: true, subtree: false });
  });

})();
