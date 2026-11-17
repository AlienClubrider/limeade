// Whether the Assistant's chat is in front of the user: the rule, without the page. app.js feeds it what
// the page shows; replies and approvals for a chat he's looking at don't buzz.
'use strict'
;(function () {
  /**
   * `pages`: the pages pushed over the main view, each `{ full }`. On a phone any page covers the chat. On a
   * wide window a side panel sits beside it, but a full-page one (Settings, Local models, a worker) covers it.
   */
  function assistantInFront({ visible, tab, pages, wide, drawerOpen }) {
    return visible && tab === 'assistant' && !drawerOpen && (!pages.length || (wide && !pages.some((p) => p.full)))
  }

  const api = { assistantInFront }
  if (typeof window !== 'undefined') window.onScreen = api
  if (typeof module !== 'undefined') module.exports = api
})()
