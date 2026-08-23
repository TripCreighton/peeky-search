/**
 * Invariants that must hold over real HTML, not just tidy fixtures.
 *
 * Runs a deterministic sample of the cached corpus (every 12th page, sorted by
 * filename) so the sweep stays fast and reproducible. The full 1164-page sweep
 * gives the same answers; this is the part worth paying for on every run.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHtml } from "../parse";
import { buildPassages } from "../passages";
import { preprocessHtml } from "../../preprocessing/strip";
import { extractBlocks } from "../../preprocessing/segment";

const CORPUS = join(process.cwd(), "eval", "corpus", "pages");
const SAMPLE_STRIDE = 12;
const MIN_HTML_CHARS = 5000;

interface SamplePage {
    file: string;
    url: string;
    html: string;
}

function sampleCorpus(): SamplePage[] {
    if (!existsSync(CORPUS)) return [];
    const files = readdirSync(CORPUS).sort();
    const pages: SamplePage[] = [];
    for (let i = 0; i < files.length; i += SAMPLE_STRIDE) {
        const file = files[i];
        if (file === undefined) continue;
        let parsed: { url?: string; html?: string };
        try {
            parsed = JSON.parse(readFileSync(join(CORPUS, file), "utf-8")) as { url?: string; html?: string };
        } catch {
            continue;
        }
        const { url, html } = parsed;
        if (url === undefined || html === undefined || html.length < MIN_HTML_CHARS) continue;
        pages.push({ file, url, html });
    }
    return pages;
}

const pages = sampleCorpus();

// The corpus is recorded locally and never committed, so a fresh clone has
// nothing to sweep. Skipping is right; failing would mean `git clone && pnpm
// test` is red for every contributor, which says nothing true about the code.
describe.skipIf(pages.length === 0)("corpus sweep", () => {

    it("has a sample to work with", () => {
        expect(pages.length).toBeGreaterThan(50);
    });

    it("parses every sampled page without throwing", () => {
        const failures: string[] = [];
        for (const page of pages) {
            try {
                const doc = parseHtml(page.html, page.url);
                buildPassages(doc);
            } catch (error) {
                failures.push(`${page.file} (${page.url}): ${String(error)}`);
            }
        }

        expect(failures).toEqual([]);
    }, 120000);

    it("never splits a code block, on any sampled page", () => {
        const split: string[] = [];
        for (const page of pages) {
            const doc = parseHtml(page.html, page.url);
            const passages = buildPassages(doc);
            for (const node of doc.nodes) {
                if (node.kind !== "code") continue;
                for (const passage of passages) {
                    if (passage.startOrder > node.order || node.order > passage.endOrder) continue;
                    if (!passage.text.includes(node.text)) split.push(`${page.url} @${node.order}`);
                }
            }
        }

        expect(split).toEqual([]);
    }, 120000);

    it("populates bodyText and document provenance on every passage", () => {
        const bad: string[] = [];
        for (const page of pages) {
            const doc = parseHtml(page.html, page.url);
            for (const passage of buildPassages(doc)) {
                if (passage.bodyText === undefined) bad.push(`${page.url} @${passage.startOrder}: no bodyText`);
                else if (!passage.text.endsWith(passage.bodyText)) bad.push(`${page.url} @${passage.startOrder}: bodyText is not the tail of text`);
                if (passage.pageKind !== doc.kind) bad.push(`${page.url} @${passage.startOrder}: pageKind`);
                if (passage.source !== doc.source) bad.push(`${page.url} @${passage.startOrder}: source`);
            }
        }

        expect(bad.slice(0, 5)).toEqual([]);
    }, 120000);

    it("produces stable passage ids across repeated runs", () => {
        for (const page of pages.slice(0, 20)) {
            const first = buildPassages(parseHtml(page.html, page.url)).map((p) => p.id);
            const second = buildPassages(parseHtml(page.html, page.url)).map((p) => p.id);

            expect(second).toEqual(first);
            expect(new Set(first).size).toBe(first.length);
        }
    }, 120000);

    it("recovers pages that v1 reduces to nothing more often than the reverse", () => {
        let v1Empty = 0;
        let v2Empty = 0;
        for (const page of pages) {
            let v1 = 0;
            try {
                const pre = preprocessHtml(page.html);
                v1 = pre.mainContent === null ? 0 : extractBlocks(pre.$, pre.mainContent).length;
            } catch { /* count as empty */ }
            const v2 = parseHtml(page.html, page.url).nodes.length;
            if (v1 === 0) v1Empty++;
            if (v2 === 0) v2Empty++;
        }

        // v1 gives up on far more real pages than v2 does. Deleting content is
        // the failure mode this rewrite exists to remove.
        expect(v2Empty).toBeLessThan(v1Empty);
    }, 120000);
});
