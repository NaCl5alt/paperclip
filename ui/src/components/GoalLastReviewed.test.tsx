// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GoalLastReviewedControl } from "./GoalLastReviewed";

describe("GoalLastReviewedControl", () => {
  it("shows the formatted last reviewed date when set", () => {
    const html = renderToStaticMarkup(
      <GoalLastReviewedControl
        lastReviewedAt="2026-07-23T00:00:00.000Z"
        onMarkReviewed={() => {}}
      />,
    );

    expect(html).toContain("Jul");
    expect(html).toContain("2026");
  });

  it("shows None when the goal has never been reviewed", () => {
    const html = renderToStaticMarkup(
      <GoalLastReviewedControl lastReviewedAt={null} onMarkReviewed={() => {}} />,
    );

    expect(html).toContain("None");
  });

  it("renders the mark-reviewed button when a handler is provided", () => {
    const html = renderToStaticMarkup(
      <GoalLastReviewedControl lastReviewedAt={null} onMarkReviewed={() => {}} />,
    );

    expect(html).toContain("Mark reviewed");
  });

  it("omits the mark-reviewed button when no handler is provided", () => {
    const html = renderToStaticMarkup(<GoalLastReviewedControl lastReviewedAt={null} />);

    expect(html).not.toContain("Mark reviewed");
  });
});
