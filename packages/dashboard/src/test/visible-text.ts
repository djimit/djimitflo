// jsdom applies no CSS: text hidden by class, attribute or a closed <details> must not count as shown (UXE-00, shared since UXE-09)
const HIDES = new Set(['hidden', 'sr-only', 'invisible', 'opacity-0']); // exact class tokens, so overflow-hidden is not one
export const visibleText = (el: Element): string => [...el.childNodes].map((n) => {
  if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
  if (!(n instanceof Element) || n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true'
    || (n.getAttribute('class') ?? '').split(/\s+/).some((c) => HIDES.has(c))) return '';
  if (n.tagName === 'DETAILS' && !n.hasAttribute('open')) return [...n.children].filter((c) => c.tagName === 'SUMMARY').map(visibleText).join(' ');
  return visibleText(n); }).join(' ');
