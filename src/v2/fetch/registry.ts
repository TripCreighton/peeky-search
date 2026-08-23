/**
 * npm registry adapter.
 *
 * v1 blocklists npmjs.com package pages outright (403, JS-rendered).
 * `registry.npmjs.org/{name}` is the unauthenticated source of truth for a
 * package: description, README, and the repository/homepage links a page
 * scrape would have to reconstruct from rendered HTML anyway.
 */

import type { Doc, DocLink, DocNode } from "../types";
import type { FetchOptions, SourceAdapter } from "./types";
import { markdownToNodes } from "./markdown-nodes";

const REGISTRY_BASE = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Extract the package name from an npmjs.com package page URL, or null if this isn't one. */
export function parseNpmPackageUrl(urlStr: string): string | null {
    let url: URL;
    try {
        url = new URL(urlStr);
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase();
    if (host !== "npmjs.com" && host !== "www.npmjs.com") return null;

    // /package/{name} or /package/{@scope/name}, optionally with /v/{version}
    const match = /^\/package\/((?:@[^/]+\/)?[^/]+)/.exec(url.pathname);
    if (match?.[1] === undefined) return null;

    return decodeURIComponent(match[1]);
}

interface NpmRegistryPerson {
    name?: string;
}

interface NpmRepository {
    type?: string;
    url?: string;
}

interface NpmRegistryDoc {
    name: string;
    description?: string;
    readme?: string;
    homepage?: string;
    repository?: NpmRepository | string;
    author?: NpmRegistryPerson | string;
    "dist-tags"?: { latest?: string };
    time?: Record<string, string>;
}

interface NpmLatestVersionDoc {
    name: string;
    version?: string;
    description?: string;
    homepage?: string;
    repository?: NpmRepository | string;
}

function normalizeRepoUrl(repo: NpmRepository | string | undefined): string | null {
    if (repo === undefined) return null;
    const raw = typeof repo === "string" ? repo : repo.url;
    if (raw === undefined || raw.length === 0) return null;
    return raw
        .replace(/^git\+/, "")
        .replace(/^git:\/\//, "https://")
        .replace(/\.git$/, "");
}

async function fetchJson<T>(url: string, timeoutMs: number, userAgent: string): Promise<T | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": userAgent, "Accept": "application/json" },
        });
        if (!response.ok) return null;
        return (await response.json()) as T;
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Resolve a package's declared homepage or repository URL. Kept separate
 * from the full adapter fetch (which pulls description + README too) and
 * backed by the small `/latest` endpoint rather than the full registry doc,
 * since a later milestone calls this on the hot path to decide whether a
 * domain is the canonical source for a library and shouldn't pay for a
 * multi-KB-to-multi-MB registry document just to answer that.
 */
export async function resolveHomepage(packageName: string): Promise<string | null> {
    const url = `${REGISTRY_BASE}/${encodeURIComponent(packageName)}/latest`;
    const doc = await fetchJson<NpmLatestVersionDoc>(url, DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT);
    if (doc === null) return null;
    if (doc.homepage !== undefined && doc.homepage.length > 0) return doc.homepage;
    return normalizeRepoUrl(doc.repository);
}

export const registryAdapter: SourceAdapter = {
    name: "registry",

    canHandle(url: string): boolean {
        return parseNpmPackageUrl(url) !== null;
    },

    async fetch(url: string, opts: FetchOptions = {}): Promise<Doc | null> {
        const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
        const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

        const name = parseNpmPackageUrl(url);
        if (name === null) return null;

        const registryUrl = `${REGISTRY_BASE}/${encodeURIComponent(name)}`;
        const doc = await fetchJson<NpmRegistryDoc>(registryUrl, timeoutMs, userAgent);
        if (doc === null) return null;

        const homepage = doc.homepage;
        const repoUrl = normalizeRepoUrl(doc.repository);

        const nodes: DocNode[] = [];
        let order = 0;

        if (doc.description !== undefined && doc.description.trim().length > 0) {
            const links: DocLink[] = [];
            if (homepage !== undefined && homepage.length > 0) links.push({ text: "Homepage", href: homepage });
            if (repoUrl !== null) links.push({ text: "Repository", href: repoUrl });

            nodes.push({
                kind: "prose",
                text: doc.description.trim(),
                order: order++,
                headingPath: [],
                ...(links.length > 0 ? { links } : {}),
            });
        }

        if (doc.readme !== undefined && doc.readme.trim().length > 0) {
            const readmeNodes = markdownToNodes(doc.readme, { startOrder: order });
            nodes.push(...readmeNodes);
            order += readmeNodes.length;
        }

        if (nodes.length === 0) return null;

        const latestVersion = doc["dist-tags"]?.latest;

        return {
            url,
            // NO `finalUrl`. `registryUrl` is the JSON endpoint the bytes came
            // from; `url` is the npmjs.com package page a reader can open. The
            // MCP formatters cite `finalUrl ?? url`, so setting it here gave the
            // model `registry.npmjs.org/foo` as the source to quote and follow.
            title: latestVersion !== undefined ? `${doc.name}@${latestVersion}` : doc.name,
            kind: "reference",
            source: "registry",
            nodes,
            kindEvidence: "registry: registry.npmjs.org package document",
        };
    },
};
