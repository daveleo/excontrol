import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { lastPointerType } from "../lib/kiosk.js";

/** Kiosk-only on-screen keyboard. The Pi's compositor (cage) has no system OSK, so the page
 *  brings its own: it opens when a text field gets focus by touch, types into whatever field is
 *  focused (React-controlled inputs included), and never takes focus itself. */

type Field = HTMLInputElement | HTMLTextAreaElement;
type Layout = "letters" | "symbols" | "numbers";

const TEXT_TYPES = new Set(["text", "password", "number", "search", "email", "url", "tel"]);
const isTypeable = (el: EventTarget | null): el is Field =>
  (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type))) &&
  !el.readOnly &&
  !el.disabled;
const wantsNumbers = (el: Field) =>
  (el instanceof HTMLInputElement && el.type === "number") || el.inputMode === "numeric" || el.inputMode === "decimal";

const ROWS: Record<Layout, string[][]> = {
  letters: [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["z", "x", "c", "v", "b", "n", "m", ".", "-"],
  ],
  symbols: [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["@", "#", "$", "%", "&", "*", "(", ")", "'", '"'],
    ["!", "?", "/", "\\", ":", ";", "_", "=", "+"],
    [",", "<", ">", "[", "]", "{", "}", "~", "|"],
  ],
  // Digits only: type=number sanitises "80." or "-" to "" — one stray key would wipe the field.
  numbers: [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["0"],
  ],
};

/** Set a value the way typing would, so React's onChange fires for controlled inputs. */
function setValue(el: Field, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Caret-aware edit. type=number has no selection API (null) — those edit at the end. */
function edit(el: Field, text: string | null) {
  const v = el.value;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start == null || end == null) {
    setValue(el, text == null ? v.slice(0, -1) : v + text);
    return;
  }
  let from = start;
  if (text == null && start === end) from = Math.max(0, start - 1);
  const ins = text ?? "";
  setValue(el, v.slice(0, from) + ins + v.slice(end));
  el.setSelectionRange(from + ins.length, from + ins.length);
}

export function OnScreenKeyboard() {
  const [field, setField] = useState<Field | null>(null);
  const [layout, setLayout] = useState<Layout>("letters");
  const [shift, setShift] = useState(false);
  const kbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!isTypeable(e.target) || lastPointerType === "mouse") return;
      setField(e.target);
      setLayout(wantsNumbers(e.target) ? "numbers" : "letters");
      setShift(false);
    };
    // Defer: focus moving field→field fires focusout before focusin.
    const onFocusOut = () => setTimeout(() => { if (!isTypeable(document.activeElement)) setField(null); }, 0);
    // A real (trusted) key press means a physical keyboard — get out of the way.
    const onKey = (e: KeyboardEvent) => { if (e.isTrusted) setField(null); };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  // Full-screen layers shrink above the keyboard (CSS reads --osk-h); keep the field visible.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!field || !kbRef.current) {
      root.style.removeProperty("--osk-h");
      root.classList.remove("osk-open");
      return;
    }
    root.style.setProperty("--osk-h", `${kbRef.current.offsetHeight}px`);
    root.classList.add("osk-open");
    requestAnimationFrame(() => field.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [field, layout]);

  if (!field) return null;

  const type = (key: string) => {
    edit(field, shift ? key.toUpperCase() : key);
    if (shift) setShift(false);
  };
  const enter = () => {
    if (field instanceof HTMLTextAreaElement) return edit(field, "\n");
    const form = field.form;
    field.blur();
    setField(null);
    form?.requestSubmit();
  };
  const close = () => {
    field.blur();
    setField(null);
  };

  const rows = ROWS[layout];
  const numeric = layout === "numbers";
  return (
    // preventDefault on pointerdown: the key press must never steal focus from the field.
    <div
      ref={kbRef}
      className={`osk${numeric ? " osk-numeric" : ""}`}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      role="group"
      aria-label="On-screen keyboard"
    >
      {rows.map((row, i) => (
        <div className="osk-row" key={i}>
          {i === 3 && !numeric && (
            <button
              type="button"
              tabIndex={-1}
              className={`osk-key osk-wide${shift ? " on" : ""}`}
              onClick={() => (layout === "letters" ? setShift(!shift) : setLayout("letters"))}
            >
              {layout === "letters" ? "⇧" : "ABC"}
            </button>
          )}
          {row.map((k) => (
            <button type="button" tabIndex={-1} className="osk-key" key={k} onClick={() => type(k)}>
              {shift && layout === "letters" ? k.toUpperCase() : k}
            </button>
          ))}
          {i === 3 && (
            <button type="button" tabIndex={-1} className="osk-key osk-wide" onClick={() => edit(field, null)} aria-label="Backspace">
              ⌫
            </button>
          )}
        </div>
      ))}
      <div className="osk-row">
        {!numeric && (
          <button type="button" tabIndex={-1} className="osk-key osk-wide" onClick={() => setLayout(layout === "symbols" ? "letters" : "symbols")}>
            {layout === "symbols" ? "ABC" : "#+="}
          </button>
        )}
        {!numeric && (
          <button type="button" tabIndex={-1} className="osk-key osk-space" onClick={() => type(" ")}>
            space
          </button>
        )}
        <button type="button" tabIndex={-1} className="osk-key osk-wide" onClick={close} aria-label="Hide keyboard">
          ⌄
        </button>
        <button type="button" tabIndex={-1} className="osk-key osk-wide osk-enter" onClick={enter}>
          {field instanceof HTMLTextAreaElement ? "↵" : "Done"}
        </button>
      </div>
    </div>
  );
}
