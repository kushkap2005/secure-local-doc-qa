/* Feature 13: role and level badges.
 *
 * Standalone: it does not touch app.js. It watches two places on the page
 * (the account area and the document list) and, whenever app.js redraws them,
 * turns the plain text into coloured badges.
 *
 *   - Your role (top right)        -> Guest / Staff / Admin badge
 *   - Each document's access level -> "Everyone" / "Staff & Admin" / "Admin only" badge
 *
 * To remove the feature, delete the <script> line in index.html.
 */
(function () {
  "use strict";

  // label shown by app.js  ->  which level it means
  const LEVEL_BY_LABEL = {
    "Everyone": "guest",
    "Staff & Admin": "staff",
    "Admin only": "admin",
  };

  const TIPS = {
    guest: "Anyone who is signed in can search this document",
    staff: "Staff and Admin can search this document",
    admin: "Only Admin can search this document",
  };

  const css = `
    .badge { display:inline-flex; align-items:center; gap:4px; padding:1px 8px;
             border-radius:999px; font-size:11px; font-weight:600; line-height:18px;
             white-space:nowrap; border:1px solid transparent; }
    .badge::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
    .badge-guest { color:#15803d; background:rgba(34,197,94,.14);  border-color:rgba(34,197,94,.35); }
    .badge-staff { color:#1d4ed8; background:rgba(59,130,246,.14); border-color:rgba(59,130,246,.35); }
    .badge-admin { color:#b45309; background:rgba(245,158,11,.16); border-color:rgba(245,158,11,.40); }
    :root[data-theme="dark"] .badge-guest { color:#4ade80; }
    :root[data-theme="dark"] .badge-staff { color:#93c5fd; }
    :root[data-theme="dark"] .badge-admin { color:#fbbf24; }
    .account-area .tag.badge { font-family:inherit; }
    .doc-item-chunks .badge { margin-left:4px; }
  `;

  function addStyles() {
    if (document.getElementById("badges-style")) return;
    const s = document.createElement("style");
    s.id = "badges-style";
    s.textContent = css;
    document.head.appendChild(s);
  }

  // Safe to run many times: it only changes things that are not yet badged.
  function decorate() {
    // 1) the role next to the username
    document.querySelectorAll(".account-area .tag").forEach((tag) => {
      const role = tag.textContent.trim().toLowerCase();
      if (!["guest", "staff", "admin"].includes(role)) return;
      if (tag.dataset.badged === role) return;
      tag.className = "tag badge badge-" + role;
      tag.dataset.badged = role;
      tag.title = "You are signed in as " + tag.textContent.trim();
    });

    // 2) the access level on every document row ("12 chunks · Admin only")
    document.querySelectorAll(".doc-item-chunks").forEach((node) => {
      if (node.dataset.badged) return;
      const parts = node.textContent.split("·");
      if (parts.length < 2) return;
      const label = parts[parts.length - 1].trim();
      const level = LEVEL_BY_LABEL[label];
      if (!level) return;
      node.dataset.badged = level;
      node.textContent = parts.slice(0, -1).join("·").trim() + " ";
      const b = document.createElement("span");
      b.className = "badge badge-" + level;
      b.textContent = label;
      b.title = TIPS[level];
      node.appendChild(b);
    });
  }

  function start() {
    addStyles();
    decorate();
    const watch = (id) => {
      const target = document.getElementById(id);
      if (target) new MutationObserver(decorate).observe(target, { childList: true, subtree: true });
    };
    watch("account-area");
    watch("doc-list");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();