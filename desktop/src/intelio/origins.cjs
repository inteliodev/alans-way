/** Browsing-zone check. Keep the origin shape in step with intelio_harness.safety.navigation_allowed. */

function pageOrigin(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed.origin;
}

function originAllowed(url, origins) {
  if (!Array.isArray(origins) || origins.length === 0) return true;
  const origin = pageOrigin(url);
  return Boolean(origin) && origins.includes(origin);
}

module.exports = { pageOrigin, originAllowed };
