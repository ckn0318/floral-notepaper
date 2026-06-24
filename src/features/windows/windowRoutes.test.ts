import { describe, expect, it } from "vitest";
import {
  buildNotepadUrl,
  buildTileUrl,
  buildTodoUrl,
  getInitialRoute,
  routeFromSearch,
} from "./windowRoutes";

describe("window routes", () => {
  it("parses supported routes and note ids", () => {
    expect(routeFromSearch("?view=notepad&noteId=abc-123")).toEqual({
      view: "notepad",
      noteId: "abc-123",
    });
    expect(routeFromSearch("?view=tile&noteId=note-1")).toEqual({
      view: "tile",
      noteId: "note-1",
    });
    expect(routeFromSearch("?view=todo")).toEqual({ view: "todo" });
    expect(routeFromSearch("?view=unknown")).toEqual({ view: "notepad" });
  });

  it("builds app urls for dynamic windows", () => {
    expect(buildNotepadUrl()).toBe("index.html?view=notepad");
    expect(buildNotepadUrl("abc 123")).toBe("index.html?view=notepad&noteId=abc+123");
    expect(buildTileUrl("note-1")).toBe("index.html?view=tile&noteId=note-1");
    expect(buildTodoUrl()).toBe("index.html?view=todo");
  });

  it("reads the browser location by default", () => {
    expect(getInitialRoute(new URL("https://floral-notepaper.test/?view=main"))).toEqual({
      view: "notepad",
    });
  });
});
