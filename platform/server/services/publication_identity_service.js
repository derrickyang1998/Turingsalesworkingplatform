'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { types: utilTypes } = require('node:util');

const MAX_URL_BYTES = 4096;
const MAX_BATCH_SIZE = 500;
const REJECTED_ORIGINAL_URL_DISCLOSURE = 'withheld_rejected_input';

const DISCLOSABLE_ERROR_DETAIL_KEYS = Object.freeze([
  'actual_bytes',
  'actual_code_units',
  'actual_items',
  'actual_type',
  'field',
  'index',
  'max_bytes',
  'max_items',
  'min_items',
  'platform',
  'port',
  'reason'
]);

const GLOBAL_TRACKING_PARAMETERS = Object.freeze([
  'dclid',
  'fbclid',
  'gclid',
  'msclkid',
  'ttclid',
  'twclid',
  'utm_campaign',
  'utm_content',
  'utm_creative_format',
  'utm_id',
  'utm_marketing_tactic',
  'utm_medium',
  'utm_source',
  'utm_source_platform',
  'utm_term'
]);

const PLATFORM_TRACKING_PARAMETERS = Object.freeze({
  tiktok: Object.freeze([
    '_r',
    '_t',
    'is_copy_url',
    'is_from_webapp',
    'refer',
    'sender_device',
    'sender_web_id',
    'share_app_id',
    'share_link_id'
  ]),
  instagram: Object.freeze(['igsh', 'igshid']),
  youtube: Object.freeze(['feature', 'si']),
  facebook: Object.freeze(['__cft__', '__tn__', 'mibextid']),
  x: Object.freeze(['cxt', 'ref_src', 'ref_url', 's', 't']),
  custom_manual: Object.freeze([])
});

const TRACKING_PARAMETER_ALLOWLIST = Object.freeze({
  global: GLOBAL_TRACKING_PARAMETERS,
  platform: PLATFORM_TRACKING_PARAMETERS
});

const GLOBAL_TRACKING_SET = new Set(GLOBAL_TRACKING_PARAMETERS);
const PLATFORM_TRACKING_SETS = Object.freeze(Object.fromEntries(
  Object.entries(PLATFORM_TRACKING_PARAMETERS).map(([platform, parameters]) => (
    [platform, new Set(parameters)]
  ))
));

const PLATFORM_HOST_ALLOWLIST = Object.freeze({
  tiktok: Object.freeze([
    'tiktok.com',
    'www.tiktok.com',
    'm.tiktok.com',
    'vm.tiktok.com',
    'vt.tiktok.com'
  ]),
  instagram: Object.freeze([
    'instagram.com',
    'www.instagram.com',
    'm.instagram.com',
    'instagr.am',
    'www.instagr.am'
  ]),
  youtube: Object.freeze([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be'
  ]),
  facebook: Object.freeze([
    'facebook.com',
    'www.facebook.com',
    'm.facebook.com',
    'web.facebook.com',
    'fb.com',
    'www.fb.com',
    'fb.watch',
    'www.fb.watch'
  ]),
  x: Object.freeze([
    'x.com',
    'www.x.com',
    'mobile.x.com',
    'twitter.com',
    'www.twitter.com',
    'mobile.twitter.com'
  ])
});

const PLATFORM_BY_HOST = Object.freeze(Object.fromEntries(
  Object.entries(PLATFORM_HOST_ALLOWLIST).flatMap(([platform, hosts]) => (
    hosts.map((host) => [host, platform])
  ))
));

const PLATFORM_BASE_DOMAINS = Object.freeze([
  'tiktok.com',
  'instagram.com',
  'instagr.am',
  'youtube.com',
  'youtu.be',
  'facebook.com',
  'fb.com',
  'fb.watch',
  'x.com',
  'twitter.com'
]);

const NON_PUBLIC_HOST_SUFFIXES = Object.freeze([
  'alt',
  'arpa',
  'example',
  'internal',
  'invalid',
  'lan',
  'local',
  'localhost',
  'onion',
  'test',
  'home',
  'home.arpa'
]);

const YOUTUBE_CONTENT_ID = /^[A-Za-z0-9_-]{11}$/;
const OPAQUE_CONTENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const POSITIVE_DECIMAL_CONTENT_ID = /^[1-9][0-9]{0,29}$/;
const SHORT_LINK_TOKEN = /^[A-Za-z0-9_-]{3,128}$/;

function deepFreeze(value, seen = new Set()) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      deepFreeze(descriptor.value, seen);
    }
  });
  return Object.freeze(value);
}

function disclosedErrorDetails(details) {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return {};
  const disclosed = {};
  DISCLOSABLE_ERROR_DETAIL_KEYS.forEach((key) => {
    if (!Object.hasOwn(details, key)) return;
    const value = details[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      disclosed[key] = value;
    }
  });
  return disclosed;
}

class PublicationIdentityServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PublicationIdentityServiceError';
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
    this.details = deepFreeze(disclosedErrorDetails(details));
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PublicationIdentityServiceError);
    }
  }
}

function serviceError(statusCode, code, message, details) {
  return new PublicationIdentityServiceError(statusCode, code, message, details);
}

function throwUrlError(statusCode, code, message, details) {
  throw serviceError(statusCode, code, message, details);
}

function hasWellFormedSurrogates(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateRawUrlInput(originalUrl) {
  if (typeof originalUrl !== 'string') {
    throwUrlError(
      400,
      'PUBLICATION_URL_TYPE_INVALID',
      'Publication URL must be a primitive string.',
      { field: 'url', actual_type: originalUrl === null ? 'null' : typeof originalUrl }
    );
  }
  if (originalUrl.length === 0) {
    throwUrlError(
      400,
      'PUBLICATION_URL_EMPTY',
      'Publication URL must not be empty.',
      { field: 'url' }
    );
  }
  if (originalUrl.length > MAX_URL_BYTES) {
    throwUrlError(
      413,
      'PUBLICATION_URL_TOO_LARGE',
      'Publication URL exceeds the admission limit.',
      {
        field: 'url',
        max_bytes: MAX_URL_BYTES,
        actual_code_units: originalUrl.length,
        reason: 'code_unit_lower_bound'
      }
    );
  }
  if (!hasWellFormedSurrogates(originalUrl)) {
    throwUrlError(
      400,
      'PUBLICATION_URL_MALFORMED',
      'Publication URL contains malformed Unicode.',
      { field: 'url', reason: 'malformed_unicode' }
    );
  }
  const byteLength = Buffer.byteLength(originalUrl, 'utf8');
  if (byteLength > MAX_URL_BYTES) {
    throwUrlError(
      413,
      'PUBLICATION_URL_TOO_LARGE',
      'Publication URL exceeds the admission limit.',
      { field: 'url', max_bytes: MAX_URL_BYTES, actual_bytes: byteLength }
    );
  }
  if (!/^https:\/\//iu.test(originalUrl)) {
    if (/^https:/iu.test(originalUrl)) {
      throwUrlError(
        400,
        'PUBLICATION_URL_MALFORMED',
        'Publication URL must use an absolute HTTPS authority form.',
        { field: 'url' }
      );
    }
    throwUrlError(
      400,
      'PUBLICATION_URL_HTTPS_REQUIRED',
      'Publication URL must use HTTPS.',
      { field: 'url' }
    );
  }
  const rawAuthority = originalUrl.slice('https://'.length).split(/[/?#]/u, 1)[0];
  if (rawAuthority.length === 0) {
    throwUrlError(
      400,
      'PUBLICATION_URL_MALFORMED',
      'Publication URL must contain a literal HTTPS authority.',
      { field: 'url', reason: 'empty_authority' }
    );
  }
  if (/[\x00-\x20\x7f]/u.test(originalUrl)) {
    throwUrlError(
      400,
      'PUBLICATION_URL_CONTROL_CHARACTER',
      'Publication URL contains a control character or unencoded whitespace.',
      { field: 'url' }
    );
  }
  if (originalUrl.includes('#')) {
    throwUrlError(
      400,
      'PUBLICATION_URL_FRAGMENT_FORBIDDEN',
      'Publication URL fragments are not admitted.',
      { field: 'url' }
    );
  }
  if (originalUrl.includes('\\') || /%(?![0-9A-Fa-f]{2})/u.test(originalUrl)) {
    throwUrlError(
      400,
      'PUBLICATION_URL_MALFORMED',
      'Publication URL contains ambiguous or malformed escaping.',
      { field: 'url', reason: 'malformed_escape' }
    );
  }
  if (rawAuthority.includes('@')) {
    throwUrlError(
      400,
      'PUBLICATION_URL_CREDENTIALS_FORBIDDEN',
      'Publication URL credentials are forbidden.',
      { field: 'url', reason: 'userinfo_syntax' }
    );
  }
  if (/[^\x00-\x7f]/u.test(rawAuthority) || rawAuthority.includes('%')) {
    throwUrlError(
      400,
      'PUBLICATION_URL_IDN_AMBIGUOUS',
      'Publication URL hostname must use literal ASCII syntax.',
      { field: 'hostname', reason: 'normalized_authority_forbidden' }
    );
  }
  const queryStart = originalUrl.indexOf('?');
  const pathStart = 'https://'.length + rawAuthority.length;
  const rawPath = originalUrl.slice(
    pathStart,
    queryStart === -1 ? originalUrl.length : queryStart
  );
  if (rawPath.includes('%')) {
    try {
      decodeURIComponent(rawPath);
    } catch {
      throwUrlError(
        400,
        'PUBLICATION_URL_MALFORMED',
        'Publication URL path contains invalid UTF-8 percent encoding.',
        { field: 'path', reason: 'invalid_utf8_path_escape' }
      );
    }
  }
  if (queryStart !== -1) {
    try {
      decodeURIComponent(originalUrl.slice(queryStart + 1));
    } catch {
      throwUrlError(
        400,
        'PUBLICATION_URL_MALFORMED',
        'Publication URL query contains invalid UTF-8 percent encoding.',
        { field: 'query', reason: 'invalid_utf8_query_escape' }
      );
    }
  }
}

function parseUrl(originalUrl) {
  validateRawUrlInput(originalUrl);
  let parsed;
  try {
    parsed = new URL(originalUrl);
  } catch {
    throwUrlError(
      400,
      'PUBLICATION_URL_MALFORMED',
      'Publication URL is malformed.',
      { field: 'url' }
    );
  }
  if (parsed.protocol !== 'https:') {
    throwUrlError(
      400,
      'PUBLICATION_URL_HTTPS_REQUIRED',
      'Publication URL must use HTTPS.',
      { field: 'url' }
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throwUrlError(
      400,
      'PUBLICATION_URL_CREDENTIALS_FORBIDDEN',
      'Publication URL credentials are forbidden.',
      { field: 'url' }
    );
  }
  if (parsed.hash !== '') {
    throwUrlError(
      400,
      'PUBLICATION_URL_FRAGMENT_FORBIDDEN',
      'Publication URL fragments are not admitted.',
      { field: 'url' }
    );
  }
  if (parsed.port !== '') {
    throwUrlError(
      400,
      'PUBLICATION_URL_PORT_FORBIDDEN',
      'Publication URL must use the standard HTTPS port.',
      { field: 'url', port: parsed.port }
    );
  }
  return parsed;
}

function stripIpv6Brackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isBlockedSuffix(hostname) {
  return NON_PUBLIC_HOST_SUFFIXES.some((suffix) => (
    hostname === suffix || hostname.endsWith('.' + suffix)
  ));
}

function resemblesUnallowlistedPlatformHost(hostname) {
  return PLATFORM_BASE_DOMAINS.some((baseDomain) => (
    ('.' + hostname + '.').includes('.' + baseDomain + '.')
  ));
}

function validateAndClassifyHost(parsed) {
  const hostname = parsed.hostname.toLowerCase();
  const ipCandidate = stripIpv6Brackets(hostname);
  if (net.isIP(ipCandidate) !== 0) {
    throwUrlError(
      400,
      'PUBLICATION_URL_IP_HOST_FORBIDDEN',
      'Publication URL must use a public DNS hostname, not an IP literal.',
      { field: 'hostname', hostname }
    );
  }
  const labels = hostname.split('.');
  if (labels.some((label) => label.startsWith('xn--'))) {
    throwUrlError(
      400,
      'PUBLICATION_URL_IDN_AMBIGUOUS',
      'Internationalized publication hostnames require manual resolution outside admission.',
      { field: 'hostname', hostname }
    );
  }
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    labels.length < 2 ||
    isBlockedSuffix(hostname) ||
    labels.some((label) => (
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )) ||
    !/^[a-z]{2,63}$/u.test(labels[labels.length - 1])
  ) {
    throwUrlError(
      400,
      'PUBLICATION_URL_HOST_NOT_PUBLIC',
      'Publication URL must use an unambiguous public-DNS-shaped hostname.',
      { field: 'hostname', hostname }
    );
  }
  const platform = Object.hasOwn(PLATFORM_BY_HOST, hostname)
    ? PLATFORM_BY_HOST[hostname]
    : null;
  if (platform === null && resemblesUnallowlistedPlatformHost(hostname)) {
    throwUrlError(
      400,
      'PUBLICATION_URL_HOST_AMBIGUOUS',
      'Publication URL resembles a supported platform but is not on its exact host allowlist.',
      { field: 'hostname', hostname }
    );
  }
  return { hostname, platform };
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeAsciiTrackerName(name) {
  let normalized = '';
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (codePoint > 0x7f) return null;
    normalized += codePoint >= 0x41 && codePoint <= 0x5a
      ? String.fromCodePoint(codePoint + 0x20)
      : character;
  }
  return normalized;
}

function isTrackingParameter(name, platform) {
  const normalized = normalizeAsciiTrackerName(name);
  if (normalized === null) return false;
  if (GLOBAL_TRACKING_SET.has(normalized)) return true;
  const platformSet = PLATFORM_TRACKING_SETS[platform];
  if (platformSet && platformSet.has(normalized)) return true;
  return platform === 'facebook' && /^__cft__\[[0-9]+\]$/u.test(normalized);
}

function retainedQueryEntries(
  parsed,
  platform,
  consumedNames = new Set(),
  preserveSourceOrder = platform === 'custom_manual'
) {
  const retained = [];
  let sourceIndex = 0;
  parsed.searchParams.forEach((value, name) => {
    if (!consumedNames.has(name) && !isTrackingParameter(name, platform)) {
      retained.push({ name, value, sourceIndex });
    }
    sourceIndex += 1;
  });
  if (!preserveSourceOrder) {
    retained.sort((left, right) => (
      compareText(left.name, right.name) ||
      left.sourceIndex - right.sourceIndex
    ));
  }
  return retained.map(({ name, value }) => [name, value]);
}

function normalizePercentHex(value) {
  return value.replace(/%[0-9a-f]{2}/giu, (match) => match.toUpperCase());
}

function normalizeCustomPath(pathname) {
  return pathname.replace(/%([0-9A-Fa-f]{2})/gu, (match, hexadecimal) => {
    const code = Number.parseInt(hexadecimal, 16);
    const unreserved = (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f ||
      code === 0x7e
    );
    return unreserved ? String.fromCharCode(code) : match.toUpperCase();
  });
}

function canonicalFromBase(base, requiredEntries, retainedEntries) {
  const canonical = new URL(base);
  canonical.search = '';
  requiredEntries.concat(retainedEntries).forEach(([name, value]) => {
    canonical.searchParams.append(name, value);
  });
  return normalizePercentHex(canonical.href);
}

function invalidPlatformPattern(platform, parsed, reason) {
  throwUrlError(
    400,
    'PUBLICATION_URL_PLATFORM_PATTERN_INVALID',
    'Publication URL does not match an admitted ' + platform + ' publication pattern.',
    {
      field: 'url',
      platform,
      hostname: parsed.hostname.toLowerCase(),
      pathname: parsed.pathname,
      reason
    }
  );
}

function exactQueryContentId(parsed, name, pattern, platform) {
  const values = parsed.searchParams.getAll(name);
  if (values.length !== 1 || !pattern.test(values[0])) {
    invalidPlatformPattern(platform, parsed, values.length === 0
      ? 'content_id_missing'
      : 'content_id_invalid_or_ambiguous');
  }
  return values[0];
}

function validatePathQueryContentId(
  parsed,
  name,
  pattern,
  platform,
  pathContentId,
  allowRepeatedMatch = false
) {
  const values = parsed.searchParams.getAll(name);
  if (values.length === 0) return;
  if (values.some((value) => !pattern.test(value))) {
    invalidPlatformPattern(platform, parsed, 'content_id_invalid_or_ambiguous');
  }
  if (values.some((value) => value !== pathContentId)) {
    invalidPlatformPattern(platform, parsed, 'conflicting_content_id');
  }
  if (!allowRepeatedMatch && values.length !== 1) {
    invalidPlatformPattern(platform, parsed, 'content_id_invalid_or_ambiguous');
  }
}

function canonicalizeTikTok(parsed, hostname) {
  const shortHost = hostname === 'vm.tiktok.com' || hostname === 'vt.tiktok.com';
  if (shortHost) {
    const shortMatch = /^\/([A-Za-z0-9_-]{3,128})\/?$/u.exec(parsed.pathname);
    if (!shortMatch || !SHORT_LINK_TOKEN.test(shortMatch[1])) {
      invalidPlatformPattern('tiktok', parsed, 'short_link_token_invalid');
    }
    return {
      platform: 'tiktok',
      platformContentId: null,
      canonicalUrl: canonicalFromBase(
        'https://' + hostname + '/' + shortMatch[1] + '/',
        [],
        retainedQueryEntries(parsed, 'tiktok', new Set(), true)
      )
    };
  }

  const contentMatch = /^\/@([A-Za-z0-9._-]{1,64})\/(video|photo)\/([1-9][0-9]{0,29})\/?$/u
    .exec(parsed.pathname);
  if (contentMatch) {
    const contentId = contentMatch[3];
    return {
      platform: 'tiktok',
      platformContentId: contentId,
      canonicalUrl: canonicalFromBase(
        'https://www.tiktok.com/@' + contentMatch[1].toLowerCase() + '/' +
          contentMatch[2] + '/' + contentId,
        [],
        retainedQueryEntries(parsed, 'tiktok')
      )
    };
  }

  const webShortMatch = /^\/t\/([A-Za-z0-9_-]{3,128})\/?$/u.exec(parsed.pathname);
  if (webShortMatch && SHORT_LINK_TOKEN.test(webShortMatch[1])) {
    return {
      platform: 'tiktok',
      platformContentId: null,
      canonicalUrl: canonicalFromBase(
        'https://www.tiktok.com/t/' + webShortMatch[1] + '/',
        [],
        retainedQueryEntries(parsed, 'tiktok', new Set(), true)
      )
    };
  }
  invalidPlatformPattern('tiktok', parsed, 'unsupported_path');
}

function canonicalizeInstagram(parsed) {
  const contentMatch = /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{1,64})\/?$/u
    .exec(parsed.pathname);
  if (contentMatch && OPAQUE_CONTENT_ID.test(contentMatch[2])) {
    const contentType = contentMatch[1] === 'reels' ? 'reel' : contentMatch[1];
    const contentId = contentMatch[2];
    return {
      platform: 'instagram',
      platformContentId: contentId,
      canonicalUrl: canonicalFromBase(
        'https://www.instagram.com/' + contentType + '/' + contentId + '/',
        [],
        retainedQueryEntries(parsed, 'instagram')
      )
    };
  }

  const shareMatch = /^\/share\/(reel|p)\/([A-Za-z0-9_-]{3,128})\/?$/u
    .exec(parsed.pathname);
  if (shareMatch && SHORT_LINK_TOKEN.test(shareMatch[2])) {
    return {
      platform: 'instagram',
      platformContentId: null,
      canonicalUrl: canonicalFromBase(
        'https://www.instagram.com/share/' + shareMatch[1] + '/' + shareMatch[2] + '/',
        [],
        retainedQueryEntries(parsed, 'instagram', new Set(), true)
      )
    };
  }
  invalidPlatformPattern('instagram', parsed, 'unsupported_path');
}

function canonicalizeYouTube(parsed, hostname) {
  const consumed = new Set(['v']);
  let contentId;
  if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
    const shortMatch = /^\/([A-Za-z0-9_-]{11})\/?$/u.exec(parsed.pathname);
    if (!shortMatch || !YOUTUBE_CONTENT_ID.test(shortMatch[1])) {
      invalidPlatformPattern('youtube', parsed, 'content_id_invalid');
    }
    contentId = shortMatch[1];
    validatePathQueryContentId(
      parsed,
      'v',
      YOUTUBE_CONTENT_ID,
      'youtube',
      contentId,
      true
    );
  } else if (/^\/watch\/?$/u.test(parsed.pathname)) {
    contentId = exactQueryContentId(parsed, 'v', YOUTUBE_CONTENT_ID, 'youtube');
  } else {
    const pathMatch = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})\/?$/u
      .exec(parsed.pathname);
    if (!pathMatch || !YOUTUBE_CONTENT_ID.test(pathMatch[1])) {
      invalidPlatformPattern('youtube', parsed, 'unsupported_path');
    }
    contentId = pathMatch[1];
    validatePathQueryContentId(
      parsed,
      'v',
      YOUTUBE_CONTENT_ID,
      'youtube',
      contentId,
      true
    );
  }
  return {
    platform: 'youtube',
    platformContentId: contentId,
    canonicalUrl: canonicalFromBase(
      'https://www.youtube.com/watch',
      [['v', contentId]],
      retainedQueryEntries(parsed, 'youtube', consumed)
    )
  };
}

function canonicalizeFacebook(parsed, hostname) {
  if (hostname === 'fb.watch' || hostname === 'www.fb.watch') {
    const shortMatch = /^\/([A-Za-z0-9_-]{3,128})\/?$/u.exec(parsed.pathname);
    if (!shortMatch || !SHORT_LINK_TOKEN.test(shortMatch[1])) {
      invalidPlatformPattern('facebook', parsed, 'short_link_token_invalid');
    }
    return {
      platform: 'facebook',
      platformContentId: null,
      canonicalUrl: canonicalFromBase(
        'https://fb.watch/' + shortMatch[1] + '/',
        [],
        retainedQueryEntries(parsed, 'facebook', new Set(), true)
      )
    };
  }

  const reelMatch = /^\/reel\/([1-9][0-9]{0,29})\/?$/u.exec(parsed.pathname);
  if (reelMatch && POSITIVE_DECIMAL_CONTENT_ID.test(reelMatch[1])) {
    const contentId = reelMatch[1];
    validatePathQueryContentId(
      parsed,
      'v',
      POSITIVE_DECIMAL_CONTENT_ID,
      'facebook',
      contentId
    );
    return {
      platform: 'facebook',
      platformContentId: contentId,
      canonicalUrl: canonicalFromBase(
        'https://www.facebook.com/reel/' + contentId + '/',
        [],
        retainedQueryEntries(parsed, 'facebook', new Set(['v']))
      )
    };
  }

  const videosMatch = /^\/[^/]+\/videos\/([1-9][0-9]{0,29})\/?$/u.exec(parsed.pathname);
  if (videosMatch && POSITIVE_DECIMAL_CONTENT_ID.test(videosMatch[1])) {
    const contentId = videosMatch[1];
    validatePathQueryContentId(
      parsed,
      'v',
      POSITIVE_DECIMAL_CONTENT_ID,
      'facebook',
      contentId
    );
    return {
      platform: 'facebook',
      platformContentId: contentId,
      canonicalUrl: canonicalFromBase(
        'https://www.facebook.com/watch/',
        [['v', contentId]],
        retainedQueryEntries(parsed, 'facebook', new Set(['v']))
      )
    };
  }

  if (/^\/(?:watch\/|video\.php)$/u.test(parsed.pathname)) {
    const contentId = exactQueryContentId(
      parsed,
      'v',
      POSITIVE_DECIMAL_CONTENT_ID,
      'facebook'
    );
    return {
      platform: 'facebook',
      platformContentId: contentId,
      canonicalUrl: canonicalFromBase(
        'https://www.facebook.com/watch/',
        [['v', contentId]],
        retainedQueryEntries(parsed, 'facebook', new Set(['v']))
      )
    };
  }

  const shareMatch = /^\/share\/(r|v|p)\/([A-Za-z0-9_-]{3,128})\/?$/u
    .exec(parsed.pathname);
  if (shareMatch && SHORT_LINK_TOKEN.test(shareMatch[2])) {
    return {
      platform: 'facebook',
      platformContentId: null,
      canonicalUrl: canonicalFromBase(
        'https://www.facebook.com/share/' + shareMatch[1] + '/' + shareMatch[2] + '/',
        [],
        retainedQueryEntries(parsed, 'facebook', new Set(), true)
      )
    };
  }
  invalidPlatformPattern('facebook', parsed, 'unsupported_path');
}

function canonicalizeX(parsed) {
  const directMatch = /^\/i\/(?:web\/)?status\/([1-9][0-9]{0,29})\/?$/u
    .exec(parsed.pathname);
  const userMatch = /^\/[A-Za-z0-9_]{1,64}\/status(?:es)?\/([1-9][0-9]{0,29})(?:\/(?:photo|video)\/[1-4])?\/?$/u
    .exec(parsed.pathname);
  const match = directMatch || userMatch;
  if (!match || !POSITIVE_DECIMAL_CONTENT_ID.test(match[1])) {
    invalidPlatformPattern('x', parsed, 'unsupported_path_or_content_id');
  }
  const contentId = match[1];
  return {
    platform: 'x',
    platformContentId: contentId,
    canonicalUrl: canonicalFromBase(
      'https://x.com/i/web/status/' + contentId,
      [],
      retainedQueryEntries(parsed, 'x')
    )
  };
}

function canonicalizeCustom(parsed) {
  const canonical = new URL(parsed.href);
  canonical.hash = '';
  canonical.pathname = normalizeCustomPath(parsed.pathname);
  canonical.search = '';
  retainedQueryEntries(parsed, 'custom_manual').forEach(([name, value]) => {
    canonical.searchParams.append(name, value);
  });
  return {
    platform: 'custom_manual',
    platformContentId: null,
    canonicalUrl: normalizePercentHex(canonical.href)
  };
}

function canonicalizeParsedUrl(parsed, classification) {
  switch (classification.platform) {
    case 'tiktok':
      return canonicalizeTikTok(parsed, classification.hostname);
    case 'instagram':
      return canonicalizeInstagram(parsed);
    case 'youtube':
      return canonicalizeYouTube(parsed, classification.hostname);
    case 'facebook':
      return canonicalizeFacebook(parsed, classification.hostname);
    case 'x':
      return canonicalizeX(parsed);
    default:
      return canonicalizeCustom(parsed);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildIdentityRecord(originalUrl, canonicalized) {
  const hasPlatformContentId = canonicalized.platformContentId !== null;
  const canonicalIdentity = hasPlatformContentId
    ? canonicalized.platform + ':' + canonicalized.platformContentId
    : 'sha256:' + sha256(canonicalized.canonicalUrl);
  return deepFreeze({
    platform: canonicalized.platform,
    platform_content_id: canonicalized.platformContentId,
    canonical_url: canonicalized.canonicalUrl,
    canonical_identity: canonicalIdentity,
    fingerprint: canonicalIdentity,
    identity_kind: hasPlatformContentId
      ? 'platform_content_id'
      : 'canonical_url_sha256',
    original_url: originalUrl
  });
}

function admitPublicationUrl(originalUrl) {
  const parsed = parseUrl(originalUrl);
  const classification = validateAndClassifyHost(parsed);
  const canonicalized = canonicalizeParsedUrl(parsed, classification);
  return buildIdentityRecord(originalUrl, canonicalized);
}

function snapshotDenseBatch(batch) {
  if (utilTypes.isProxy(batch)) {
    throw serviceError(
      400,
      'PUBLICATION_BATCH_CONTAINER_UNSAFE',
      'Publication batch Proxy containers are forbidden.',
      { field: 'batch' }
    );
  }
  if (!Array.isArray(batch)) {
    throw serviceError(
      400,
      'PUBLICATION_BATCH_TYPE_INVALID',
      'Publication batch must be an Array.',
      { field: 'batch', actual_type: batch === null ? 'null' : typeof batch }
    );
  }
  if (Object.getPrototypeOf(batch) !== Array.prototype) {
    throw serviceError(
      400,
      'PUBLICATION_BATCH_CONTAINER_INVALID',
      'Publication batch must be a plain Array.',
      { field: 'batch', reason: 'non_plain_array' }
    );
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(batch, 'length');
  const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value')
    ? lengthDescriptor.value
    : null;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw serviceError(
      400,
      'PUBLICATION_BATCH_CONTAINER_INVALID',
      'Publication batch has an invalid length descriptor.',
      { field: 'batch.length' }
    );
  }
  if (length === 0) {
    throw serviceError(
      400,
      'PUBLICATION_BATCH_EMPTY',
      'Publication batch must contain at least one row.',
      { field: 'batch', min_items: 1 }
    );
  }
  if (length > MAX_BATCH_SIZE) {
    throw serviceError(
      413,
      'PUBLICATION_BATCH_TOO_LARGE',
      'Publication batch exceeds the admission limit.',
      { field: 'batch', max_items: MAX_BATCH_SIZE, actual_items: length }
    );
  }

  let descriptors;
  let ownKeys;
  try {
    descriptors = Object.getOwnPropertyDescriptors(batch);
    ownKeys = Reflect.ownKeys(batch);
  } catch {
    throw serviceError(
      400,
      'PUBLICATION_BATCH_CONTAINER_UNSAFE',
      'Publication batch cannot be inspected safely.',
      { field: 'batch' }
    );
  }

  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) {
      throw serviceError(
        400,
        'PUBLICATION_BATCH_MUST_BE_DENSE',
        'Publication batch must not contain sparse rows.',
        { field: 'batch', index }
      );
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      throw serviceError(
        400,
        'PUBLICATION_BATCH_ACCESSOR_FORBIDDEN',
        'Publication batch row accessors are forbidden.',
        { field: 'batch', index }
      );
    }
    if (!descriptor.enumerable) {
      throw serviceError(
        400,
        'PUBLICATION_BATCH_CONTAINER_INVALID',
        'Publication batch row descriptors must be ordinary enumerable values.',
        { field: 'batch', index, reason: 'non_enumerable_row' }
      );
    }
    snapshot.push(descriptor.value);
  }

  const allowedKeys = new Set(['length']);
  for (let index = 0; index < length; index += 1) allowedKeys.add(String(index));
  if (
    ownKeys.length !== allowedKeys.size ||
    ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
  ) {
    throw serviceError(
      400,
      'PUBLICATION_BATCH_CONTAINER_INVALID',
      'Publication batch must not contain non-row properties.',
      { field: 'batch', reason: 'unexpected_own_property' }
    );
  }
  return snapshot;
}

function errorSnapshot(error, index) {
  return deepFreeze({
    name: error.name,
    code: error.code,
    status: error.status,
    statusCode: error.statusCode,
    message: error.message,
    details: Object.assign({}, error.details, { index })
  });
}

function admitPublicationBatch(batch) {
  const snapshot = snapshotDenseBatch(batch);
  const firstIndexByIdentity = new Map();
  const rows = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  let duplicateCount = 0;

  snapshot.forEach((value, index) => {
    try {
      const admitted = admitPublicationUrl(value);
      const priorIndex = firstIndexByIdentity.get(admitted.canonical_identity);
      const duplicate = priorIndex !== undefined;
      const outcome = duplicate ? 'duplicate' : 'accepted';
      if (duplicate) {
        duplicateCount += 1;
      } else {
        firstIndexByIdentity.set(admitted.canonical_identity, index);
        acceptedCount += 1;
      }
      rows.push({
        index,
        outcome,
        status: outcome,
        first_index: duplicate ? priorIndex : index,
        platform: admitted.platform,
        platform_content_id: admitted.platform_content_id,
        canonical_url: admitted.canonical_url,
        canonical_identity: admitted.canonical_identity,
        fingerprint: admitted.fingerprint,
        identity_kind: admitted.identity_kind,
        original_url: admitted.original_url
      });
    } catch (error) {
      if (!(error instanceof PublicationIdentityServiceError)) throw error;
      rejectedCount += 1;
      rows.push({
        index,
        outcome: 'rejected',
        status: 'rejected',
        first_index: null,
        original_url: null,
        original_url_disclosure: REJECTED_ORIGINAL_URL_DISCLOSURE,
        error: errorSnapshot(error, index)
      });
    }
  });

  return deepFreeze({
    total_count: snapshot.length,
    accepted_count: acceptedCount,
    rejected_count: rejectedCount,
    duplicate_count: duplicateCount,
    rows
  });
}

module.exports = {
  MAX_URL_BYTES,
  MAX_BATCH_SIZE,
  REJECTED_ORIGINAL_URL_DISCLOSURE,
  TRACKING_PARAMETER_ALLOWLIST,
  PLATFORM_HOST_ALLOWLIST,
  PublicationIdentityServiceError,
  PublicationIdentityError: PublicationIdentityServiceError,
  admitPublicationUrl,
  admitPublicationLink: admitPublicationUrl,
  admitPublicationBatch,
  admitPublicationLinks: admitPublicationBatch
};
