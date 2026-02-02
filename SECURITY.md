# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in peeky-search, please report it privately rather than opening a public issue.

Create a private security advisory on GitHub at https://github.com/TripCreighton/peeky-search/security/advisories/new

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 1 week
- **Fix timeline:** Depends on severity, typically 1-4 weeks

### Scope

This policy applies to:
- The peeky-search npm package
- The MCP server implementation
- The CLI tool

This policy does not cover:
- SearXNG (report to their project)
- Third-party dependencies (report to their maintainers)

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Security Considerations

peeky-search fetches content from URLs. Users should be aware:

- **Network requests:** The tool makes HTTP requests to URLs you provide or that SearXNG returns
- **No sandboxing:** HTML is parsed but JavaScript is not executed
- **Local Docker:** SearXNG runs locally in Docker; no queries go to third parties
