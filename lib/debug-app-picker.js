(function (root, factory) {
  const wineApps = (root && root.wineApps) ||
    (typeof module === 'object' && module.exports ? require('./apps') : null);
  const api = factory(root, wineApps);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DebugAppPicker = api;
})(typeof window !== 'undefined' ? window : globalThis, function (host, wineApps) {
  'use strict';

  const RECENT_KEY = 'wine-assembly:recent-debug-apps';
  const MAX_RECENT = 5;
  const APP_REGISTRY = (wineApps && wineApps.APPS) || {};
  const CATEGORY_DEFS = [
    {
      label: 'Apps & Utilities',
      sections: [
        'Featured',
        'Win98 Accessories',
        'XP',
        { group: 'Other', label: 'Other Apps', appSection: 'other-apps' },
      ],
    },
    {
      label: 'Classic Games',
      sections: [
        'Entertainment Pack',
        'Community WEP Remakes',
        'Plus! 98',
        { group: 'Other', label: 'Other Games', appSection: 'other-games' },
      ],
    },
    {
      label: '16-bit Games',
      sections: [
        '16-bit (Win16 / NE)',
        'Entertainment Pack 1 (16-bit)',
        'Entertainment Pack 2 (16-bit)',
        'Entertainment Pack 3 (16-bit)',
        'Entertainment Pack 4 (16-bit)',
      ],
    },
    {
      label: 'PC Games',
      sections: [
        'DirectX Shareware',
        { group: 'Local Candidates', installer: false },
      ],
    },
    {
      label: 'Demoscene',
      sections: ['Demoscene'],
    },
    {
      label: 'Screensavers',
      sections: ['Plus! 98 Screensavers'],
    },
    {
      label: 'SDK Samples',
      sections: ['DirectX SDK Samples'],
    },
    {
      label: 'Installers',
      sections: [
        'Installers',
        { group: 'Local Candidates', label: 'Game Installers', installer: true },
      ],
    },
  ];

  function normalize(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function buildCatalog(select) {
    const entries = [];
    const groups = new Map();

    function addOption(option, group) {
      const entry = {
        value: option.value,
        label: option.textContent.trim(),
        group,
      };
      entries.push(entry);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry);
    }

    for (const child of Array.from(select.children || [])) {
      const tag = String(child.tagName || '').toUpperCase();
      if (tag === 'OPTION') {
        addOption(child, 'Featured');
      } else if (tag === 'OPTGROUP') {
        for (const option of Array.from(child.children || [])) {
          if (String(option.tagName || '').toUpperCase() === 'OPTION') {
            addOption(option, child.label || 'More Programs');
          }
        }
      }
    }

    return { entries, groups };
  }

  function categorizeCatalog(catalog) {
    const assigned = new Set();
    const categories = [];

    function isInstaller(entry) {
      return /(?:_inst|_installer)$/.test(entry.value) || /\binstaller\b/i.test(entry.label);
    }

    function buildSection(rawSection) {
      const definition = typeof rawSection === 'string'
        ? { group: rawSection }
        : rawSection;
      let entries = catalog.groups.get(definition.group) || [];
      if (definition.appSection) entries = entries.filter(entry =>
        APP_REGISTRY[entry.value] &&
        APP_REGISTRY[entry.value].debugPickerSection === definition.appSection);
      if (definition.installer === true) entries = entries.filter(isInstaller);
      if (definition.installer === false) entries = entries.filter(entry => !isInstaller(entry));
      entries = entries.filter(entry => !assigned.has(entry.value));
      if (!entries.length) return null;
      for (const entry of entries) assigned.add(entry.value);
      return {
        label: definition.label || definition.group,
        entries,
      };
    }

    for (const definition of CATEGORY_DEFS) {
      const sections = definition.sections.map(buildSection).filter(Boolean);
      if (!sections.length) continue;
      categories.push({
        label: definition.label,
        sections,
        groups: sections.map(section => section.label),
        count: sections.reduce((total, section) => total + section.entries.length, 0),
      });
    }

    const leftovers = catalog.entries.filter(entry => !assigned.has(entry.value));
    if (leftovers.length) {
      const sections = [];
      for (const group of catalog.groups.keys()) {
        const entries = leftovers.filter(entry => entry.group === group);
        if (entries.length) sections.push({ label: group, entries });
      }
      categories.push({
        label: 'More Programs',
        sections,
        groups: sections.map(section => section.label),
        count: leftovers.length,
      });
    }
    return categories;
  }

  function searchCatalog(catalog, query) {
    const needle = normalize(query);
    if (!needle) return catalog.entries.slice();
    const words = needle.split(' ');
    return catalog.entries
      .map((entry, index) => {
        const label = normalize(entry.label);
        const value = normalize(entry.value);
        const group = normalize(entry.group);
        const haystack = `${label} ${value} ${group}`;
        if (!words.every(word => haystack.includes(word))) return null;
        let rank = 4;
        if (label === needle) rank = 0;
        else if (label.startsWith(needle)) rank = 1;
        else if (label.split(' ').some(word => word.startsWith(needle))) rank = 2;
        else if (label.includes(needle)) rank = 3;
        return { entry, rank, index };
      })
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(result => result.entry);
  }

  function createDebugAppPicker(options) {
    options = options || {};
    const doc = options.document || document;
    const select = options.select || doc.getElementById('app-select');
    const picker = options.picker || doc.getElementById('app-picker');
    if (!select || !picker) return null;

    const trigger = picker.querySelector('.app-picker-trigger');
    const triggerLabel = picker.querySelector('.app-picker-trigger-label');
    const popup = picker.querySelector('.app-picker-popup');
    if (!trigger || !triggerLabel || !popup) return null;

    let catalog = buildCatalog(select);
    let categories = categorizeCatalog(catalog);
    let rootPanel = null;
    let childPanel = null;
    let searchInput = null;
    let activeCategory = '';
    let open = false;

    function makeElement(tag, className, text) {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    }

    function selectedEntry() {
      return catalog.entries.find(entry => entry.value === select.value) || catalog.entries[0] || null;
    }

    function syncFromSelect() {
      catalog = buildCatalog(select);
      categories = categorizeCatalog(catalog);
      const selected = selectedEntry();
      triggerLabel.textContent = selected ? selected.label : 'Choose a program';
      trigger.title = selected ? `${selected.label} — ${selected.group}` : 'Choose a program';
    }

    function loadRecent() {
      let values = [];
      try {
        const parsed = JSON.parse(host.localStorage.getItem(RECENT_KEY) || '[]');
        if (Array.isArray(parsed)) values = parsed;
      } catch (_) {}
      const selected = selectedEntry();
      if (selected) values.unshift(selected.value);
      const seen = new Set();
      return values
        .filter(value => catalog.entries.some(entry => entry.value === value))
        .filter(value => !seen.has(value) && seen.add(value))
        .slice(0, MAX_RECENT);
    }

    function remember(value) {
      const values = [value, ...loadRecent().filter(item => item !== value)].slice(0, MAX_RECENT);
      try { host.localStorage.setItem(RECENT_KEY, JSON.stringify(values)); } catch (_) {}
    }

    function makeItem(label, detail, className) {
      const button = makeElement('button', `app-picker-item${className ? ` ${className}` : ''}`);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      const text = makeElement('span', 'app-picker-item-label', label);
      button.appendChild(text);
      if (detail) button.appendChild(makeElement('span', 'app-picker-item-detail', detail));
      return button;
    }

    function addHeading(panel, text) {
      panel.appendChild(makeElement('div', 'app-picker-heading', text));
    }

    function choose(entry) {
      select.value = entry.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      remember(entry.value);
      syncFromSelect();
      closePicker(true);
    }

    function addProgram(panel, entry, showGroup) {
      const button = makeItem(entry.label, showGroup ? entry.group : '');
      button.dataset.app = entry.value;
      if (entry.value === select.value) button.classList.add('selected');
      button.addEventListener('click', () => choose(entry));
      panel.appendChild(button);
      return button;
    }

    function clearChild() {
      if (childPanel) childPanel.remove();
      childPanel = null;
      activeCategory = '';
      if (rootPanel) {
        for (const button of rootPanel.querySelectorAll('.app-picker-category.active')) {
          button.classList.remove('active');
        }
      }
    }

    function showCategory(category, sourceButton) {
      clearChild();
      activeCategory = category.label;
      sourceButton.classList.add('active');
      childPanel = makeElement('div', 'app-picker-panel app-picker-child');
      childPanel.setAttribute('role', 'menu');

      const back = makeItem('\u2190 Back', '', 'app-picker-back');
      back.addEventListener('click', () => {
        clearChild();
        if (searchInput) searchInput.focus();
      });
      childPanel.appendChild(back);
      addHeading(childPanel, category.label);
      for (const section of category.sections) {
        addHeading(childPanel, section.label);
        for (const entry of section.entries) addProgram(childPanel, entry, false);
      }
      popup.appendChild(childPanel);
      const selected = childPanel.querySelector('.app-picker-item.selected');
      if (selected) selected.scrollIntoView({ block: 'nearest' });
    }

    function renderSearchResults(query, resultsHost) {
      clearChild();
      resultsHost.replaceChildren();
      const results = searchCatalog(catalog, query);
      if (!query.trim()) {
        resultsHost.hidden = true;
        return;
      }
      resultsHost.hidden = false;
      addHeading(resultsHost, `${results.length} result${results.length === 1 ? '' : 's'}`);
      if (!results.length) {
        resultsHost.appendChild(makeElement('div', 'app-picker-empty', 'No programs found'));
        return;
      }
      for (const entry of results) addProgram(resultsHost, entry, true);
    }

    function renderRoot() {
      popup.replaceChildren();
      rootPanel = makeElement('div', 'app-picker-panel app-picker-root');
      rootPanel.setAttribute('role', 'menu');

      const searchWrap = makeElement('div', 'app-picker-search-wrap');
      searchInput = makeElement('input', 'app-picker-search');
      searchInput.type = 'search';
      searchInput.placeholder = 'Find a program...';
      searchInput.setAttribute('aria-label', 'Find a program');
      searchInput.autocomplete = 'off';
      searchWrap.appendChild(searchInput);
      rootPanel.appendChild(searchWrap);

      const searchResults = makeElement('div', 'app-picker-search-results');
      searchResults.hidden = true;
      rootPanel.appendChild(searchResults);

      const browse = makeElement('div', 'app-picker-browse');
      addHeading(browse, 'Recent');
      for (const value of loadRecent()) {
        const entry = catalog.entries.find(item => item.value === value);
        if (entry) addProgram(browse, entry, false);
      }
      browse.appendChild(makeElement('div', 'app-picker-separator'));
      addHeading(browse, 'Categories');
      for (const category of categories) {
        const button = makeItem(category.label, `${category.count}  \u203a`, 'app-picker-category');
        button.dataset.category = category.label;
        const activate = () => {
          if (activeCategory !== category.label) showCategory(category, button);
        };
        button.addEventListener('click', activate);
        button.addEventListener('mouseenter', activate);
        button.addEventListener('focus', () => {
          if (doc.documentElement.clientWidth > 680) activate();
        });
        browse.appendChild(button);
      }
      rootPanel.appendChild(browse);
      popup.appendChild(rootPanel);

      searchInput.addEventListener('input', () => {
        const searching = !!searchInput.value.trim();
        browse.hidden = searching;
        renderSearchResults(searchInput.value, searchResults);
      });
      searchInput.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown') return;
        const first = rootPanel.querySelector('.app-picker-search-results:not([hidden]) .app-picker-item, .app-picker-browse:not([hidden]) .app-picker-item');
        if (first) {
          event.preventDefault();
          first.focus();
        }
      });
    }

    function openPicker() {
      if (open) return;
      open = true;
      syncFromSelect();
      renderRoot();
      popup.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      host.requestAnimationFrame(() => searchInput && searchInput.focus());
    }

    function closePicker(restoreFocus) {
      if (!open) return;
      open = false;
      popup.hidden = true;
      popup.replaceChildren();
      rootPanel = null;
      childPanel = null;
      searchInput = null;
      activeCategory = '';
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }

    trigger.addEventListener('click', () => open ? closePicker(false) : openPicker());
    select.addEventListener('change', syncFromSelect);
    doc.addEventListener('pointerdown', event => {
      if (open && !picker.contains(event.target)) closePicker(false);
    });
    doc.addEventListener('keydown', event => {
      if (!open || event.key !== 'Escape') return;
      event.preventDefault();
      closePicker(true);
    });

    picker.classList.add('enhanced');
    trigger.hidden = false;
    syncFromSelect();
    return {
      open: openPicker,
      close: closePicker,
      syncFromSelect,
      get catalog() { return catalog; },
      get categories() { return categories; },
    };
  }

  function autoInit() {
    if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('debug')) return;
    const picker = document.getElementById('app-picker');
    if (!picker || picker.debugAppPicker) return;
    picker.debugAppPicker = createDebugAppPicker({ picker });
    host.debugAppPicker = picker.debugAppPicker;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
    else autoInit();
  }

  return {
    CATEGORY_DEFS,
    buildCatalog,
    categorizeCatalog,
    searchCatalog,
    createDebugAppPicker,
  };
});
