"use strict";

const sourceLinks = require("../../js/ua.docx_source_links");

class FakeTextRun {
  constructor(options) {
    this.options = options;
  }
}

class FakeHyperlink {
  constructor(options) {
    this.options = options;
  }
}

class FakeParagraph {
  constructor(options) {
    this.options = options;
  }
}

function fakeDocx() {
  return {
    TextRun: FakeTextRun,
    ExternalHyperlink: FakeHyperlink,
    Paragraph: FakeParagraph,
    Document: class FakeDocument {},
  };
}

describe("DOCX source-link integrity adapter", () => {
  test("recognises only the canonical legacy source paragraph", () => {
    expect(
      sourceLinks.isCanonicalSourceParagraph({
        text: sourceLinks.SOURCE_PARAGRAPH_TEXT,
      }),
    ).toBe(true);
    expect(sourceLinks.isCanonicalSourceParagraph({ text: "Datenquelle" })).toBe(false);
    expect(sourceLinks.isCanonicalSourceParagraph(null)).toBe(false);
  });

  test("replaces the plain source sentence with dataset and licence hyperlinks", () => {
    const options = sourceLinks.linkedSourceParagraphOptions(fakeDocx(), {
      text: sourceLinks.SOURCE_PARAGRAPH_TEXT,
      spacing: { after: 200 },
    });

    expect(options.text).toBeUndefined();
    expect(options.spacing).toEqual({ after: 200 });
    const hyperlinks = options.children.filter((child) => child instanceof FakeHyperlink);
    expect(hyperlinks).toHaveLength(2);
    expect(hyperlinks.map((item) => item.options.link)).toEqual([
      sourceLinks.DATASET_URL,
      sourceLinks.LICENSE_URL,
    ]);
    expect(hyperlinks[0].options.children[0].options).toMatchObject({
      style: "Hyperlink",
    });
  });

  test("decorates only matching Paragraph instances", () => {
    const docx = fakeDocx();
    const LinkedParagraph = sourceLinks.createLinkedParagraphConstructor(docx);
    const linked = new LinkedParagraph({
      text: sourceLinks.SOURCE_PARAGRAPH_TEXT,
      spacing: { after: 200 },
    });
    const ordinary = new LinkedParagraph({ text: "Ordinary paragraph" });

    expect(linked).toBeInstanceOf(FakeParagraph);
    expect(linked.options.children).toHaveLength(5);
    expect(linked.options.children[1].options.link).toBe(sourceLinks.DATASET_URL);
    expect(ordinary.options).toEqual({ text: "Ordinary paragraph" });
  });

  test("restores a composable temporary docx namespace after success and failure", async () => {
    const original = fakeDocx();
    const root = { docx: original };
    let decorated;
    await sourceLinks.withLinkedSourceParagraph(root, async () => {
      decorated = root.docx;
      expect(decorated).not.toBe(original);
      expect(decorated.Document).toBe(original.Document);
      expect(decorated.Paragraph).not.toBe(original.Paragraph);
      expect(Object.getOwnPropertyDescriptor(decorated, "Paragraph")).toMatchObject({
        configurable: true,
        writable: false,
      });
      const outerProxy = new Proxy(decorated, {
        get(target, property, receiver) {
          if (property === "Paragraph") return class OuterParagraph extends target.Paragraph {};
          return Reflect.get(target, property, receiver);
        },
      });
      expect(() => outerProxy.Paragraph).not.toThrow();
    });
    expect(root.docx).toBe(original);

    await expect(
      sourceLinks.withLinkedSourceParagraph(root, async () => {
        throw new Error("export failed");
      }),
    ).rejects.toThrow("export failed");
    expect(root.docx).toBe(original);
  });

  test("installs once, serialises exports and preserves receiver and arguments", async () => {
    const root = { docx: fakeDocx() };
    const observations = [];
    const UA = {
      exportToWord: async function originalExporter(...args) {
        observations.push({
          receiver: this,
          args,
          paragraph: root.docx.Paragraph,
        });
        await Promise.resolve();
        return args.join(":");
      },
    };

    const runtime = sourceLinks.install(UA, root);
    const firstWrapper = UA.exportToWord;
    expect(runtime.available).toBe(true);
    expect(runtime.delegated).toBe(false);
    expect(sourceLinks.install(UA, root)).toBe(runtime);
    expect(UA.exportToWord).toBe(firstWrapper);

    await expect(UA.exportToWord.call(UA, "a", "b")).resolves.toBe("a:b");
    expect(observations).toHaveLength(1);
    expect(observations[0].receiver).toBe(UA);
    expect(observations[0].args).toEqual(["a", "b"]);
    expect(observations[0].paragraph).not.toBe(FakeParagraph);
    expect(root.docx.Paragraph).toBe(FakeParagraph);
  });

  test("delegates to the full document-provenance runtime instead of stacking proxies", async () => {
    const originalExporter = jest.fn(async () => "document-provenance-result");
    const root = { docx: fakeDocx() };
    const UA = {
      __documentExportProvenanceInstalled: true,
      exportToWord: originalExporter,
    };

    const runtime = sourceLinks.install(UA, root);

    expect(runtime).toMatchObject({
      available: true,
      delegated: true,
      reason: "document_provenance_owns_source_links",
      originalExporter,
      wrappedExporter: null,
    });
    expect(UA.exportToWord).toBe(originalExporter);
    await expect(UA.exportToWord("ctx")).resolves.toBe("document-provenance-result");
    expect(originalExporter).toHaveBeenCalledWith("ctx");
    expect(root.docx.Paragraph).toBe(FakeParagraph);
  });

  test("does not allow concurrent exports to share the temporary docx namespace", async () => {
    const root = { docx: fakeDocx() };
    const order = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst;
    let markFirstStarted;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise((resolve) => {
      markFirstStarted = resolve;
    });
    const UA = {
      exportToWord: async (label) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${label}`);
        if (label === "first") {
          markFirstStarted();
          await firstGate;
        }
        order.push(`end:${label}`);
        active -= 1;
        return label;
      },
    };
    sourceLinks.install(UA, root);

    const first = UA.exportToWord("first");
    const second = UA.exportToWord("second");
    await firstStarted;
    await Promise.resolve();
    expect(order).toEqual(["start:first"]);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
    expect(root.docx.Paragraph).toBe(FakeParagraph);
  });

  test("fails clearly when the required docx link API is absent", () => {
    expect(() =>
      sourceLinks.linkedSourceParagraphOptions(
        { TextRun: FakeTextRun },
        { text: sourceLinks.SOURCE_PARAGRAPH_TEXT },
      ),
    ).toThrow(/missing_docx_link_api/);
    expect(() => sourceLinks.createLinkedParagraphConstructor({})).toThrow(
      /missing_docx_paragraph/,
    );
  });
});
