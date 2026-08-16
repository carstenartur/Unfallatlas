/** Keep the semantic AI handoff bound even when the export modal is opened later. */
(() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});
  let observer = null;

  function bind() {
    const fn = UA.aiVisualResearch?._internal?.bindEnhancedControls;
    return typeof fn === 'function' ? fn() : false;
  }

  function install() {
    const documentValue = root.document;
    if (!documentValue) return false;
    bind();

    if (!observer && typeof root.MutationObserver === 'function') {
      observer = new root.MutationObserver(() => bind());
      observer.observe(documentValue.documentElement, { childList: true, subtree: true });
    }

    if (documentValue.documentElement?.dataset.uaVisualResearchUi !== '1') {
      documentValue.documentElement.dataset.uaVisualResearchUi = '1';
      documentValue.addEventListener('click', event => {
        if (event.target?.closest?.('#btnOpenExport')) {
          root.setTimeout?.(bind, 0);
        }
      }, true);
    }
    return true;
  }

  UA.aiVisualResearchUi = Object.freeze({ install, bind });
  install();
})();
