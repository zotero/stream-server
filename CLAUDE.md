# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Start server:** `npm start`
- **Run tests:** `npm test` (sets `NODE_ENV=test`, uses Mocha)
- **Run benchmark:** `npm run benchmark`

There is no lint or build step.

## Architecture

This is the Zotero Stream Server -- a WebSocket-based push notification service for the Zotero API. Clients connect via WebSocket and subscribe to topics (e.g., `/users/123456`, `/groups/234567`). When changes occur, notifications are delivered in real time via Redis pub/sub.

### Core modules

- **server.js** -- Main entry point (exported as an async function called by `index.js`). Creates the HTTP/HTTPS server, attaches the WebSocket server (`ws` library), handles WebSocket connection lifecycle, and processes client messages (`createSubscriptions`, `deleteSubscriptions`). Accepts an `onInit` callback used by tests.
- **connections.js** -- Singleton (IIFE) managing all active WebSocket connections and subscriptions in memory. Tracks three indexes: `connections[]` (array of connection objects), `topicSubscriptions{}` (topic -> subscriptions), and `keySubscriptions{}` (apiKey -> subscriptions). Handles Redis notifications (`handleNotification`) and dispatches events like `topicUpdated`, `topicAdded`, `topicRemoved`, `topicDeleted` to connected clients. Also manages keepalive ping/pong and debouncing of continued notifications.
- **zotero_api.js** -- Zotero API client. `getKeyInfo()` resolves an API key to its accessible topics (user libraries and groups). `checkPublicTopicAccess()` verifies public topic access. Uses `cwait.TaskQueue` for concurrency limiting (max 10 concurrent API requests) and a 5-second request timeout.
- **redis.js** -- Creates and configures the Redis client (subscribe-only, with exponential retry). The Redis connection is used purely for pub/sub -- no key/value storage.
- **utils.js** -- Singleton with `WSError` (custom error with WebSocket close codes; HTTP-range codes are offset by +4000), `end()` for HTTP responses, and `wsEnd()` for WebSocket close frames.
- **log.js** -- Singleton logger with levels: trace, debug, info, warn, error. Automatically redacts API keys from output.
- **statsd.js** -- StatsD client for metrics; stubs all methods if no host is configured.

### Connection model

There are two connection modes:
1. **Single-key** -- Client provides an API key at connect time (via `?key=` query param or `Zotero-API-Key` header). Subscriptions are automatically created for all accessible topics + global topics. Connection cannot be modified afterward.
2. **Multi-key** -- Client connects without a key, then sends `createSubscriptions`/`deleteSubscriptions` messages to manage subscriptions. Supports multiple API keys and public topics per connection.

Connections with "access tracking" enabled (all single-key connections and multi-key connections that subscribed without specifying topics) automatically receive `topicAdded`/`topicRemoved` events when the API key's access changes.

### Configuration

Uses the `config` npm package. `config/default.js` has defaults; override with `config/local.js` or environment-specific files. Key settings: `httpPort`, `redis.url`, `redis.prefix`, `apiURL`, `globalTopics`, `trustedProxies`, delay timings.

### Tests

Tests are in `test/server_test.js` using Mocha + Chai + Sinon. Redis is mocked via `mockery` (substitutes `redis` with `test/support/redis_mock.js`). The mock's `postMessages()` simulates Redis pub/sub. The Zotero API is stubbed with Sinon. `test/support/websocket.js` wraps the `ws` client with a promise-based `send()` that waits for expected events.

## Code Style

- Uses `var` extensively (legacy codebase); `let` is acceptable for new code
- Tab indentation
- Non-cuddled braces (opening brace on same line, `else`/`catch` on new line after closing brace)
- CommonJS modules (`require`/`module.exports`)
- Singletons via IIFEs (`module.exports = function() { ... }()`)
- `"use strict"` at file top
- WebSocket close codes use 4000+ range (HTTP status + 4000)
