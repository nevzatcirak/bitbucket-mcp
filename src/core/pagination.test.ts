import { describe, expect, it } from "vitest";
import { extractPageItems, pageMeta, pageQuery } from "./pagination.js";
import { SERVER_PAGINATION, CLOUD_PAGINATION } from "./provider.js";

describe("pageQuery", () => {
  it("emits zero-based start/limit for Server/DC", () => {
    expect(pageQuery({ start: 50, limit: 10 }, SERVER_PAGINATION)).toEqual({ limit: 10, start: 50 });
  });

  it("translates offsets into one-based page numbers for Cloud", () => {
    expect(pageQuery({ start: 50, limit: 25 }, CLOUD_PAGINATION)).toEqual({ pagelen: 25, page: 3 });
    expect(pageQuery({}, CLOUD_PAGINATION)).toEqual({ pagelen: 25, page: 1 });
  });

  it("applies defaults and clamps", () => {
    expect(pageQuery({}, SERVER_PAGINATION)).toEqual({ limit: 25, start: 0 });
    expect(pageQuery({ limit: 0 }, SERVER_PAGINATION)).toEqual({ limit: 1, start: 0 });
    expect(pageQuery({ limit: 5000 }, SERVER_PAGINATION)).toEqual({ limit: 1000, start: 0 });
    expect(pageQuery({ start: -10 }, SERVER_PAGINATION)).toEqual({ limit: 25, start: 0 });
  });
});

describe("pageMeta", () => {
  it("normalizes a Server/DC envelope", () => {
    const payload = { size: 25, limit: 25, start: 0, isLastPage: false, nextPageStart: 25, values: [{}] };
    expect(pageMeta(payload, 0, 25, 25)).toEqual({
      size: 25,
      limit: 25,
      start: 0,
      isLastPage: false,
      nextPageStart: 25,
    });
  });

  it("falls back to request defaults when the envelope omits fields", () => {
    expect(pageMeta(null, 10, 25, 3)).toEqual({
      size: 3,
      limit: 25,
      start: 10,
      isLastPage: true,
      nextPageStart: null,
    });
  });

  it("derives isLastPage from total when the envelope lacks the flag", () => {
    const payload = { size: 10, limit: 10, start: 20, total: 35 };
    expect(pageMeta(payload, 20, 10, 10)).toMatchObject({ isLastPage: false, nextPageStart: 30 });

    const last = { size: 5, limit: 10, start: 30, total: 35 };
    expect(pageMeta(last, 30, 10, 5)).toMatchObject({ isLastPage: true, nextPageStart: null });
  });

  it("respects an explicit isLastPage even against total", () => {
    const payload = { size: 10, start: 0, total: 100, isLastPage: true };
    expect(pageMeta(payload, 0, 10, 10)).toMatchObject({ isLastPage: true, nextPageStart: null });
  });
});

describe("extractPageItems", () => {
  it("reads the values array", () => {
    expect(extractPageItems({ values: [1, 2] })).toEqual([1, 2]);
  });

  it("returns an empty array for missing or malformed envelopes", () => {
    expect(extractPageItems({})).toEqual([]);
    expect(extractPageItems(null)).toEqual([]);
    expect(extractPageItems({ values: "nope" })).toEqual([]);
  });
});
