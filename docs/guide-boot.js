// Unicorn Pocket — docs viewer bootstrap. MUST be an external file (not inline):
// guide.html carries the same CSP as the app (`script-src 'self'`), which BLOCKS
// inline <script>. An inline bootstrap silently never runs and the page hangs on
// "Loading…". Loaded via <script src="guide-boot.js"> after guide.js.
'use strict';

(function () {
  const WHITELIST = new Set(['quickstart', 'setup', 'voice-pack-from-your-messages']);

  function getDocName() {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('doc') || '';
    // Normalise: strip any .md extension the caller may have included
    const name = raw.replace(/\.md$/i, '');
    return WHITELIST.has(name) ? name : 'quickstart';
  }

  const DOC_TITLES = {
    'quickstart': '5-minute quick start',
    'setup': 'Setup guide',
    'voice-pack-from-your-messages': 'Build your voice pack',
  };

  const docName = getDocName();
  document.getElementById('docTitle').textContent = DOC_TITLES[docName] || docName;
  document.title = 'Unicorn Pocket — ' + (DOC_TITLES[docName] || docName);

  fetch('./' + encodeURIComponent(docName) + '.md')
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function (md) {
      const html = window.GuideRenderer.renderMarkdown(md);
      document.getElementById('docContent').innerHTML = html;
    })
    .catch(function (err) {
      document.getElementById('docContent').innerHTML =
        '<div class="error-card">Could not load the guide (' + err.message + ').<br>' +
        '<a href="../index.html">← Back to app</a></div>';
    });
})();
