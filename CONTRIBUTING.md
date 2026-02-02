# Contributing to peeky-search

Thanks for your interest in contributing! This document outlines the process for contributing to this project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/TripCreighton/peeky-search.git`
3. Install dependencies: `pnpm install`
4. Create a branch: `git checkout -b my-feature`

## Development

```bash
pnpm build          # Compile TypeScript
pnpm build:watch    # Watch mode
pnpm test           # Run tests in watch mode
pnpm test:run       # Run tests once
```

## Before Submitting a PR

1. **Run tests:** `pnpm test:run` - all tests must pass
2. **Type check:** `pnpm build:tsc` - no type errors
3. **Test your changes manually** with the CLI or MCP server

## Pull Request Process

1. Update documentation if you're changing behavior
2. Add tests for new functionality
3. Keep PRs focused - one feature or fix per PR
4. Write a clear PR description explaining what and why

## Code Style

- Use TypeScript strict mode
- Prefer `const` over `let`
- Use type-only imports: `import type { Foo } from "./foo"`
- Handle `undefined` from array access (we use `noUncheckedIndexedAccess`)
- Keep functions small and focused

## Commit Messages

Write clear commit messages that explain what changed:

```
Add title relevance filtering to pre-scrape stage

Skip scraping pages where title/snippet don't contain enough
query tokens. Reduces wasted bandwidth on irrelevant results.
```

## Tests

- Place tests in `__tests__/` directories next to the code they test
- Use descriptive test names that explain the behavior
- Follow the Arrange-Act-Assert pattern

## Questions?

Open an issue for discussion before starting major changes. This helps ensure your work aligns with the project direction.
