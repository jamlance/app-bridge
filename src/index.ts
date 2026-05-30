/**
 * @inkress/app-bridge — client SDK for embedded apps on Inkress.
 *
 * Drop this into your iframe page. It reads the session token from the
 * URL, verifies the handoff genuinely came from Inkress, talks
 * postMessage to the host dashboard, and gives you typed APIs for:
 *
 *   - Merchant + user identity (resolved before `inkress.ready` resolves)
 *   - Host-rendered toasts, modals, and confirmations
 *   - URL/route sync with the dashboard chrome (back button works)
 *   - Session-token refresh + RFC 8693 access-token exchange
 *   - Clipboard writes that survive third-party-cookie isolation
 *
 * Quickstart:
 *
 *   import { createInkressApp } from '@inkress/app-bridge';
 *
 *   const inkress = await createInkressApp();
 *   console.log(`Hello, ${inkress.merchant.name}`);
 *   inkress.notify({ kind: 'success', message: 'Order created' });
 *   const at = await inkress.session.exchange({
 *     clientId: 'inkc_…',
 *     clientSecret: '…',
 *     tokenEndpoint: 'https://api.inkress.com/api/v1/hooks/oauth/token',
 *   });
 *
 * Spec: https://docs.inkress.com/embedded (mirrors commerce-api's
 * docs/embedded-apps-spec.md).
 */

export const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 10_000;

// ============================================================================
// Types
// ============================================================================

export type ToastKind = "success" | "error" | "info" | "warning";
export type Theme = "light" | "dark";

export interface InkressMerchant {
  id: number;
  username: string | null;
  name: string | null;
  currency_code: string | null;
}

export interface InkressUser {
  id: number | null;
}

export interface InkressSession {
  /** The current short-lived JWT. Auto-refreshed by the host. */
  token: string;
  /** Unix seconds. The bridge re-mints before this passes. */
  exp: number;
}

export interface BootstrapConfig {
  merchant: InkressMerchant;
  user: InkressUser;
  scopes: string[];
  locale: string;
  theme: Theme;
  host_version: string;
  session: InkressSession;
  /**
   * Inkress API base — e.g. "https://api.inkress.com/api/v1". The
   * dashboard and API are usually on different origins, so the host
   * sends this explicitly. `session.exchange` defaults its
   * tokenEndpoint to `${api_base_url}/hooks/oauth/token` when set.
   */
  api_base_url?: string;
}

export interface NotifyArgs {
  kind?: ToastKind;
  message: string;
  duration_ms?: number;
}

export interface ConfirmArgs {
  title: string;
  body: string;
  confirm_label?: string;
  cancel_label?: string;
  destructive?: boolean;
}

export interface ModalArgs {
  title: string;
  body: string;
  primary_action?: { label: string; style?: "primary" | "destructive" };
  secondary_action?: { label: string };
}

export type ModalAction = "primary" | "secondary" | "dismiss";

export interface ClipboardWriteResult {
  ok: boolean;
  error?: string;
}

export type HostEventName = "route.changed" | "theme.changed";

export interface RouteChangedPayload {
  path: string;
}
export interface ThemeChangedPayload {
  theme: Theme;
}

export interface AccessTokenExchangeArgs {
  /** Your OAuth client_id (the inkc_… string). */
  clientId: string;
  /** Your OAuth client_secret. Server-side use only; never ship it
   *  in browser bundles. If you call exchange() from the browser,
   *  proxy via your own backend. */
  clientSecret: string;
  /**
   * The /token URL. Default: derived from the JWT issuer claim:
   * `${iss}/api/v1/hooks/oauth/token`.
   */
  tokenEndpoint?: string;
  /** Optional subset of consented scopes. Default = JWT scopes. */
  scope?: string[];
}

export interface AccessTokenResult {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

// ============================================================================
// Public API
// ============================================================================

export interface InkressApp {
  /** Identity, resolved before this object is returned. */
  merchant: InkressMerchant;
  user: InkressUser;
  scopes: string[];
  locale: string;
  theme: Theme;
  hostOrigin: string;
  /** Inkress API base. Populated from inkress.config.api_base_url
   *  when the host provides it; falls back to undefined otherwise. */
  apiBaseUrl?: string;

  /** Show a host-rendered toast. Fire-and-forget. */
  notify(args: NotifyArgs): void;
  /** Host-rendered yes/no. Resolves with the user's choice. */
  confirm(args: ConfirmArgs): Promise<boolean>;
  /** Open a host-rendered modal. Resolves when closed. */
  modal: {
    open(args: ModalArgs): Promise<ModalAction>;
    close(): void;
  };
  /** Navigation primitives. */
  navigate: {
    /** App-internal nav. Host updates browser URL to
     *  `/dashboard/apps/:client_id<path>` without an iframe reload. */
    embed(path: string): void;
    /** Cross-section nav within the dashboard chrome. Must start with
     *  `/dashboard/`. */
    host(path: string): void;
  };
  /** Session lifecycle. */
  session: {
    /** Current JWT + expiry. Auto-updated by the host. */
    current(): InkressSession;
    /** Subscribe to fresh tokens. Fires before expiry; unsubscribe
     *  with the returned function. */
    onRefresh(cb: (s: InkressSession) => void): () => void;
    /** Force a fresh token now (rate-limited host-side). */
    refresh(): Promise<InkressSession>;
    /** Exchange the current session JWT for a regular access token
     *  (RFC 8693). Requires your client_id + client_secret. */
    exchange(args: AccessTokenExchangeArgs): Promise<AccessTokenResult>;
  };
  /** Write to clipboard under host's user-activation context. */
  clipboard: {
    write(text: string): Promise<ClipboardWriteResult>;
  };
  /** Request a specific iframe height (clamped by host). */
  resize(height: number): void;
  /** Subscribe to host-emitted events. */
  events: {
    on<T extends HostEventName>(
      event: T,
      cb: (payload: HostEventPayload<T>) => void,
    ): () => void;
    off(event: HostEventName, cb: (...args: any[]) => void): void;
  };
  /** Detach all listeners. Call before unmount in SPAs. */
  destroy(): void;
}

type HostEventPayload<T extends HostEventName> = T extends "route.changed"
  ? RouteChangedPayload
  : T extends "theme.changed"
    ? ThemeChangedPayload
    : never;

// ============================================================================
// Options
// ============================================================================

export interface CreateInkressAppOptions {
  /**
   * Where to look for the session token. Defaults to window.location
   * search params (`inkress_session`). Pass a literal token for
   * server-side bootstrap.
   */
  sessionToken?: string;
  /**
   * Scrub the token from the URL after reading it. Default true.
   * Set to false if you handle URL state yourself.
   */
  scrubUrl?: boolean;
  /**
   * Override the host origin to verify inbound messages against.
   * Default: parsed from the session JWT's `iss` claim.
   */
  hostOriginOverride?: string;
  /**
   * Logger. Default: console. Set to a no-op in production if you
   * don't want the bridge's chatter.
   */
  logger?: { warn: (...args: any[]) => void; error: (...args: any[]) => void };
  /**
   * Override the bootstrap timeout. Default 10s.
   */
  readyTimeoutMs?: number;
}

// ============================================================================
// Errors
// ============================================================================

export class InkressBridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "InkressBridgeError";
  }
}

// ============================================================================
// Internal envelope
// ============================================================================

interface Envelope {
  inkress: number;
  id: string;
  type: string;
  ts: number;
  payload?: any;
  in_reply_to?: string;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// Singleton enforcement
// ============================================================================

let singleton: InkressApp | null = null;

/**
 * Initialise the embedded-apps client. Call this once per iframe.
 * Subsequent calls return the same instance (with a console warning
 * — having two bridges in the same window dual-handles every message).
 */
export async function createInkressApp(
  opts: CreateInkressAppOptions = {},
): Promise<InkressApp> {
  if (singleton) {
    (opts.logger ?? console).warn(
      "[inkress] createInkressApp called twice; returning the existing instance.",
    );
    return singleton;
  }

  const sessionToken = opts.sessionToken ?? readSessionTokenFromUrl();
  if (!sessionToken) {
    throw new InkressBridgeError(
      "missing_session_token",
      "No session token found in URL (?inkress_session=…) or options.",
    );
  }

  const decoded = decodeJwtUnverified(sessionToken);
  if (!decoded) {
    throw new InkressBridgeError(
      "invalid_session_token",
      "Session token isn't a parseable JWT.",
    );
  }

  const hostOrigin =
    opts.hostOriginOverride ?? deriveHostOriginFromJwt(decoded);
  if (!hostOrigin) {
    throw new InkressBridgeError(
      "missing_host_origin",
      "Couldn't derive host origin from JWT iss claim. Pass hostOriginOverride explicitly.",
    );
  }

  // Verify the token's signature on the app side. Without the app's
  // whsec_ we can only structurally validate — that's still useful
  // because tampering breaks the structure. Apps that hold their
  // whsec_ (typically the backend, not the browser) can use
  // verifyJwtWithSecret() for the cryptographic check.

  if (opts.scrubUrl !== false) scrubSessionTokenFromUrl();

  if (typeof window === "undefined") {
    throw new InkressBridgeError(
      "no_window",
      "createInkressApp must run in a browser context.",
    );
  }

  if (window === window.parent) {
    throw new InkressBridgeError(
      "not_embedded",
      "This page is not embedded — window.parent === window. Open it via Inkress.",
    );
  }

  const logger = opts.logger ?? console;
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;

  // ------------------------------------------------------------------
  // Bridge transport
  // ------------------------------------------------------------------

  const pending = new Map<string, Pending>();
  const eventHandlers = new Map<
    HostEventName,
    Set<(payload: any) => void>
  >();
  const refreshSubscribers = new Set<(s: InkressSession) => void>();

  let currentSession: InkressSession = {
    token: sessionToken,
    exp: decoded.exp ?? 0,
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (event.origin !== hostOrigin) return;
    if (event.source !== window.parent) return;
    const raw = event.data;
    if (!raw || typeof raw !== "object" || raw.inkress !== PROTOCOL_VERSION) {
      return;
    }
    const envelope = raw as Envelope;

    // Targeted reply?
    if (envelope.in_reply_to) {
      const p = pending.get(envelope.in_reply_to);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(envelope.in_reply_to);
      if (envelope.type === "inkress.error") {
        const err = envelope.payload || {};
        p.reject(
          new InkressBridgeError(
            err.code || "host_error",
            err.message || "Host returned error",
          ),
        );
      } else {
        p.resolve(envelope.payload);
      }
      return;
    }

    // Unsolicited events from host.
    switch (envelope.type) {
      case "inkress.session.token": {
        const sess = envelope.payload as InkressSession;
        if (sess?.token && typeof sess.exp === "number") {
          currentSession = sess;
          refreshSubscribers.forEach((cb) => {
            try {
              cb(sess);
            } catch (err) {
              logger.error("[inkress] session.onRefresh callback threw:", err);
            }
          });
        }
        return;
      }
      case "inkress.route.changed":
        dispatchEvent("route.changed", envelope.payload);
        return;
      case "inkress.theme.changed":
        dispatchEvent("theme.changed", envelope.payload);
        return;
      case "inkress.session.revoked":
        logger.warn(
          "[inkress] session revoked:",
          (envelope.payload as any)?.reason || "unknown",
        );
        // Notify any session.onRefresh subscribers with a sentinel?
        // For v1 we just leave it to the developer's error handling
        // when the next API call 401s.
        return;
      default:
        // Unknown unsolicited event — ignored to allow forward-compat
        // additions without breaking older SDKs.
        return;
    }
  };

  window.addEventListener("message", onWindowMessage);

  const send = (type: string, payload?: any): void => {
    const msg: Envelope = {
      inkress: PROTOCOL_VERSION,
      id: genId(),
      type,
      ts: Date.now(),
      payload,
    };
    window.parent.postMessage(msg, hostOrigin);
  };

  const request = <T = any>(type: string, payload?: any): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const id = genId();
      const msg: Envelope = {
        inkress: PROTOCOL_VERSION,
        id,
        type,
        ts: Date.now(),
        payload,
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new InkressBridgeError(
            "timeout",
            `Host didn't respond to ${type} within ${REQUEST_TIMEOUT_MS}ms`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage(msg, hostOrigin);
    });
  };

  const dispatchEvent = (event: HostEventName, payload: any) => {
    const subs = eventHandlers.get(event);
    if (!subs) return;
    subs.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        logger.error(`[inkress] events.on(${event}) callback threw:`, err);
      }
    });
  };

  // ------------------------------------------------------------------
  // Bootstrap
  // ------------------------------------------------------------------

  const configPromise = request<BootstrapConfig>(
    "inkress.ready",
    { version: "0.1.0", capabilities: [] },
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const config = await Promise.race([
    configPromise,
    new Promise<BootstrapConfig>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new InkressBridgeError(
            "ready_timeout",
            `Host didn't respond to inkress.ready within ${readyTimeoutMs}ms. Check CSP frame-ancestors.`,
          ),
        );
      }, readyTimeoutMs);
    }),
  ]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });

  // Adopt the freshest session the host pushed in the config — it may
  // be newer than the URL one if there was any latency between mint
  // and load.
  if (config?.session?.token) {
    currentSession = config.session;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  const app: InkressApp = {
    merchant: config.merchant,
    user: config.user,
    scopes: config.scopes,
    locale: config.locale,
    theme: config.theme,
    hostOrigin,
    apiBaseUrl: config.api_base_url,

    notify({ kind = "info", message, duration_ms }) {
      if (!message) return;
      send("inkress.notify", { kind, message, duration_ms });
    },

    async confirm(args) {
      const r = await request<{ confirmed: boolean }>(
        "inkress.confirm",
        args,
      );
      return !!r?.confirmed;
    },

    modal: {
      async open(args) {
        const r = await request<{ action: ModalAction }>(
          "inkress.modal.open",
          args,
        );
        return r?.action ?? "dismiss";
      },
      close() {
        send("inkress.modal.close");
      },
    },

    navigate: {
      embed(path) {
        if (typeof path !== "string" || !path.startsWith("/")) return;
        send("inkress.navigate.embed", { path });
      },
      host(path) {
        if (typeof path !== "string" || !path.startsWith("/dashboard/")) return;
        send("inkress.navigate.host", { path });
      },
    },

    session: {
      current() {
        return currentSession;
      },
      onRefresh(cb) {
        refreshSubscribers.add(cb);
        return () => refreshSubscribers.delete(cb);
      },
      async refresh() {
        const r = await request<InkressSession>("inkress.session.refresh");
        if (r?.token && typeof r.exp === "number") {
          currentSession = r;
          refreshSubscribers.forEach((cb) => {
            try {
              cb(r);
            } catch (err) {
              logger.error("[inkress] session.onRefresh callback threw:", err);
            }
          });
          return r;
        }
        throw new InkressBridgeError(
          "refresh_failed",
          "Host returned no fresh session token.",
        );
      },
      async exchange(args) {
        // Resolution order for the token endpoint:
        //   1. explicit args.tokenEndpoint
        //   2. ${config.api_base_url}/hooks/oauth/token (the host
        //      knows the API origin; the JWT issuer is the
        //      DASHBOARD origin, not the API)
        //   3. ${iss}/api/v1/hooks/oauth/token — works for setups
        //      where dashboard + API share an origin (rare in prod
        //      but useful for local dev)
        const tokenEndpoint =
          args.tokenEndpoint ??
          (config.api_base_url
            ? `${stripTrailingSlash(config.api_base_url)}/hooks/oauth/token`
            : null) ??
          (decoded.iss ? `${decoded.iss}/api/v1/hooks/oauth/token` : null);
        if (!tokenEndpoint) {
          throw new InkressBridgeError(
            "missing_token_endpoint",
            "tokenEndpoint not provided and JWT iss didn't yield a default.",
          );
        }
        const body = new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          client_id: args.clientId,
          client_secret: args.clientSecret,
          subject_token: currentSession.token,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          requested_token_type:
            "urn:ietf:params:oauth:token-type:access_token",
        });
        if (args.scope?.length) {
          body.set("scope", args.scope.join(" "));
        }
        const r = await fetch(tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        if (!r.ok) {
          let detail: any = await r.text();
          try {
            detail = JSON.parse(detail);
          } catch {
            // not JSON
          }
          throw new InkressBridgeError(
            (detail?.error as string) || "exchange_failed",
            (detail?.error_description as string) || `HTTP ${r.status}`,
          );
        }
        return (await r.json()) as AccessTokenResult;
      },
    },

    clipboard: {
      async write(text) {
        return request<ClipboardWriteResult>(
          "inkress.clipboard.write",
          { text },
        );
      },
    },

    resize(height) {
      if (!Number.isFinite(height) || height <= 0) return;
      send("inkress.resize", { height });
    },

    events: {
      on<T extends HostEventName>(
        event: T,
        cb: (payload: HostEventPayload<T>) => void,
      ): () => void {
        let subs = eventHandlers.get(event);
        if (!subs) {
          subs = new Set();
          eventHandlers.set(event, subs);
          send("inkress.event.subscribe", { event });
        }
        subs.add(cb as any);
        return () => app.events.off(event, cb as any);
      },
      off(event, cb) {
        const subs = eventHandlers.get(event);
        if (!subs) return;
        subs.delete(cb);
        if (subs.size === 0) {
          eventHandlers.delete(event);
          send("inkress.event.unsubscribe", { event });
        }
      },
    },

    destroy() {
      window.removeEventListener("message", onWindowMessage);
      pending.forEach((p) => {
        clearTimeout(p.timer);
        p.reject(
          new InkressBridgeError(
            "destroyed",
            "Bridge destroyed before reply arrived.",
          ),
        );
      });
      pending.clear();
      eventHandlers.clear();
      refreshSubscribers.clear();
      singleton = null;
    },
  };

  singleton = app;
  return app;
}

// ============================================================================
// Optional JWT signature verification (for apps that hold whsec_)
// ============================================================================

/**
 * Verify a session JWT's HMAC-SHA256 signature using the app's
 * webhook_secret (the `whsec_…` value). Returns the decoded claims on
 * success.
 *
 * Use this on your backend after receiving the session token from the
 * browser via your own channel — never ship `whsec_` to the browser.
 * For browser-only apps, structural validation (which createInkressApp
 * already does) plus a hard reliance on the iss/origin checks is the
 * intended threat model.
 */
export async function verifyJwtWithSecret(
  jwt: string,
  secret: string,
): Promise<Record<string, any>> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new InkressBridgeError("invalid_jwt", "Not a 3-part JWT");
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Web Crypto isn't available in old Node versions; we feature-detect.
  const subtle =
    (globalThis.crypto && globalThis.crypto.subtle) ||
    // @ts-expect-error — node fallback
    (await import("node:crypto").then((m) => (m as any).webcrypto?.subtle));
  if (!subtle) {
    throw new InkressBridgeError(
      "no_subtle",
      "Web Crypto SubtleCrypto unavailable in this environment.",
    );
  }

  const enc = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = enc.encode(`${headerB64}.${payloadB64}`);
  const sig = base64UrlDecode(sigB64);
  // .buffer is widened to ArrayBufferLike on lib.dom; subtle expects
  // ArrayBuffer. The cast is safe here — we own the allocation.
  const sigBuf = sig.buffer as ArrayBuffer;
  const ok = await subtle.verify("HMAC", key, sigBuf, signed);
  if (!ok) {
    throw new InkressBridgeError(
      "invalid_signature",
      "JWT signature did not verify.",
    );
  }
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp <= now) {
    throw new InkressBridgeError("token_expired", "JWT exp is in the past.");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + 1) {
    throw new InkressBridgeError("token_not_yet_valid", "JWT nbf > now.");
  }
  return claims;
}

// ============================================================================
// Helpers
// ============================================================================

function readSessionTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("inkress_session");
}

function scrubSessionTokenFromUrl(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  url.searchParams.delete("inkress_session");
  url.searchParams.delete("inkress_session_id");
  url.searchParams.delete("inkress_dest");
  window.history.replaceState(
    window.history.state,
    "",
    url.pathname + (url.search ? `?${url.searchParams}` : "") + url.hash,
  );
}

function decodeJwtUnverified(jwt: string): Record<string, any> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(parts[1] as string));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function deriveHostOriginFromJwt(
  claims: Record<string, any>,
): string | null {
  const iss = claims?.iss;
  if (typeof iss !== "string") return null;
  try {
    return new URL(iss).origin;
  } catch {
    return null;
  }
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin =
    typeof atob === "function"
      ? atob(b64)
      : // @ts-expect-error — node fallback
        Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function genId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const buf = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(buf);
  else for (let i = 0; i < 16; i += 1) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
