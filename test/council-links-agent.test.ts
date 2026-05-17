import { describe, it, expect } from "vitest";
import {
  extractHostname,
  filterAndRankLinks,
  isGovDomain,
  isOfficialOrGovUrl,
  isPdfUrl,
  normalizeUrl,
} from "@/lib/agent/council-links-agent";

describe("council links helpers", () => {
  it("normalizes URLs by removing hashes and trailing slashes", () => {
    expect(normalizeUrl("https://example.gov.au/path/#section")).toBe(
      "https://example.gov.au/path"
    );
  });

  it("extracts hostname from official website", () => {
    expect(extractHostname("https://www.sydney.gov.au")).toBe("sydney.gov.au");
  });

  it("identifies gov.au domains", () => {
    expect(isGovDomain("example.gov.au")).toBe(true);
    expect(isGovDomain("example.com.au")).toBe(false);
  });

  it("detects PDF URLs", () => {
    expect(isPdfUrl("https://example.gov.au/file.pdf")).toBe(true);
    expect(isPdfUrl("https://example.gov.au/file"))
      .toBe(false);
  });

  it("accepts official or gov URLs only", () => {
    expect(isOfficialOrGovUrl("https://council.gov.au/page", "council.gov.au")).toBe(true);
    expect(isOfficialOrGovUrl("https://planning.nsw.gov.au/", "council.gov.au")).toBe(true);
    expect(isOfficialOrGovUrl("https://example.com/", "council.gov.au")).toBe(false);
  });

  it("filters, dedupes, and ranks links", () => {
    const links = filterAndRankLinks(
      [
        { url: "https://council.gov.au/da", title: "DA" },
        { url: "https://council.gov.au/da/", title: "DA" },
        { url: "https://planning.nsw.gov.au/portal", title: "Portal" },
        { url: "https://example.com/" },
        { url: "https://council.gov.au/policy.pdf" },
      ],
      "https://council.gov.au",
      5
    );

    expect(links.length).toBe(3);
    expect(links[0].url).toBe("https://council.gov.au/da");
    expect(links.some((link) => link.url.includes("planning.nsw.gov.au"))).toBe(true);
    expect(links.some((link) => link.url.endsWith(".pdf"))).toBe(true);
  });
});
