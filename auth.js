'use strict';

// PIN gate removed — dashboard is open access.
// App scripts await window.__unlocked before fetching data; resolve immediately.
window.__unlocked = Promise.resolve();
window.__resolveUnlock = function () {};
