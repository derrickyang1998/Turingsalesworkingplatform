'use strict';

const http = require('node:http');
const dns = require('node:dns');
const dgram = require('node:dgram');
const net = require('node:net');
const { AsyncLocalStorage } = require('node:async_hooks');

const express = require('express');
const jwt = require('jsonwebtoken');

const PROTOCOL = 'tm-phase4-one-request-replay-probe-v1';
const TARGET_METHOD = 'POST';
const TARGET_PATH = '/api/workflow/templates';
const fault = process.env.TM_PHASE4_ONE_REQUEST_REPLAY_FAULT || 'none';
const storage = new AsyncLocalStorage();
let requestAttempt = 0;
let eventSequence = 0;

function requestPath(value) {
  try {
    return new URL(String(value || ''), 'http://phase4.local').pathname;
  } catch (_error) {
    return null;
  }
}

function isTargetRequest(request) {
  return request &&
    request.method === TARGET_METHOD &&
    requestPath(request.url) === TARGET_PATH;
}

function emitProbe(context, kind, details = {}) {
  if (typeof process.send !== 'function' || !process.connected) return;
  try {
    process.send({
      protocol: PROTOCOL,
      sequence: ++eventSequence,
      attempt: context && context.attempt || 0,
      kind,
      ...details
    });
  } catch (_error) {
    // The parent can close the IPC channel while the test server is stopping.
  }
}

function isLoopbackHost(value) {
  const host = String(value === undefined ? 'localhost' : value)
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%[0-9a-z_.-]+$/i, '');
  return host === 'localhost' ||
    host === '::1' ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(host) ||
    /^::ffff:127(?:\.[0-9]{1,3}){3}$/.test(host);
}

function blockExternalNetwork(transport, host, port = null) {
  const context = storage.getStore();
  emitProbe(context, 'external-network-attempt', {
    transport,
    host: host === undefined ? null : String(host),
    port: port === undefined ? null : port
  });
  const error = new Error(
    `Phase 4 replay proof blocked non-loopback ${transport} networking`
  );
  error.code = 'TM_EXTERNAL_NETWORK_BLOCKED';
  throw error;
}

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function observedSocketConnect(...args) {
  const first = args[0];
  let host;
  let port = null;
  let isUnixSocket = false;
  if (first && typeof first === 'object') {
    isUnixSocket = typeof first.path === 'string';
    host = first.host;
    port = first.port === undefined ? null : first.port;
  } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
    isUnixSocket = true;
  } else {
    port = first === undefined ? null : first;
    host = typeof args[1] === 'string' ? args[1] : undefined;
  }
  if (!isUnixSocket && !isLoopbackHost(host)) {
    return blockExternalNetwork('tcp', host, port);
  }
  return originalSocketConnect.apply(this, args);
};

function guardDnsMethod(owner, methodName) {
  const original = owner && owner[methodName];
  if (typeof original !== 'function') return;
  owner[methodName] = function guardedDnsMethod(host, ...args) {
    if (!isLoopbackHost(host)) {
      return blockExternalNetwork(`dns.${methodName}`, host);
    }
    return original.call(this, host, ...args);
  };
}

for (const methodName of [
  'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
  'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
  'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'
]) {
  guardDnsMethod(dns, methodName);
  guardDnsMethod(dns.Resolver && dns.Resolver.prototype, methodName);
  guardDnsMethod(dns.promises, methodName);
  guardDnsMethod(
    dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype,
    methodName
  );
}

const originalDgramSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function guardedDgramSend(...args) {
  const address = args
    .slice(1)
    .filter((value) => typeof value === 'string')
    .at(-1);
  if (!address || !isLoopbackHost(address)) {
    return blockExternalNetwork('udp', address);
  }
  return originalDgramSend.apply(this, args);
};

function listenerSource() {
  const stack = String(new Error().stack || '').replace(/\\/g, '/');
  if (stack.includes('/middleware/phase4_request_pipeline.js')) return 'phase4';
  if (/\/(?:body-parser|raw-body)\//.test(stack)) return 'global';
  return 'other';
}

const originalAddListener = http.IncomingMessage.prototype.addListener;
function observedAddListener(eventName, listener) {
  const context = storage.getStore();
  if (context && eventName === 'data') {
    const source = listenerSource();
    context.bodyListeners[source] += 1;
    emitProbe(context, 'body-listener', { source });
  }
  return originalAddListener.call(this, eventName, listener);
}
http.IncomingMessage.prototype.addListener = observedAddListener;
http.IncomingMessage.prototype.on = observedAddListener;

function wrappedParserFactory(parser, originalFactory) {
  return function createObservedParser(options) {
    let configuredOptions = options;
    if (fault === 'parser-bypass' && parser === 'json') {
      configuredOptions = { ...(options || {}), type: () => true };
    }
    const middleware = originalFactory.call(this, configuredOptions);
    return function observedParser(request, response, next) {
      const context = storage.getStore();
      if (!context) return middleware(request, response, next);
      const beforeGlobalListeners = context.bodyListeners.global;
      return middleware(request, response, (error) => {
        emitProbe(context, 'global-parser-finished', {
          parser,
          body_value_present: request.body !== undefined,
          readable_ended: Boolean(request.readableEnded),
          data_listeners_added:
            context.bodyListeners.global - beforeGlobalListeners
        });
        return next(error);
      });
    };
  };
}

express.json = wrappedParserFactory('json', express.json);
express.urlencoded = wrappedParserFactory('urlencoded', express.urlencoded);

const originalVerify = jwt.verify;
jwt.verify = function observedJwtVerify(...args) {
  const context = storage.getStore();
  if (context) emitProbe(context, 'jwt-verify');
  return originalVerify.apply(this, args);
};

const originalServerEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function observedServerEmit(eventName, ...args) {
  if (eventName !== 'request' || !isTargetRequest(args[0])) {
    return originalServerEmit.call(this, eventName, ...args);
  }

  const request = args[0];
  const response = args[1];
  const context = {
    attempt: ++requestAttempt,
    bodyListeners: { phase4: 0, global: 0, other: 0 }
  };

  if (fault === 'mutation-bypass' && context.attempt === 2) {
    request.headers['idempotency-key'] =
      `${request.headers['idempotency-key']}.bypass`;
    emitProbe(context, 'fault-injected', { fault: 'mutation-bypass' });
  }

  if (fault === 'auth-bypass') {
    const userId = Number(
      process.env.TM_PHASE4_ONE_REQUEST_REPLAY_USER_ID || '1'
    );
    delete request.headers.authorization;
    request.user = {
      id: userId,
      username: 'phase4-replay-proof',
      display_name: 'Phase 4 replay proof',
      role: 'admin',
      department: 'verification',
      api_quota: 1
    };
    request.authContext = { fixture_identity_injected: true };
    emitProbe(context, 'fault-injected', { fault: 'auth-bypass' });
  }

  return storage.run(context, () => {
    if (fault === 'network-bypass' && context.attempt === 1) {
      const socket = new net.Socket();
      try {
        socket.connect({ host: '203.0.113.1', port: 443 });
      } catch (error) {
        if (!error || error.code !== 'TM_EXTERNAL_NETWORK_BLOCKED') throw error;
      } finally {
        socket.destroy();
      }
      emitProbe(context, 'fault-injected', { fault: 'network-bypass' });
    }
    emitProbe(context, 'request-enter', {
      authorization_present: typeof request.headers.authorization === 'string',
      content_length: request.headers['content-length'] || null
    });
    response.once('finish', () => {
      emitProbe(context, 'request-finished', {
        status_code: response.statusCode,
        body_listeners: { ...context.bodyListeners }
      });
    });
    return originalServerEmit.call(this, eventName, ...args);
  });
};
