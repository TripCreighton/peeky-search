import * as cheerio from "cheerio";
import type { AnyNode, Element as CheerioElement } from "domhandler";
import { normalizeWhitespace, matchesPatterns } from "../utils/shared";

/** Max length for UI button text detection */
const UI_TEXT_MAX_LENGTH = 50;
/** Minimum link count to consider element as navigation */
const MIN_LINKS_FOR_NAV = 3;
/** Link text ratio threshold above which element is considered navigation */
const LINK_RATIO_THRESHOLD = 0.8;
/** Max total chars for link-heavy navigation detection */
const NAV_TEXT_MAX_LENGTH = 200;

function isElement(node: AnyNode): node is CheerioElement {
    return node.type === "tag";
}

// Elements to always remove (non-content elements)
const REMOVE_ELEMENTS = [
    "script",
    "style",
    "link",
    "img",
    "iframe",
    "video",
    "audio",
    "object",
    "embed",
    "param",
    "applet",
    "noscript",
    "svg",
    "canvas",
    "map",
    "area",
    // Interactive elements that are never content
    "button",
    "input",
    "select",
    "textarea",
    "form",
    "label",
    "fieldset",
    "legend",
    "datalist",
    "output",
    "progress",
    "meter",
];

// Boilerplate elements to remove
const BOILERPLATE_ELEMENTS = [
    "nav",
    "footer",
    "aside",
    "header",
];

// Common boilerplate class/id patterns
const BOILERPLATE_PATTERNS = [
    /nav(igation)?/i,
    /footer/i,
    /header/i,
    /sidebar/i,
    /menu/i,
    /breadcrumb/i,
    /cookie/i,
    /consent/i,
    /banner/i,
    /advert(isement)?/i,
    /ads?[-_]?/i,
    /social/i,
    /share/i,
    /comment/i,
    /related/i,
    /recommend/i,
    /popup/i,
    /modal/i,
    /newsletter/i,
    /subscribe/i,
    /signup/i,
    /login/i,
    /signin/i,
    /search/i,
    /widget/i,
    /toolbar/i,
    /promo/i,
];

// UI elements to remove even inside main content (buttons, actions, toolbars)
const UI_ELEMENT_PATTERNS = [
    /copy[-_]?(button|link|code|markdown)?/i,
    /share[-_]?(button|link|menu)?/i,
    /action[-_]?(bar|menu|buttons?)/i,
    /btn[-_]?(copy|share|action)/i,
    /clipboard/i,
    /open[-_]?in/i,
    /chat[-_]?(gpt|button)/i,
    /ai[-_]?(chat|assistant)/i,
    /feedback/i,
    /edit[-_]?(page|this|on[-_]?github)/i,
    /page[-_]?actions?/i,
    /toc|table[-_]?of[-_]?contents/i,
    /on[-_]?this[-_]?page/i,
    /sticky[-_]?(nav|sidebar|toc)/i,
    /floating[-_]?(menu|button|action)/i,
];

// Text content patterns that indicate UI elements (for text-based filtering)
const UI_TEXT_PATTERNS = [
    /^copy\s*(as\s*)?(markdown|code|text)?$/i,
    /^open\s+in\s+\w+/i,  // "Open in X" for any service
    /^(share|copy)\s*(this|link|page)?$/i,
    /^edit\s*(this\s*)?(page|on\s*github)?$/i,
    /^(give\s*)?feedback$/i,
    /^(scroll\s*to\s*)?top$/i,
    /^on\s+this\s+page$/i,
    /^table\s+of\s+contents$/i,
];

/**
 * Get combined id and class string from element for pattern matching
 */
function getElementIdentifiers(el: CheerioElement): string {
    const id = el.attribs?.id ?? "";
    const className = el.attribs?.class ?? "";
    return `${id} ${className}`;
}

/**
 * Check if an element matches boilerplate patterns by class/id
 */
function isBoilerplateElement(el: CheerioElement): boolean {
    if (el.type !== "tag") return false;
    return matchesPatterns(getElementIdentifiers(el), BOILERPLATE_PATTERNS);
}

/**
 * Check if an element is a UI element (buttons, actions, etc.) by class/id
 */
function isUIElement(el: CheerioElement): boolean {
    if (el.type !== "tag") return false;
    return matchesPatterns(getElementIdentifiers(el), UI_ELEMENT_PATTERNS);
}

/**
 * Check if text content matches UI text patterns
 */
function isUIText(text: string): boolean {
    return matchesPatterns(normalizeWhitespace(text), UI_TEXT_PATTERNS);
}

/**
 * Strip HTML of scripts, styles, and other non-content elements
 * Returns a Cheerio API instance with cleaned HTML
 */
export function stripHtml(html: string): cheerio.CheerioAPI {
    const $ = cheerio.load(html);

    // Remove non-content elements
    for (const selector of REMOVE_ELEMENTS) {
        $(selector).remove();
    }

    return $;
}

/**
 * Remove boilerplate sections (nav, footer, sidebar, ads, etc.)
 * Protects main content areas from removal
 */
export function removeBoilerplate($: cheerio.CheerioAPI): void {
    // First, mark main content areas to protect them
    const mainContent = $("main, article, [role='main']");
    mainContent.attr("data-peeky-protect", "true");
    mainContent.find("*").attr("data-peeky-protect", "true");

    // Remove boilerplate elements by tag (only if not protected)
    for (const selector of BOILERPLATE_ELEMENTS) {
        $(selector).each((_, el) => {
            const $el = $(el);
            if (!$el.attr("data-peeky-protect") && !$el.find("[data-peeky-protect]").length) {
                $el.remove();
            }
        });
    }

    // Remove elements matching boilerplate patterns (only if not protected)
    $("*").each((_, el) => {
        if (!isElement(el)) return;
        const $el = $(el);
        if ($el.attr("data-peeky-protect")) return;
        if ($el.find("[data-peeky-protect]").length) return;
        if (isBoilerplateElement(el)) {
            $el.remove();
        }
    });

    // Clean up protection markers
    $("[data-peeky-protect]").removeAttr("data-peeky-protect");
}

/**
 * Remove UI elements (copy buttons, share links, action bars) from content
 * This runs on the main content after it's been identified
 */
export function removeUIElements($: cheerio.CheerioAPI, container: cheerio.Cheerio<AnyNode>): void {
    // Remove elements matching UI patterns by class/id
    container.find("*").each((_, el) => {
        if (!isElement(el)) return;
        if (isUIElement(el)) {
            $(el).remove();
        }
    });

    // Remove elements with UI-like text content (buttons, links with action text)
    container.find("button, a, span, div").each((_, el) => {
        const $el = $(el);
        const text = $el.text();

        if (text.length < UI_TEXT_MAX_LENGTH && isUIText(text)) {
            $el.remove();
        }
    });

    // Remove common doc site UI elements by selector
    const uiSelectors = [
        "[data-copy]",
        "[data-clipboard]",
        "[aria-label*='copy']",
        "[aria-label*='share']",
        "[title*='Copy']",
        "[title*='Share']",
        ".copy-button",
        ".share-button",
        "[class*='ActionMenu']",
        "[class*='PageActions']",
        // Tab navigation and anchor links within content
        "[role='tablist']",
        "[role='tab']",
        ".tabs",
        ".tab-list",
        "[class*='TabList']",
        "[class*='Tabs']",
        // Anchor/jump links
        "[class*='anchor-link']",
        "[class*='heading-link']",
        "a[href^='#']:empty", // Empty anchor links
        // Sticky sidebars (often contain TOC and share links)
        "[class*='sticky']",
    ];

    for (const selector of uiSelectors) {
        container.find(selector).remove();
    }

    // Remove link-only elements that look like navigation
    // (multiple consecutive short links without other content)
    container.find("p, div, span").each((_, el) => {
        const $el = $(el);
        const links = $el.find("a");
        const text = normalizeWhitespace($el.text());

        // If element is mostly links and short, it's probably navigation
        if (links.length >= MIN_LINKS_FOR_NAV) {
            let linkTextLen = 0;
            links.each((_, link) => {
                linkTextLen += $(link).text().length;
            });

            if (linkTextLen > text.length * LINK_RATIO_THRESHOLD && text.length < NAV_TEXT_MAX_LENGTH) {
                $el.remove();
            }
        }
    });
}

interface ContentCandidate {
    element: cheerio.Cheerio<AnyNode>;
    selector: string;
    score: number;
}

/**
 * Find the main content container in the document
 * Returns the best candidate element or null if none found
 */
export function findMainContent($: cheerio.CheerioAPI): ContentCandidate | null {
    // Prefer semantic <main> element
    const mainEl = $("main");
    if (mainEl.length > 0) {
        return {
            element: mainEl,
            selector: "main",
            score: 100,
        };
    }

    // Then prefer <article>
    const articleEl = $("article");
    if (articleEl.length > 0) {
        return {
            element: articleEl,
            selector: "article",
            score: 90,
        };
    }

    // Fall back to scoring candidate containers by text density
    const candidates: ContentCandidate[] = [];

    // Check direct children of body
    $("body").children().each((_, elem) => {
        if (elem.type !== "tag") return;

        const $el = $(elem);

        // Skip known boilerplate
        if (BOILERPLATE_ELEMENTS.includes(elem.tagName.toLowerCase())) return;
        if (isBoilerplateElement(elem)) return;

        // Score by text density (text length minus link text)
        const textLen = normalizeWhitespace($el.text()).length;
        let linkTextLen = 0;
        $el.find("a").each((_, link) => {
            linkTextLen += normalizeWhitespace($(link).text()).length;
        });

        // Score: text length - 2 * link text (penalize link-heavy sections)
        const score = textLen - 2 * linkTextLen;

        // Build selector for debugging
        let selector = elem.tagName;
        if (elem.attribs?.id) {
            selector += `#${elem.attribs.id}`;
        }
        if (elem.attribs?.class) {
            selector += `.${elem.attribs.class.split(" ").join(".")}`;
        }

        candidates.push({ element: $el, selector, score });
    });

    // Also check elements with content-like classes/ids
    const contentSelectors = [
        "[role='main']",
        "#content",
        "#main-content",
        ".content",
        ".main-content",
        ".post-content",
        ".article-content",
        ".entry-content",
    ];

    for (const sel of contentSelectors) {
        const $el = $(sel);
        if ($el.length > 0) {
            const textLen = normalizeWhitespace($el.text()).length;
            let linkTextLen = 0;
            $el.find("a").each((_, link) => {
                linkTextLen += normalizeWhitespace($(link).text()).length;
            });
            const score = textLen - 2 * linkTextLen;
            candidates.push({ element: $el, selector: sel, score });
        }
    }

    if (candidates.length === 0) {
        return null;
    }

    // Sort by score descending; tie-break by selector for determinism
    candidates.sort((a, b) => {
        const d = b.score - a.score;
        if (d !== 0) return d;
        return a.selector.localeCompare(b.selector);
    });
    const best = candidates[0];
    return best ?? null;
}

/**
 * Full preprocessing: strip HTML, remove boilerplate, find main content
 */
export function preprocessHtml(html: string): {
    $: cheerio.CheerioAPI;
    mainContent: cheerio.Cheerio<AnyNode> | null;
    selector: string | null;
} {
    const $ = stripHtml(html);
    removeBoilerplate($);

    const candidate = findMainContent($);
    if (candidate === null) {
        return { $, mainContent: null, selector: null };
    }

    // Remove UI elements (copy buttons, share links, etc.) from main content
    removeUIElements($, candidate.element);

    return {
        $,
        mainContent: candidate.element,
        selector: candidate.selector,
    };
}
