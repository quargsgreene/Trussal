// Runtime <style> injection for the modules that import their CSS as raw text
// (build.mjs's '.css': 'text' loader and vite.config.js's matching dev
// transform). In dev, vite-plugin-trussal-hmr.js makes the imported string
// mutable and accepts each stylesheet update by rewriting the <style> element
// that holds the previous text; this module owns the create-or-update part.
//
// Upsert instead of inject-once: create the element if needed, then rewrite
// its text whenever the imported string differs. In production the string is
// static, so this is one comparison at startup and behaves like the old code.

export function upsertStyle(id, css, doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || !doc.head) return null;
  let el = doc.getElementById(id);
  if (!el) {
    el = doc.createElement('style');
    el.id = id;
    doc.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
  return el;
}
