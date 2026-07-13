(function () {
  window.TMBuild = Object.freeze({ app: "20260713-v030-baseline-consolidation", ppt: "20260702-v916-kb-bridge-client-cn" });
  window.tmAppBuild = window.TMBuild.app;
  try {
    Object.defineProperty(window, 'tmAppBuild', {
      value: window.TMBuild.app,
      writable: false,
      configurable: false,
      enumerable: true
    });
  } catch (_error) {}
}());
