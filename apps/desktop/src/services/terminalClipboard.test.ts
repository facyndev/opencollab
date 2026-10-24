import { describe, expect, it, vi } from "vitest";

import {
  copyTextToClipboard,
  createTerminalKeyEventHandler,
  pasteFromClipboard,
  type ClipboardAdapter,
  type TerminalLike,
} from "./terminalClipboard";

function makeTerm(selection = ""): TerminalLike & {
  pasted: string[];
  clearedSelection: number;
  selectedAll: number;
  clearedBuffer: number;
} {
  let currentSelection = selection;
  const term = {
    pasted: [] as string[],
    clearedSelection: 0,
    selectedAll: 0,
    clearedBuffer: 0,
    hasSelection: () => currentSelection.length > 0,
    getSelection: () => currentSelection,
    clearSelection: () => {
      currentSelection = "";
      term.clearedSelection += 1;
    },
    paste: (data: string) => {
      term.pasted.push(data);
    },
    selectAll: () => {
      term.selectedAll += 1;
    },
    clear: () => {
      term.clearedBuffer += 1;
    },
  };
  return term;
}

function makeKeyEvent(
  overrides: Partial<KeyboardEvent> & { key: string },
): KeyboardEvent & { defaultPrevented: boolean } {
  const event = {
    type: "keydown",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...overrides,
  };
  return event as unknown as KeyboardEvent & { defaultPrevented: boolean };
}

describe("terminalClipboard", () => {
  it("Ctrl+C with active selection copies text, clears selection, and blocks SIGINT", async () => {
    const term = makeTerm("hello world");
    const clipboard: ClipboardAdapter = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(""),
    };
    const handler = createTerminalKeyEventHandler(term, clipboard);
    const event = makeKeyEvent({ key: "c", ctrlKey: true });

    const allowXterm = handler(event);

    expect(allowXterm).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledWith("hello world");
    expect(term.clearedSelection).toBe(1);
  });

  it("Ctrl+C without selection passes through to xterm so SIGINT reaches the PTY", () => {
    const term = makeTerm("");
    const clipboard: ClipboardAdapter = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(""),
    };
    const handler = createTerminalKeyEventHandler(term, clipboard);
    const event = makeKeyEvent({ key: "c", ctrlKey: true });

    const allowXterm = handler(event);

    expect(allowXterm).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+C always blocks PTY input and copies when selection exists", () => {
    const termWithSel = makeTerm("selected output");
    const clipboard: ClipboardAdapter = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(""),
    };
    const handlerWithSel = createTerminalKeyEventHandler(termWithSel, clipboard);

    expect(handlerWithSel(makeKeyEvent({ key: "C", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledWith("selected output");
    expect(termWithSel.clearedSelection).toBe(1);

    const termEmpty = makeTerm("");
    const handlerEmpty = createTerminalKeyEventHandler(termEmpty, clipboard);
    expect(handlerEmpty(makeKeyEvent({ key: "C", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+V and Ctrl+Shift+V prevent default browser paste, read clipboard, and paste into terminal", async () => {
    const term = makeTerm("");
    const clipboard: ClipboardAdapter = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue("npm test"),
    };
    const handler = createTerminalKeyEventHandler(term, clipboard);
    const ctrlV = makeKeyEvent({ key: "v", ctrlKey: true });

    const allowXterm = handler(ctrlV);

    expect(allowXterm).toBe(false);
    expect(ctrlV.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(term.pasted).toEqual(["npm test"]);
    });

    const ctrlShiftV = makeKeyEvent({ key: "V", ctrlKey: true, shiftKey: true });
    expect(handler(ctrlShiftV)).toBe(false);
    expect(ctrlShiftV.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(term.pasted).toEqual(["npm test", "npm test"]);
    });
  });

  it("copyTextToClipboard and pasteFromClipboard handle clipboard operations safely", async () => {
    const term = makeTerm("");
    const clipboard: ClipboardAdapter = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue("copied path"),
    };

    expect(await copyTextToClipboard("C:\\Users\\facun", clipboard)).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith("C:\\Users\\facun");

    await pasteFromClipboard(term, clipboard);
    expect(term.pasted).toEqual(["copied path"]);
  });
});
