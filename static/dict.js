/* In-card dictionary: click or hover a word to see its CC-Canto / CC-CEDICT
 * definition. Works on any `.reading .w` rendered by the app (search results,
 * review, browse) via event delegation, including words injected later by JS. */
(function () {
  // Register the offline service worker from every page that loads dict.js
  // (search / review / browse), not just /study. This primes the canto-shell
  // cache so the installed app — whose start_url is /study — works offline no
  // matter which page the user first visited; the SW's navigate fallback then
  // serves /study for any offline open. study.js registers the same SW; calling
  // register() twice with the same URL is a no-op.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  }

  let pop = null;          // the single floating popover element
  let anchor = null;       // the .w currently shown
  let pinned = false;      // true when opened by click (ignores mouseleave)
  let hoverTimer = null;
  const cache = new Map(); // word -> senses array (or null = no entry)

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'dictpop';
    pop.setAttribute('role', 'dialog');
    pop.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
    pop.addEventListener('mouseleave', () => { if (!pinned) hide(); });
    document.body.appendChild(pop);
    return pop;
  }

  function hide() {
    clearTimeout(hoverTimer);
    if (pop) pop.classList.remove('open');
    if (anchor) anchor.classList.remove('dict-active');
    anchor = null;
    pinned = false;
  }

  function esc(s) {
    return (s || '').replace(/[&<>]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function senseHtml(s) {
    const jp = s.jyutping
      ? `<span class="dp-jyut">${esc(s.jyutping)}</span>` : '';
    const pos = s.pos ? `<span class="dp-pos">${esc(s.pos)}</span>` : '';
    const tag = s.canto ? '<span class="dp-tag">粵 Cantonese</span>' : '';
    const defs = (s.defs || []).map(d => `<li>${esc(d)}</li>`).join('');
    return `<div class="dp-sense">${jp}${pos}${tag}<ul>${defs}</ul></div>`;
  }

  function render(word, senses) {
    const p = ensurePop();
    if (!senses || !senses.length) {
      p.innerHTML = `<div class="dp-head"><b>${esc(word)}</b></div>` +
        `<div class="dp-empty">No dictionary entry.</div>`;
      return;
    }
    // Per-character fallback when the whole word wasn't found.
    if (senses[0] && senses[0].per_char) {
      const rows = senses[0].per_char.map(c =>
        `<div class="dp-sense"><b class="dp-ch">${esc(c.char)}</b>` +
        (c.jyutping ? `<span class="dp-jyut">${esc(c.jyutping)}</span>` : '') +
        (c.pos ? `<span class="dp-pos">${esc(c.pos)}</span>` : '') +
        `<ul><li>${esc((c.defs || [])[0] || '')}</li></ul></div>`).join('');
      p.innerHTML = `<div class="dp-head"><b>${esc(word)}</b>` +
        `<span class="dp-note">by character</span></div>${rows}`;
      return;
    }
    p.innerHTML = `<div class="dp-head"><b>${esc(word)}</b></div>` +
      senses.map(senseHtml).join('');
  }

  function place(el) {
    const p = ensurePop();
    const r = el.getBoundingClientRect();
    p.classList.add('open');
    const pr = p.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
    let top = r.bottom + 8;            // prefer below the word
    if (top + pr.height > window.innerHeight - 8 && r.top - pr.height - 8 > 0)
      top = r.top - pr.height - 8;     // flip above if it would overflow
    p.style.left = `${left + window.scrollX}px`;
    p.style.top = `${top + window.scrollY}px`;
  }

  async function show(el, pin) {
    const word = (el.querySelector('.wh') || el).textContent.trim();
    if (!word) return;
    if (anchor && anchor !== el) anchor.classList.remove('dict-active');  // only one at a time
    anchor = el;
    pinned = pin;
    el.classList.add('dict-active');
    let senses = cache.get(word);
    if (senses === undefined) {
      try {
        const res = await fetch('/api/define?word=' + encodeURIComponent(word));
        senses = res.ok ? (await res.json()).senses : [];
      } catch (e) { senses = []; }
      cache.set(word, senses);
    }
    if (anchor !== el) return;         // a newer interaction superseded this one
    render(word, senses);
    place(el);
  }

  // A word worth defining: a reading cell that isn't a Latin token.
  function wordCell(t) {
    const w = t.closest && t.closest('.reading .w');
    return (w && !w.classList.contains('latin')) ? w : null;
  }

  document.addEventListener('click', e => {
    const w = wordCell(e.target);
    if (w) {
      e.stopPropagation();
      if (anchor === w && pinned) { hide(); return; }
      show(w, true);
    } else if (pop && !pop.contains(e.target)) {
      hide();
    }
  });

  document.addEventListener('mouseover', e => {
    if (matchMedia('(hover: none)').matches) return;  // touch: tap only
    const w = wordCell(e.target);
    if (!w || w === anchor) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (!pinned) show(w, false); }, 220);
  });

  document.addEventListener('mouseout', e => {
    if (pinned) return;
    const w = wordCell(e.target);
    if (!w) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!pinned && (!pop || !pop.matches(':hover'))) hide();
    }, 180);
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  window.addEventListener('resize', hide);
})();
