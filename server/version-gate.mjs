// version-gate.mjs — the ONE place the bus decides whether a client's version is allowed on.
//
// Policy (PO ruling 2026-09-16): every host on the bus must run the SAME latest version. The
// leader is the authority — a client is admitted only if its release version (package.json semver,
// see cc-rev.pkgVersion — the only identity present for plugin installs too) EXACTLY matches the
// leader's. A mismatch is refused on BOTH the REST /register path and the WS upgrade with HTTP
// 426 Upgrade Required, so a stale host is forced to update before it can coordinate.
//
// Two deliberate fail-OPEN carve-outs so the gate can never brick the whole bus:
//   1. bypass=true (operator's CC_VERSION_GATE_BYPASS on the leader) → admit everyone, for rollout
//      / emergencies. Loud + logged at boot by the caller.
//   2. the leader can't determine its OWN version (serverVersion falsy) → admit, because refusing
//      the entire fleet over a server-side package.json read error is worse than a version skew.
// A client that sends NO version (an old client predating this gate) is NOT a carve-out — it is
// exactly the stale host we mean to force to update, so it is refused.
//
// Pure + side-effect-free so it unit-tests in isolation; callers own the HTTP/socket response.

/**
 * @param {string|null|undefined} clientVersion  the version the client reported
 * @param {string|null|undefined} serverVersion  the leader's own pkgVersion()
 * @param {{bypass?: boolean}} [opts]
 * @returns {null | {required: string, yours: string, how_to_update: string}}
 *          null = admit; an object = REFUSE, carrying the details for the 426 body.
 */
export function versionGateReject(clientVersion, serverVersion, { bypass = false } = {}) {
  if (bypass) return null;                       // carve-out 1: operator override
  if (!serverVersion) return null;               // carve-out 2: leader can't self-identify → fail open
  if (clientVersion && clientVersion === serverVersion) return null;   // the one admit path
  return {
    required: serverVersion,
    yours: clientVersion || 'unknown',
    how_to_update:
      `Every host on the bus must run the same version. Update the crosstalk plugin on this host to ` +
      `${serverVersion} (reinstall the plugin, or in a checkout: git pull && restart), then re-arm receive.`,
  };
}

// Express middleware that gates the ENTIRE authed data plane, not just /register — a stale client
// that ignores the /register 426 must not still send/poll/claim on the other routes (the enforcement,
// vs. the mere signal, of "every host on the latest version"). Mount AFTER requireAuth so a 426 can
// never be an unauthenticated version oracle. Clients carry their version in the `x-cc-version` header
// (present on GETs too, where there is no body); the body `version` is a fallback for older callers.
export function versionGateMiddleware({ serverVersion = null, versionGateBypass = false } = {}) {
  return (req, res, next) => {
    const claimed = req.get('x-cc-version') || (req.body && req.body.version) || '';
    const vg = versionGateReject(claimed, serverVersion, { bypass: versionGateBypass });
    if (vg) {
      return res.status(426).json({
        error: `version gate: the bus requires ${vg.required}, you sent ${vg.yours}`,
        reason: 'version_mismatch',
        ...vg,
      });
    }
    next();
  };
}
