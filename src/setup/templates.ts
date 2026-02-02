import { randomBytes } from "crypto";

/**
 * Generate a 64-character hex secret key for SearXNG
 */
export function generateSecretKey(): string {
    return randomBytes(32).toString("hex");
}

/**
 * Generate docker-compose.yml content
 */
export function getDockerComposeTemplate(port: number): string {
    return `services:
  searxng:
    image: searxng/searxng:latest
    container_name: peeky-searxng
    restart: unless-stopped
    ports:
      - "${port}:8080"
    volumes:
      - ./settings.yml:/etc/searxng/settings.yml:ro
`;
}

/**
 * Generate SearXNG settings.yml content
 *
 * Default: Brave + Google + DuckDuckGo for redundancy
 * Users can edit ~/.peeky-search/settings.yml to customize engines
 */
export function getSettingsTemplate(secretKey: string): string {
    return `use_default_settings: true

server:
  secret_key: "${secretKey}"
  limiter: false        # no rate limiting for local use

search:
  safe_search: 0        # no filtering (technical content)
  default_lang: "en"    # English results
  ban_time_on_fail: 5   # initial ban time (seconds)
  max_ban_time_on_fail: 60  # max ban time (reduced from default 120)
  suspended_times:
    SearxEngineTooManyRequests: 300   # 5 min (reduced from 1 hour)
    SearxEngineAccessDenied: 3600     # 1 hour (reduced from 24 hours)
    SearxEngineCaptcha: 3600          # 1 hour (reduced from 24 hours)
  formats:
    - html
    - json

outgoing:
  request_timeout: 4.0  # slightly longer timeout for reliability
  enable_http2: true    # faster connections
  retries: 1            # retry failed requests once

# Engines: Brave + Google as primary, DuckDuckGo as fallback
# Each has retry settings for resilience
engines:
  - name: brave
    disabled: false
    timeout: 5.0
    retries: 1
    retry_on_http_error: [429, 503]  # retry on rate limit and unavailable
  - name: google
    disabled: false
    timeout: 4.0
    retries: 1
    retry_on_http_error: [429, 503]
  - name: duckduckgo
    disabled: false     # enabled as fallback
    timeout: 4.0
    retries: 1
  - name: startpage
    disabled: true
  - name: bing
    disabled: true
  - name: qwant
    disabled: true
  - name: mojeek
    disabled: true
  - name: yahoo
    disabled: true
`;
}

/**
 * Generate config.json content
 */
export function getConfigTemplate(port: number): string {
    return JSON.stringify(
        {
            port,
            installedAt: new Date().toISOString(),
        },
        null,
        2
    );
}

/**
 * Generate MCP client config JSON for display
 */
export function getMcpConfigJson(port: number): string {
    return JSON.stringify(
        {
            mcpServers: {
                "peeky-search": {
                    command: "npx",
                    args: ["-y", "peeky-search", "mcp"],
                    env: {
                        SEARXNG_URL: `http://localhost:${port}`,
                    },
                },
            },
        },
        null,
        2
    );
}
