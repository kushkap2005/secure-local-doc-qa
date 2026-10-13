/* Branding: the product name "SecureDoc Q&A" and its logo (a locked document).
 *
 * Changes four things in the page, and nothing else:
 *   1. the name next to the logo (top-left)
 *   2. the logo itself (replaces the small drawn square)
 *   3. the browser tab title
 *   4. the browser tab icon
 *
 * The logo is one SVG string below, so it is the only place to edit if the
 * design changes. Standalone: one <script> line in index_new.html.
 * To remove: delete that line (the page goes back to the old name and logo).
 */
(function () {
  "use strict";

  const NAME = "SecureDoc Q&A";

  // 48x48 tile: blue-to-purple gradient, white document, padlock badge.
  const LOGO =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<defs><linearGradient id="sdqa-g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#9b6bff"/></linearGradient></defs>' +
    '<rect width="48" height="48" rx="12" fill="url(#sdqa-g)"/>' +
    '<path d="M14 8H28L35 15V36a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z" fill="#fff"/>' +
    '<path d="M28 8V15H35" fill="#cfd8ff"/>' +
    '<path d="M16 21h11M16 25.5h11M16 30h6" stroke="#5b6df0" stroke-width="1.8" stroke-linecap="round"/>' +
    '<circle cx="35" cy="35" r="9.5" fill="#0a1023" stroke="#fff" stroke-width="2"/>' +
    '<rect x="31.2" y="34" width="7.6" height="6" rx="1.2" fill="#fff"/>' +
    '<path d="M33 34v-2.2a2 2 0 0 1 4 0V34" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round"/>' +
    "</svg>";

  function setTitle() {
    document.title = NAME + " — Local Document Q&A";
  }

  function setTabIcon() {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/svg+xml";
    link.href = "data:image/svg+xml," + encodeURIComponent(LOGO);
  }

  function setBrand() {
    const brand = document.querySelector(".brand");
    if (!brand) return;
    const name = brand.querySelector(".brand-name");
    if (name) name.textContent = NAME;

    const old = brand.querySelector(".brand-mark");
    if (old && !brand.querySelector(".brand-logo")) {
      const logo = document.createElement("span");
      logo.className = "brand-logo";
      logo.setAttribute("aria-hidden", "true");
      logo.innerHTML = LOGO; // fixed string defined above, no user input
      logo.style.cssText = "display:inline-flex;width:28px;height:28px;flex:none;";
      const svg = logo.firstChild;
      svg.setAttribute("width", "28");
      svg.setAttribute("height", "28");
      svg.style.borderRadius = "9px";
      svg.style.boxShadow = "0 6px 16px var(--accent-glow, rgba(91,140,255,.35))";
      old.replaceWith(logo);
    }
  }

  function start() {
    setTitle();
    setTabIcon();
    setBrand();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();