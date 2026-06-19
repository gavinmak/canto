// Tone-color Jyutping: tint each syllable by its trailing tone digit (1-6).
// This is the product's signature — run it over any .jyut element.

// Chao tone-contour glyph, ported from CantoBridge's _TonePainter
// (lib/core/widgets/jyutping_text.dart). viewBox y runs 1 (high) .. 11 (low),
// matching the painter's high=0 / mid=h/2 / low=h anchors. stroke inherits the
// syllable's tone color via currentColor.
const TONE_CONTOURS = {
  1: 'M0,1 L10,1',    // high level
  2: 'M0,6 L10,1',    // mid rising to high
  3: 'M0,6 L10,6',    // mid level
  4: 'M0,6 L10,11',   // mid falling to low
  5: 'M0,11 L10,6',   // low rising to mid
  6: 'M0,11 L10,11',  // low level
};
function toneMark(tone) {
  const d = TONE_CONTOURS[tone];
  if (!d) return '';
  return `<svg class="tm" viewBox="0 0 10 12" aria-hidden="true">` +
         `<path d="${d}" fill="none" stroke="currentColor" ` +
         `stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

function colorizeJyutping(el) {
  const raw = (el.dataset.jyut ?? el.textContent).trim();
  if (!el.dataset.jyut) el.dataset.jyut = raw;   // remember source for re-runs
  el.innerHTML = raw.split(/(\s+)/).map(tok => {
    if (/^\s+$/.test(tok) || !tok) return tok;
    const m = tok.match(/^(.*?)([1-6])([^1-6]*)$/);   // syllable + tone + trailing punct
    if (!m) return `<span class="syl">${escapeHtml(tok)}</span>`;
    return `<span class="syl t${m[2]}">${escapeHtml(m[1])}` +
           `<span class="tn">${toneMark(m[2])}<span class="td">${m[2]}</span></span>` +
           `${escapeHtml(m[3])}</span>`;
  }).join('');
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}
document.addEventListener('DOMContentLoaded', () =>
  document.querySelectorAll('.jyut').forEach(colorizeJyutping));
