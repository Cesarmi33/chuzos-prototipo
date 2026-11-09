/* Chuzos landing: language toggle, contact block, video play. No dependencies. */
(function () {
  "use strict";
  var CFG = window.CHUZOS_CONFIG || {};
  var ES = window.CHUZOS_ES || {};
  var EN = {};                       // English captured from the HTML itself
  var nodes = document.querySelectorAll("[data-i18n]");
  nodes.forEach(function (n) { EN[n.getAttribute("data-i18n")] = n.innerHTML; });
  var ariaNodes = document.querySelectorAll("[data-i18n-aria]");
  ariaNodes.forEach(function (n) { EN[n.getAttribute("data-i18n-aria")] = n.getAttribute("aria-label"); });
  EN.meta_title = document.title;
  var metaDesc = document.querySelector('meta[name="description"]');
  EN.meta_desc = metaDesc ? metaDesc.getAttribute("content") : "";
  EN.js_w_ok = "Done! You’re on the list. We’ll let you know when the pilot opens.";
  EN.js_w_again = "You were already on the list. Thanks!";
  EN.js_w_role = "Choose whether you buy food or run a stall.";
  EN.js_w_email = "Please enter a valid email.";
  EN.js_w_err = "Couldn’t save. Check your connection and try again.";
  EN.js_w_wait = "Saving…";
  EN.js_email = "Email me"; EN.js_linkedin = "LinkedIn"; EN.js_instagram = "Instagram"; EN.js_founder = "Founder:";
  var lang = "en";

  function tr(key) { return (lang === "es" && ES[key] != null) ? ES[key] : EN[key]; }

  function clean(v) { return (typeof v === "string") ? v.trim() : ""; }
  function safeUrl(u) { u = clean(u); return /^https:\/\//i.test(u) ? u : ""; }
  function safeEmail(e) { e = clean(e); return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e) ? e : ""; }

  function renderContact() {
    var name = clean(CFG.FOUNDER_NAME);
    var email = safeEmail(CFG.CONTACT_EMAIL);
    var li = safeUrl(CFG.LINKEDIN_URL);
    var ig = safeUrl(CFG.INSTAGRAM_URL);
    var founder = document.getElementById("founder-line");
    if (name) { founder.textContent = tr("js_founder") + " " + name; founder.hidden = false; } else { founder.hidden = true; }
    var items = [];
    if (email) items.push({ href: "mailto:" + email + "?subject=" + encodeURIComponent("Chuzos co-founder"), label: tr("js_email"), cls: "btn primary", ext: false });
    if (li) items.push({ href: li, label: tr("js_linkedin"), cls: "btn ghostlight", ext: true });
    if (ig) items.push({ href: ig, label: tr("js_instagram"), cls: "btn ghostlight", ext: true });
    var btns = document.getElementById("contact-btns"), soon = document.getElementById("contact-soon"), foot = document.getElementById("footer-contact");
    btns.innerHTML = ""; foot.innerHTML = "";
    items.forEach(function (it) {
      var a = document.createElement("a");
      a.href = it.href; a.className = it.cls; a.textContent = it.label;
      if (it.ext) { a.target = "_blank"; a.rel = "noopener"; }
      btns.appendChild(a);
      var f = a.cloneNode(true); f.className = ""; foot.appendChild(f);
    });
    if (email) { var s = document.createElement("span"); s.className = "mail"; s.textContent = email; btns.appendChild(s); }
    var has = items.length > 0;
    btns.hidden = !has; foot.hidden = !has; soon.hidden = has;
  }

  function setLang(l) {
    lang = (l === "es") ? "es" : "en";
    nodes.forEach(function (n) { var k = n.getAttribute("data-i18n"); var v = tr(k); if (v != null) n.innerHTML = v; });
    ariaNodes.forEach(function (n) { var k = n.getAttribute("data-i18n-aria"); var v = tr(k); if (v != null) n.setAttribute("aria-label", v); });
    document.documentElement.lang = lang;
    document.title = tr("meta_title");
    if (metaDesc) metaDesc.setAttribute("content", tr("meta_desc"));
    document.querySelectorAll("[data-lang]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-lang") === lang)); });
    renderContact();
    try { localStorage.setItem("chuzos_lang", lang); } catch (e) {}
  }

  document.querySelectorAll("[data-lang]").forEach(function (b) {
    b.addEventListener("click", function () { setLang(b.getAttribute("data-lang")); });
  });

  // Initial language: ?lang=es / ?lang=en, else saved choice, else Spanish.
  var q = (location.search.match(/[?&]lang=(es|en)/) || [])[1];
  var saved = null; try { saved = localStorage.getItem("chuzos_lang"); } catch (e) {}
  setLang(q || saved || "es");

  // Waitlist form: POST /api/waitlist (stored on Chuzos' own server, no third parties).
  var form = document.getElementById("waitlist-form");
  if (form) {
    var msg = document.getElementById("waitlist-msg");
    var say = function (key, ok) { msg.textContent = tr(key); msg.className = "wmsg " + (ok ? "ok" : "err"); };
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var role = form.querySelector('input[name="role"]:checked');
      var email = form.email.value.trim();
      if (!role) return say("js_w_role", false);
      if (!safeEmail(email)) return say("js_w_email", false);
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true; msg.textContent = tr("js_w_wait"); msg.className = "wmsg";
      var src = (location.search.match(/[?&]src=([\w-]{1,30})/) || [])[1] || "landing";
      fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: role.value, email: email, name: form.elements.name.value.trim(), website: form.elements.website.value, lang: lang, source: src }) })
        .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (r) {
          if (r.s === 200 && r.j.ok) { say(r.j.created === false ? "js_w_again" : "js_w_ok", true); form.reset(); }
          else say(r.s === 400 && /correo/.test(r.j.error || "") ? "js_w_email" : "js_w_err", false);
        })
        .catch(function () { say("js_w_err", false); })
        .then(function () { btn.disabled = false; });
    });
  }

  // Video: big play overlay + "Watch the video" buttons.
  var video = document.getElementById("explainer");
  var over = document.querySelector(".playover");
  function play() {
    if (!video) return;
    var p = video.play(); if (p && p.catch) p.catch(function () {});
  }
  if (video && over) {
    // Clean poster until the user presses play (native controls stay if JS is off).
    if (video.hasAttribute("data-hide-controls")) video.removeAttribute("controls");
    over.addEventListener("click", play);
    video.addEventListener("play", function () { over.hidden = true; video.setAttribute("controls", ""); });
    video.addEventListener("ended", function () { over.hidden = false; });
  }
  document.querySelectorAll("[data-play]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      document.getElementById("video").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      setTimeout(play, 450);
    });
  });
})();
