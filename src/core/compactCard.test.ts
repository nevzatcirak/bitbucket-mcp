import { describe, expect, it } from "vitest";
import { defineCardFields, projectCard, projectCards } from "./compactCard.js";

const PR = {
  id: 101,
  title: "Add pagination helper",
  state: "OPEN",
  author: { displayName: "dev-one" },
  toRef: { displayId: "main" },
  description: "x".repeat(80),
  links: { self: [{ href: "https://bitbucket.example.com/pr/101" }] },
};

const FIELDS = defineCardFields([
  ["id", "id"],
  ["title", "title", 40],
  ["state", "state"],
  ["author", "author.displayName"],
  ["targetBranch", "toRef.displayId"],
  ["description", "description", 20],
]);

describe("projectCard", () => {
  it("projects a flat, token-cheap card from a raw payload", () => {
    expect(projectCard(PR, FIELDS)).toEqual({
      id: 101,
      title: "Add pagination helper",
      state: "OPEN",
      author: "dev-one",
      targetBranch: "main",
      description: `${"x".repeat(19)}…`,
    });
  });

  it("maps missing paths to null instead of undefined", () => {
    expect(projectCard({ id: 1 }, FIELDS)).toMatchObject({ author: null, targetBranch: null });
  });

  it("does not forward link/avatar payloads", () => {
    const card = projectCard(PR, FIELDS);
    expect(JSON.stringify(card)).not.toContain("links");
    expect(JSON.stringify(card)).not.toContain("href");
  });
});

describe("projectCards", () => {
  it("projects every record", () => {
    const cards = projectCards([PR, { id: 102 }], FIELDS);
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({ id: 102, author: null });
  });
});
