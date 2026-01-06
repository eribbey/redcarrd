const axios = require('axios');
const https = require('https');

// SSL verification configuration
// WARNING: Disabling SSL verification exposes you to MITM attacks
// Default: disabled unless explicitly re-enabled via DISABLE_SSL_VERIFICATION=false
const DISABLE_SSL_VERIFICATION = process.env.DISABLE_SSL_VERIFICATION !== 'false';

function createHttpsAgent(logger) {
  if (DISABLE_SSL_VERIFICATION && logger) {
    logger.warn(
      'SSL certificate verification is disabled by default; set DISABLE_SSL_VERIFICATION=false to re-enable strict validation (MITM risk)',
      {
      module: 'solverClient',
      env: 'DISABLE_SSL_VERIFICATION',
      },
    );
  }
  return new https.Agent({ rejectUnauthorized: !DISABLE_SSL_VERIFICATION });
}

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function normalizeSolverCookies(cookies = [], targetUrl) {
  if (!cookies || !cookies.length) return [];

  const fallbackDomain = (() => {
    try {
      return new URL(targetUrl).hostname;
    } catch (_) {
      return undefined;
    }
  })();

  return cookies
    .map((cookie) => {
      if (!cookie) return null;
      const name = cookie.name || cookie.Name;
      const value = cookie.value ?? cookie.Value;
      if (!name || typeof value === 'undefined') return null;

      const domain = cookie.domain || cookie.Domain || fallbackDomain;
      const path = cookie.path || cookie.Path || '/';
      const sameSite = cookie.sameSite || cookie.SameSite;
      const expires = cookie.expires || cookie.Expiry || undefined;

      return {
        name,
        value: String(value),
        domain,
        path,
        expires,
        httpOnly: Boolean(cookie.httpOnly ?? cookie.HttpOnly),
        secure: Boolean(cookie.secure ?? cookie.Secure ?? (fallbackDomain ? targetUrl?.startsWith('https://') : false)),
        sameSite: typeof sameSite === 'string' ? sameSite : undefined,
      };
    })
    .filter(Boolean);
}

class SolverClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint;
    this.provider = (options.provider || 'flaresolverr').toLowerCase();
    this.apiKey = options.apiKey;
    this.maxTimeout = options.maxTimeout || 45000;
    this.enabled = Boolean(this.endpoint);
    this.logger = options.logger;
  }

  async solve(url, options = {}) {
    if (!this.enabled) return null;
    const payloadHeaders = {};
    if (this.apiKey) payloadHeaders['X-Api-Key'] = this.apiKey;

    const requestUserAgent = options.userAgent;
    const requestHeaders = options.headers || {};

    try {
      const requestBody = this.provider === 'byparr'
        ? this.buildByparrPayload(url, requestUserAgent, requestHeaders)
        : this.buildFlaresolverrPayload(url, requestUserAgent, requestHeaders);

      const response = await axios.post(this.endpoint, requestBody, {
        headers: payloadHeaders,
        timeout: this.maxTimeout,
        proxy: false,
        httpsAgent: createHttpsAgent(this.logger),
      });

      return this.normalizeResponse(response.data, url);
    } catch (error) {
      this.logger?.warn?.('Solver client failed', {
        url,
        provider: this.provider,
        endpoint: this.endpoint,
        error: error?.message,
      });
      return null;
    }
  }

  buildFlaresolverrPayload(url, userAgent, headers) {
    const payload = {
      cmd: 'request.get',
      url,
      maxTimeout: this.maxTimeout,
      cookies: [],
      session: undefined,
      returnOnlyCookies: false,
    };

    const cleanedHeaders = { ...headers };
    if (userAgent) cleanedHeaders['User-Agent'] = userAgent;
    if (Object.keys(cleanedHeaders).length > 0) payload.headers = cleanedHeaders;

    return payload;
  }

  buildByparrPayload(url, userAgent, headers) {
    const payload = {
      url,
      session: undefined,
      cookies: [],
      maxTimeout: this.maxTimeout,
    };

    const cleanedHeaders = { ...headers };
    if (userAgent) cleanedHeaders['User-Agent'] = userAgent;
    if (Object.keys(cleanedHeaders).length > 0) payload.headers = cleanedHeaders;

    return payload;
  }

  normalizeResponse(data, url) {
    if (!data) return null;

    const solution = data.solution || data.result || data;
    if (!solution) return null;

    const cookies = Array.isArray(solution.cookies) ? solution.cookies : [];
    const userAgent = solution.userAgent || solution['user-agent'];
    const responseBody = solution.response || solution.body || solution.html;
    const headers = solution.headers || {};

    return {
      html: responseBody,
      cookies,
      userAgent,
      headers,
      normalizedCookies: normalizeSolverCookies(cookies, url),
    };
  }
}

function createSolverClientFromEnv(logger) {
  const endpoint = process.env.SOLVER_ENDPOINT_URL || process.env.SOLVER_URL;
  const provider = (process.env.SOLVER_PROVIDER || 'flaresolverr').toLowerCase();
  const apiKey = process.env.SOLVER_API_KEY;
  const maxTimeoutEnv = parseInt(process.env.SOLVER_MAX_TIMEOUT_MS, 10);
  const maxTimeout = Number.isFinite(maxTimeoutEnv) ? maxTimeoutEnv : 45000;
  const enabled = parseBooleanEnv(process.env.SOLVER_ENABLED, true);

  if (!endpoint || !enabled) {
    return new SolverClient({ endpoint: null, provider, apiKey, maxTimeout, logger });
  }

  return new SolverClient({ endpoint, provider, apiKey, maxTimeout, logger });
}

module.exports = {
  SolverClient,
  createSolverClientFromEnv,
  normalizeSolverCookies,
};
