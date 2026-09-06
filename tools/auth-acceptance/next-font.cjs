/* global module */
// Auth acceptance does not require a Google Fonts request. Keep an actual
// font-face declaration so Next's font loader still executes normally.
module.exports = new Proxy({}, {
  get: () => '@font-face { font-family: Inter; src: local(Arial); font-style: normal; font-weight: 100 900; font-display: swap; }',
});
