import { describe, it, expect } from "vitest";
import {
    stripHtml,
    removeBoilerplate,
    findMainContent,
    preprocessHtml,
    removeUIElements,
} from "../strip";

describe("stripHtml", () => {
    it("removes script elements", () => {
        const html = `
            <html>
            <body>
                <p>Content before</p>
                <script>console.log("hello");</script>
                <p>Content after</p>
            </body>
            </html>
        `;

        const $ = stripHtml(html);

        expect($("script").length).toBe(0);
        expect($("p").length).toBe(2);
    });

    it("removes style elements", () => {
        const html = `
            <html>
            <head>
                <style>.nav { color: blue; }</style>
            </head>
            <body>
                <p>Content</p>
                <style>.footer { padding: 10px; }</style>
            </body>
            </html>
        `;

        const $ = stripHtml(html);

        expect($("style").length).toBe(0);
        expect($("p").text()).toBe("Content");
    });

    it("removes form elements", () => {
        const html = `
            <html>
            <body>
                <p>Content</p>
                <form>
                    <input type="text">
                    <button>Submit</button>
                </form>
            </body>
            </html>
        `;

        const $ = stripHtml(html);

        expect($("form").length).toBe(0);
        expect($("input").length).toBe(0);
        expect($("button").length).toBe(0);
    });

    it("removes media elements", () => {
        const html = `
            <html>
            <body>
                <p>Content</p>
                <img src="image.jpg">
                <video src="video.mp4"></video>
                <audio src="audio.mp3"></audio>
                <iframe src="frame.html"></iframe>
            </body>
            </html>
        `;

        const $ = stripHtml(html);

        expect($("img").length).toBe(0);
        expect($("video").length).toBe(0);
        expect($("audio").length).toBe(0);
        expect($("iframe").length).toBe(0);
    });

    it("preserves content elements", () => {
        const html = `
            <html>
            <body>
                <main>
                    <article>
                        <h1>Title</h1>
                        <p>Paragraph</p>
                        <ul><li>List item</li></ul>
                        <pre>Code block</pre>
                    </article>
                </main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);

        expect($("main").length).toBe(1);
        expect($("article").length).toBe(1);
        expect($("h1").text()).toBe("Title");
        expect($("p").text()).toBe("Paragraph");
        expect($("li").text()).toBe("List item");
        expect($("pre").text()).toBe("Code block");
    });
});

describe("removeBoilerplate", () => {
    it("removes nav elements outside main", () => {
        const html = `
            <html>
            <body>
                <nav>
                    <a href="/">Home</a>
                    <a href="/about">About</a>
                </nav>
                <main>
                    <p>Content</p>
                </main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        removeBoilerplate($);

        expect($("nav").length).toBe(0);
        expect($("main").length).toBe(1);
        expect($("p").text()).toBe("Content");
    });

    it("removes footer elements outside main", () => {
        const html = `
            <html>
            <body>
                <main><p>Content</p></main>
                <footer>
                    <p>Copyright 2024</p>
                </footer>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        removeBoilerplate($);

        expect($("footer").length).toBe(0);
        expect($("main p").text()).toBe("Content");
    });

    it("protects content inside main element", () => {
        const html = `
            <html>
            <body>
                <main>
                    <nav class="article-nav">
                        <a href="#section1">Section 1</a>
                    </nav>
                    <p>Content</p>
                </main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        removeBoilerplate($);

        // Nav inside main should be protected
        expect($("main nav").length).toBe(1);
        expect($("main p").text()).toBe("Content");
    });

    it("removes elements matching boilerplate patterns", () => {
        const html = `
            <html>
            <body>
                <div class="sidebar">Sidebar content</div>
                <div class="advertisement">Ad content</div>
                <main><p>Content</p></main>
                <div id="cookie-consent">Cookie notice</div>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        removeBoilerplate($);

        expect($(".sidebar").length).toBe(0);
        expect($(".advertisement").length).toBe(0);
        expect($("#cookie-consent").length).toBe(0);
        expect($("main").length).toBe(1);
    });

    it("does not over-match boilerplate patterns", () => {
        const html = `
            <html>
            <body>
                <main>
                    <p class="navigation-helper">This helps with navigation</p>
                    <p>Regular content</p>
                </main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        removeBoilerplate($);

        // "navigation-helper" inside main should be protected
        expect($(".navigation-helper").length).toBe(1);
    });
});

describe("findMainContent", () => {
    it("prefers main element", () => {
        const html = `
            <html>
            <body>
                <article>Article content here with lots of text</article>
                <main>Main content here</main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        const result = findMainContent($);

        expect(result?.selector).toBe("main");
    });

    it("falls back to article element", () => {
        const html = `
            <html>
            <body>
                <article>Article content</article>
                <div>Other div</div>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        const result = findMainContent($);

        expect(result?.selector).toBe("article");
    });

    it("finds main content in nested structure", () => {
        const html = `
            <html>
            <body>
                <div class="wrapper">
                    <main>
                        <p>Main content here</p>
                    </main>
                </div>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        const result = findMainContent($);

        expect(result?.selector).toBe("main");
        expect(result?.element.find("p").text()).toBe("Main content here");
    });

    it("uses content selectors as fallback", () => {
        const html = `
            <html>
            <body>
                <nav>Navigation</nav>
                <div id="content">
                    <p>Lots of real content here that should be found and extracted properly.</p>
                </div>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        removeBoilerplate($);
        const result = findMainContent($);

        // Should find #content
        expect(result?.selector).toBe("#content");
    });

    it("returns null for empty document", () => {
        const html = `<html><body></body></html>`;

        const $ = stripHtml(html);
        const result = findMainContent($);

        expect(result).toBeNull();
    });
});

describe("removeUIElements", () => {
    it("removes copy button elements", () => {
        const html = `
            <html>
            <body>
                <main>
                    <pre>const x = 1;</pre>
                    <button class="copy-button">Copy</button>
                    <span class="copy-code">Copy as Markdown</span>
                </main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        const main = $("main");
        removeUIElements($, main);

        expect($(".copy-button").length).toBe(0);
        expect($(".copy-code").length).toBe(0);
        expect($("pre").text()).toBe("const x = 1;");
    });

    it("removes share button elements", () => {
        const html = `
            <html>
            <body>
                <main>
                    <p>Content</p>
                    <div class="share-button">Share</div>
                    <a class="share-link">Share this</a>
                </main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        const main = $("main");
        removeUIElements($, main);

        expect($(".share-button").length).toBe(0);
        expect($(".share-link").length).toBe(0);
    });

    it("removes UI text patterns but keeps learning content", () => {
        const html = `
            <html>
            <body>
                <main>
                    <button>Copy as Markdown</button>
                    <p>Learn to copy files to the server.</p>
                </main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        const main = $("main");
        removeUIElements($, main);

        // "Copy as Markdown" button should be removed
        expect($("button").length).toBe(0);
        // But "Learn to copy files" paragraph should remain
        expect($("p").text()).toBe("Learn to copy files to the server.");
    });

    it("removes data-clipboard elements", () => {
        const html = `
            <html>
            <body>
                <main>
                    <pre>code</pre>
                    <button data-clipboard="true">Copy</button>
                </main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        const main = $("main");
        removeUIElements($, main);

        expect($("[data-clipboard]").length).toBe(0);
    });

    it("removes elements with copy aria-label", () => {
        const html = `
            <html>
            <body>
                <main>
                    <pre>code</pre>
                    <button aria-label="copy to clipboard">Copy</button>
                </main>
            </body>
            </html>
        `;

        const $ = stripHtml(html);
        const main = $("main");
        removeUIElements($, main);

        expect($("[aria-label*='copy']").length).toBe(0);
    });
});

describe("preprocessHtml", () => {
    it("performs full preprocessing pipeline", () => {
        const html = `
            <html>
            <body>
                <nav><a href="/">Home</a></nav>
                <main>
                    <article>
                        <h1>Title</h1>
                        <p>Content paragraph here.</p>
                        <button class="copy-button">Copy</button>
                    </article>
                </main>
                <footer>Copyright</footer>
            </body>
            </html>
        `;

        const result = preprocessHtml(html);

        expect(result.mainContent).not.toBeNull();
        expect(result.selector).toBe("main");
        expect(result.$("nav").length).toBe(0);
        expect(result.$("footer").length).toBe(0);
        expect(result.$(".copy-button").length).toBe(0);
        expect(result.$("h1").text()).toBe("Title");
        expect(result.$("p").text()).toBe("Content paragraph here.");
    });

    it("handles empty HTML gracefully", () => {
        const html = `<html><body></body></html>`;

        const result = preprocessHtml(html);

        expect(result.mainContent).toBeNull();
        expect(result.selector).toBeNull();
    });

    it("handles malformed HTML", () => {
        const html = `
            <html>
            <body>
                <main>
                    <p>Unclosed paragraph
                    <p>Another paragraph</p>
                </main>
            </body>
        `;

        const result = preprocessHtml(html);

        // Should still find and process content
        expect(result.mainContent).not.toBeNull();
        expect(result.selector).toBe("main");
    });
});
