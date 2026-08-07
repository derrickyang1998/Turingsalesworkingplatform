'use strict';

const crypto = require('node:crypto');
const qs = require('qs');
const {
  MEDIA_KINDS,
  createOwnedRoutePredicate,
  isValidRequestId
} = require('../contracts/campaign_contract');

const DEFAULT_BODY_TIMEOUT_MS = 60_000;

class Phase4RequestError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'Phase4RequestError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function requestHeader(request, name) {
  const value = request.headers && request.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function applicationJson(contentType) {
  if (typeof contentType !== 'string') return false;
  const separator = contentType.indexOf(';');
  const mediaType = (separator === -1 ? contentType : contentType.slice(0, separator))
    .trim()
    .toLowerCase();
  return mediaType === 'application/json';
}

function applicationUrlencoded(contentType) {
  if (typeof contentType !== 'string') return false;
  const separator = contentType.indexOf(';');
  const mediaType = (separator === -1 ? contentType : contentType.slice(0, separator))
    .trim()
    .toLowerCase();
  return mediaType === 'application/x-www-form-urlencoded';
}

function multipartBoundary(contentType) {
  if (typeof contentType !== 'string') return null;
  const separator = contentType.indexOf(';');
  const mediaType = (separator === -1 ? contentType : contentType.slice(0, separator))
    .trim()
    .toLowerCase();
  if (mediaType !== 'multipart/form-data' || separator === -1) return null;

  const parameters = contentType.slice(separator);
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"\r\n]*)"|([^;\s]*))/i.exec(parameters);
  const boundary = match && (match[1] !== undefined ? match[1] : match[2]);
  if (
    !boundary ||
    boundary.length > 70 ||
    !/^[0-9A-Za-z'()+_,./:=? -]+$/.test(boundary) ||
    /\s$/.test(boundary)
  ) {
    return null;
  }
  return boundary;
}

function canonicalContentLength(request) {
  const value = requestHeader(request, 'content-length');
  if (value === undefined) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Phase4RequestError(
      400,
      'INVALID_REQUEST_BODY',
      'Invalid Content-Length'
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Phase4RequestError(
      400,
      'INVALID_REQUEST_BODY',
      'Invalid Content-Length'
    );
  }
  return parsed;
}

function unsupportedMediaType() {
  return new Phase4RequestError(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'Unsupported request media type'
  );
}

function bodyLimitError(policy) {
  if (policy.mediaKind === MEDIA_KINDS.MULTIPART) {
    return new Phase4RequestError(
      413,
      'UPLOAD_LIMIT_EXCEEDED',
      'Upload envelope exceeds the request limit',
      { limit_bytes: policy.maxRawBytes }
    );
  }
  return new Phase4RequestError(
    413,
    'INVALID_REQUEST_BODY',
    'Request body exceeds the request limit',
    { limit_bytes: policy.maxRawBytes }
  );
}

function validateMediaAndLength(request, policy) {
  const contentType = requestHeader(request, 'content-type');
  const contentLength = canonicalContentLength(request);
  const transferEncoding = requestHeader(request, 'transfer-encoding');

  if (policy.mediaKind === MEDIA_KINDS.EMPTY && contentLength !== null && contentLength > 0) {
    throw new Phase4RequestError(
      400,
      'INVALID_REQUEST_BODY',
      'Request body must be empty'
    );
  }

  let parsedMediaKind = policy.mediaKind;
  if (policy.mediaKind === MEDIA_KINDS.JSON) {
    if (!applicationJson(contentType)) throw unsupportedMediaType();
  } else if (policy.mediaKind === MEDIA_KINDS.DUAL) {
    if (applicationJson(contentType)) {
      parsedMediaKind = MEDIA_KINDS.JSON;
    } else if (applicationUrlencoded(contentType)) {
      parsedMediaKind = 'urlencoded';
    } else if (
      transferEncoding === undefined &&
      (contentLength === null || contentLength === 0)
    ) {
      parsedMediaKind = MEDIA_KINDS.EMPTY;
    } else {
      throw unsupportedMediaType();
    }
  } else if (policy.mediaKind === MEDIA_KINDS.MULTIPART) {
    if (!multipartBoundary(contentType)) throw unsupportedMediaType();
  } else if (
    policy.mediaKind === MEDIA_KINDS.EMPTY &&
    contentType !== undefined &&
    !applicationJson(contentType)
  ) {
    throw unsupportedMediaType();
  }

  if (contentLength !== null && contentLength > policy.maxRawBytes) {
    throw bodyLimitError(policy);
  }

  return {
    contentLength,
    bodyKnownEmpty: transferEncoding === undefined && (contentLength === null || contentLength === 0),
    parsedMediaKind
  };
}

function timeoutError(policy) {
  if (policy.mediaKind === MEDIA_KINDS.MULTIPART) {
    return new Phase4RequestError(
      408,
      'UPLOAD_PARSE_TIMEOUT',
      'Upload body timed out'
    );
  }
  return new Phase4RequestError(
    408,
    'REQUEST_BODY_TIMEOUT',
    'Request body timed out'
  );
}

function disconnectError() {
  return new Phase4RequestError(
    400,
    'INVALID_REQUEST_BODY',
    'Request body disconnected'
  );
}

function readBoundedBody(request, policy, bodyTimeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      fail(timeoutError(policy));
    }, bodyTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('aborted', onAborted);
      request.removeListener('error', onError);
    }

    function finish(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof request.pause === 'function') request.pause();
      reject(error);
    }

    function onData(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > policy.maxRawBytes) {
        if (policy.mediaKind === MEDIA_KINDS.EMPTY) {
          return fail(new Phase4RequestError(
            400,
            'INVALID_REQUEST_BODY',
            'Request body must be empty'
          ));
        }
        return fail(bodyLimitError(policy));
      }
      chunks.push(value);
    }

    function onEnd() {
      finish(Buffer.concat(chunks, bytes));
    }

    function onAborted() {
      fail(disconnectError());
    }

    function onError() {
      fail(disconnectError());
    }

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);

    if (request.readableEnded) finish(Buffer.alloc(0));
  });
}

function generateValidatedRequestId(generator) {
  const generated = generator();
  if (isValidRequestId(generated)) return generated;
  const fallback = crypto.randomUUID();
  if (!isValidRequestId(fallback)) {
    throw new Error('Unable to generate a valid request ID');
  }
  return fallback;
}

function attachRequestId(request, response, generator) {
  const supplied = requestHeader(request, 'x-request-id');
  const requestId = supplied === undefined || !isValidRequestId(supplied)
    ? generateValidatedRequestId(generator)
    : supplied;

  request.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);

  if (supplied !== undefined && !isValidRequestId(supplied)) {
    throw new Phase4RequestError(
      400,
      'INVALID_REQUEST_ID',
      'Invalid X-Request-Id'
    );
  }
  return requestId;
}

function normalizeError(error) {
  if (error instanceof Phase4RequestError) return error;
  return new Phase4RequestError(
    500,
    'REQUEST_BOUNDARY_FAILED',
    'Request boundary failed'
  );
}

function closeUnreadRequestAfterResponse(request, response) {
  response.setHeader('Connection', 'close');
  response.shouldKeepAlive = false;
  response.once('finish', () => {
    if (!request.complete && request.socket && !request.socket.destroyed) {
      setImmediate(() => {
        if (request.socket && !request.socket.destroyed) request.socket.destroy();
      });
    }
  });
}

function sendJsonError(request, response, error) {
  if (response.destroyed || response.writableEnded) return;
  const normalized = normalizeError(error);
  const requestId = request.requestId || generateValidatedRequestId(crypto.randomUUID);
  request.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);
  closeUnreadRequestAfterResponse(request, response);

  const body = {
    error: normalized.message,
    code: normalized.code,
    request_id: requestId
  };
  if (normalized.details !== undefined) body.details = normalized.details;
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');

  response.statusCode = normalized.status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(bytes.length));
  response.end(bytes);
}

function assignParsedMultipart(request, parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Phase4RequestError(
      400,
      'UPLOAD_INVALID_CONTENT',
      'Invalid multipart request'
    );
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'body')) request.body = parsed.body;
  if (Object.prototype.hasOwnProperty.call(parsed, 'file')) request.file = parsed.file;
  if (Object.prototype.hasOwnProperty.call(parsed, 'files')) request.files = parsed.files;
  return parsed;
}

function createPhase4RequestPipeline(options = {}) {
  const {
    registry,
    authenticate,
    admit = async () => true,
    parseMultipart = null,
    onAdmissionFailure = async () => {},
    shouldOwnRequest = () => true,
    generateRequestId = crypto.randomUUID
  } = options;
  const bodyTimeoutMs = options.bodyTimeoutMs === undefined
    ? DEFAULT_BODY_TIMEOUT_MS
    : options.bodyTimeoutMs;
  const requireDurableAdmission = options.requireDurableAdmission === undefined
    ? admit.requiresDurableAdmission === true
    : options.requireDurableAdmission;

  if (!registry || typeof registry.match !== 'function') {
    throw new TypeError('A route policy registry is required');
  }
  if (typeof authenticate !== 'function') {
    throw new TypeError('An authentication function is required');
  }
  if (typeof admit !== 'function') {
    throw new TypeError('An admission function is required');
  }
  if (typeof onAdmissionFailure !== 'function') {
    throw new TypeError('onAdmissionFailure must be a function');
  }
  if (typeof shouldOwnRequest !== 'function') {
    throw new TypeError('shouldOwnRequest must be a function');
  }
  if (typeof generateRequestId !== 'function') {
    throw new TypeError('A request ID generator is required');
  }
  if (typeof requireDurableAdmission !== 'boolean') {
    throw new TypeError('requireDurableAdmission must be a boolean');
  }
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs <= 0) {
    throw new TypeError('bodyTimeoutMs must be a positive safe integer');
  }

  const ownershipDecisions = new WeakMap();

  function cachedOwnershipDecision(request, policy) {
    let decisions = ownershipDecisions.get(request);
    if (!decisions) {
      decisions = new Map();
      ownershipDecisions.set(request, decisions);
    }
    if (!decisions.has(policy)) {
      decisions.set(policy, Boolean(shouldOwnRequest(request, policy)));
    }
    return decisions.get(policy);
  }

  function matchedPolicy(request) {
    return registry.match(
      request.method,
      request.originalUrl || request.url || request.path
    );
  }

  function ownedRoutePredicate(request) {
    const policy = matchedPolicy(request);
    return Boolean(policy && cachedOwnershipDecision(request, policy));
  }

  async function middleware(request, response, next) {
    const policy = matchedPolicy(request);
    if (!policy || !cachedOwnershipDecision(request, policy)) return next();

    try {
      const requestId = attachRequestId(request, response, generateRequestId);
      request.phase4Request = {
        policy,
        requestId,
        rawBody: null,
        multipart: null,
        mediaKind: null,
        admission: null,
        admissionFailed: false
      };

      const authentication = await authenticate(request, {
        requestId,
        policy
      });
      if (!authentication) {
        throw new Phase4RequestError(
          401,
          'AUTHENTICATION_REQUIRED',
          'Authentication required'
        );
      }
      if (!request.user && authentication !== true) {
        request.user = authentication.user || authentication;
      }

      const headerAdmission = validateMediaAndLength(request, policy);
      const admission = await admit(request, {
        requestId,
        policy,
        contentLength: headerAdmission.contentLength
      });
      if (
        requireDurableAdmission && policy.admission &&
        (!admission || typeof admission !== 'object' || Array.isArray(admission))
      ) {
        throw new Phase4RequestError(
          500,
          'UPLOAD_SANDBOX_NOT_READY',
          'Durable upload admission was not established'
        );
      }
      if (admission !== true && admission !== undefined && admission !== null) {
        request.phase4Request.admission = admission;
      }

      const rawBody = headerAdmission.bodyKnownEmpty
        ? Buffer.alloc(0)
        : await readBoundedBody(request, policy, bodyTimeoutMs);
      request.phase4Request.rawBody = rawBody;
      request.phase4Request.mediaKind = headerAdmission.parsedMediaKind;

      if (policy.discardBody) {
        request.body = undefined;
      } else if (headerAdmission.parsedMediaKind === MEDIA_KINDS.JSON) {
        if (rawBody.length === 0) {
          request.body = undefined;
        } else {
          try {
            request.body = JSON.parse(rawBody.toString('utf8'));
          } catch (_error) {
            throw new Phase4RequestError(
              400,
              'INVALID_REQUEST_BODY',
              'Invalid JSON body'
            );
          }
          if (request.body === null || typeof request.body !== 'object') {
            throw new Phase4RequestError(
              400,
              'INVALID_REQUEST_BODY',
              'JSON body must be an object or array'
            );
          }
        }
      } else if (headerAdmission.parsedMediaKind === 'urlencoded') {
        try {
          request.body = qs.parse(rawBody.toString('utf8'), {
            allowPrototypes: false,
            depth: 32,
            parameterLimit: 1000,
            throwOnLimitExceeded: true
          });
        } catch (_error) {
          throw new Phase4RequestError(
            400,
            'INVALID_REQUEST_BODY',
            'Invalid URL-encoded body'
          );
        }
      } else if (policy.mediaKind === MEDIA_KINDS.MULTIPART) {
        if (typeof parseMultipart !== 'function') {
          throw new Error('Multipart parser is not configured');
        }
        request.phase4Request.multipart = assignParsedMultipart(
          request,
          await parseMultipart(request, rawBody, policy)
        );
      }

      return next();
    } catch (error) {
      const phase4Request = request.phase4Request;
      if (
        phase4Request &&
        phase4Request.admission &&
        phase4Request.admissionFailed !== true
      ) {
        phase4Request.admissionFailed = true;
        try {
          await onAdmissionFailure(request, phase4Request.admission, error);
        } catch (_admissionError) {
          return sendJsonError(request, response, new Phase4RequestError(
            500,
            'AUDIT_PERSISTENCE_FAILED',
            'Parser admission failure could not be fenced'
          ));
        }
      }
      return sendJsonError(request, response, error);
    }
  }

  return Object.freeze({
    middleware,
    isOwnedRoute: ownedRoutePredicate,
    shouldSkipGlobalBodyParser: ownedRoutePredicate
  });
}

function createGlobalParserSkipPredicate(registry) {
  return createOwnedRoutePredicate(registry);
}

module.exports = {
  DEFAULT_BODY_TIMEOUT_MS,
  Phase4RequestError,
  createGlobalParserSkipPredicate,
  createPhase4RequestPipeline,
  sendJsonError
};
